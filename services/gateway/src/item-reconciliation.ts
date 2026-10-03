import { sql } from './db.ts';
import { readTwentyRecord, type TwentyRecordType } from './twenty.ts';
import { recoverProposalItem, ProposalItemError } from './proposal-items.ts';
import { canonicalItemOperationInput, hashItemOperationInput,
  type ItemOperation } from './item-operations.ts';

export type ItemRecoveryVerdict = 'verified' | 'needs_manual_review' | 'lookup_failed';
export type ItemRecoveryEvidence = {
  operationId: string; role: string; state: ItemOperation['state'];
  verdict: ItemRecoveryVerdict; reason: string; checkedAt: string;
  recordType?: TwentyRecordType; recordId?: string;
  expected?: Record<string, unknown>; observed?: Record<string, unknown>;
};
export type ItemRecoveryReport = {
  itemId: string; revision: number; status: string; recovered: boolean;
  resolvedCount: number; operations: ItemRecoveryEvidence[]; manualReviewRequired: boolean;
};
export type ItemRecoverySubject = {
  itemId: string; revision: number; revisionId: string; status: string;
  companyId: string; operations: ItemOperation[];
};
export interface ItemRecoveryRepository {
  loadOwned(itemId: string, userId: string, revision: number): Promise<ItemRecoverySubject>;
  resolveVerified(subject: ItemRecoverySubject, operation: ItemOperation, evidence: ItemRecoveryEvidence, userId: string): Promise<boolean>;
  recover(subject: ItemRecoverySubject, userId: string): Promise<boolean>;
}
export type ItemRecoveryDependencies = {
  repository?: ItemRecoveryRepository; read?: typeof readTwentyRecord; now?: () => Date;
};

const recordObjects: Record<string, TwentyRecordType> = {
  visits: 'visit', supportCases: 'supportCase', projects: 'project',
  workItems: 'workItem', productFitments: 'productFitment', opportunities: 'opportunity',
};
const objectForRole = (role: string): TwentyRecordType | undefined => {
  if (/^visit:(update|project-link)$/.test(role)) return 'visit';
  if (/^support:(update|append|correction)$/.test(role)) return 'supportCase';
  if (role === 'project:update') return 'project';
  if (role === 'fitment:update') return 'productFitment';
  if (role === 'opportunity:update') return 'opportunity';
  if (/^work:.+:(update|dependency)$/.test(role)) return 'workItem';
  return undefined;
};
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const sameRequestedValue = (expected: unknown, actual: unknown): boolean => {
  if (actual === undefined) return false;
  const shape = object(expected);
  if (shape) {
    const current = object(actual);
    return !!current && Object.entries(shape).every(([key, value]) => sameRequestedValue(value, current[key]));
  }
  return canonicalItemOperationInput(expected) === canonicalItemOperationInput(actual);
};
const currentField = (row: Record<string, unknown>, key: string): unknown => {
  if (Object.hasOwn(row, key)) return row[key];
  if (key.endsWith('Id')) return object(row[key.slice(0, -2)])?.['id'];
  return undefined;
};

/** Absence or a matching name is never proof that a create was not applied. */
export const inspectItemOperation = async (
  operation: ItemOperation, subject: Pick<ItemRecoverySubject, 'revisionId' | 'companyId'>,
  read: typeof readTwentyRecord = readTwentyRecord, now = () => new Date(),
): Promise<ItemRecoveryEvidence> => {
  const base = { operationId: operation.id, role: operation.role, state: operation.state, checkedAt: now().toISOString() };
  const manual = (reason: string, extra: Partial<ItemRecoveryEvidence> = {}): ItemRecoveryEvidence =>
    ({ ...base, verdict: 'needs_manual_review', reason,
      expected: operation.request_evidence?.length ? { requests: operation.request_evidence } : { proposal: operation.input }, ...extra });
  if (operation.state !== 'unknown') return manual('operation_not_unknown');
  if (operation.role.endsWith(':create')) return manual('create_identity_unproven');
  const type = objectForRole(operation.role);
  const requests = operation.request_evidence ?? [];
  if (!type || requests.length !== 1) return manual('request_evidence_unavailable');
  const request = requests[0]!;
  const match = /^\/rest\/([A-Za-z]+)\/([a-f0-9-]{36})$/i.exec(request.path);
  const fields = object(request.body);
  const input = object(operation.input);
  const boundId = input?.['targetId'] ?? object(input?.['target'])?.['id'];
  if (request.method !== 'PATCH' || !match || recordObjects[match[1]!] !== type ||
      !fields || !Object.keys(fields).length || boundId !== match[2] || input?.['companyId'] !== subject.companyId) {
    return manual('request_target_unproven');
  }
  const recordId = match[2]!;
  let row: Record<string, unknown> | undefined;
  try { row = object(await read(type, recordId)); }
  catch { return { ...base, verdict: 'lookup_failed', reason: 'crm_read_failed', recordType: type, recordId }; }
  if (!row || row['id'] !== recordId || row['deletedAt']) return manual('record_missing_or_deleted', { recordType: type, recordId });
  const companyId = row['companyId'] ?? object(row['company'])?.['id'];
  if (companyId !== subject.companyId) return manual('record_company_changed', { recordType: type, recordId });
  const observed = Object.fromEntries(Object.keys(fields).map((key) => [key, currentField(row!, key)]));
  const extra = { recordType: type, recordId, expected: fields, observed };
  const append = operation.role === 'support:append' || operation.role === 'support:correction';
  if (append) {
    const marker = `<!-- boothnote-operation:${subject.revisionId}:${operation.role} -->`;
    const expectedMarkdown = object(fields['issueDescription'])?.['markdown'];
    const actualMarkdown = object(row['issueDescription'])?.['markdown'];
    if (typeof expectedMarkdown !== 'string' || typeof actualMarkdown !== 'string') return manual('append_evidence_unavailable', extra);
    const markerAt = expectedMarkdown.indexOf(marker);
    const start = expectedMarkdown.lastIndexOf('\n\n---\n\n### 进展', markerAt);
    if (markerAt < 0 || start < 0 || expectedMarkdown.indexOf(marker, markerAt + marker.length) >= 0 ||
        !actualMarkdown.includes(expectedMarkdown.slice(start, markerAt + marker.length))) {
      return manual('append_marker_or_content_unproven', extra);
    }
    if (!Object.entries(fields).every(([key, value]) => key === 'issueDescription' || sameRequestedValue(value, currentField(row!, key)))) {
      return manual('request_postcondition_changed', extra);
    }
  } else if (!Object.entries(fields).every(([key, value]) => sameRequestedValue(value, currentField(row!, key)))) {
    return manual('request_postcondition_changed', extra);
  }
  return { ...base, verdict: 'verified', reason: append ? 'append_marker_and_content_verified' : 'request_postcondition_verified', ...extra };
};

const postgresRecoveryRepository: ItemRecoveryRepository = {
  async loadOwned(itemId, userId, revision) {
    const [row] = await sql<Array<{ id: string; status: string; company_id: string | null; confirm_payload: { companyId?: string } | null }>>`
      select r.id, r.status, r.company_id, r.confirm_payload from proposal_item i
      join proposal_revision r on r.item_id = i.id and r.revision = i.current_revision
      where i.id = ${itemId} and i.user_id = ${userId} and i.current_revision = ${revision}`;
    if (!row) throw new ProposalItemError('item_not_found_or_stale', 404);
    const companyId = row.confirm_payload?.companyId ?? row.company_id;
    if (!companyId) throw new ProposalItemError('item_company_required', 422);
    const operations = await sql<ItemOperation[]>`
      select id, revision_id, role, input_hash, input, state, result, error, attempt_id, request_evidence
      from item_operation where revision_id = ${row.id} and state in ('unknown', 'running') order by created_at, id`;
    return { itemId, revision, revisionId: row.id, status: row.status, companyId, operations };
  },
  async resolveVerified(subject, operation, evidence, userId) {
    if (evidence.verdict !== 'verified') return false;
    return sql.begin(async (tx) => {
      const [owned] = await tx`select r.id from proposal_item i join proposal_revision r on r.item_id = i.id
        where i.id = ${subject.itemId} and i.user_id = ${userId} and i.current_revision = ${subject.revision}
          and r.id = ${subject.revisionId} and r.status = 'unknown' for update of i, r`;
      if (!owned) return false;
      const result = /^work:.+:update$/.test(operation.role) ? evidence.recordId! : null;
      const audit = { actorId: userId, at: new Date().toISOString(), outcome: 'succeeded',
        previousState: 'unknown', previousError: operation.error, previousAttemptId: operation.attempt_id,
        evidence: { reason: evidence.reason, checkedAt: evidence.checkedAt, recordType: evidence.recordType,
          recordId: evidence.recordId, requestHash: hashItemOperationInput(operation.request_evidence),
          observedHash: hashItemOperationInput(evidence.observed) } };
      const rows = await tx`update item_operation set state = 'succeeded', result = ${tx.json(result)},
        error = null, attempt_id = null, audit = audit || ${tx.json([audit] as never)}, updated_at = now()
        where id = ${operation.id} and revision_id = ${subject.revisionId} and state = 'unknown'
          and input_hash = ${operation.input_hash} and attempt_id is not distinct from ${operation.attempt_id}
          and request_evidence = ${tx.json((operation.request_evidence ?? []) as never)} returning id`;
      return rows.length > 0;
    });
  },
  recover: (subject, userId) => recoverProposalItem(subject.itemId, userId, subject.revision),
};

const reportFor = async (subject: ItemRecoverySubject, dependencies: ItemRecoveryDependencies): Promise<ItemRecoveryReport> => ({
  itemId: subject.itemId, revision: subject.revision, status: subject.status, recovered: false, resolvedCount: 0,
  operations: await Promise.all(subject.operations.map((operation) => inspectItemOperation(operation, subject, dependencies.read, dependencies.now))),
  manualReviewRequired: false,
});

export const inspectItemRecovery = async (
  itemId: string, userId: string, revision: number, dependencies: ItemRecoveryDependencies = {},
): Promise<ItemRecoveryReport> => {
  const repository = dependencies.repository ?? postgresRecoveryRepository;
  const report = await reportFor(await repository.loadOwned(itemId, userId, revision), dependencies);
  report.manualReviewRequired = report.operations.some((entry) => entry.verdict !== 'verified');
  return report;
};

/** Only service-side readback proofs can mark success; this never retries CRM writes. */
export const reconcileItemRecovery = async (
  itemId: string, userId: string, revision: number, dependencies: ItemRecoveryDependencies = {},
): Promise<ItemRecoveryReport> => {
  const repository = dependencies.repository ?? postgresRecoveryRepository;
  const subject = await repository.loadOwned(itemId, userId, revision);
  if (subject.status !== 'unknown') throw new ProposalItemError('item_not_unknown', 409);
  const report = await reportFor(subject, dependencies);
  for (let index = 0; index < subject.operations.length; index++) {
    const evidence = report.operations[index]!;
    if (evidence.verdict === 'verified' && await repository.resolveVerified(subject, subject.operations[index]!, evidence, userId)) {
      report.resolvedCount++;
      evidence.state = 'succeeded';
    }
  }
  report.recovered = await repository.recover(subject, userId);
  if (report.recovered) report.status = 'ready';
  const remaining = await repository.loadOwned(itemId, userId, revision);
  report.manualReviewRequired = remaining.operations.length > 0;
  return report;
};
