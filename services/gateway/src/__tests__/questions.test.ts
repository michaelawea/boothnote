import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { containsExplicitTargetIdentifier, createAgentQuestion, reconcilePendingQuestionItems, proposalFingerprint, QuestionError, resolveQuestionOption } from '../questions.ts';
import { candidateText, readCandidatePages, readCrmCandidates, registerCandidates, toTargetCandidate } from '../targetCandidates.ts';
import { sql } from '../db.ts';
import type { QuestionSnapshot, TargetCandidate } from '../../../../shared/agent-questions.mjs';

after(() => sql.end());
const COMPANY = randomUUID();
const context = () => ({ stagingId: randomUUID(), inboxId: randomUUID(), threadId: randomUUID(), userId: randomUUID(),
  companies: [{ id: COMPANY, code: 'EXAMPLE' }], questions: [] as QuestionSnapshot[], targetCandidates: new Map<string, TargetCandidate>() });
const support = (name = '车辆充电不足', status = 'NEW', companyId = COMPANY) => ({ id: randomUUID(), name, companyId, caseStatus: status,
  issueDescription: { markdown: 'DCDC-40；上坡电压偏低，检查IGN信号。' } });

describe('目标检索的负结果与失败严格分开', () => {
  it('真实空列表是ok；HTTP错误/错误包是error且禁止据此新建', async () => {
    const empty = await readCrmCandidates('supportCase', COMPANY, { read: async () => ({ data: { supportCases: [] }, pageInfo: { hasNextPage: false } }) });
    assert.equal(empty.status, 'ok');
    const unavailable = await readCrmCandidates('supportCase', COMPANY, { read: async () => { throw new Error('503'); } });
    assert.equal(unavailable.status, 'error');
    assert.match(candidateText('售后', unavailable), /不能据此认定不存在或自动新建/);
    const badPackage = await readCrmCandidates('supportCase', COMPANY, { read: async () => ({ errors: ['LIMIT_REACHED'] }) });
    assert.equal(badPackage.status, 'error');
  });

  it('第一页全关闭，第二页的开放工单仍被找到；不能先过滤再停止分页', async () => {
    let calls = 0;
    const target = support();
    const result = await readCrmCandidates('supportCase', COMPANY, { read: async (path) => {
      calls++;
      if (calls === 1) return { data: { supportCases: Array.from({ length: 50 }, () => support('旧工单', 'CLOSED')) }, pageInfo: { hasNextPage: true, endCursor: 'next' } };
      assert.match(path, /starting_after=next/);
      return { data: { supportCases: [target] }, pageInfo: { hasNextPage: false } };
    } });
    assert.equal(calls, 2);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.candidates.map((candidate) => candidate.target.id), [target.id]);
  });

  it('有下一页却没有cursor、页数上限、重复cursor均明确incomplete', async () => {
    const missing = await readCandidatePages('supportCases', 'companyId[eq]:x', async () => ({ data: { supportCases: [support()] }, pageInfo: { hasNextPage: true } }));
    assert.equal(missing.complete, false);
    const capped = await readCandidatePages('supportCases', 'x', async () => ({ data: { supportCases: [support()] }, pageInfo: { hasNextPage: true, endCursor: randomUUID() } }), 1);
    assert.equal(capped.complete, false);
    const repeated = await readCandidatePages('supportCases', 'x', async () => ({ data: { supportCases: [support()] }, pageInfo: { hasNextPage: true, endCursor: 'same' } }));
    assert.equal(repeated.complete, false);
  });

  it('同SKU同标题仍有不同UUID和故障正文；其他客户不能进入候选', async () => {
    const first = support('DCDC故障');
    const second = { ...support('DCDC故障'), issueDescription: { markdown: 'DCDC-40；下坡过压，另一个故障。' } };
    const result = await readCrmCandidates('supportCase', COMPANY, { read: async () => ({ data: { supportCases: [first, second, support('别家', 'NEW', randomUUID())] } }) });
    assert.equal(result.candidates.length, 2);
    assert.notEqual(result.candidates[0]!.target.id, result.candidates[1]!.target.id);
    const text = candidateText('已有售后', result);
    assert.match(text, /上坡/);
    assert.match(text, /下坡/);
    assert.match(text, /candidateHandle/);
  });

  it('显式查已关闭工单返回实际CLOSED，默认开放列表不包含它', async () => {
    const record = support('CASE-2026-123 旧问题', 'CLOSED');
    const read = async () => ({ data: { supportCases: [record] } });
    assert.equal((await readCrmCandidates('supportCase', COMPANY, { read })).candidates.length, 0);
    const explicit = await readCrmCandidates('supportCase', COMPANY, { read, query: 'CASE-2026-123' });
    assert.equal(explicit.candidates[0]!.target.status, 'CLOSED');
    assert.match(candidateText('售后', explicit), /"closed":true/);
  });

  it('明确UUID直接查真实对象，不受候选分页上限影响', async () => {
    const record = support('较早的工单', 'CLOSED');
    const paths: string[] = [];
    const result = await readCrmCandidates('supportCase', COMPANY, { query: record.id, read: async (path) => {
      paths.push(path); return { data: { supportCase: record } };
    } });
    assert.deepEqual(paths, [`/rest/supportCases/${record.id}`]);
    assert.equal(result.status, 'ok');
    assert.equal(result.candidates[0]!.target.id, record.id);
  });
});

describe('问题选项的确定性目标身份', () => {
  it('原文编号必须完整匹配；UUID明确时不要求同时说出项目编号', () => {
    const target={id:randomUUID(),code:'PRJ-12'};
    assert.equal(containsExplicitTargetIdentifier('更新 PRJ-12：客户已回覆',target),true);
    assert.equal(containsExplicitTargetIdentifier('Update PRJ-12 after the meeting.',target),true);
    assert.equal(containsExplicitTargetIdentifier(`更新这个 ${target.id.toUpperCase()}。`,target),true);
    assert.equal(containsExplicitTargetIdentifier('更新PRJ-123',target),false);
    assert.equal(containsExplicitTargetIdentifier('更新PRJ-12-extra',target),false);
    assert.equal(containsExplicitTargetIdentifier('追加最近的项目',target),false);
  });
  it('真实已读候选才能绑定目标；模型编的UUID/句柄不能绑定', () => {
    const ctx = context();
    const record = support();
    const candidate = toTargetCandidate('supportCase', record, COMPANY)!;
    registerCandidates(ctx, [{ status: 'ok', candidates: [candidate] }]);
    const question = createAgentQuestion(ctx, { question: '追加到这条吗？', targetOptions: [
      { label: '追加到原工单', candidateHandle: candidate.handle }, { label: '新问题', action: 'create' }, { label: '都不是', action: 'clarify' },
    ], recommendedIndex: 0 });
    assert.equal(question.choices![0]!.target!.id, record.id);
    assert.equal(question.recommendedOptionId, question.choices![0]!.optionId);
    assert.notEqual(question.choices![0]!.optionId, candidate.handle);
    assert.throws(() => createAgentQuestion(context(), { question: 'Q', targetOptions: [{ label: '选伪造目标', candidateHandle: randomUUID() }] }), (error: unknown) => error instanceof QuestionError && error.code === 'unknown_candidate');
  });

  it('不能跨客户混选、不能把售后append改为update、无目标只允许create/clarify', () => {
    const ctx = context();
    const first = toTargetCandidate('supportCase', support(), COMPANY)!;
    const foreignCompany = randomUUID();
    const second = toTargetCandidate('project', { id: randomUUID(), name: '项目', companyId: foreignCompany }, foreignCompany)!;
    registerCandidates(ctx, [{ status: 'ok', candidates: [first, second] }]);
    assert.throws(() => createAgentQuestion(ctx, { question: 'Q', targetOptions: [{ label: 'A', candidateHandle: first.handle }, { label: 'B', candidateHandle: second.handle }] }), /一家客户/);
    assert.throws(() => createAgentQuestion(ctx, { question: 'Q', targetOptions: [{ label: 'A', candidateHandle: first.handle, action: 'update' }] }), /动作/);
    assert.throws(() => createAgentQuestion(ctx, { question: 'Q', targetOptions: [{ label: 'A', action: 'append' }] }), /已检索候选/);
  });

  it('旧文字选项仍可展示，但不拥有目标；一轮仅一问', () => {
    const ctx = context();
    const question = createAgentQuestion(ctx, { question: '哪一季度？', options: ['Q3', 'Q4'] });
    assert.equal(question.kind, 'clarify');
    assert.equal(question.choices![0]!.target, undefined);
    assert.equal(question.choices![0]!.action, 'clarify');
    assert.throws(() => createAgentQuestion(ctx, { question: '再问' }), /一轮最多/);
  });

  it('多事项漏itemId在工具执行时即可纠正，指定一项只绑定该项及版本', () => {
    const ctx = context();
    const items = [{ itemId: randomUUID(), revisionId: randomUUID(), companyId: COMPANY }, { itemId: randomUUID(), revisionId: randomUUID(), companyId: COMPANY }];
    const candidate = toTargetCandidate('supportCase', support(), COMPANY)!;
    const multi = { ...ctx, proposedItems: items };
    registerCandidates(multi, [{ status: 'ok', candidates: [candidate] }]);
    const input = { question: '这一项追加到原工单？', targetOptions: [{ label: '是', candidateHandle: candidate.handle }] };
    assert.throws(() => createAgentQuestion(multi, input), (error: unknown) => error instanceof QuestionError && error.code === 'question_item_required');
    assert.throws(() => createAgentQuestion(multi, { question:'这条新建还是继续说明？',targetOptions:[{label:'新建',action:'create'},{label:'补充说明',action:'clarify'}] }),
      (error: unknown) => error instanceof QuestionError && error.code === 'question_item_required');
    assert.throws(() => createAgentQuestion(multi, { question:'这条问题何时出现？',options:['今天','昨天'] }),
      (error: unknown) => error instanceof QuestionError && error.code === 'question_item_required');
    assert.equal(multi.questions.length, 0, '错误提问不能留进最终输出');
    const question = createAgentQuestion(multi, { ...input, itemId: items[1]!.itemId });
    assert.equal(question.itemId, items[1]!.itemId);
    assert.equal(question.revisionId, items[1]!.revisionId);
  });

  it('旧提案处置必须提供准确旧草稿continue与create；普通问话或另一旧草稿不能绕过', () => {
    const legacyId = randomUUID();
    const ctx = { ...context(), inheritedLegacyStagingId: legacyId };
    const candidate: TargetCandidate = { handle: randomUUID(), target: { type: 'staging', id: legacyId,
      companyId: COMPANY, action: 'continue' }, label: '准确旧事项', description: '原始故障' };
    const sibling: TargetCandidate = { ...candidate, handle: randomUUID(), target: { ...candidate.target, id: randomUUID() } };
    registerCandidates(ctx, [{ status: 'ok', candidates: [candidate, sibling] }]);
    assert.throws(() => createAgentQuestion(ctx, { question: '哪一季度？', options: ['Q1', 'Q2'] }), /先提供明确旧草稿/);
    assert.throws(() => createAgentQuestion(ctx, { question: '继续？', targetOptions: [
      { label: '另一草稿', candidateHandle: sibling.handle }, { label: '独立新事项', action: 'create' },
    ] }), /先提供明确旧草稿/);
    const question = createAgentQuestion(ctx, { question: '继续准确旧草稿还是独立新事项？', targetOptions: [
      { label: '继续准确旧草稿', candidateHandle: candidate.handle }, { label: '独立新事项', action: 'create' },
    ] });
    assert.equal(question.purpose, 'legacy_disposition');
    assert.equal(question.legacyStagingId, legacyId);
  });

  it('后续修订使已问问题版本失效时撤出待发问题，不偷偷绑定新版或其它项', () => {
    const itemId = randomUUID();
    const ctx = { ...context(), proposedItems: [{ itemId, revisionId: 'revision-1', companyId: COMPANY }] };
    createAgentQuestion(ctx, { question: '今天还是昨天？', options: ['今天', '昨天'], itemId });
    ctx.proposedItems = [{ itemId, revisionId: 'revision-2', companyId: COMPANY }];
    assert.match(reconcilePendingQuestionItems(ctx)[0]!, /question_stale/);
    assert.equal(ctx.questions.length, 0);
  });

  it('第二个/就这个只解析携带questionId的那道问题，不按全thread最新问题猜目标', () => {
    const ctx = context();
    const first = toTargetCandidate('supportCase', support('相同标题'), COMPANY)!;
    const second = toTargetCandidate('supportCase', support('相同标题'), COMPANY)!;
    registerCandidates(ctx, [{ status: 'ok', candidates: [first, second] }]);
    const q = createAgentQuestion(ctx, { question: '选择哪条？', targetOptions: [
      { label: '相同标题', candidateHandle: first.handle }, { label: '相同标题', candidateHandle: second.handle },
    ], recommendedIndex: 0 });
    assert.equal(resolveQuestionOption(q, undefined, '第二个')!.target!.id, second.target.id);
    assert.equal(resolveQuestionOption(q, undefined, '就这个')!.target!.id, first.target.id);
    assert.equal(resolveQuestionOption(q, undefined, '相同标题'), undefined, '重复标签不能转成唯一UUID');
    assert.equal(resolveQuestionOption({ ...q, recommendedOptionId: undefined }, undefined, '就这个'), undefined);
    assert.equal(resolveQuestionOption(q, undefined, '第二个，但是别改状态'), undefined, '带额外业务条件不能当作纯选项直接落提案');
  });

  it('fingerprint忽略展示/改字提示，业务正文、客户及目标变化都会失效', () => {
    const base = { summary: '待确认', details: '故障详情', recordType: 'support', companyCode: 'EXAMPLE' };
    assert.equal(proposalFingerprint(base), proposalFingerprint({ ...base, corrections: [{ heard: 'a', corrected: 'b' }], companySuggestion: { name: 'X' } }));
    assert.equal(proposalFingerprint(base), proposalFingerprint(Object.fromEntries(Object.entries(base).reverse())));
    assert.notEqual(proposalFingerprint(base), proposalFingerprint({ ...base, details: '新详情' }));
    assert.notEqual(proposalFingerprint(base, COMPANY), proposalFingerprint(base, randomUUID()));
    assert.notEqual(proposalFingerprint(base), proposalFingerprint({ ...base, targetBinding: { id: randomUUID() } }));
  });
});
