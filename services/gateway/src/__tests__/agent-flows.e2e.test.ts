import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { sql } from '../db.ts';
import { hashPassword } from '../auth.ts';
import { proposeRecords, listProposalItems, recoverInterruptedProposalItems, recoverProposalItem } from '../proposal-items.ts';
import { resolveUnknownItemOperation } from '../item-operations.ts';
import { acquireCommitWorkerLease } from '../commitWorkerLease.ts';
import { createAgentQuestion, persistAgentQuestions } from '../questions.ts';
import { readCrmCandidates, readPendingCandidates } from '../targetCandidates.ts';
import { newContext } from '../../agent/src/tools/context.ts';
import type { QuestionSnapshot } from '../../../../shared/agent-questions.mjs';

/** Real gateway HTTP + migrated Postgres + FAKE Twenty REST; no model calls.
 * Run only via scripts/test-isolated-agent.py. The fixture proves our state and
 * request handling; it does not prove Twenty schema, idempotency or deployment.
 * Agent proposals/questions are injected through the actual domain services so
 * these tests are deterministic and cannot quietly skip without credentials.
 */
const BASE = process.env.GATEWAY_URL ?? '';
const CRM = process.env.FIXTURE_TWENTY_URL ?? '';
const local = (url: string) => /^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/.test(url);
if (!local(BASE) || !local(CRM) || !/@(?:localhost|127\.0\.0\.1):\d+\//.test(process.env.APP_DATABASE_URL ?? '')) {
  throw new Error('agent-flows E2E requires the isolated local gateway/database/FAKE Twenty runner');
}
const probe = await fetch(`${CRM}/healthz`).then((response) => response.json()) as { realTwenty: boolean };
assert.equal(probe.realTwenty, false, 'never run fixture seed/reset against a real CRM');

type Audit = { method: string; path: string; body: any; status: number; resultId?: string; applied?: boolean; responseDropped?: boolean };
type FixtureState = { tables: Record<string, Record<string, any>>; audit: Audit[] };
type Batch = { threadId: string; inboxId: string; stagingId: string; text: string };
const companyA = { id: randomUUID(), code: 'FIXTUREA', name: 'Example Caravan Alpha' };
const companyB = { id: randomUUID(), code: 'FIXTUREB', name: 'Example Caravan Beta' };
const oldCaseId = randomUUID();
const otherCaseId = randomUUID();
const userId = randomUUID();
const otherUserId = randomUUID();
const contributorId = randomUUID();
let token = '';
let otherToken = '';

const fixture = async (path: string, method = 'GET', body?: unknown): Promise<any> => {
  const response = await fetch(`${CRM}${path}`, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const json = await response.json();
  assert.equal(response.ok, true, `fixture ${method} ${path}: ${JSON.stringify(json)}`);
  return json;
};
const state = (): Promise<FixtureState> => fixture('/__fixture/state');
const call = async (path: string, method = 'GET', body?: unknown, auth = token) => {
  const response = await fetch(`${BASE}${path}`, {
    method, headers: { Authorization: `Bearer ${auth}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json() as any };
};
const eventually = async <T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string, timeoutMs = 15_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let value: T;
  do {
    value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`${label} did not settle: ${JSON.stringify(value!)}`);
};
const batch = async (text: string, extracted: Record<string, unknown> = {}): Promise<Batch> => {
  const created = await call('/threads', 'POST', { title: text });
  assert.equal(created.status, 201);
  const threadId: string = created.json.id;
  const [inbox] = await sql<Array<{ id: string }>>`insert into inbox(client_id,user_id,thread_id,text,source)
    values(${randomUUID()},${userId},${threadId},${text},'note') returning id`;
  const [staging] = await sql<Array<{ id: string }>>`insert into staging(inbox_id,thread_id,status,extracted,resolved_company_id)
    values(${inbox!.id},${threadId},'ready',${sql.json(extracted as never)},${companyA.id}) returning id`;
  await sql`insert into thread_message(thread_id,role,text,inbox_id)
    values(${threadId},'user',${text},${inbox!.id})`;
  return { threadId, inboxId: inbox!.id, stagingId: staging!.id, text };
};
const proposal = async (source: Batch, label: string, count: number, code = companyA.code) => {
  const records = Array.from({ length: count }, (_, index) => ({
    key: `${label}:${index}`, recordType: 'support', companyCode: code, action: 'create' as const,
    fields: { summary: label, details: `${label}: independently tracked defect`, modelName: 'Fixture DC-DC', caseStatus: 'NEW', severity: 'MEDIUM' },
  }));
  const input = { stagingId: source.stagingId, inboxId: source.inboxId, threadId: source.threadId, userId, records };
  return { input, items: await proposeRecords(input) };
};
const confirm = (source: Batch, items: Array<{ itemId: string; revision: number }>) =>
  call(`/staging/${source.stagingId}/items/confirm`, 'POST', { items: items.map(({ itemId, revision }) => ({ itemId, revision })) });
const waitItems = (source: Batch, accept: (items: Awaited<ReturnType<typeof listProposalItems>>) => boolean) =>
  eventually(() => listProposalItems(source.stagingId), accept, source.text);
const casesNamed = (snapshot: FixtureState, name: string) => Object.values(snapshot.tables.supportCases!).filter((record) => record.name === name);
const successfulCaseCreates = (snapshot: FixtureState, name: string) =>
  snapshot.audit.filter((entry) => entry.method === 'POST' && entry.path === '/rest/supportCases' && entry.body.name === name && entry.applied);
const sendOfflineNote = async (clientThreadId: string, clientId: string, text: string, auth = token) => {
  const form = new FormData();
  form.append('payload', JSON.stringify({ clientThreadId, clientId, text, toAgent: true }));
  const response = await fetch(`${BASE}/inbox`, { method: 'POST', headers: { Authorization: `Bearer ${auth}` }, body: form });
  return { status: response.status, json: await response.json() as any };
};

before(async () => {
  await fixture('/__fixture/reset', 'POST', { tables: {
    companies: [companyA, companyB].map((company) => ({ id: company.id, accountCode: company.code, name: company.name, accountType: 'OEM_BRAND', country: 'DE' })),
    contributors: [{ id: contributorId, userCode: 'fixture-operator', name: 'Fixture Operator', contributorType: 'INTERNAL', isActive: true }],
    supportCases: [
      { id: oldCaseId, name: 'Old DC-DC charging case', companyId: companyA.id, caseStatus: 'NEW', severity: 'MEDIUM', issueDescription: { markdown: 'Original investigation: do not overwrite.' } },
      { id: otherCaseId, name: 'Other account case', companyId: companyB.id, caseStatus: 'NEW', severity: 'MEDIUM', issueDescription: { markdown: 'Different account: do not write here.' } },
    ],
  } });
  const passwordHash = await hashPassword('isolated-fixture-password');
  await sql`insert into app_user(id,user_code,display_name,password_hash,role,is_active,locale)
    values(${userId},'fixture-operator','Fixture Operator',${passwordHash},'staff',true,'zh'),
      (${otherUserId},'fixture-other','Fixture Other',${passwordHash},'staff',true,'en')`;
  const login = await call('/auth/login', 'POST', { userCode: 'fixture-operator', password: 'isolated-fixture-password' }, '');
  assert.equal(login.status, 200);
  token = login.json.token;
  const otherLogin = await call('/auth/login', 'POST', { userCode: 'fixture-other', password: 'isolated-fixture-password' }, '');
  assert.equal(otherLogin.status, 200);
  otherToken = otherLogin.json.token;
});
after(async () => { await sql.end({ timeout: 5 }); });

describe('isolated agent flows (#64/#65) · real HTTP/PG with FAKE CRM', () => {
  it('concurrent stable client thread IDs reuse one own thread, stay user-scoped and cannot restore deletion', async () => {
    const clientThreadId = randomUUID();
    const [first, second] = await Promise.all([
      call('/threads', 'POST', { clientThreadId, title: 'Offline shared identity' }),
      call('/threads', 'POST', { clientThreadId, title: 'Same retry identity' }),
    ]);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(first.json.id, second.json.id);
    const anotherOwner = await call('/threads', 'POST', { clientThreadId, title: 'Other user local identity' }, otherToken);
    assert.equal(anotherOwner.status, 201);
    assert.notEqual(anotherOwner.json.id, first.json.id);
    assert.equal((await call(`/threads/${first.json.id}`, 'GET', undefined, otherToken)).status, 404);
    assert.equal((await call(`/threads/${first.json.id}`, 'DELETE')).status, 200);
    const deletedReplay = await call('/threads', 'POST', { clientThreadId, title: 'Retry after deletion' });
    assert.equal(deletedReplay.status, 409);
    const deletedNote = await sendOfflineNote(clientThreadId, randomUUID(), 'Must not resurrect the deleted thread');
    assert.equal(deletedNote.status, 409);
    const [persisted] = await sql<Array<{ deleted_at: Date | null }>>`select deleted_at from thread where id=${first.json.id}`;
    assert.ok(persisted?.deleted_at);
  });

  it('two offline notes share one thread and expose stable client acknowledgements; replay adds no extra user message', async () => {
    const clientThreadId = randomUUID();
    const firstClient = randomUUID();
    const secondClient = randomUUID();
    const [first, second] = await Promise.all([
      sendOfflineNote(clientThreadId, firstClient, 'Offline note one'),
      sendOfflineNote(clientThreadId, secondClient, 'Offline note two'),
    ]);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(first.json.threadId, second.json.threadId);
    const replay = await sendOfflineNote(clientThreadId, firstClient, 'Offline note one');
    assert.equal(replay.status, 200);
    assert.equal(replay.json.inboxId, first.json.inboxId);
    const projected = await call(`/threads/${first.json.threadId}`);
    const originals = projected.json.messages.filter((message: any) => message.role === 'user');
    assert.equal(originals.length, 2);
    assert.deepEqual(new Set(originals.map((message: any) => message.client_id)), new Set([firstClient, secondClient]));
    const foreignReplay = await sendOfflineNote(clientThreadId, firstClient, 'Foreign collision', otherToken);
    assert.equal(foreignReplay.status, 409);
  });

  it('fixture explicitly separates lost replies from unapplied failures and rejects unsupported filters', async () => {
    const invalid = await fetch(`${CRM}/rest/supportCases?filter=${encodeURIComponent('companyId[eq]:x,unsupported')}`);
    assert.equal(invalid.status, 400);
    const rejectedSeed = await fetch(`${CRM}/__fixture/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tables: { unknownTable: [] } }) });
    assert.equal(rejectedSeed.status, 400);
    assert.ok((await state()).tables.supportCases![oldCaseId], 'bad seed must not partly erase prior records');
    await fixture('/__fixture/fail', 'POST', { method: 'POST', path: '/rest/supportCases', dropAfterWrite: true });
    await assert.rejects(fetch(`${CRM}/rest/supportCases`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'fixture-lost-reply-check', companyId: companyB.id, issueDescription: { markdown: 'fixture only' } }) }));
    const snapshot = await state();
    const [applied] = casesNamed(snapshot, 'fixture-lost-reply-check');
    assert.ok(applied);
    assert.equal(successfulCaseCreates(snapshot, 'fixture-lost-reply-check').length, 1);
    assert.equal(snapshot.audit.at(-1)?.responseDropped, true);
    await fixture(`/rest/supportCases/${applied.id}`, 'DELETE');
  });

  it('three equal-field matters retain distinct identity; per-item confirmation creates exactly three fixture cases', async () => {
    const source = await batch('three distinct defects from one immutable input');
    const { input, items } = await proposal(source, 'three-item-fixture', 3);
    assert.equal(new Set(items.map((item) => item.itemId)).size, 3);
    assert.deepEqual(items.map((item) => item.fields), [items[0]!.fields, items[0]!.fields, items[0]!.fields]);
    const replay = await proposeRecords(input);
    assert.deepEqual(replay.map((item) => item.itemId), items.map((item) => item.itemId), 'same tool proposal keys do not create a fourth item');
    const projected = await call(`/staging/${source.stagingId}/items`);
    assert.equal(projected.status, 200);
    assert.equal(projected.json.summary.total, 3);
    assert.equal(projected.json.summary.confirmed, 0);
    const legacy = await call(`/staging/${source.stagingId}/confirm`, 'POST', { companyId: companyA.id });
    assert.equal(legacy.status, 409, 'a legacy client must not silently confirm an entire multi-item batch');
    assert.equal((await confirm(source, items.slice(0, 2))).status, 200);
    let persisted = await waitItems(source, (rows) => rows.filter((item) => item.status === 'confirmed').length === 2);
    assert.equal(persisted.find((item) => item.itemId === items[2]!.itemId)?.status, 'ready');
    assert.equal(casesNamed(await state(), 'three-item-fixture').length, 2);
    assert.equal((await confirm(source, [items[2]!])).status, 200);
    persisted = await waitItems(source, (rows) => rows.every((item) => item.status === 'confirmed'));
    assert.equal(new Set(persisted.map((item) => item.twentyRefs?.supportCaseId)).size, 3);
    assert.equal(casesNamed(await state(), 'three-item-fixture').length, 3);
    const [original] = await sql<Array<{ text: string }>>`select text from inbox where id=${source.inboxId}`;
    assert.equal(original!.text, source.text);
  });

  it('lost reply in one matter does not rebuild completed siblings; unknown cannot be blindly confirmed again', async () => {
    const source = await batch('partial progress with an uncertain remote outcome');
    const { items } = await proposal(source, 'partial-item-fixture', 3);
    assert.equal((await confirm(source, [items[0]!])).status, 200);
    await waitItems(source, (rows) => rows.find((item) => item.itemId === items[0]!.itemId)?.status === 'confirmed');
    const firstId = (await listProposalItems(source.stagingId)).find((item) => item.itemId === items[0]!.itemId)!.twentyRefs?.supportCaseId;
    await fixture('/__fixture/fail', 'POST', { method: 'POST', path: '/rest/supportCases', dropAfterWrite: true, times: 1 });
    assert.equal((await confirm(source, items.slice(1))).status, 200);
    const persisted = await waitItems(source, (rows) => rows.filter((item) => item.status === 'confirmed').length === 2 && rows.some((item) => item.status === 'unknown'));
    const unknown = persisted.find((item) => item.status === 'unknown')!;
    assert.equal(persisted.find((item) => item.itemId === items[0]!.itemId)?.twentyRefs?.supportCaseId, firstId);
    const beforeRetry = await state();
    assert.equal(casesNamed(beforeRetry, 'partial-item-fixture').length, 3, 'lost response really did leave a remote record');
    assert.equal(successfulCaseCreates(beforeRetry, 'partial-item-fixture').length, 3);
    const retry = await confirm(source, [unknown]);
    assert.equal(retry.status, 409);
    const [operation] = await sql<Array<{ state: string }>>`select state from item_operation where revision_id=${unknown.revisionId} and state='unknown'`;
    assert.equal(operation?.state, 'unknown');
    assert.equal((await call(`/staging/${source.stagingId}/items`)).json.summary.status, 'unknown');
    assert.equal(successfulCaseCreates(await state(), 'partial-item-fixture').length, 3);
  });

  it('an audited successful append that closed a case can finish its receipt without appending or reopening again', async () => {
    const caseId = randomUUID();
    await fixture('/rest/supportCases', 'POST', { id: caseId, name: 'Fixture case to close',
      companyId: companyA.id, caseStatus: 'NEW', issueDescription: { markdown: 'Original closing investigation.' } });
    const source = await batch('Known successful close with a lost response');
    const items = await proposeRecords({ stagingId: source.stagingId, inboxId: source.inboxId,
      threadId: source.threadId, userId, records: [{ key: 'closed-append-recovery', recordType: 'support', action: 'append',
        companyCode: companyA.code, target: { type: 'supportCase', id: caseId, companyId: companyA.id, action: 'append' },
        fields: { summary: 'Close the verified fixture defect', details: 'Fixture repair was verified complete.', caseStatus: 'CLOSED' } }] });
    await fixture('/__fixture/fail', 'POST', { method: 'PATCH', path: `/rest/supportCases/${caseId}`, dropAfterWrite: true });
    assert.equal((await confirm(source, items)).status, 200);
    await waitItems(source, (rows) => rows[0]?.status === 'unknown');
    const uncertain = await state();
    const closedRecord = uncertain.tables.supportCases![caseId];
    assert.equal(closedRecord.caseStatus, 'CLOSED');
    assert.match(closedRecord.issueDescription.markdown, /Fixture repair was verified complete\./);
    assert.equal(uncertain.audit.filter((entry) => entry.path === `/rest/supportCases/${caseId}` && entry.applied).length, 1);
    assert.equal((await confirm(source, items)).status, 409, 'no retry before an outcome is established');
    // Trusted fixture readback and its mutation audit establish success here.
    // This exercises the domain resolution path; no public/manual absence retry
    // endpoint exists, and the fixture does not validate real CRM reconciliation.
    assert.equal(await resolveUnknownItemOperation(items[0]!.revisionId, 'support:append',
      { outcome: 'succeeded', result: null }, userId), true);
    const [receipt] = await sql<Array<{ state: string; audit: any[] }>>`select state,audit from item_operation
      where revision_id=${items[0]!.revisionId} and role='support:append'`;
    assert.equal(receipt!.state, 'succeeded');
    assert.equal(receipt!.audit[0].actorId, userId);
    assert.equal(await recoverProposalItem(items[0]!.itemId, userId, items[0]!.revision), true);
    assert.equal((await confirm(source, items)).status, 200);
    await waitItems(source, (rows) => rows[0]?.status === 'confirmed');
    const finished = await state();
    assert.equal(finished.tables.supportCases![caseId].caseStatus, 'CLOSED');
    assert.equal(finished.tables.supportCases![caseId].issueDescription.markdown, closedRecord.issueDescription.markdown);
    assert.equal(finished.audit.filter((entry) => entry.path === `/rest/supportCases/${caseId}` && entry.applied).length, 1);
  });

  it('one input can contain two accounts while each confirmed matter keeps its own company', async () => {
    const source = await batch('independent matters for two fictional accounts');
    const items = await proposeRecords({ stagingId: source.stagingId, inboxId: source.inboxId, threadId: source.threadId, userId,
      records: [companyA, companyB].map((company) => ({ key: company.code, recordType: 'support', companyCode: company.code,
        fields: { summary: `multi-account-${company.code}`, details: 'An independent fictional account defect' } })) });
    assert.equal((await confirm(source, items)).status, 200);
    const persisted = await waitItems(source, (rows) => rows.every((item) => item.status === 'confirmed'));
    const snapshot = await state();
    for (const item of persisted) {
      const actual = snapshot.tables.supportCases![item.twentyRefs!.supportCaseId!];
      assert.equal(actual.companyId, item.companyId);
    }
    assert.deepEqual(new Set(persisted.map((item) => item.companyId)), new Set([companyA.id, companyB.id]));
  });

  it('cancel returns only the selected queued revision to ready and keeps its sibling committing', async () => {
    const source = await batch('one selected confirmation cancelled');
    const { items } = await proposal(source, 'cancel-item-fixture', 2);
    assert.equal((await confirm(source, items)).status, 200);
    const cancelled = await call(`/proposal-items/${items[0]!.itemId}/confirm`, 'DELETE', { revision: items[0]!.revision });
    assert.equal(cancelled.status, 200);
    const persisted = await waitItems(source, (rows) => rows.some((item) => item.status === 'confirmed') && rows.some((item) => item.status === 'ready'));
    assert.equal(persisted.find((item) => item.itemId === items[0]!.itemId)?.status, 'ready');
    assert.equal(casesNamed(await state(), 'cancel-item-fixture').length, 1);
  });

  it('draft withdrawal blocks requeue while wrong revisions and foreign users cannot withdraw a sibling', async () => {
    const source = await batch('one ready draft intentionally withdrawn');
    const { items } = await proposal(source, 'withdraw-item-fixture', 2);
    const path = `/proposal-items/${items[0]!.itemId}`;
    assert.equal((await call(path, 'DELETE', { revision: 999 })).status, 409);
    assert.ok([404, 409].includes((await call(path, 'DELETE', { revision: 1 }, otherToken)).status));
    assert.equal((await call(path, 'DELETE', { revision: 1 })).status, 200);
    const persisted = await listProposalItems(source.stagingId);
    assert.equal(persisted.find((item) => item.itemId === items[0]!.itemId)?.status, 'withdrawn');
    assert.equal(persisted.find((item) => item.itemId === items[1]!.itemId)?.status, 'ready');
    assert.equal((await confirm(source, [items[0]!])).status, 409);
    assert.equal(casesNamed(await state(), 'withdraw-item-fixture').length, 0);
  });

  it('updating an existing project stage preserves its unstated budget, planned SOP and specification', async () => {
    const projectId = randomUUID();
    const code = 'FIXTUREA-2026-901';
    await fixture('/rest/projects', 'POST', { id: projectId, name: 'Existing fixture project', companyId: companyA.id,
      projectCode: code, projectStage: 'CONTACTED', budgetEur: 42000, plannedSop: '2027-04-15', specSummary: { markdown: 'Keep the verified specification.' } });
    const source = await batch('Only update a known project stage');
    const items = await proposeRecords({ stagingId: source.stagingId, inboxId: source.inboxId, threadId: source.threadId, userId,
      records: [{ key: 'project-stage-update', recordType: 'project', action: 'update', companyCode: companyA.code,
        target: { type: 'project', id: projectId, companyId: companyA.id, code },
        fields: { summary: 'Stage change only', project: { projectCode: code, projectStage: 'SAMPLE_TESTING' } } }] });
    assert.equal((await confirm(source, items)).status, 200);
    await waitItems(source, (rows) => rows[0]?.status === 'confirmed');
    const actual = (await state()).tables.projects![projectId];
    assert.equal(actual.projectStage, 'SAMPLE_TESTING');
    assert.equal(actual.budgetEur, 42000);
    assert.equal(actual.plannedSop, '2027-04-15');
    assert.deepEqual(actual.specSummary, { markdown: 'Keep the verified specification.' });
  });

  it('a project code owned by another account is rejected before the first visit or project mutation', async () => {
    const projectId = randomUUID();
    const code = 'FIXTUREB-2026-902';
    await fixture('/rest/projects', 'POST', { id: projectId, name: 'Other account fixture project',
      companyId: companyB.id, projectCode: code, projectStage: 'CONTACTED' });
    const source = await batch('Wrong account attempted to reuse a project code');
    const items = await proposeRecords({ stagingId: source.stagingId, inboxId: source.inboxId,
      threadId: source.threadId, userId, records: [{ key: 'foreign-project-code', recordType: 'project',
        companyCode: companyA.code, fields: { summary: 'Cross-account code must not silently update',
          project: { projectCode: code, name: 'Must not replace foreign title', projectStage: 'SAMPLE_TESTING' } } }] });
    const beforeConfirm = await state();
    assert.equal((await confirm(source, items)).status, 200);
    const [rejected] = await waitItems(source, (rows) => rows[0]?.status === 'failed');
    assert.match(rejected!.error!, /RECOMMIT_CONFLICT.*项目编号属于其他客户/);
    const snapshot = await state();
    assert.equal(snapshot.audit.filter((entry) => entry.applied).length,
      beforeConfirm.audit.filter((entry) => entry.applied).length, 'a visit must not precede the account guard');
    assert.deepEqual(snapshot.tables.projects![projectId], beforeConfirm.tables.projects![projectId]);
  });

  it('a committed matter cannot silently migrate to another account or reopen its now-closed support case', async () => {
    const source = await batch('Committed support identity must stay with its account');
    const { items } = await proposal(source, 'owned-case-fixture', 1);
    assert.equal((await confirm(source, items)).status, 200);
    const [committed] = await waitItems(source, (rows) => rows[0]?.status === 'confirmed');
    const caseId = committed!.twentyRefs!.supportCaseId!;
    const next = await batch('Follow-up to a closed support case');
    await assert.rejects(proposeRecords({ stagingId: next.stagingId, inboxId: next.inboxId, threadId: next.threadId, userId,
      records: [{ key: 'wrong-account', itemId: committed!.itemId, expectedRevision: 1, recordType: 'support', companyCode: companyB.code,
        fields: { summary: 'Do not change the committed account' } }] }), /company/i);
    await fixture(`/rest/supportCases/${caseId}`, 'PATCH', { caseStatus: 'CLOSED' });
    const changed = await proposeRecords({ stagingId: next.stagingId, inboxId: next.inboxId, threadId: next.threadId, userId,
      records: [{ key: 'closed-case-update', itemId: committed!.itemId, expectedRevision: 1, recordType: 'support', companyCode: companyA.code,
        fields: { summary: 'New details cannot silently append to a closed case',
          details: 'New follow-up while the case remains closed.', caseStatus: 'CLOSED' } }] });
    const beforeQueue = await state();
    const queued = await confirm(next, changed);
    if (queued.status === 200) {
      await waitItems(next, (rows) => ['failed', 'unknown'].includes(rows[0]?.status ?? ''));
    } else {
      assert.equal(queued.status, 409);
    }
    const snapshot = await state();
    assert.equal(snapshot.tables.supportCases![caseId].caseStatus, 'CLOSED');
    assert.equal(snapshot.audit.filter((entry) => entry.applied && entry.path === `/rest/supportCases/${caseId}`).length,
      beforeQueue.audit.filter((entry) => entry.applied && entry.path === `/rest/supportCases/${caseId}`).length);
  });

  it('a failed revision with a successful remote step must recover before a new revision can be proposed', async () => {
    const source = await batch('Partial remote step cannot be hidden by a new proposal');
    const { items } = await proposal(source, 'partial-revision-fixture', 1);
    const visit = await fixture('/rest/visits', 'POST', { name: 'Partially completed fixture visit', companyId: companyA.id });
    const visitId = visit.data.createVisit.id;
    const payload = { companyId: companyA.id, fields: { severity: 'MEDIUM' } };
    await sql`update proposal_revision set status='failed',error='later fixture step rejected',
      confirm_payload=${sql.json(payload)} where id=${items[0]!.revisionId}`;
    await sql`insert into item_operation(revision_id,role,input_hash,input,state,result)
      values(${items[0]!.revisionId},'visit:create','fixture-partial-hash','{}','succeeded',${sql.json({ recordId: visitId })})`;
    const correction = await batch('Attempted correction of partially completed revision');
    const beforeCorrection = await state();
    await assert.rejects(proposeRecords({ stagingId: correction.stagingId, inboxId: correction.inboxId,
      threadId: correction.threadId, userId, records: [{ key: 'unsafe-partial-correction', itemId: items[0]!.itemId,
        expectedRevision: 1, recordType: 'support', companyCode: companyA.code,
        fields: { summary: 'Must recover existing successful step first' } }] }),
      (error: any) => error.code === 'partial_item_requires_recovery' && error.status === 409);
    const [revisions] = await sql<Array<{ count: number }>>`select count(*)::int as count from proposal_revision where item_id=${items[0]!.itemId}`;
    assert.equal(revisions!.count, 1);
    assert.equal((await state()).audit.filter((entry) => entry.applied).length,
      beforeCorrection.audit.filter((entry) => entry.applied).length);
    assert.ok((await state()).tables.visits![visitId]);
    const changedFields = await call(`/staging/${source.stagingId}/items/confirm`, 'POST', {
      items: [{ itemId: items[0]!.itemId, revision: 1, fields: { severity: 'HIGH' } }],
    });
    assert.equal(changedFields.status, 422);
    assert.equal(changedFields.json.error, 'partial_item_changes_require_reconciliation');
    const [unchanged] = await sql<Array<{ confirm_payload: unknown }>>`select confirm_payload from proposal_revision where id=${items[0]!.revisionId}`;
    assert.deepEqual(unchanged!.confirm_payload, payload);
    // Scheduling an unchanged version retains its old field edits. Cancel before
    // execution because this synthetic partial ledger intentionally has no full
    // result payload and is not evidence of real Twenty recovery semantics.
    assert.equal((await confirm(source, items)).status, 200);
    const [rescheduled] = await sql<Array<{ confirm_payload: { fields: unknown } }>>`select confirm_payload from proposal_revision where id=${items[0]!.revisionId}`;
    assert.deepEqual(rescheduled!.confirm_payload.fields, payload.fields);
    assert.equal((await call(`/proposal-items/${items[0]!.itemId}/confirm`, 'DELETE', { revision: 1 })).status, 200);
    const [cancelled] = await sql<Array<{ confirm_payload: unknown }>>`select confirm_payload from proposal_revision where id=${items[0]!.revisionId}`;
    assert.deepEqual(cancelled!.confirm_payload, rescheduled!.confirm_payload,
      'cancel must preserve the acknowledged inputs of a partial operation');
    assert.equal((await confirm(source, items)).status, 200);
    assert.equal((await call(`/proposal-items/${items[0]!.itemId}/confirm`, 'DELETE', { revision: 1 })).status, 200);
    const withdrawn = await call(`/proposal-items/${items[0]!.itemId}`, 'DELETE', { revision: 1 });
    assert.equal(withdrawn.status, 409, 'a partial draft cannot hide durable CRM writes by being withdrawn');
    assert.equal((await listProposalItems(source.stagingId))[0]!.status, 'ready');
    assert.equal((await state()).audit.filter((entry) => entry.applied).length,
      beforeCorrection.audit.filter((entry) => entry.applied).length);
  });

  it('historical successful writes allow new ready corrections but never permit changing the owned CRM case', async () => {
    const source = await batch('Confirmed identity with legitimate subsequent draft corrections');
    const { items } = await proposal(source, 'stable-target-fixture', 1);
    assert.equal((await confirm(source, items)).status, 200);
    const [committed] = await waitItems(source, (rows) => rows[0]?.status === 'confirmed');
    const ownCaseId = committed!.twentyRefs!.supportCaseId!;
    const firstCorrection = await batch('First unconfirmed correction');
    const [revision2] = await proposeRecords({ stagingId: firstCorrection.stagingId, inboxId: firstCorrection.inboxId,
      threadId: firstCorrection.threadId, userId, records: [{ key: 'normal-ready-correction-2', itemId: committed!.itemId,
        expectedRevision: 1, recordType: 'support', companyCode: companyA.code, fields: { details: 'First correction draft' } }] });
    const secondCorrection = await batch('Second unconfirmed correction');
    const [revision3] = await proposeRecords({ stagingId: secondCorrection.stagingId, inboxId: secondCorrection.inboxId,
      threadId: secondCorrection.threadId, userId, records: [{ key: 'normal-ready-correction-3', itemId: committed!.itemId,
        expectedRevision: revision2!.revision, recordType: 'support', companyCode: companyA.code,
        fields: { details: 'Corrected the draft again before confirming' } }] });
    assert.equal(revision3!.revision, 3, 'historical ownership must not block corrections with no current remote writes');
    const beforeSelection = await state();
    const response = await call(`/staging/${secondCorrection.stagingId}/items/confirm`, 'POST', {
      items: [{ itemId: revision3!.itemId, revision: revision3!.revision, supportCaseId: oldCaseId }],
    });
    assert.equal(response.status, 409);
    assert.equal(response.json.error, 'item_target_change_requires_new_item');
    assert.equal((await listProposalItems(secondCorrection.stagingId))[0]!.status, 'ready');
    assert.equal((await state()).audit.filter((entry) => entry.applied).length,
      beforeSelection.audit.filter((entry) => entry.applied).length);
    assert.deepEqual((await state()).tables.supportCases![ownCaseId], beforeSelection.tables.supportCases![ownCaseId]);
    assert.deepEqual((await state()).tables.supportCases![oldCaseId], beforeSelection.tables.supportCases![oldCaseId]);
  });

  it('a second worker lease cannot take over or disturb the active worker database', async () => {
    const beforeAttempt = await sql`select id,status from proposal_revision order by id`;
    await assert.rejects(acquireCommitWorkerLease(), /Another gateway commit worker/);
    assert.deepEqual(await sql`select id,status from proposal_revision order by id`, beforeAttempt);
    assert.equal((await call('/health')).status, 200);
  });

  it('crash-residue recovery turns running remote writes into unknown without a mutation or blind retry', async () => {
    // Inject a residual row and call the recovery service directly. This verifies
    // durable state transitions, not OS process replacement or production restart.
    const source = await batch('simulated crash residue only');
    const { items } = await proposal(source, 'recovery-item-fixture', 1);
    const revisionId = items[0]!.revisionId;
    await sql`update proposal_revision set status='committing' where id=${revisionId}`;
    await sql`insert into item_operation(revision_id,role,input_hash,input,state,attempt_id)
      values(${revisionId},'supportCase:create','fixture-hash','{}','running',${randomUUID()})`;
    const beforeRecovery = await state();
    const recovered = await recoverInterruptedProposalItems();
    assert.equal(recovered.items, 1);
    assert.equal(recovered.operations, 1);
    assert.equal((await listProposalItems(source.stagingId))[0]!.status, 'unknown');
    const [operation] = await sql<Array<{ state: string }>>`select state from item_operation where revision_id=${revisionId}`;
    assert.equal(operation!.state, 'unknown');
    assert.equal((await confirm(source, items)).status, 409);
    assert.equal((await state()).audit.filter((entry) => entry.applied).length, beforeRecovery.audit.filter((entry) => entry.applied).length);
  });
});

const questionFixture = async (label: string, itemCount = 1) => {
  const source = await batch(label, { companyCode: companyA.code, recordType: 'support', summary: label, details: `${label}: follow-up investigation` });
  const { items } = await proposal(source, label, itemCount);
  const search = await readCrmCandidates('supportCase', companyA.id, { query: 'Old DC-DC' });
  assert.equal(search.status, 'ok');
  const candidate = search.candidates.find((entry) => entry.target.id === oldCaseId)!;
  assert.ok(candidate);
  const context = newContext({ inboxId: source.inboxId, stagingId: source.stagingId, threadId: source.threadId,
    userId, userCode: 'fixture-operator', displayName: 'Fixture Operator', companies: [companyA, companyB].map((company) => ({ ...company, group: '', type: 'OEM_BRAND' })),
    suppliers: [], attachments: [], maxSteps: 8, pushPlaybooks: [], resumed: false, source: 'pwa',
    itemId: items[0]!.itemId, revisionId: items[0]!.revisionId });
  context.targetCandidates!.set(candidate.handle, candidate);
  createAgentQuestion(context, { question: 'Continue the old charging case?', itemId: items[0]!.itemId,
    targetOptions: [{ label: 'Continue old case', candidateHandle: candidate.handle }, { label: 'Create separate case', action: 'create' }], recommendedIndex: 0 });
  const [message] = await sql<Array<{ id: string }>>`insert into thread_message(thread_id,role,text,inbox_id,meta)
    values(${source.threadId},'agent','Choose a target before confirming.',${source.inboxId},${sql.json({ stagingId: source.stagingId, questions: context.questions } as never)}) returning id`;
  const [question] = await persistAgentQuestions(context, message!.id);
  return { source, items, question: question!, messageId: message!.id };
};
const answer = (source: Batch, question: QuestionSnapshot, body: Record<string, unknown>, auth = token) =>
  call(`/threads/${source.threadId}/questions/${question.questionId}/answers`, 'POST', {
    expectedRevision: question.expectedRevision, ...body,
  }, auth);

describe('structured target question snapshots (#65) · FAKE CRM boundaries', () => {
  it('a legacy work-item answer keeps the selected task and its real parent despite a different project in the source', async () => {
    const parentId = randomUUID();
    const sourceParentId = randomUUID();
    const taskId = randomUUID();
    const parentCode = 'FIXTUREA-2026-903';
    const sourceCode = 'FIXTUREA-2026-904';
    const taskCode = `${parentCode}-001`;
    await fixture('/rest/projects', 'POST', { id: parentId, companyId: companyA.id, projectCode: parentCode,
      name: 'Selected task real parent', projectStage: 'CONTACTED', budgetEur: 12345,
      specSummary: { markdown: 'Selected parent specification must stay intact.' } });
    await fixture('/rest/projects', 'POST', { id: sourceParentId, companyId: companyA.id, projectCode: sourceCode,
      name: 'Different source parent', projectStage: 'CONTACTED', budgetEur: 54321,
      specSummary: { markdown: 'Source parent specification must stay intact.' } });
    await fixture('/rest/workItems', 'POST', { id: taskId, companyId: companyA.id, projectId: parentId, itemCode: taskCode,
      name: 'Selected existing task', itemStatus: 'OPEN', body: { markdown: 'Existing task context.' } });
    const source = await batch('Legacy follow-up initially names another project', {
      recordType: 'followup', companyCode: companyA.code, summary: 'Update the selected existing task',
      details: 'Updated fixture task evidence.', project: { projectCode: sourceCode },
      workItems: [{ title: 'Task evidence update', body: 'Updated fixture task evidence.' }],
    });
    const search = await readCrmCandidates('workItem', companyA.id, { query: taskCode });
    assert.equal(search.status, 'ok');
    const candidate = search.candidates.find((entry) => entry.target.id === taskId)!;
    assert.ok(candidate);
    const context = newContext({ inboxId: source.inboxId, stagingId: source.stagingId, threadId: source.threadId,
      userId, userCode: 'fixture-operator', displayName: 'Fixture Operator',
      companies: [{ ...companyA, group: '', type: 'OEM_BRAND' }], suppliers: [], attachments: [],
      maxSteps: 8, pushPlaybooks: [], resumed: false, source: 'pwa' });
    context.targetCandidates!.set(candidate.handle, candidate);
    createAgentQuestion(context, { question: 'Follow the existing task?',
      targetOptions: [{ label: 'Update selected task', candidateHandle: candidate.handle }] });
    const [message] = await sql<Array<{ id: string }>>`insert into thread_message(thread_id,role,text,inbox_id,meta)
      values(${source.threadId},'agent','Select the task.',${source.inboxId},${sql.json({ stagingId: source.stagingId, questions: context.questions } as never)}) returning id`;
    const [question] = await persistAgentQuestions(context, message!.id);
    const accepted = await answer(source, question!, { clientId: randomUUID(), optionId: question!.choices![0]!.optionId });
    assert.equal(accepted.status, 201);
    assert.equal(accepted.json.target.id, taskId);
    const beforeConfirm = await state();
    assert.equal((await call(`/staging/${accepted.json.stagingId}/confirm`, 'POST', { companyId: companyA.id })).status, 200);
    await eventually(async () => (await sql<Array<{ status: string; error: string | null }>>`select status,error from staging where id=${accepted.json.stagingId}`)[0]!,
      (row) => row.status === 'confirmed', 'legacy work-item parent binding');
    const snapshot = await state();
    assert.equal(snapshot.tables.workItems![taskId].projectId, parentId);
    assert.equal(snapshot.tables.workItems![taskId].companyId, companyA.id);
    assert.match(snapshot.tables.workItems![taskId].body.markdown, /Updated fixture task evidence\./);
    assert.equal(Object.keys(snapshot.tables.projects!).length, Object.keys(beforeConfirm.tables.projects!).length);
    assert.equal(Object.keys(snapshot.tables.workItems!).length, Object.keys(beforeConfirm.tables.workItems!).length);
    assert.equal(snapshot.tables.projects![parentId].budgetEur, 12345);
    assert.deepEqual(snapshot.tables.projects![parentId].specSummary, beforeConfirm.tables.projects![parentId].specSummary);
    assert.deepEqual(snapshot.tables.projects![sourceParentId], beforeConfirm.tables.projects![sourceParentId]);
  });

  it('continuing another legacy draft consumes both old proposals and commits their combined details only once', async () => {
    const original = await batch('Legacy draft A in another thread', {
      recordType: 'support', companyCode: companyA.code, summary: 'legacy-continuation-fixture',
      details: 'Original draft A investigation.', modelName: 'Fixture DC-DC', caseStatus: 'NEW', severity: 'MEDIUM',
    });
    const source = await batch('Legacy draft B follow-up', {
      recordType: 'support', companyCode: companyA.code, summary: 'legacy-continuation-fixture',
      details: 'Follow-up draft B evidence.', modelName: 'Fixture DC-DC', caseStatus: 'NEW', severity: 'MEDIUM',
    });
    const pending = await readPendingCandidates(companyA.id, companyA.code, userId, source.stagingId);
    assert.equal(pending.status, 'ok');
    const candidate = pending.candidates.find((entry) => entry.target.id === original.stagingId)!;
    assert.ok(candidate);
    const context = newContext({ inboxId: source.inboxId, stagingId: source.stagingId, threadId: source.threadId,
      userId, userCode: 'fixture-operator', displayName: 'Fixture Operator',
      companies: [{ ...companyA, group: '', type: 'OEM_BRAND' }], suppliers: [], attachments: [],
      maxSteps: 8, pushPlaybooks: [], resumed: false, source: 'pwa' });
    context.targetCandidates!.set(candidate.handle, candidate);
    createAgentQuestion(context, { question: 'Continue draft A?',
      targetOptions: [{ label: 'Continue draft A', candidateHandle: candidate.handle }] });
    const [message] = await sql<Array<{ id: string }>>`insert into thread_message(thread_id,role,text,inbox_id,meta)
      values(${source.threadId},'agent','Select the pending matter.',${source.inboxId},${sql.json({ stagingId: source.stagingId, questions: context.questions } as never)}) returning id`;
    const [question] = await persistAgentQuestions(context, message!.id);
    const beforeAnswer = await state();
    const clientId = randomUUID();
    const accepted = await answer(source, question!, { clientId, optionId: question!.choices![0]!.optionId });
    assert.equal(accepted.status, 201);
    assert.equal(accepted.json.requiresAgent, false);
    assert.equal((await state()).audit.filter((entry) => entry.applied).length,
      beforeAnswer.audit.filter((entry) => entry.applied).length, 'draft selection cannot write CRM');
    const oldRows = await sql<Array<{ id: string; status: string; superseded_by: string }>>`
      select id,status,superseded_by from staging where id in (${original.stagingId},${source.stagingId})`;
    assert.equal(oldRows.length, 2);
    assert.ok(oldRows.every((row) => row.status === 'superseded' && row.superseded_by === accepted.json.stagingId));
    const [merged] = await sql<Array<{ status: string; extracted: any }>>`select status,extracted from staging where id=${accepted.json.stagingId}`;
    assert.equal(merged!.status, 'ready');
    assert.equal(merged!.extracted.details, 'Original draft A investigation.\n\nFollow-up draft B evidence.');
    assert.equal(merged!.extracted.targetBinding, undefined, 'consumed staging identity cannot remain a commit target');
    assert.equal((await call(`/staging/${original.stagingId}/confirm`, 'POST', { companyId: companyA.id })).status, 409);
    assert.equal((await call(`/staging/${source.stagingId}/confirm`, 'POST', { companyId: companyA.id })).status, 409);
    const replay = await answer(source, question!, { clientId, optionId: question!.choices![0]!.optionId });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.stagingId, accepted.json.stagingId);
    assert.equal((await call(`/staging/${accepted.json.stagingId}/confirm`, 'POST', { companyId: companyA.id })).status, 200);
    await eventually(async () => (await sql<Array<{ status: string; error: string | null }>>`select status,error from staging where id=${accepted.json.stagingId}`)[0]!,
      (row) => row.status === 'confirmed', 'combined legacy draft');
    const records = casesNamed(await state(), 'legacy-continuation-fixture');
    assert.equal(records.length, 1);
    assert.match(records[0]!.issueDescription.markdown, /Original draft A investigation\./);
    assert.match(records[0]!.issueDescription.markdown, /Follow-up draft B evidence\./);
  });

  it('cross-thread old target is bound by option identity; answer creates no CRM write and revision touches only its item', async () => {
    const older = await batch('old case belongs to a separate conversation');
    await sql`update staging set status='confirmed',twenty_refs=${sql.json({ supportCaseId: oldCaseId })},
      created_records=${sql.json([{ object: 'supportCase', id: oldCaseId, name: 'Old DC-DC charging case' }])} where id=${older.stagingId}`;
    const { source, items, question, messageId } = await questionFixture('target-question-fixture', 2);
    const beforeAnswer = await state();
    const clientId = randomUUID();
    const body = { clientId, optionId: question.choices![0]!.optionId };
    const accepted = await answer(source, question, body);
    assert.equal(accepted.status, 201);
    assert.equal(accepted.json.target.id, oldCaseId);
    assert.equal(accepted.json.requiresAgent, false);
    assert.notEqual(source.threadId, older.threadId);
    assert.equal((await state()).audit.filter((entry) => entry.applied).length, beforeAnswer.audit.filter((entry) => entry.applied).length, 'choosing a target does not confirm CRM writes');
    const [newItem] = await listProposalItems(accepted.json.stagingId);
    assert.equal(newItem!.itemId, items[0]!.itemId);
    assert.equal(newItem!.revision, 2);
    assert.equal(newItem!.target?.id, oldCaseId);
    assert.equal((await listProposalItems(source.stagingId)).find((item) => item.itemId === items[1]!.itemId)?.status, 'ready');
    const replay = await answer(source, question, body);
    assert.equal(replay.status, 200);
    assert.equal(replay.json.duplicate, true);
    assert.equal(replay.json.inboxId, accepted.json.inboxId);
    const [count] = await sql<Array<{ count: number }>>`select count(*)::int as count from inbox where client_id=${clientId}`;
    assert.equal(count!.count, 1);
    const concurrentOtherAnswer = await answer(source, question, { clientId: randomUUID(), optionId: question.choices![1]!.optionId });
    assert.equal(concurrentOtherAnswer.status, 409);
    const hydrated = await call(`/threads/${source.threadId}`);
    const questionMessage = hydrated.json.messages.find((message: any) => message.id === messageId);
    assert.equal(questionMessage.meta.questions[0].status, 'answered');
    const followup = { ...source, inboxId: accepted.json.inboxId, stagingId: accepted.json.stagingId };
    assert.equal((await confirm(followup, [newItem!])).status, 200);
    await waitItems(followup, (rows) => rows[0]?.status === 'confirmed');
    const afterConfirm = await state();
    assert.equal(afterConfirm.tables.supportCases![oldCaseId].issueDescription.markdown.includes('Original investigation: do not overwrite.'), true);
    assert.equal(afterConfirm.tables.supportCases![oldCaseId].issueDescription.markdown.includes('target-question-fixture'), true);
    assert.equal(casesNamed(afterConfirm, 'target-question-fixture').length, 0, 'target answer appends to the exact old case instead of creating a new one');
    assert.equal(afterConfirm.tables.supportCases![otherCaseId].issueDescription.markdown, 'Different account: do not write here.');
    const deleteSharedOwner = await call(`/staging/${older.stagingId}/record`, 'DELETE');
    assert.equal(deleteSharedOwner.status, 409, 'a legacy record owner cannot delete a case now shared by a new item');
    assert.ok((await state()).tables.supportCases![oldCaseId]);
  });

  it('wrong thread, foreign user, unknown option and wrong expected revision reject without creating an answer inbox', async () => {
    const { source, question } = await questionFixture('invalid-answer-fixture');
    const another = await batch('unrelated source thread');
    const clientId = randomUUID();
    const wrongThread = await answer(another, question, { clientId, optionId: question.choices![0]!.optionId });
    assert.equal(wrongThread.status, 404);
    assert.equal((await answer(source, question, { clientId, optionId: question.choices![0]!.optionId }, otherToken)).status, 404);
    assert.equal((await answer(source, question, { clientId, optionId: randomUUID() })).status, 422);
    assert.equal((await answer(source, question, { clientId, optionId: question.choices![0]!.optionId, expectedRevision: 'stale-version' })).status, 409);
    const [count] = await sql<Array<{ count: number }>>`select count(*)::int as count from inbox where client_id=${clientId}`;
    assert.equal(count!.count, 0);
  });

  it('a changed item invalidates its old target question rather than applying an answer to the newest matter', async () => {
    const { source, items, question } = await questionFixture('stale-question-fixture');
    const newer = await batch('explicitly edited the item in the same thread');
    const [originalInbox] = await sql<Array<{ id: string }>>`insert into inbox(client_id,user_id,thread_id,text,source)
      values(${randomUUID()},${userId},${source.threadId},'edited proposal','followup') returning id`;
    const [edited] = await sql<Array<{ id: string }>>`insert into staging(inbox_id,thread_id,status) values(${originalInbox!.id},${source.threadId},'ready') returning id`;
    await proposeRecords({ stagingId: edited!.id, inboxId: originalInbox!.id, threadId: source.threadId, userId,
      records: [{ key: 'explicit-revision', itemId: items[0]!.itemId, expectedRevision: 1, recordType: 'support', companyCode: companyA.code, fields: { summary: newer.text } }] });
    const response = await answer(source, question, { clientId: randomUUID(), optionId: question.choices![0]!.optionId });
    assert.equal(response.status, 409);
    assert.equal(response.json.error, 'question_stale');
  });

  it('withdrawing the source item prevents an old question from restoring it or creating an answer inbox', async () => {
    const { source, items, question } = await questionFixture('withdrawn-question-fixture');
    const clientId = randomUUID();
    assert.equal((await call(`/proposal-items/${items[0]!.itemId}`, 'DELETE', { revision: items[0]!.revision })).status, 200);
    const response = await answer(source, question, { clientId, optionId: question.choices![0]!.optionId });
    assert.equal(response.status, 409);
    assert.equal(response.json.error, 'question_stale');
    assert.equal((await listProposalItems(source.stagingId))[0]!.status, 'withdrawn');
    const [inbox] = await sql<Array<{ count: number }>>`select count(*)::int as count from inbox where client_id=${clientId}`;
    const [revisions] = await sql<Array<{ count: number }>>`select count(*)::int as count from proposal_revision where item_id=${items[0]!.itemId}`;
    assert.equal(inbox!.count, 0);
    assert.equal(revisions!.count, 1);
  });

  it('a suggested case moved to another account rejects the answer before changing the proposal or inbox', async () => {
    const { source, items, question } = await questionFixture('moved-target-fixture');
    await fixture(`/rest/supportCases/${oldCaseId}`, 'PATCH', { companyId: companyB.id });
    const clientId = randomUUID();
    const response = await answer(source, question, { clientId, optionId: question.choices![0]!.optionId });
    assert.equal(response.status, 422);
    assert.equal(response.json.error, 'target_company_mismatch');
    assert.equal((await listProposalItems(source.stagingId))[0]!.revisionId, items[0]!.revisionId);
    const [inbox] = await sql<Array<{ count: number }>>`select count(*)::int as count from inbox where client_id=${clientId}`;
    assert.equal(inbox!.count, 0);
    await fixture(`/rest/supportCases/${oldCaseId}`, 'PATCH', { companyId: companyA.id });
  });

  it('closing the suggested remote target blocks the answer and leaves the source proposal intact', async () => {
    const { source, question } = await questionFixture('closed-target-fixture');
    await fixture(`/rest/supportCases/${oldCaseId}`, 'PATCH', { caseStatus: 'CLOSED' });
    const response = await answer(source, question, { clientId: randomUUID(), optionId: question.choices![0]!.optionId });
    assert.equal(response.status, 409);
    assert.equal((await listProposalItems(source.stagingId))[0]!.status, 'ready');
    await fixture(`/rest/supportCases/${oldCaseId}`, 'PATCH', { caseStatus: 'NEW' });
  });

  it('expired question and an answer client ID already owned by another user are rejected atomically', async () => {
    const { source, question, messageId } = await questionFixture('expired-question-fixture');
    const expiredId = randomUUID();
    const expiry = new Date(Date.now() - 1000);
    const expired = { ...question, questionId: expiredId, expiresAt: expiry.toISOString() };
    await sql`insert into agent_question(id,user_id,thread_id,staging_id,source_message_id,item_id,revision_id,proposal_fingerprint,snapshot,expires_at)
      values(${expiredId},${userId},${source.threadId},${source.stagingId},${messageId},${expired.itemId!},${expired.revisionId!},
        ${expired.proposalFingerprint!},${sql.json(expired as never)},${expiry})`;
    const expiredClient = randomUUID();
    const result = await answer(source, expired, { clientId: expiredClient, optionId: expired.choices![0]!.optionId });
    assert.equal(result.status, 409);
    assert.equal(result.json.error, 'question_expired');
    const collisionClient = randomUUID();
    await sql`insert into inbox(client_id,user_id,text,source) values(${collisionClient},${otherUserId},'Foreign fixture original','note')`;
    const collision = await answer(source, question, { clientId: collisionClient, optionId: question.choices![0]!.optionId });
    assert.equal(collision.status, 409);
    assert.equal(collision.json.error, 'answer_client_conflict');
    const [ownWrites] = await sql<Array<{ count: number }>>`select count(*)::int as count from inbox
      where user_id=${userId} and client_id in (${expiredClient},${collisionClient})`;
    assert.equal(ownWrites!.count, 0);
    const [answers] = await sql<Array<{ count: number }>>`select count(*)::int as count from agent_question_answer where question_id in (${question.questionId},${expiredId})`;
    assert.equal(answers!.count, 0);
  });
});
