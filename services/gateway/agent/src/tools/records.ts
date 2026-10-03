import { Type } from '@earendil-works/pi-ai';
import { proposeRecords, listThreadItems, resolveExplicitCandidate } from '../host.ts';
import type { Skill } from '../runtime.ts';
import type { SkillContext } from './context.ts';

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
    'fields沿用propose_fields的字段；项目可带project/workItems/document完整子提案。未知客户留空，不借其它项的客户。',
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
    const known=ctx.threadId ? await read(ctx.threadId,ctx.userId) : [];
    for (const p of records) {
      if (p['itemId'] && !known.some((i)=>i.itemId===p['itemId'] && i.revision===p['expectedRevision'])) {
        return {text:'修订目标不是这条对话的当前事项，请先调 get_proposal_items；指代不清请问人。'};
      }
      if (p['action'] && !['create','append','update'].includes(String(p['action']))) return {text:'事项action必须是create/append/update。'};
    }
    const proposals=[];
    for (const p of records) {
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
        action:binding?.action ?? p['action'] as 'create'|'append'|'update'|undefined,target:binding,fields:p['fields'] as Record<string,unknown>,
        confidence:p['confidence'] as Record<string,string>|undefined});
    }
    const items=await persist({stagingId:ctx.stagingId,inboxId:ctx.inboxId,threadId:ctx.threadId,userId:ctx.userId,records:proposals});
    ctx.proposed=true;
    const currentItems=new Map((ctx.proposedItems ?? []).map((item)=>[item.itemId,item]));
    for (const item of items) {
      if (item.revision >= (currentItems.get(item.itemId)?.revision ?? 0)) currentItems.set(item.itemId,item);
    }
    ctx.proposedItems=[...currentItems.values()];
    return {text:`已保留 ${items.length} 个独立事项，分别核对客户和动作后才会入库。\n`+
      JSON.stringify(items.map((item,index)=>({key:records[index]?.['key'],itemId:item.itemId,revision:item.revision,status:item.status,stagingId:item.stagingId,recordType:item.recordType,companyCode:item.companyCode}))),details:{items}};
  },
},{
  name:'get_proposal_items',label:'查看独立事项',description:'查看本对话可独立处理的事项与当前itemId/revision。'+
    '新增问题新建事项；只有明确点名的更正才传已有itemId。多个候选指代不清时问人，不取最新或第一项。',
  parameters:Type.Object({}),execute:async()=>({text:JSON.stringify(ctx.threadId ? await read(ctx.threadId,ctx.userId) : []),details:{}}),
}];
};
