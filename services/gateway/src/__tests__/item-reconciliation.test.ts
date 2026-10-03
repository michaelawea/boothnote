import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inspectItemOperation, inspectItemRecovery, reconcileItemRecovery,
  type ItemRecoveryRepository, type ItemRecoverySubject } from '../item-reconciliation.ts';
import type { ItemOperation } from '../item-operations.ts';
import { sql } from '../db.ts';

after(() => sql.end());
const revisionId = '11111111-1111-4111-8111-111111111111';
const recordId = '22222222-2222-4222-8222-222222222222';
const companyId = '33333333-3333-4333-8333-333333333333';
const subject = { revisionId, companyId };
const operation = (patch: Partial<ItemOperation> = {}): ItemOperation => ({
  id: 'operation-fixture', revision_id: revisionId, role: 'support:update', input_hash: 'fixture-hash',
  input: { companyId, targetId: recordId }, state: 'unknown', result: null, error: 'reply lost', attempt_id: 'attempt-fixture',
  request_evidence: [{ method: 'PATCH', path: `/rest/supportCases/${recordId}`, body: { caseStatus: 'IN_PROGRESS', severity: 'HIGH' } }],
  ...patch,
});
const row = (patch: Record<string, unknown> = {}) => ({ id: recordId, companyId, caseStatus: 'IN_PROGRESS', severity: 'HIGH', ...patch });
const inspect = (op: ItemOperation, current: Record<string, unknown> | null = row()) => inspectItemOperation(op, subject, async () => current);

describe('CRM evidence proves a known operation, never mere existence', () => {
  it('verifies every frozen PATCH field and preserves its known target identity', async () => {
    const evidence = await inspect(operation());
    assert.equal(evidence.verdict, 'verified');
    assert.equal(evidence.reason, 'request_postcondition_verified');
    assert.equal(evidence.recordId, recordId);
  });
  it('a record in the same company is insufficient when the requested field was not written', async () => {
    assert.equal((await inspect(operation(), row({ severity: 'LOW' }))).verdict, 'needs_manual_review');
  });
  it('missing response fields cannot stand in for a requested explicit null', async () => {
    const op = operation({ request_evidence: [{ method: 'PATCH', path: `/rest/supportCases/${recordId}`, body: { severity: null } }] });
    assert.equal((await inspect(op, { id: recordId, companyId })).verdict, 'needs_manual_review');
  });
  it('a deleted or missing record cannot prove either succeeded or not-applied', async () => {
    for (const current of [null, row({ deletedAt: '2026-10-03T00:00:00Z' })]) {
      assert.equal((await inspect(operation(), current)).reason, 'record_missing_or_deleted');
    }
  });
  it('a company move rejects readback even when the requested fields match', async () => {
    assert.equal((await inspect(operation(), row({ companyId: recordId }))).reason, 'record_company_changed');
  });
  it('read failure preserves uncertainty without suggesting that the target is absent', async () => {
    const result = await inspectItemOperation(operation(), subject, async () => { throw new Error('503'); });
    assert.equal(result.verdict, 'lookup_failed');
    assert.equal(result.reason, 'crm_read_failed');
  });
  it('create remains manual even when a similar record exists; it never searches or marks not-applied', async () => {
    let reads = 0;
    const result = await inspectItemOperation(operation({ role: 'support:create' }), subject, async () => { reads++; return row(); });
    assert.equal(result.reason, 'create_identity_unproven');
    assert.equal(reads, 0);
  });
  it('legacy operations without frozen requests remain manual', async () => {
    assert.equal((await inspect(operation({ request_evidence: undefined }))).reason, 'request_evidence_unavailable');
  });
  it('multiple mutations cannot be resolved from a single matching record', async () => {
    const op = operation();
    op.request_evidence!.push(op.request_evidence![0]!);
    assert.equal((await inspect(op)).reason, 'request_evidence_unavailable');
  });
  it('request resource and semantic target must agree with the role', async () => {
    assert.equal((await inspect(operation({ request_evidence: [{ method: 'PATCH', path: `/rest/projects/${recordId}`, body: { severity: 'HIGH' } }] }))).reason, 'request_target_unproven');
    assert.equal((await inspect(operation({ input: { companyId, targetId: companyId } }))).reason, 'request_target_unproven');
  });
  it('rich text comparisons tolerate returned metadata but require the same requested markdown', async () => {
    const op = operation({ role: 'work:FIXTURE:update', request_evidence: [{ method: 'PATCH', path: `/rest/workItems/${recordId}`, body: { body: { markdown: 'Fictional task' }, projectId: companyId } }] });
    assert.equal((await inspect(op, row({ body: { markdown: 'Fictional task', blocknote: 'provider data' }, project: { id: companyId } }))).verdict, 'verified');
    assert.equal((await inspect(op, row({ body: { markdown: 'Different task' }, projectId: companyId }))).verdict, 'needs_manual_review');
  });
});

describe('append evidence includes both its operation marker and actual contribution', () => {
  const marker = `<!-- boothnote-operation:${revisionId}:support:append -->`;
  const contribution = `\n\n---\n\n### 进展 · 2026-10-03 · Fixture User\n\nFictional tested contribution\n\n${marker}`;
  const append = () => operation({ role: 'support:append', input: { companyId, target: { id: recordId } },
    request_evidence: [{ method: 'PATCH', path: `/rest/supportCases/${recordId}`, body: { issueDescription: { markdown: `Earlier record${contribution}` }, caseStatus: 'IN_PROGRESS' } }] });
  it('verifies the full frozen appended segment even if later contributions follow it', async () => {
    const result = await inspect(append(), row({ issueDescription: { markdown: `Earlier record${contribution}\n\nLater contribution` } }));
    assert.equal(result.verdict, 'verified');
    assert.equal(result.reason, 'append_marker_and_content_verified');
  });
  it('an operation marker by itself cannot fabricate a successful append', async () => {
    assert.equal((await inspect(append(), row({ issueDescription: { markdown: marker } }))).reason, 'append_marker_or_content_unproven');
  });
  it('the appended content without the unique marker cannot prove this operation', async () => {
    assert.equal((await inspect(append(), row({ issueDescription: { markdown: contribution.replace(marker, '') } }))).verdict, 'needs_manual_review');
  });
  it('a later changed status makes a compound append request require review', async () => {
    assert.equal((await inspect(append(), row({ caseStatus: 'CLOSED', issueDescription: { markdown: contribution } }))).reason, 'request_postcondition_changed');
  });
});

const repositoryFixture = (operations = [operation()]) => {
  const current: ItemRecoverySubject = { itemId: 'item-fixture', revision: 2, revisionId, companyId, status: 'unknown', operations };
  const resolved: Array<{ id: string; userId: string }> = [];
  let recovered = 0;
  let casBlocked = false;
  const repository: ItemRecoveryRepository = {
    async loadOwned(itemId, userId, revision) {
      assert.equal(itemId, current.itemId); assert.equal(userId, 'owner-fixture'); assert.equal(revision, current.revision);
      return structuredClone(current);
    },
    async resolveVerified(_subject, op, evidence, userId) {
      assert.equal(evidence.verdict, 'verified');
      if (casBlocked) return false;
      resolved.push({ id: op.id, userId });
      current.operations = current.operations.filter((entry) => entry.id !== op.id);
      return true;
    },
    async recover() {
      if (current.operations.length) return false;
      recovered++;
      current.status = 'ready';
      return true;
    },
  };
  return { current, resolved, repository, recovered: () => recovered, blockCAS: () => { casBlocked = true; } };
};

describe('owner-scoped recovery does not perform or trust client CRM writes', () => {
  it('inspection is read-only and only forwards the requested owner/current revision', async () => {
    const f = repositoryFixture();
    const result = await inspectItemRecovery('item-fixture', 'owner-fixture', 2, { repository: f.repository, read: async () => row() });
    assert.equal(result.recovered, false);
    assert.equal(result.resolvedCount, 0);
    assert.equal(f.resolved.length, 0);
    assert.equal(f.recovered(), 0);
  });
  it('verified receipts recover the same revision to ready; they never enqueue a mutation', async () => {
    const f = repositoryFixture();
    const result = await reconcileItemRecovery('item-fixture', 'owner-fixture', 2, { repository: f.repository, read: async () => row() });
    assert.equal(result.recovered, true);
    assert.equal(result.status, 'ready');
    assert.equal(result.resolvedCount, 1);
    assert.equal(result.operations[0]!.state, 'succeeded');
    assert.deepEqual(f.resolved, [{ id: 'operation-fixture', userId: 'owner-fixture' }]);
  });
  it('partly proven operations keep the item unknown until every uncertain step is resolved', async () => {
    const f = repositoryFixture([operation(), operation({ id: 'unknown-create', role: 'visit:create' })]);
    const result = await reconcileItemRecovery('item-fixture', 'owner-fixture', 2, { repository: f.repository, read: async () => row() });
    assert.equal(result.resolvedCount, 1);
    assert.equal(result.recovered, false);
    assert.equal(result.manualReviewRequired, true);
    assert.equal(result.status, 'unknown');
    assert.equal(f.current.operations[0]!.id, 'unknown-create');
  });
  it('a stale CAS proof cannot recover or overwrite another operation attempt', async () => {
    const f = repositoryFixture(); f.blockCAS();
    const result = await reconcileItemRecovery('item-fixture', 'owner-fixture', 2, { repository: f.repository, read: async () => row() });
    assert.equal(result.resolvedCount, 0);
    assert.equal(result.recovered, false);
    assert.equal(result.manualReviewRequired, true);
  });
  it('missing evidence never creates a not-applied decision or releases a retry', async () => {
    const f = repositoryFixture([operation({ request_evidence: undefined })]);
    const result = await reconcileItemRecovery('item-fixture', 'owner-fixture', 2, { repository: f.repository, read: async () => null });
    assert.equal(result.resolvedCount, 0);
    assert.equal(result.recovered, false);
    assert.equal(f.resolved.length, 0);
  });
});
