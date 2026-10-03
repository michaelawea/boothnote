import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { newContext } from '../tools/context.ts';
import { recordSkills } from '../tools/records.ts';
import { writeSkills, rememberCompanySuggestion } from '../tools/write.ts';
import { createAgentQuestion } from '../../../src/questions.ts';
import type { ProposalItemView } from '../../../src/proposal-model.ts';
import type { ProposeRecordsInput } from '../../../src/proposal-items.ts';
import type { TargetBinding } from '../../../../../shared/agent-questions.mjs';

const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];
const context = (threadId: string | null = 'thread-current') => newContext({
  inboxId: 'inbox-current', stagingId: 'staging-current', threadId,
  userId: 'user-current', userCode: 'user-code', displayName: '测试人员',
  companies: [{ id: 'company-known', code: 'KNOWN', name: '已知客户', group: 'OEM', type: 'OEM' }],
  suppliers: [], attachments: [], maxSteps: 6, pushPlaybooks: [], resumed: false, source: 'pwa',
});
const view = (index: number, overrides: Partial<ProposalItemView> = {}): ProposalItemView => ({
  itemId: ids[index]!, revisionId: `revision-${index + 1}`, revision: index + 1,
  stagingId: 'staging-current', recordType: 'support', action: 'create',
  companyId: null, companyCode: null, target: null,
  fields: {}, confidence: {}, evidenceRefs: [], status: 'ready', confirmAfter: null,
  twentyRefs: null, createdRecords: [], error: null, ...overrides,
});
type ExplicitResolver = NonNullable<NonNullable<Parameters<typeof recordSkills>[1]>['resolveExplicitCandidate']>;
const setup = (known: ProposalItemView[] = [], threadId: string | null = 'thread-current', resolver?: ExplicitResolver) => {
  const ctx = context(threadId);
  const calls: ProposeRecordsInput[] = [];
  const reads: Array<{threadId: string; userId: string}> = [];
  const skills = recordSkills(ctx, {
    listThreadItems: async (currentThreadId, userId) => {
      reads.push({ threadId: currentThreadId, userId });
      return known;
    },
    proposeRecords: async (input) => {
      calls.push(input);
      return input.records.map((record, index) => view(index, {
        recordType: record.recordType,
        companyCode: record.companyCode ?? null,
        companyId: record.companyCode === 'KNOWN' ? 'company-known' : null,
        fields: record.fields,
      }));
    },
    resolveExplicitCandidate: resolver ?? (async () => { throw new Error('Unexpected target resolution'); }),
  });
  return { ctx, skills, calls, reads, propose: skills.find((skill) => skill.name === 'propose_records')!,
    list: skills.find((skill) => skill.name === 'get_proposal_items')! };
};
const record = (overrides: Record<string, unknown> = {}) => ({
  key: 'battery-case-1', recordType: 'support', fields: { modelName: 'B100', summary: '充不进电' },
  ...overrides,
});

describe('structured record tool contract', () => {
  it('keeps every identity from earlier tool calls while replacing a revised item with its current version', async () => {
    const ctx=context();
    let call=0;
    const skill=recordSkills(ctx,{
      listThreadItems:async()=>[view(0,{revision:1})],
      proposeRecords:async()=>++call===1 || call===4 ? [view(0,{revision:1})] :
        call===2 ? [view(1,{revision:1})] : [view(0,{revision:2,revisionId:'first-item-revision-2'})],
    })[0]!;
    await skill.execute({records:[record()]});
    await skill.execute({records:[record({key:'second-case'})]});
    assert.deepEqual(ctx.proposedItems?.map((item)=>item.itemId),[ids[0],ids[1]]);
    await skill.execute({records:[record({key:'first-case-revision',itemId:ids[0],expectedRevision:1})]});
    assert.equal(ctx.proposedItems?.length,2);
    assert.equal(ctx.proposedItems?.[0]?.revisionId,'first-item-revision-2');
    assert.equal(ctx.proposedItems?.[1]?.itemId,ids[1]);
    await skill.execute({records:[record()]});
    assert.equal(ctx.proposedItems?.[0]?.revisionId,'first-item-revision-2','重试原proposal key返回旧ack也不能回退当前上下文身份');
  });

  it('exposes draft proposal and scoped reading tools without a CRM confirmation capability', () => {
    const { skills, propose, list } = setup();
    assert.deepEqual(skills.map((skill) => skill.name).sort(), ['get_proposal_items', 'propose_records']);
    const schema = propose.parameters;
    assert.equal(schema.type, 'object');
    assert.deepEqual(schema.required, ['records']);
    const records = schema.properties.records;
    assert.equal(records.type, 'array');
    assert.equal(records.minItems, 1);
    assert.equal(records.maxItems, 20);
    assert.deepEqual(records.items.required, ['key', 'recordType', 'fields']);
    assert.equal(records.items.properties.itemId.type, 'string');
    assert.equal(records.items.properties.expectedRevision.type, 'number');
    assert.equal(records.items.properties.targetCandidateHandle.type, 'string');
    assert.equal(records.items.properties.fields.type, 'object');
    assert.deepEqual(list.parameters.properties, {});
  });

  it('keeps two same-model same-symptom cases and one inverter case independent, and exposes each real identity to the model', async () => {
    const { ctx, calls, reads, propose } = setup();
    const records = [
      record({ key: 'battery-case-1', companyCode: 'KNOWN' }),
      record({ key: 'battery-case-2', companyCode: 'KNOWN' }),
      record({ key: 'inverter-case-1', fields: { modelName: 'I200', summary: '输出断电' } }),
    ];
    const result = await propose.execute({ records });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.records.length, 3);
    assert.deepEqual(calls[0]!.records.map((item) => item.key), records.map((item) => item.key));
    assert.deepEqual(calls[0]!.records[0]!.fields, calls[0]!.records[1]!.fields);
    assert.deepEqual(reads, [{ threadId: 'thread-current', userId: 'user-current' }]);
    const visible = JSON.parse(result.text.slice(result.text.indexOf('\n') + 1)) as Array<Record<string, unknown>>;
    assert.deepEqual(visible.map((item) => item['itemId']), ids);
    assert.deepEqual(visible.map((item) => item['revision']), [1, 2, 3]);
    assert.deepEqual(visible.map((item) => item['key']), records.map((item) => item.key));
    assert.equal(new Set(visible.map((item) => item['itemId'])).size, 3);
    assert.equal(ctx.proposed, true);
    assert.deepEqual(ctx.proposedItems?.map((item) => item.itemId), ids);
  });

  it('leaves an unknown customer unset and passes its own AI suggestions without borrowing a sibling customer', async () => {
    const { ctx, calls, propose } = setup();
    ctx.suggestedCompany = '旧的整轮建议';
    const unknownFields = {
      summary: '逆变器输出断电', suggested_company: '新客户甲',
      suggestedCompanyFields: { name: '新客户甲', country: 'Germany', accountType: 'dealer' },
    };
    await propose.execute({ records: [
      record({ key: 'known-case', companyCode: 'KNOWN' }),
      record({ key: 'unknown-case', fields: unknownFields }),
    ] });
    const submitted = calls[0]!.records;
    assert.equal(submitted[0]!.companyCode, 'KNOWN');
    assert.equal(submitted[1]!.companyCode, undefined);
    assert.deepEqual(submitted[1]!.fields, { ...unknownFields, recordType:'support',
      suggestedCompanyFields:{name:'新客户甲',country:'DE',accountType:'DEALER'} });
    assert.equal(ctx.proposedItems?.[1]?.companyId, null);
    assert.equal(ctx.suggestedCompany, '旧的整轮建议');
  });

  it('retains one issue affecting eighteen units instead of creating eighteen cases', async () => {
    const { calls, propose } = setup();
    await propose.execute({ records: [record({ fields: { summary: '一个批次同一故障', affectedUnits: 18 } })] });
    assert.equal(calls[0]!.records.length, 1);
    assert.equal(calls[0]!.records[0]!.fields['affectedUnits'], 18);
  });

  it('forwards a targeted revision only when its item and version are current in this user’s thread', async () => {
    const known = view(0, { revision: 7 });
    const { calls, propose } = setup([known]);
    await propose.execute({ records: [record({ itemId: known.itemId, expectedRevision: 7, action: 'update' })] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.userId, 'user-current');
    assert.equal(calls[0]!.threadId, 'thread-current');
    assert.equal(calls[0]!.stagingId, 'staging-current');
    assert.equal(calls[0]!.inboxId, 'inbox-current');
    assert.equal(calls[0]!.records[0]!.itemId, known.itemId);
    assert.equal(calls[0]!.records[0]!.expectedRevision, 7);
    assert.equal(calls[0]!.records[0]!.action, 'update');
  });

  for (const [label, target] of [
    ['an invented item', { itemId: '44444444-4444-4444-8444-444444444444', expectedRevision: 7 }],
    ['a stale revision', { itemId: ids[0], expectedRevision: 6 }],
    ['an omitted revision', { itemId: ids[0] }],
  ] as const) {
    it(`rejects ${label} before persisting any sibling`, async () => {
      const { ctx, calls, propose } = setup([view(0, { revision: 7 })]);
      const result = await propose.execute({ records: [record(), record({ key: 'revision', ...target })] });
      assert.match(result.text, /get_proposal_items/);
      assert.equal(calls.length, 0);
      assert.equal(ctx.proposed, false);
      assert.equal(ctx.proposedItems, undefined);
    });
  }

  it('rejects illegal actions before persisting any sibling', async () => {
    const { ctx, calls, propose } = setup();
    const result = await propose.execute({ records: [record(), record({ key: 'bad-action', action: 'delete' })] });
    assert.match(result.text, /create\/append\/update/);
    assert.equal(calls.length, 0);
    assert.equal(ctx.proposed, false);
  });

  it('does not claim a proposal succeeded when the proposer throws', async () => {
    const ctx = context();
    const failure = new Error('proposal persistence failed');
    let attempts = 0;
    const skills = recordSkills(ctx, {
      listThreadItems: async () => [],
      proposeRecords: async () => { attempts++; throw failure; },
    });
    await assert.rejects(skills[0]!.execute({ records: [record()] }), (error) => error === failure);
    assert.equal(attempts, 1);
    assert.equal(ctx.proposed, false);
    assert.equal(ctx.proposedItems, undefined);
  });

  it('returns scoped current items in readable text without proposing or confirming them', async () => {
    const known = [view(0, { revision: 7 }), view(1, { revision: 4 })];
    const { ctx, calls, reads, list } = setup(known);
    const result = await list.execute({});
    assert.deepEqual(JSON.parse(result.text), known);
    assert.deepEqual(reads, [{ threadId: 'thread-current', userId: 'user-current' }]);
    assert.equal(calls.length, 0);
    assert.equal(ctx.proposed, false);
  });

  it('has no revision targets or lookup queries without an actual thread', async () => {
    const { calls, reads, propose, list } = setup([], null);
    assert.deepEqual(JSON.parse((await list.execute({})).text), []);
    const result = await propose.execute({ records: [record({ itemId: ids[0], expectedRevision: 1 })] });
    assert.match(result.text, /get_proposal_items/);
    assert.equal(calls.length, 0);
    assert.equal(reads.length, 0);
  });

  it('uses a server-verified explicit candidate as the true target of its own item', async () => {
    const target: TargetBinding = { type: 'supportCase', id: ids[2]!, companyId: 'company-known', action: 'append', code: 'CASE-123' };
    const resolutions: Array<{ handle: string; companyCode: string | undefined; stagingId: string; userId: string }> = [];
    const { ctx, calls, propose } = setup([], 'thread-current', async (current, handle, companyCode) => {
      resolutions.push({ handle, companyCode, stagingId: current.stagingId, userId: current.userId });
      return target;
    });
    await propose.execute({ records: [record({ companyCode: 'KNOWN', targetCandidateHandle: 'read-only-handle', action: 'create' })] });
    assert.deepEqual(resolutions, [{ handle: 'read-only-handle', companyCode: 'KNOWN', stagingId: ctx.stagingId, userId: ctx.userId }]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.records[0]!.target, target);
    assert.equal(calls[0]!.records[0]!.action, 'append');
    assert.equal(calls[0]!.records[0]!.companyCode, 'KNOWN');
    assert.equal(ctx.proposed, true);
  });

  it('derives an explicit project update from the verified candidate rather than inventing a relation UUID', async () => {
    const target: TargetBinding = { type: 'project', id: ids[2]!, companyId: 'company-known', action: 'update', code: 'PROJECT-123' };
    const { calls, propose } = setup([], 'thread-current', async () => target);
    await propose.execute({ records: [record({ recordType: 'followup', companyCode: 'KNOWN', targetCandidateHandle: 'project-handle' })] });
    assert.deepEqual(calls[0]!.records[0]!.target, target);
    assert.equal(calls[0]!.records[0]!.action, 'update');
  });

  for (const [recordType, targetType] of [['support', 'project'], ['project', 'supportCase'], ['fitment', 'supportCase']] as const) {
    it(`rejects a ${targetType} target for ${recordType} before persisting the entire batch`, async () => {
      const { ctx, calls, propose } = setup([], 'thread-current', async () => ({
        type: targetType, id: ids[2]!, companyId: 'company-known', action: targetType === 'supportCase' ? 'append' : 'update',
      }));
      const result = await propose.execute({ records: [record(), record({ key: 'wrong-target', recordType, companyCode: 'KNOWN', targetCandidateHandle: 'handle' })] });
      assert.match(result.text, /不一致/);
      assert.equal(calls.length, 0);
      assert.equal(ctx.proposed, false);
    });
  }

  it('does not bind a target with a missing per-item customer or copy another item’s customer', async () => {
    let resolutions = 0;
    const { ctx, calls, propose } = setup([], 'thread-current', async () => {
      resolutions++;
      return { type: 'supportCase', id: ids[2]!, companyId: 'company-known', action: 'append' };
    });
    const result = await propose.execute({ records: [
      record({ companyCode: 'KNOWN' }), record({ key: 'unknown-target', targetCandidateHandle: 'handle' }),
    ] });
    assert.match(result.text, /companyCode/);
    assert.equal(resolutions, 0);
    assert.equal(calls.length, 0);
    assert.equal(ctx.proposed, false);
  });

  it('keeps an explicit pending-draft candidate on the human continue path instead of duplicating it as a CRM item', async () => {
    const { ctx, calls, propose } = setup([], 'thread-current', async () => ({
      type: 'staging', id: ids[2]!, companyId: 'company-known', action: 'continue',
    }));
    const result = await propose.execute({ records: [record({ companyCode: 'KNOWN', targetCandidateHandle: 'pending-handle' })] });
    assert.match(result.text, /ask_user.*continue/);
    assert.equal(calls.length, 0);
    assert.equal(ctx.proposed, false);
  });

  it('does not persist siblings or claim success when the explicit source verification fails', async () => {
    const failure = new Error('target is not explicitly named in this source');
    const { ctx, calls, propose } = setup([], 'thread-current', async () => { throw failure; });
    await assert.rejects(propose.execute({ records: [
      record(), record({ key: 'bad-proof', companyCode: 'KNOWN', targetCandidateHandle: 'unverified-handle' }),
    ] }), (error) => error === failure);
    assert.equal(calls.length, 0);
    assert.equal(ctx.proposed, false);
    assert.equal(ctx.proposedItems, undefined);
  });
});


describe('proposal/question order and explicit customer suggestions',()=>{
  it('先问后提交多事项会保留提案并撤掉歧义问题，模型可指定稳定itemId重问',async()=>{
    const {ctx,propose,calls}=setup();
    const ask=writeSkills(ctx).find((skill)=>skill.name==='ask_user')!;
    assert.equal((await ask.execute({question:'哪一个故障？',options:['第一个','第二个']})).terminate,undefined);
    const response=await propose.execute({records:[record(),record({key:'second-case'})]});
    assert.equal(calls.length,1);
    assert.equal(ctx.proposedItems?.length,2);
    assert.equal(ctx.questions.length,0);
    assert.match(response.text,/question_item_required/);
    await ask.execute({question:'第二个故障何时出现？',options:['今天','昨天'],itemId:ids[1]});
    assert.equal(ctx.questions[0]?.itemId,ids[1]);
  });
  it('先问后提交唯一事项可绑定该唯一身份，不凭模型或数组顺序选择多项',async()=>{
    const {ctx,propose}=setup();
    createAgentQuestion(ctx,{question:'何时出现？',options:['今天','昨天']});
    await propose.execute({records:[record()]});
    assert.equal(ctx.questions[0]?.itemId,ids[0]);
    assert.equal(ctx.questions[0]?.revisionId,'revision-1');
  });
  it('先提交多事项再问而漏itemId在工具调用时被拒绝，不新增问题',async()=>{
    const {ctx,propose}=setup();
    await propose.execute({records:[record(),record({key:'second-case'})]});
    const ask=writeSkills(ctx).find((skill)=>skill.name==='ask_user')!;
    await assert.rejects(ask.execute({question:'哪一个故障？',options:['第一个','第二个']}),/必须传itemId/);
    assert.equal(ctx.questions.length,0);
  });
  it('多客户flag提示仅进入明确同名项，不把最后一家建议复制给未指定客户的项',async()=>{
    const {ctx,propose,calls}=setup();
    rememberCompanySuggestion(ctx,{name:'Example Alpha',country:'DE',accountType:'DEALER'});
    rememberCompanySuggestion(ctx,{name:'Example Beta',country:'FR',accountType:'DISTRIBUTOR'});
    ctx.suggestedCompany='Example Beta';
    await propose.execute({records:[
      record({key:'alpha',fields:{summary:'Alpha故障',suggested_company:'Example Alpha'}}),
      record({key:'beta',fields:{summary:'Beta故障',suggested_company:'Example Beta'}}),
      record({key:'unknown',fields:{summary:'归属未知',sourceCompanyName:'Example Alpha'}}),
    ]});
    assert.deepEqual(calls[0]!.records[0]!.fields['suggestedCompanyFields'],{name:'Example Alpha',country:'DE',accountType:'DEALER'});
    assert.deepEqual(calls[0]!.records[1]!.fields['suggestedCompanyFields'],{name:'Example Beta',country:'FR',accountType:'DISTRIBUTOR'});
    assert.equal(calls[0]!.records[2]!.fields['suggested_company'],undefined);
    assert.equal(calls[0]!.records[2]!.fields['sourceCompanyName'],'Example Alpha', '传闻消息来源保留，但不能当作客户');
  });
  it('明确itemKey可以绑定新客户，但与该项明说公司不一致时整批受控拒绝',async()=>{
    const {ctx,propose,calls}=setup();
    rememberCompanySuggestion(ctx,{name:'Example Alpha',country:'DE',accountType:'DEALER'},'first-case');
    let response=await propose.execute({records:[record({key:'first-case',fields:{summary:'故障'}})]});
    assert.equal(calls[0]!.records[0]!.fields['suggested_company'],'Example Alpha');
    response=await propose.execute({records:[record({key:'first-case',fields:{summary:'故障',suggested_company:'Example Beta'}})]});
    assert.equal(calls.length,1);
    assert.match(response.text,/suggestion_item_mismatch/);
  });
  it('非法业务字段返回具体item key与field，不先保存合法兄弟项',async()=>{
    const {propose,calls}=setup();
    const response=await propose.execute({records:[record(),record({key:'inverter',fields:{summary:'故障',severity:'IMPOSSIBLE'}})]});
    assert.equal(calls.length,0);
    assert.match(response.text,/"key":"inverter"/);
    assert.match(response.text,/"field":"severity"/);
  });
  it('关系UUID剥除后向模型明确报告，不冒充已采纳',async()=>{
    const {propose,calls}=setup();
    const response=await propose.execute({records:[record({fields:{summary:'故障',companyId:'invented-relationship'}})]});
    assert.equal(calls[0]!.records[0]!.fields['companyId'],undefined);
    assert.match(response.text,/关系或内部字段未采纳/);
    assert.match(response.text,/companyId/);
  });
  it('与旧单条关系未知时不产生items，也不能退回legacy把多个事项压成一项',async()=>{
    const {ctx,propose,calls}=setup();
    ctx.inheritedLegacyStagingId='legacy-pending';
    const response=await propose.execute({records:[record(),record({key:'second-case'})]});
    assert.equal(calls.length,0);
    assert.match(response.text,/legacy_disposition_required/);
    const legacy=writeSkills(ctx).find((skill)=>skill.name==='propose_fields')!;
    assert.match((await legacy.execute({recordType:'support',summary:'Flattened cases'})).text,/legacy_disposition_required/);
  });
});
