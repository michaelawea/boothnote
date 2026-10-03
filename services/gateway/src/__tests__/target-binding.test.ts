import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateTargetBinding, TargetValidationError } from '../targetCandidates.ts';
import { sql } from '../db.ts';
import type { TargetBinding } from '../../../../shared/agent-questions.mjs';

after(() => sql.end());
const id = '11111111-1111-4111-8111-111111111111';
const companyId = '22222222-2222-4222-8222-222222222222';
const target: TargetBinding = { type: 'supportCase', id, companyId, action: 'append',
  status: 'NEW', updatedAt: '2026-10-03T01:00:00Z' };
const check = async (binding: TargetBinding, patch: Record<string, unknown> = {}) => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { supportCase: {
    id, companyId, caseStatus: 'IN_PROGRESS', updatedAt: '2026-10-03T02:00:00Z', ...patch,
  } } }), { headers: { 'content-type': 'application/json' } });
  try { await validateTargetBinding(binding, companyId); }
  finally { globalThis.fetch = saved; }
};

describe('append target identity survives another append, without weakening replace conflicts', () => {
  it('allows a prior append to change updatedAt and move NEW to IN_PROGRESS', async () => {
    await check(target);
  });
  it('replacement still rejects changed status or content version', async () => {
    await assert.rejects(check({ ...target, action: 'update' }), (error: unknown) =>
      error instanceof TargetValidationError && error.code === 'target_changed');
    await assert.rejects(check({ ...target, action: 'update' }, { caseStatus: 'NEW' }), (error: unknown) =>
      error instanceof TargetValidationError && error.code === 'target_changed');
  });
  it('append still rejects closed cases, moved customers and deleted records', async () => {
    for (const [patch, code] of [
      [{ caseStatus: 'CLOSED' }, 'target_closed'],
      [{ companyId: id }, 'target_company_mismatch'],
      [{ deletedAt: '2026-10-03T02:00:00Z' }, 'target_not_found'],
    ] as const) {
      await assert.rejects(check(target, patch), (error: unknown) => error instanceof TargetValidationError && error.code === code);
    }
  });
  it('append cannot silently follow a changed record code', async () => {
    await assert.rejects(check({ ...target, code: 'CASE-FIXTURE' }, { projectCode: 'CASE-CHANGED' }), (error: unknown) =>
      error instanceof TargetValidationError && error.code === 'target_changed');
  });
});
