import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from '../db.ts';
import { hashPassword } from '../auth.ts';
import { listProposalItems, proposeRecords } from '../proposal-items.ts';
import type { ProposalItemView } from '../proposal-model.ts';

/** Real HTTP/Postgres + strictly local FAKE Twenty; no model calls.
 * Run only through scripts/test-isolated-agent.py. Injection/readback verify our
 * recovery behavior, not real Twenty schema/idempotency. Clients cannot declare
 * success/absence or supply substitute receipts.
 */
const BASE = process.env.GATEWAY_URL ?? '';
const CRM = process.env.FIXTURE_TWENTY_URL ?? '';
const local = (url: string) => /^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/.test(url);
if (!local(BASE) || !local(CRM) || !/@(?:localhost|127\.0\.0\.1):\d+\//.test(process.env.APP_DATABASE_URL ?? '')) {
  throw new Error('item-recovery requires the isolated local gateway/database/FAKE Twenty runner');
}
assert.equal((await fetch(CRM + '/healthz').then((response) => response.json()) as any).realTwenty, false);
assert.equal(process.env.AGENT_MULTI_ITEMS, '1', 'explicitly exercise the gated multi-item path');

type Audit = { method: string; path: string; body: any; status: number; applied?: boolean; resultId?: string };
type Snapshot = { tables: Record<string, Record<string, any>>; audit: Audit[] };
type Source = { threadId: string; inboxId: string; stagingId: string; text: string };
type Draft = { source: Source; item: ProposalItemView };
const company = { id: randomUUID(), code: 'RECOVERYFIXTURE', name: 'Example Caravan Recovery' };
const otherCompany = { id: randomUUID(), code: 'RECOVERYOTHER', name: 'Example Caravan Recovery Other' };
const userId = randomUUID();
const foreignId = randomUUID();
let token = '';
let foreignToken = '';

const fixture = async (path: string, method = 'GET', body?: unknown): Promise<any> => {
  const response = await fetch(CRM + path, { method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const result = await response.json();
  assert.equal(response.ok, true, 'fixture ' + method + ' ' + path + ': ' + JSON.stringify(result));
  return result;
};
const snapshot = (): Promise<Snapshot> => fixture('/__fixture/state');
const writes = (state: Snapshot) => state.audit.filter((entry) => entry.applied);
const call = async (path: string, method = 'GET', body?: unknown, auth = token) => {
  const response = await fetch(BASE + path, { method,
    headers: { Authorization: 'Bearer ' + auth, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, json: await response.json() as any };
};
const eventually = async <T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> => {
  const until = Date.now() + 20_000;
  let value: T;
  do {
    value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < until);
  assert.fail(label + ': ' + JSON.stringify(value!));
};
const source = async (text: string): Promise<Source> => {
  const created = await call('/threads', 'POST', { title: text });
  assert.equal(created.status, 201);
  const threadId = created.json.id as string;
  const [inbox] = await sql.unsafe<Array<{ id: string }>>(
    "insert into inbox(client_id,user_id,thread_id,text,source) values($1,$2,$3,$4,'note') returning id",
    [randomUUID(), userId, threadId, text]);
  const [staging] = await sql.unsafe<Array<{ id: string }>>(
    "insert into staging(inbox_id,thread_id,status) values($1,$2,'ready') returning id", [inbox!.id, threadId]);
  await sql.unsafe("insert into thread_message(thread_id,role,text,inbox_id) values($1,'user',$2,$3)", [threadId, text, inbox!.id]);
  return { threadId, inboxId: inbox!.id, stagingId: staging!.id, text };
};
const support = async (label: string, targetId?: string, caseStatus = 'NEW'): Promise<Draft> => {
  const batch = await source(label);
  const [item] = await proposeRecords({ ...batch, userId, records: [{ key: label, recordType: 'support',
    companyCode: company.code, action: targetId ? 'append' : 'create',
    ...(targetId ? { target: { type: 'supportCase', id: targetId, companyId: company.id, action: 'append' } as const } : {}),
    fields: { summary: label, details: label + ': distinct verified fixture evidence.',
      severity: 'MEDIUM', caseStatus, modelName: 'Fixture DC-DC' } }] });
  return { source: batch, item: item! };
};
const confirm = (draft: Draft, fields?: Record<string, unknown>) => call('/staging/' + draft.source.stagingId + '/items/confirm', 'POST', {
  items: [{ itemId: draft.item.itemId, revision: draft.item.revision, ...(fields ? { fields } : {}) }],
});
const settle = (draft: Draft, status: string) => eventually(
  async () => (await listProposalItems(draft.source.stagingId))[0]!,
  (item) => item.status === status, draft.source.text + ' should become ' + status);
const recoveryPath = (draft: Draft) => '/proposal-items/' + draft.item.itemId + '/recovery';
const inspect = (draft: Draft, auth = token) => call(recoveryPath(draft) + '?revision=' + draft.item.revision, 'GET', undefined, auth);
const save = (draft: Draft, auth = token) => call(recoveryPath(draft), 'POST', { revision: draft.item.revision }, auth);
const operation = async (draft: Draft, role: string) => {
  const [row] = await sql.unsafe<Array<{ id: string; state: string; input_hash: string; input: any; input_reset: any; request_evidence: any[]; audit: any[]; result: any }>>(
    'select id,state,input_hash,input,input_reset,request_evidence,audit,result from item_operation where revision_id=$1 and role=$2',
    [draft.item.revisionId, role]);
  assert.ok(row);
  return row;
};
const knownCase = async (label: string) => {
  const id = randomUUID();
  await fixture('/rest/supportCases', 'POST', { id, name: label, companyId: company.id,
    caseStatus: 'NEW', severity: 'MEDIUM', issueDescription: { markdown: 'Original fixture investigation.' } });
  return id;
};
const lostAppend = async (label: string, close = false) => {
  const caseId = await knownCase(label);
  const draft = await support(label, caseId, close ? 'CLOSED' : 'NEW');
  await fixture('/__fixture/fail', 'POST', { method: 'PATCH', path: '/rest/supportCases/' + caseId, dropAfterWrite: true });
  assert.equal((await confirm(draft)).status, 200);
  await settle(draft, 'unknown');
  return { draft, caseId };
};
const remainsUnknown = async (draft: Draft, expectedVerdict: string, expectedReason?: string) => {
  const before = await snapshot();
  const report = await inspect(draft);
  assert.equal(report.status, 200);
  assert.equal(report.json.operations[0].verdict, expectedVerdict);
  if (expectedReason) assert.equal(report.json.operations[0].reason, expectedReason);
  const saved = await save(draft);
  assert.equal(saved.status, 200);
  assert.equal(saved.json.resolvedCount, 0);
  assert.equal(saved.json.recovered, false);
  assert.equal(saved.json.manualReviewRequired, true);
  assert.equal(saved.json.status, 'unknown');
  // The target ownership check runs before the unknown-state guard. Both reject
  // blind confirmation; a moved target must return its precise ownership error.
  const expectedStatus = expectedReason === 'record_company_changed' ? 422 : 409;
  const expectedError = expectedReason === 'record_company_changed' ? 'target_company_mismatch' : 'item_result_unknown';
  const unchangedPayload = await sql.unsafe('select confirm_payload from proposal_revision where id=$1', [draft.item.revisionId]);
  for (const fields of [undefined, { severity: 'HIGH', summary: 'Forbidden unknown replan' }]) {
    const rejected = await confirm(draft, fields);
    assert.equal(rejected.status, expectedStatus);
    assert.equal(rejected.json.error, expectedError);
  }
  assert.deepEqual(await sql.unsafe('select confirm_payload from proposal_revision where id=$1', [draft.item.revisionId]), unchangedPayload);
  assert.equal(writes(await snapshot()).length, writes(before).length, 'inspection/save cannot mutate CRM');
  const unresolved = await sql.unsafe<Array<{ state: string }>>(
    "select state from item_operation where revision_id=$1 and state='unknown'", [draft.item.revisionId]);
  assert.equal(unresolved.length, 1);
};

before(async () => {
  await fixture('/__fixture/reset', 'POST', { tables: {
    companies: [company, otherCompany].map((record) => ({ id: record.id, name: record.name,
      accountCode: record.code, accountType: 'OEM_BRAND', country: 'DE' })),
    contributors: [{ id: randomUUID(), userCode: 'recovery-fixture', name: 'Recovery Fixture', contributorType: 'INTERNAL', isActive: true }],
  } });
  const passwordHash = await hashPassword('isolated-recovery-password');
  await sql.unsafe("insert into app_user(id,user_code,display_name,password_hash,role,is_active,locale) "
    + "values($1,'recovery-fixture','Recovery Fixture',$2,'staff',true,'zh'),"
    + "($3,'recovery-foreign','Recovery Foreign',$2,'staff',true,'en')", [userId, passwordHash, foreignId]);
  for (const userCode of ['recovery-fixture', 'recovery-foreign']) {
    const login = await call('/auth/login', 'POST', { userCode, password: 'isolated-recovery-password' }, '');
    assert.equal(login.status, 200);
    if (userCode === 'recovery-fixture') token = login.json.token;
    else foreignToken = login.json.token;
  }
});
after(async () => { await sql.end({ timeout: 5 }); });

describe('server recovery · real HTTP/PG with FAKE CRM transport failures', () => {
  for (const status of [400, 422]) {
    it('trusted Twenty ' + status + ' before any successful step allows an edited failed card to retry safely', async () => {
      const draft = await support('trusted-rejection-' + status);
      await fixture('/__fixture/fail', 'POST', { method: 'POST', path: '/rest/visits', status,
        response: { statusCode: status, messages: ['Fixture request rejected: correct the field.'] } });
      const before = await snapshot();
      assert.equal((await confirm(draft)).status, 200);
      await settle(draft, 'failed');
      const rejected = await operation(draft, 'visit:create');
      assert.equal(rejected.state, 'failed');
      assert.equal(rejected.request_evidence.length, 1);
      assert.equal(rejected.request_evidence[0].method, 'POST');
      assert.equal(writes(await snapshot()).length, writes(before).length);
      const summary = draft.source.text + ' corrected';
      assert.equal((await confirm(draft, { severity: 'HIGH', summary })).status, 200);
      const completed = await settle(draft, 'confirmed');
      assert.equal(completed.revision, 1, 'the real failed-card path edits the same revision');
      const final = await snapshot();
      const record = final.tables.supportCases![completed.twentyRefs!.supportCaseId!];
      assert.equal(record.severity, 'HIGH');
      assert.equal(record.name, summary);
      assert.equal(final.audit.filter((entry) => entry.path === '/rest/visits' && entry.applied).length,
        before.audit.filter((entry) => entry.path === '/rest/visits' && entry.applied).length + 1);
      assert.equal(final.audit.filter((entry) => entry.path === '/rest/supportCases' && entry.applied).length,
        before.audit.filter((entry) => entry.path === '/rest/supportCases' && entry.applied).length + 1);
      const [original] = await sql.unsafe<Array<{ text: string }>>('select text from inbox where id=$1', [draft.source.inboxId]);
      assert.equal(original!.text, draft.source.text);
    });
  }

  it('a failed card queued as A, cancelled and queued as B uses only the final fields and uncommitted account', async () => {
    const draft = await support('cancelled-replan-final-selection');
    await fixture('/__fixture/fail', 'POST', { method: 'POST', path: '/rest/visits', status: 400,
      response: { statusCode: 400, messages: ['Fixture request rejected before mutation.'] } });
    assert.equal((await confirm(draft)).status, 200);
    await settle(draft, 'failed');
    const beforeReplan = await snapshot();
    assert.equal((await confirm(draft, { summary: 'Cancelled A selection', severity: 'HIGH' })).status, 200);
    assert.equal((await call('/proposal-items/' + draft.item.itemId + '/confirm', 'DELETE', { revision: 1 })).status, 200);
    const finalSelection = await call('/staging/' + draft.source.stagingId + '/items/confirm', 'POST', {
      items: [{ itemId: draft.item.itemId, revision: 1, companyId: otherCompany.id,
        fields: { summary: 'Final B selection', severity: 'LOW' } }],
    });
    assert.equal(finalSelection.status, 200);
    const completed = await settle(draft, 'confirmed');
    const final = await snapshot();
    const record = final.tables.supportCases![completed.twentyRefs!.supportCaseId!];
    assert.equal(record.companyId, otherCompany.id);
    assert.equal(record.name, 'Final B selection');
    assert.equal(record.severity, 'LOW');
    const applied = final.audit.slice(beforeReplan.audit.length).filter((entry) => entry.applied);
    const visitCreates = applied.filter((entry) => entry.path === '/rest/visits' && entry.method === 'POST');
    const caseCreates = applied.filter((entry) => entry.path === '/rest/supportCases' && entry.method === 'POST');
    assert.equal(visitCreates.length, 1);
    assert.equal(caseCreates.length, 1);
    assert.equal(visitCreates[0]!.body.companyId, otherCompany.id);
    assert.ok(applied.every((entry) => entry.body.name !== 'Cancelled A selection'));
    const receipt = await operation(draft, 'visit:create');
    assert.equal(receipt.state, 'succeeded');
    assert.equal(receipt.input.companyId, otherCompany.id);
    assert.equal(receipt.input.fields.summary, 'Final B selection');
    assert.equal(receipt.input_reset, null);
    assert.ok(receipt.audit.filter((entry) => entry.outcome === 'unapplied_input_reset').length >= 2);
  });

  for (const failure of [
    { label: 'HTML 400', status: 400, responseText: '<html>Fixture proxy rejected the request</html>', contentType: 'text/html' },
    { label: 'unrecognized JSON 400', status: 400, response: { error: 'Fixture proxy rejected the request' } },
    { label: 'application-looking 503', status: 503, response: { statusCode: 503, messages: ['Fixture backend unavailable'] } },
  ]) {
    it(failure.label + ' stays unknown and never treats apparent absence as permission to recreate', async () => {
      const draft = await support('uncertain-' + failure.label);
      await fixture('/__fixture/fail', 'POST', { method: 'POST', path: '/rest/visits', ...failure });
      assert.equal((await confirm(draft)).status, 200);
      await settle(draft, 'unknown');
      assert.equal((await operation(draft, 'visit:create')).state, 'unknown');
      await remainsUnknown(draft, 'needs_manual_review', 'create_identity_unproven');
    });
  }

  it('a create applied before its reply was lost remains manual even when a similar remote case is visible', async () => {
    const draft = await support('unproven-create-identity');
    await fixture('/__fixture/fail', 'POST', { method: 'POST', path: '/rest/supportCases', dropAfterWrite: true });
    const before = await snapshot();
    assert.equal((await confirm(draft)).status, 200);
    await settle(draft, 'unknown');
    const afterLoss = await snapshot();
    assert.equal(Object.values(afterLoss.tables.supportCases!).filter((row) => row.name === draft.source.text).length, 1);
    assert.equal((await operation(draft, 'support:create')).state, 'unknown');
    await remainsUnknown(draft, 'needs_manual_review', 'create_identity_unproven');
    const final = await snapshot();
    assert.equal(final.audit.filter((entry) => entry.path === '/rest/supportCases' && entry.method === 'POST').length,
      before.audit.filter((entry) => entry.path === '/rest/supportCases' && entry.method === 'POST').length + 1);
    assert.equal(final.audit.filter((entry) => entry.path === '/rest/visits' && entry.applied).length,
      before.audit.filter((entry) => entry.path === '/rest/visits' && entry.applied).length + 1);
  });

  it('known-ID append readback saves a server audit and waits for explicit confirmation without duplicating the closed case write', async () => {
    const { draft, caseId } = await lostAppend('verified-lost-append', true);
    const beforeRecovery = await snapshot();
    const frozen = await operation(draft, 'support:append');
    assert.equal(frozen.request_evidence.length, 1);
    assert.equal(frozen.request_evidence[0].path, '/rest/supportCases/' + caseId);
    assert.equal(frozen.request_evidence[0].method, 'PATCH');
    assert.match(frozen.request_evidence[0].body.issueDescription.markdown, /<!-- boothnote-operation:/);
    const report = await inspect(draft);
    assert.equal(report.status, 200);
    assert.equal(report.json.status, 'unknown');
    assert.equal(report.json.recovered, false);
    assert.equal(report.json.operations[0].verdict, 'verified');
    assert.equal(report.json.operations[0].recordId, caseId);
    assert.equal((await operation(draft, 'support:append')).state, 'unknown', 'GET evidence never changes the ledger');
    const saved = await save(draft);
    assert.equal(saved.status, 200);
    assert.equal(saved.json.status, 'ready');
    assert.equal(saved.json.recovered, true);
    assert.equal(saved.json.resolvedCount, 1);
    assert.equal(saved.json.manualReviewRequired, false);
    assert.equal(writes(await snapshot()).length, writes(beforeRecovery).length);
    const receipt = await operation(draft, 'support:append');
    assert.equal(receipt.state, 'succeeded');
    assert.equal(receipt.result, null);
    assert.equal(receipt.audit.at(-1).actorId, userId);
    assert.equal(receipt.audit.at(-1).evidence.recordId, caseId);
    assert.equal(receipt.audit.at(-1).evidence.reason, 'append_marker_and_content_verified');
    assert.equal((await listProposalItems(draft.source.stagingId))[0]!.status, 'ready');
    assert.equal((await confirm(draft)).status, 200);
    await settle(draft, 'confirmed');
    const final = await snapshot();
    assert.equal(final.tables.supportCases![caseId].caseStatus, 'CLOSED');
    assert.equal(final.tables.supportCases![caseId].issueDescription.markdown,
      beforeRecovery.tables.supportCases![caseId].issueDescription.markdown);
    assert.equal(final.audit.filter((entry) => entry.path === '/rest/supportCases/' + caseId && entry.applied).length, 1);
    assert.equal(final.audit.filter((entry) => entry.path === '/rest/visits' && entry.applied).length,
      beforeRecovery.audit.filter((entry) => entry.path === '/rest/visits' && entry.applied).length);
  });

  it('POST independently rereads a target that changed after a previously verified GET', async () => {
    const { draft, caseId } = await lostAppend('changed-after-inspection');
    assert.equal((await inspect(draft)).json.operations[0].verdict, 'verified');
    await fixture('/rest/supportCases/' + caseId, 'PATCH', { severity: 'HIGH' });
    await remainsUnknown(draft, 'needs_manual_review', 'request_postcondition_changed');
  });

  it('an append marker without its exact contribution does not establish success', async () => {
    const { draft, caseId } = await lostAppend('marker-without-contribution');
    const frozen = await operation(draft, 'support:append');
    const marker = frozen.request_evidence[0].body.issueDescription.markdown.match(/<!-- boothnote-operation:[^>]+ -->/)[0];
    await fixture('/rest/supportCases/' + caseId, 'PATCH', { issueDescription: { markdown: marker } });
    await remainsUnknown(draft, 'needs_manual_review', 'append_marker_or_content_unproven');
  });

  it('an unapplied uncertain PATCH is not inferred to be safely retryable from missing progress', async () => {
    const caseId = await knownCase('uncertain-unapplied-patch');
    const draft = await support('uncertain-unapplied-patch', caseId);
    await fixture('/__fixture/fail', 'POST', { method: 'PATCH', path: '/rest/supportCases/' + caseId, status: 503 });
    assert.equal((await confirm(draft)).status, 200);
    await settle(draft, 'unknown');
    await remainsUnknown(draft, 'needs_manual_review', 'append_marker_or_content_unproven');
    assert.equal((await snapshot()).audit.filter((entry) => entry.path === '/rest/supportCases/' + caseId && entry.applied).length, 0);
  });

  it('CRM read failures preserve unknown operations rather than authorizing not-applied or success', async () => {
    const { draft, caseId } = await lostAppend('unavailable-recovery-read');
    await fixture('/__fixture/fail', 'POST', { method: 'GET', path: '/rest/supportCases/' + caseId, status: 503, times: 2 });
    await remainsUnknown(draft, 'lookup_failed', 'crm_read_failed');
  });

  it('a remote case moved to another account cannot supply recovery evidence', async () => {
    const { draft, caseId } = await lostAppend('recovery-account-mismatch');
    await fixture('/rest/supportCases/' + caseId, 'PATCH', { companyId: otherCompany.id });
    await remainsUnknown(draft, 'needs_manual_review', 'record_company_changed');
  });

  it('foreign owners, stale revisions and client-supplied recovery state or receipts are rejected atomically', async () => {
    const { draft } = await lostAppend('recovery-request-boundaries');
    const before = await snapshot();
    const ledger = await operation(draft, 'support:append');
    assert.equal((await inspect(draft, foreignToken)).status, 404);
    assert.equal((await save(draft, foreignToken)).status, 404);
    assert.equal((await call(recoveryPath(draft) + '?revision=2')).status, 404);
    assert.equal((await call(recoveryPath(draft), 'POST', { revision: 2 })).status, 404);
    for (const extra of [{ state: 'succeeded' }, { receipt: { id: randomUUID() } }, { recordId: randomUUID() }]) {
      const rejected = await call(recoveryPath(draft), 'POST', { revision: 1, ...extra });
      assert.equal(rejected.status, 422);
      assert.equal(rejected.json.error, 'invalid_recovery_request');
    }
    assert.equal((await call(recoveryPath(draft), 'POST', { revision: '1' })).status, 422);
    assert.equal((await call(recoveryPath(draft), 'POST', { revision: 0 })).status, 422);
    assert.equal((await call(recoveryPath(draft) + '?revision=1.0')).status, 422);
    assert.deepEqual(await operation(draft, 'support:append'), ledger);
    assert.equal(writes(await snapshot()).length, writes(before).length);
    assert.equal((await listProposalItems(draft.source.stagingId))[0]!.status, 'unknown');
  });
});
