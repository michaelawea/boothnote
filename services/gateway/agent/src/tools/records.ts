import { Type } from '@earendil-works/pi-ai';
import { proposeRecords, listThreadItems, resolveExplicitCandidate, reconcilePendingQuestionItems,
  companySuggestion, sanitizeItemFields, IGNORED_ITEM_FIELDS, ProposalItemError } from '../host.ts';
import type { Skill } from '../runtime.ts';
import type { SkillContext } from './context.ts';


/** 只按明确名称或 key 带入提示；有合法显式字段时不拿最后一次 flag 覆盖。 */
export const fieldsWithCompanySuggestion = (ctx: SkillContext, proposal: Record<string, unknown>): Record<string, unknown> => {
  const raw=proposal['fields'];
  if (!raw || typeof raw!=='object' || Array.isArray(raw)) throw new ProposalItemError('invalid_item_fields',422,'fields必须是对象。','fields');
  const fields={...raw as Record<string,unknown>};
  const explicitName=typeof fields['suggested_company']==='string' ? fields['suggested_company'].trim() : '';
  const keyed=ctx.itemCompanySuggestions?.get(String(proposal['key']??''));
  if (keyed && explicitName && keyed.name!==explicitName) throw new ProposalItemError('suggestion_item_mismatch',422,'事项明确公司名与该key的建议不一致。','suggested_company');
  const hint=keyed ?? (explicitName ? ctx.companySuggestions?.get(explicitName) : undefined);
  if (hint && !proposal['companyCode']) {
    const ownHints=companySuggestion(hint.name,fields['suggestedCompanyFields']);
    fields['suggested_company']=hint.name;
    fields['suggestedCompanyFields']={...hint,
      ...(ownHints?.country ? {country:ownHints.country} : {}),
      ...(ownHints?.accountType ? {accountType:ownHints.accountType} : {}),
    };
  }
  return fields;
};

/** Structured planning creates drafts only. It never confirms or writes CRM records. */
export const recordSkills = (ctx: SkillContext, dependencies: {proposeRecords?:typeof proposeRecords;listThreadItems?:typeof listThreadItems;resolveExplicitCandidate?:typeof resolveExplicitCandidate} = {}): Skill[] => {
const persist=dependencies.proposeRecords ?? proposeRecords;
const read=dependencies.listThreadItems ?? listThreadItems;
const explicit=dependencies.resolveExplicitCandidate ?? resolveExplicitCandidate;
return [{
  name:'propose_records',label:'提交逐项提案',
  description:'把可独立跟进、解决、关闭的业务事项分别提交；一个输入可有多客户、多售后或混合类型。'+
    '明确两个同型号同现象独立案例也提交两项，不编序列号；一个问题影响18台仍是一项。'+
    'key是本轮稳定名称，工具重试用相同key；修订已有事项必须用get_proposal_items返回的itemId和expectedRevision，'+
    '新增事项不能继承或取代别的事项。targetCandidateHandle只可引用只读检索候选，且原文明说其编号或UUID；其余关联先用ask_user。'+
    'fields沿用propose_fields的业务字段，包括chain和corrections；项目可带project/workItems/document完整子提案。'+
    '未知客户留空；fields.suggested_company为本事项明确的新客户名，suggestedCompanyFields含同名name/country/accountType提示。'+
    'flag_new_company提示只按同名公司或其明确itemKey带入，不借其它项的客户。未知字段会返回事项key和字段错误，关系UUID不会被采纳。',
  parameters:Type.Object({records:Type.Array(Type.Object({
    key:Type.String({description:'本轮稳定事项键，例如battery-case-1，后续重试不要换键'}),
    itemId:Type.Optional(Type.String({description:'仅定向修订：get_proposal_items返回的服务端ID'})),
    expectedRevision:Type.Optional(Type.Number({description:'要修订的当前版本整数'})),
    recordType:Type.String({description:'support / fitment / project / followup'}),
    companyCode:Type.Optional(Type.String({description:'本事项客户代号；必须是检索名单中的代号。未知留空'})),
    targetCandidateHandle:Type.Optional(Type.String({description:'仅原文明说编号/UUID时引用检索得到的candidateHandle；服务端验证客户和类型，其他推荐先ask_user'})),
    action:Type.Optional(Type.String({description:'create新事项、append进展、update更正；原文有明确编号可引用targetCandidateHandle，其余关联先ask_user确认'})),
    fields:Type.Record(Type.String(),Type.Any(),{description:'原文完整详情与结构化字段；不填未知事实，不传关系UUID'}),
    confidence:Type.Optional(Type.Record(Type.String(),Type.String())),
  }),{minItems:1,maxItems:20})}),
  execute:async ({records}: {records:Array<Record<string,unknown>>}) => {
    if (ctx.continuedLegacyStagingId) return {
      text: 'legacy_continue_requires_fields: 用户已选择继续准确旧单条草稿，本轮用 propose_fields 合并新信息；不能用 propose_records 清掉旧字段或复制给多个事项。',
      details: { rejected: true, code: 'legacy_continue_requires_fields' },
    };
    if (ctx.inheritedLegacyStagingId) {
      ctx.legacyDispositionRequired = true;
      return {
      text: 'legacy_disposition_required: 本轮带有尚未处置的旧单条提案，未新增任何事项。'+
        '先检索自己的旧草稿，用 ask_user 提供该草稿的 continue 候选与 create（独立新事项）出口；必须等用户选择。不要用 propose_fields 把多个独立事项压成一项。',
      details: { rejected: true, code: 'legacy_disposition_required' },
      };
    }
    const known=ctx.threadId ? await read(ctx.threadId,ctx.userId) : [];
    for (const p of records) {
      if (p['itemId'] && !known.some((i)=>i.itemId===p['itemId'] && i.revision===p['expectedRevision'])) {
        return {text:'修订目标不是这条对话的当前事项，请先调 get_proposal_items；指代不清请问人。'};
      }
      if (p['action'] && !['create','append','update'].includes(String(p['action']))) return {text:'事项action必须是create/append/update。'};
    }
    const proposals=[];
    const ignored: Array<{key:string;fields:string[]}> = [];
    for (const p of records) {
      let fields;
      try {
        const enriched=fieldsWithCompanySuggestion(ctx,p);
        fields=sanitizeItemFields(enriched,String(p['recordType']??''));
        const discarded=Object.keys(enriched).filter((key)=>(IGNORED_ITEM_FIELDS as readonly string[]).includes(key));
        if (discarded.length) ignored.push({key:String(p['key']??''),fields:discarded});
      } catch (error) {
        if (!(error instanceof ProposalItemError)) throw error;
        const detail={key:String(p['key']??''),field:error.field ?? 'recordType',code:error.code};
        return {text:`事项未保存；请修正该项字段后重试：${JSON.stringify(detail)}`,details:{rejected:true,...detail}};
      }
      let binding;
      if (typeof p['targetCandidateHandle']==='string') {
        if (typeof p['companyCode']!=='string' || !p['companyCode']) return {text:'明确关联目标时必须填写本事项companyCode，不能借另一项的客户。'};
        const target=await explicit(ctx,p['targetCandidateHandle'],p['companyCode']);
        if (target.type==='staging') return {text:'待确认草稿需通过ask_user的continue选项消费原提案；不能作为CRM目标另建重复事项。'};
        const type=String(p['recordType']);
        if ((type==='support' && target.type!=='supportCase') || type==='fitment' ||
          (['project','followup'].includes(type) && target.type==='supportCase')) {
          return {text:'候选类型与本事项不一致：售后仅关联supportCase，项目跟进仅关联project/workItem。'};
        }
        const action=target.type==='supportCase' ? 'append' as const : 'update' as const;
        binding={...target,type:target.type,action};
      }
      proposals.push({key:String(p['key']??''),itemId:typeof p['itemId']==='string' ? p['itemId'] : undefined,
        expectedRevision:typeof p['expectedRevision']==='number' ? p['expectedRevision'] : undefined,
        recordType:String(p['recordType']??''),companyCode:typeof p['companyCode']==='string' ? p['companyCode'] : undefined,
        action:binding?.action ?? p['action'] as 'create'|'append'|'update'|undefined,target:binding,fields,
        confidence:p['confidence'] as Record<string,string>|undefined,
        evidenceRefs:ctx.dispositionSourceInboxId ? [...new Set([ctx.inboxId,ctx.dispositionSourceInboxId])].map((inboxId)=>({inboxId})) : undefined});
    }
    const items=await persist({stagingId:ctx.stagingId,inboxId:ctx.inboxId,threadId:ctx.threadId,userId:ctx.userId,records:proposals});
    ctx.proposed=true;
    const currentItems=new Map((ctx.proposedItems ?? []).map((item)=>[item.itemId,item]));
    for (const item of items) {
      if (item.revision >= (currentItems.get(item.itemId)?.revision ?? 0)) currentItems.set(item.itemId,item);
    }
    ctx.proposedItems=[...currentItems.values()];
    const questionWarnings=reconcilePendingQuestionItems(ctx);
    return {text:`已保留 ${items.length} 个独立事项，分别核对客户和动作后才会入库。\n`+
      JSON.stringify(items.map((item,index)=>({key:records[index]?.['key'],itemId:item.itemId,revision:item.revision,status:item.status,stagingId:item.stagingId,recordType:item.recordType,companyCode:item.companyCode})))+
      (ignored.length ? `\n以下关系或内部字段未采纳，关系由服务端校验解析：${JSON.stringify(ignored)}` : '')+
      (questionWarnings.length ? `\n${questionWarnings.join('\n')}` : ''),details:{items,ignored,questionWarnings}};
  },
},{
  name:'get_proposal_items',label:'查看独立事项',description:'查看本对话可独立处理的事项与当前itemId/revision。'+
    '新增问题新建事项；只有明确点名的更正才传已有itemId。多个候选指代不清时问人，不取最新或第一项。',
  parameters:Type.Object({}),execute:async()=>({text:JSON.stringify(ctx.threadId ? await read(ctx.threadId,ctx.userId) : []),details:{}}),
}];
};
