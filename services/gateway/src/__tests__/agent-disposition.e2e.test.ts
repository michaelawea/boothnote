import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { sql } from '../db.ts';
import { hashPassword } from '../auth.ts';
import { listProposalItems, proposeRecords } from '../proposal-items.ts';
import { createAgentQuestion, persistAgentReply, loadLegacyDispositionSource } from '../questions.ts';
import { readPendingCandidates } from '../targetCandidates.ts';
import { newContext } from '../../agent/src/tools/context.ts';
import { readSkills } from '../../agent/src/tools/read.ts';
import { recordSkills } from '../../agent/src/tools/records.ts';
import { writeSkills } from '../../agent/src/tools/write.ts';
import type { QuestionSnapshot } from '../../../../shared/agent-questions.mjs';

/** Real transactions and gateway reads with an isolated FAKE CRM; no model calls.
 * The safety checks deliberately reject ordinary dev or production selectors.
 * Run through scripts/test-isolated-agent.py only.
 */
const BASE = process.env.GATEWAY_URL ?? '';
const CRM = process.env.FIXTURE_TWENTY_URL ?? '';
const local = (url: string) => /^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/.test(url);
if (!local(BASE) || !local(CRM) || !/@(?:localhost|127\.0\.0\.1):\d+\//.test(process.env.APP_DATABASE_URL ?? '')) {
  throw new Error('agent-disposition E2E requires the isolated local gateway/database/FAKE Twenty runner');
}
const probe = await fetch(`${CRM}/healthz`).then((response) => response.json()) as { realTwenty: boolean };
assert.equal(probe.realTwenty, false, 'never seed or reset a real CRM');

type Batch = { threadId: string; inboxId: string; stagingId: string; text: string };
type Reply = { id: string; text: string; meta: { questions: unknown[]; stagingId: string; questionWarning?: string } };
const company = { id: randomUUID(), code: 'REPLYFIXTURE', name: 'Example Caravan Reply' };
const userId = randomUUID();
let token = '';

const call = async (path: string, method = 'GET', body?: unknown, auth = token) => {
  const response = await fetch(`${BASE}${path}`, {
    method, headers: { Authorization: `Bearer ${auth}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json() as any };
};
const batch = async (text: string, existingThreadId?: string, detached = false): Promise<Batch> => {
  let threadId = existingThreadId;
  if (!threadId) {
    const created = await call('/threads', 'POST', { title: text });
    assert.equal(created.status, 201);
    threadId = created.json.id;
  }
  assert.ok(threadId);
  const [inbox] = await sql<Array<{ id: string }>>`insert into inbox(client_id,user_id,thread_id,text,source)
    values(${randomUUID()},${userId},${detached ? null : threadId},${text},'note') returning id`;
  const [staging] = await sql<Array<{ id: string }>>`insert into staging(inbox_id,thread_id,status,extracted,resolved_company_id)
    values(${inbox!.id},${threadId},'ready',${sql.json({ recordType: 'support', companyCode: company.code, summary: text })},${company.id}) returning id`;
  await sql`insert into thread_message(thread_id,role,text,inbox_id)
    values(${threadId},'user',${text},${inbox!.id})`;
  return { threadId, inboxId: inbox!.id, stagingId: staging!.id, text };
};
const context = (source: Batch) => newContext({
  inboxId: source.inboxId, stagingId: source.stagingId, threadId: source.threadId,
  userId, userCode: 'reply-fixture', displayName: 'Reply Fixture',
  companies: [{ ...company, group: '', type: 'OEM_BRAND' }],
  suppliers: [], attachments: [], maxSteps: 8, pushPlaybooks: [], resumed: false, source: 'pwa',
});
const proposalInput = (source: Batch, count: number) => ({
  stagingId: source.stagingId, inboxId: source.inboxId, threadId: source.threadId, userId,
  records: Array.from({ length: count }, (_, index) => ({
    key: `reply-item-${index}`, recordType: 'support', companyCode: company.code,
    fields: { summary: `${source.text} ${index + 1}`, details: `Fictional independent fault ${index + 1}` },
  })),
});
const replies = (source: Batch) => sql<Reply[]>`select id,text,meta from thread_message
  where thread_id=${source.threadId} and inbox_id=${source.inboxId} and role='agent' order by created_at,id`;
const questions = (source: Batch) => sql<Array<{ id: string; source_message_id: string; item_id: string | null; snapshot: any }>>`
  select id,source_message_id,item_id,snapshot from agent_question where staging_id=${source.stagingId}`;
const staging = async (id: string) => {
  const [row] = await sql<Array<{ status: string; extracted: Record<string, any>; resolved_company_id: string | null; superseded_by: string | null }>>`
    select status,extracted,resolved_company_id,superseded_by from staging where id=${id}`;
  assert.ok(row);
  return row;
};
const dispositionFixture = async (label: string, detachedVoice = false) => {
  const original = await batch(`${label}: original legacy fault`);
  const originalFields = { recordType: 'support', companyCode: company.code,
    summary: `${label}: original fault`, details: 'Exact original legacy investigation.',
    modelName: 'Fixture Battery', caseStatus: 'IN_PROGRESS', severity: 'CRITICAL', affectedUnits: 18,
    chain: [{ name: 'Example Channel', role: 'DEALER' }], corrections: [{ heard: 'Example Cars', corrected: 'Example Caravan' }] };
  await sql`update staging set extracted=${sql.json(originalFields)} where id=${original.stagingId}`;
  const sibling = await batch(`${label}: independent sibling fault`, original.threadId);
  const source = await batch(detachedVoice ? '' : `${label}: a new note whose relationship is still ambiguous`, original.threadId, detachedVoice);
  if (detachedVoice) await sql`update staging set transcript='Two new independent fictional faults.' where id=${source.stagingId}`;
  await sql`update staging set status='extracting',extracted=${sql.json({ ...originalFields, legacyDispositionRequired: true })} where id=${source.stagingId}`;
  const beforeOriginal = await staging(original.stagingId);
  const beforeSibling = await staging(sibling.stagingId);
  const ctx = context(source);
  ctx.inheritedLegacyStagingId = original.stagingId;
  const candidates = await readPendingCandidates(company.id, company.code, userId, source.stagingId);
  assert.equal(candidates.status, 'ok');
  const exact = candidates.candidates.find((candidate) => candidate.target.id === original.stagingId);
  assert.ok(exact);
  ctx.targetCandidates!.set(exact.handle, exact);
  createAgentQuestion(ctx, { question: 'Continue this exact draft or keep this note independent?', targetOptions: [
    { label: 'Continue the exact original legacy fault', candidateHandle: exact.handle },
    { label: 'Create independent business items from this new note', action: 'create' },
  ] });
  assert.equal((await sql.begin((tx) => persistAgentReply(ctx,
    { text: 'Select the relationship before proposing new items.', fallbackText: 'Retain the existing draft.', partial: false }, tx))).questionFailed, false);
  const [stored] = await questions(source);
  assert.ok(stored);
  const question = stored.snapshot as QuestionSnapshot;
  assert.equal(question.purpose, 'legacy_disposition');
  assert.equal(question.legacyStagingId, original.stagingId);
  return { original, sibling, source, beforeOriginal, beforeSibling, question };
};
const answer = (source: Batch, question: QuestionSnapshot, optionId: string, clientId: string) =>
  call(`/threads/${source.threadId}/questions/${question.questionId}/answers`, 'POST', {
    clientId, expectedRevision: question.expectedRevision, optionId,
  });

before(async () => {
  const seeded = await fetch(`${CRM}/__fixture/reset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tables: {
      companies: [{ id: company.id, accountCode: company.code, name: company.name, accountType: 'OEM_BRAND', country: 'DE' }],
    } }),
  });
  assert.equal(seeded.ok, true);
  const passwordHash = await hashPassword('isolated-reply-password');
  await sql`insert into app_user(id,user_code,display_name,password_hash,role,is_active,locale)
    values(${userId},'reply-fixture','Reply Fixture',${passwordHash},'staff',true,'zh')`;
  const login = await call('/auth/login', 'POST', { userCode: 'reply-fixture', password: 'isolated-reply-password' }, '');
  assert.equal(login.status, 200);
  token = login.json.token;
});
after(async () => { await sql.end({ timeout: 5 }); });

describe('agent reply and question persistence · actual PostgreSQL savepoints', () => {
  it('a question without an item is isolated from the reply and two already saved items', async () => {
    const source = await batch('Two faults asked before proposing');
    const ctx = context(source);
    createAgentQuestion(ctx, { question: 'Which fault should be investigated?', options: ['Need more detail'] });
    const text = 'Both independent faults have been saved for review.';
    const result = await sql.begin(async (tx) => {
      await proposeRecords(proposalInput(source, 2), tx);
      return persistAgentReply(ctx, { text, fallbackText: text, partial: false }, tx);
    });
    assert.equal(result.questionFailed, true);
    assert.deepEqual(ctx.questions, []);
    const stored = await replies(source);
    assert.equal(stored.length, 1, 'the failed savepoint must not leave a duplicate assistant reply');
    assert.ok(stored[0]!.text.includes(text), 'a question validation failure cannot erase the ordinary reply');
    assert.deepEqual(stored[0]!.meta.questions, []);
    assert.equal(stored[0]!.meta.questionWarning, 'question_item_required');
    assert.equal((await questions(source)).length, 0);
    const items = await listProposalItems(source.stagingId);
    assert.equal(items.length, 2, 'the outer transaction must retain the business items');
    assert.ok(items.every((item) => item.status === 'ready'));
    const hydrated = await call(`/threads/${source.threadId}`);
    assert.equal(hydrated.status, 200);
    const visible = hydrated.json.messages.find((message: any) => message.id === stored[0]!.id);
    assert.equal(visible.proposal_items.length, 2, 'saved items must remain visible on the persisted reply');
    assert.deepEqual(visible.meta.questions, []);
  });

  it('a valid item-bound question is stored exactly once with its normal reply', async () => {
    const source = await batch('One precisely bound fault');
    const ctx = context(source);
    const [item] = await proposeRecords(proposalInput(source, 1));
    assert.ok(item);
    ctx.proposedItems = [item];
    const question = createAgentQuestion(ctx, { question: 'Create a separate case or provide more detail?', itemId: item.itemId,
      targetOptions: [{ label: 'Create separate case', action: 'create' }, { label: 'More detail', action: 'clarify' }] });
    const text = 'The independent fault is ready. Confirm the next action.';
    const result = await sql.begin((tx) => persistAgentReply(ctx, { text, fallbackText: 'Unused fallback', partial: false }, tx));
    assert.equal(result.questionFailed, false);
    const stored = await replies(source);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.text, text);
    assert.equal(stored[0]!.meta.questionWarning, undefined);
    assert.equal(stored[0]!.meta.questions.length, 1);
    const durable = await questions(source);
    assert.equal(durable.length, 1);
    assert.equal(durable[0]!.id, question.questionId);
    assert.equal(durable[0]!.source_message_id, stored[0]!.id);
    assert.equal(durable[0]!.item_id, item.itemId);
    assert.equal(durable[0]!.snapshot.expectedRevision, item.revisionId);
    const hydrated = await call(`/threads/${source.threadId}`);
    assert.equal(hydrated.status, 200);
    const visible = hydrated.json.messages.find((message: any) => message.id === stored[0]!.id);
    assert.equal(visible.meta.questions[0].status, 'pending');
    assert.equal(visible.meta.questions[0].questionId, question.questionId);
  });

  it('a database foreign-key failure remains an error and does not become a successful fallback reply', async () => {
    const source = await batch('Missing immutable input reference');
    const ctx = context(source);
    ctx.inboxId = randomUUID();
    createAgentQuestion(ctx, { question: 'Clarify the fault?', options: ['Provide detail'] });
    await assert.rejects(() => sql.begin((tx) => persistAgentReply(ctx,
      { text: 'Must not persist', fallbackText: 'Must not downgrade a DB error', partial: false }, tx)),
    (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === '23503');
    assert.equal((await sql`select id from thread_message where thread_id=${source.threadId} and role='agent'`).length, 0);
    assert.equal((await questions(source)).length, 0);
    assert.equal(ctx.questions.length, 1, 'the database failure must not be misrepresented as a handled question error');
  });
});

describe('legacy draft disposition · exact identities and independent new input', () => {
  it('a source awaiting the user relationship choice cannot be queued by either confirmation endpoint', async () => {
    const { source } = await dispositionFixture('No-premature-confirm fixture');
    const single = await call(`/staging/${source.stagingId}/confirm`, 'POST', { companyId: company.id });
    assert.equal(single.status, 409);
    assert.equal(single.json.error, 'legacy_disposition_required');
    const bulk = await call('/staging/confirm-batch', 'POST', { items: [{ id: source.stagingId, companyId: company.id }] });
    assert.equal(bulk.status, 200);
    assert.deepEqual(bulk.json.results, [{ id: source.stagingId, ok: false, reason: 'legacy_disposition_required' }]);
    assert.equal((await staging(source.stagingId)).status, 'extracting');
  });
  it('create preserves both old cards and clears inherited customer and business fields from the new answer', async () => {
    const { original, sibling, source, beforeOriginal, beforeSibling, question } = await dispositionFixture('Independent-create fixture');
    const choice = question.choices!.find((option) => option.action === 'create');
    assert.ok(choice);
    const clientId = randomUUID();
    const accepted = await answer(source, question, choice.optionId, clientId);
    assert.equal(accepted.status, 201);
    assert.equal(accepted.json.requiresAgent, true, 'the new note must be extracted rather than submitting copied old facts');
    assert.deepEqual(await staging(original.stagingId), beforeOriginal, 'the precise old card remains independently confirmable');
    assert.deepEqual(await staging(sibling.stagingId), beforeSibling, 'another old card is not consumed by this decision');
    const consumedSource = await staging(source.stagingId);
    assert.equal(consumedSource.status, 'superseded');
    assert.equal(consumedSource.superseded_by, accepted.json.stagingId);
    const fresh = await staging(accepted.json.stagingId);
    assert.equal(fresh.status, 'pending');
    assert.equal(fresh.resolved_company_id, null);
    assert.deepEqual(fresh.extracted, {
      answeredQuestionId: question.questionId,
      answerToQuestion: { stagingId: source.stagingId, action: 'create', purpose: 'legacy_disposition', legacyStagingId: original.stagingId },
    });
    const [newInput] = await sql<Array<{ company_code: string | null; thread_id: string }>>`
      select company_code,thread_id from inbox where id=${accepted.json.inboxId}`;
    assert.ok(newInput);
    assert.equal(newInput.company_code, null, 'immutable new input cannot inherit the old customer binding');
    assert.equal(newInput.thread_id, original.threadId);
    const replay = await answer(source, question, choice.optionId, clientId);
    assert.equal(replay.status, 200);
    assert.equal(replay.json.stagingId, accepted.json.stagingId);
    assert.deepEqual(await staging(original.stagingId), beforeOriginal);
  });

  it('continue consumes only the precise original and extracting question source, retaining an independent sibling', async () => {
    const { original, sibling, source, beforeOriginal, beforeSibling, question } = await dispositionFixture('Exact-continue fixture');
    const choice = question.choices!.find((option) => option.action === 'continue');
    assert.ok(choice);
    assert.equal(choice.target!.id, original.stagingId);
    const accepted = await answer(source, question, choice.optionId, randomUUID());
    assert.equal(accepted.status, 201);
    assert.equal(accepted.json.requiresAgent, true, 'the current note still needs extraction after the relationship decision');
    for (const consumed of [original, source]) {
      const row = await staging(consumed.stagingId);
      assert.equal(row.status, 'superseded');
      assert.equal(row.superseded_by, accepted.json.stagingId);
    }
    assert.deepEqual(await staging(sibling.stagingId), beforeSibling);
    const continued = await staging(accepted.json.stagingId);
    assert.equal(continued.status, 'pending');
    assert.equal(continued.resolved_company_id, company.id);
    assert.equal(continued.extracted.summary, beforeOriginal.extracted.summary);
    assert.equal(continued.extracted.details, beforeOriginal.extracted.details);
    assert.equal(continued.extracted.targetBinding, undefined, 'the consumed staging identity is not a CRM write target');
    assert.equal(continued.extracted.legacyDispositionRequired, undefined, 'the accepted choice releases the boundary on the new draft');
    assert.deepEqual(continued.extracted.answerToQuestion, {
      stagingId: source.stagingId, action: 'continue', purpose: 'legacy_disposition', legacyStagingId: original.stagingId,
    });
    assert.equal((await listProposalItems(original.stagingId)).length, 0);
    assert.equal((await listProposalItems(accepted.json.stagingId)).length, 0, 'no item or CRM write should be invented during the relationship decision');
    const recovered = await loadLegacyDispositionSource({ stagingId: accepted.json.stagingId, userId, threadId: source.threadId });
    assert.equal(recovered?.action, 'continue');
    const ctx = context({ ...source, stagingId: accepted.json.stagingId, inboxId: accepted.json.inboxId });
    ctx.continuedLegacyStagingId = recovered!.legacyStagingId;
    const multi = await recordSkills(ctx)[0]!.execute({ records: [{ key: 'new', recordType: 'support', fields: { summary: 'Only new progress' } }] });
    assert.match(multi.text, /legacy_continue_requires_fields/);
    assert.equal((await listProposalItems(accepted.json.stagingId)).length, 0);
    const legacy = writeSkills(ctx).find((skill) => skill.name === 'propose_fields')!;
    await legacy.execute({ summary: 'New progress summary', details: 'New verified investigation progress.' });
    const patched = await staging(accepted.json.stagingId);
    assert.equal(patched.extracted.recordType, 'support');
    assert.equal(patched.extracted.companyCode, company.code);
    for (const field of ['modelName', 'caseStatus', 'severity', 'affectedUnits', 'chain', 'corrections']) {
      assert.deepEqual(patched.extracted[field], beforeOriginal.extracted[field], `omitted ${field} must retain the exact legacy basis`);
    }
    assert.match(patched.extracted.details, /Exact original legacy investigation/);
    assert.match(patched.extracted.details, /New verified investigation progress/);
    assert.deepEqual(await staging(sibling.stagingId), beforeSibling);
  });
});


it('durable disposition restores a later-attached voice source, keeps its evidence, and rejects foreign source access', async () => {
  const {source,original,question}=await dispositionFixture('Detached-voice-source fixture',true);
  const choice=question.choices!.find((option)=>option.action==='create')!;
  const accepted=await answer(source,question,choice.optionId,randomUUID());
  assert.equal(accepted.status,201);
  const input={stagingId:accepted.json.stagingId,userId,threadId:source.threadId};
  const recovered=await loadLegacyDispositionSource(input);
  assert.deepEqual(recovered,{action:'create',inboxId:source.inboxId,legacyStagingId:original.stagingId,text:'Two new independent fictional faults.'});
  assert.equal(await loadLegacyDispositionSource({...input,userId:randomUUID()}),null);
  assert.equal(await loadLegacyDispositionSource({...input,threadId:randomUUID()}),null);
  const ctx=context({...source,stagingId:accepted.json.stagingId,inboxId:accepted.json.inboxId});
  ctx.relatedInboxIds=[recovered!.inboxId];
  ctx.dispositionSourceInboxId=recovered!.inboxId;
  const [attachment]=await sql<Array<{id:string}>>`insert into attachment(inbox_id,kind,filename,mime,bytes,path)
    values(${source.inboxId},'file','source-evidence.txt','text/plain',20,'isolated-fixture-unused.txt') returning id`;
  await sql`insert into attachment_text(attachment_id,status,text) values(${attachment!.id},'ready','Original source attachment evidence.')`;
  const reader=readSkills(ctx).find((skill)=>skill.name==='read_attachment')!;
  assert.match((await reader.execute({attachment_id:attachment!.id})).text,/Original source attachment evidence/);
  const wrongOwner=readSkills({...ctx,userId:randomUUID()}).find((skill)=>skill.name==='read_attachment')!;
  assert.match((await wrongOwner.execute({attachment_id:attachment!.id})).text,/不属于这条速记/);
  const proposer=recordSkills(ctx)[0]!;
  await proposer.execute({records:[{key:'new-fault',recordType:'support',companyCode:company.code,fields:{summary:'A distinct new fictional fault'}}]});
  const [item]=await listProposalItems(accepted.json.stagingId);
  assert.ok(item);
  assert.deepEqual(new Set(item.evidenceRefs.map((entry)=>entry.inboxId)),new Set([accepted.json.inboxId,source.inboxId]));
});

it('a later-attached source may be proposed but evidence still excludes another thread and another user', async () => {
  const own = await batch('Own later-attached voice source', undefined, true);
  const sameThread = await batch('Earlier evidence in this exact thread', own.threadId, true);
  const otherThread = await batch('Independent evidence from another thread');
  const input = { stagingId: own.stagingId, inboxId: own.inboxId, threadId: own.threadId, userId };
  const entry = { key: 'detached-case', recordType: 'support', companyCode: company.code, fields: { summary: 'Own fictional fault' } };
  const accepted = await proposeRecords({ ...input, records: [{ ...entry, evidenceRefs: [{ inboxId: sameThread.inboxId }] }] });
  assert.equal(accepted.length, 1);
  await assert.rejects(proposeRecords({ ...input, records: [{ ...entry, key: 'wrong-thread', evidenceRefs: [{ inboxId: otherThread.inboxId }] }] }),
    (error: any) => error.code === 'invalid_evidence_source' && error.status === 422);
  const foreignUser = randomUUID();
  await sql`insert into app_user(id,user_code,display_name,password_hash,role,is_active)
    values(${foreignUser},${'foreign-'+foreignUser.slice(0,8)},'Foreign Fixture','not-a-login-hash','staff',true)`;
  const [foreignInput] = await sql<Array<{ id: string }>>`insert into inbox(client_id,user_id,text,source)
    values(${randomUUID()},${foreignUser},'Foreign source is never evidence','note') returning id`;
  await assert.rejects(proposeRecords({ ...input, records: [{ ...entry, key: 'wrong-user-evidence', evidenceRefs: [{ inboxId: foreignInput!.id }] }] }),
    (error: any) => error.code === 'invalid_evidence_source' && error.status === 422);
  await assert.rejects(proposeRecords({ ...input, userId: foreignUser, records: [entry] }),
    (error: any) => error.code === 'proposal_batch_not_found' && error.status === 404);
  assert.equal((await listProposalItems(own.stagingId)).length, 1, 'rejected references create no sibling identities');
});
