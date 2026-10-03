import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canonicalItemOperationInput,
  DefiniteItemOperationError,
  durableItemOperation,
  hashItemOperationInput,
  ItemOperationConflictError,
  markInterruptedItemOperationsUnknown,
  itemOperationResetInput,
  recordItemMutationRequest,
  resolveUnknownItemOperation,
  UnknownItemOperationError,
  type ItemOperation,
  type ItemOperationResolution,
  type ItemOperationStore,
} from '../item-operations.ts';
import { TwentyHttpError } from '../twenty-errors.ts';

class MemoryStore implements ItemOperationStore {
  rows = new Map<string, ItemOperation>();
  audit: Array<Record<string, unknown>> = [];
  failReceipt = false;
  failRequest = false;
  key(revisionId: string, role: string) { return `${revisionId}/${role}`; }
  async getOrCreate(revisionId: string, role: string, hash: string, input: unknown) {
    const key = this.key(revisionId, role);
    if (!this.rows.has(key)) {
      this.rows.set(key, {
        id: key, revision_id: revisionId, role, input_hash: hash,
        input: structuredClone(input), state: 'planned', result: null, error: null, attempt_id: null,
      });
    }
    return structuredClone(this.rows.get(key)!);
  }
  async get(revisionId: string, role: string) {
    return structuredClone(this.rows.get(this.key(revisionId, role)) ?? null);
  }
  async claim(id: string, hash: string, _at: Date, attemptId: string) {
    const row = this.rows.get(id)!;
    if (row.input_hash !== hash || row.input_reset != null || !['planned', 'failed'].includes(row.state)) return false;
    row.state = 'running';
    row.attempt_id = attemptId;
    row.request_evidence = [];
    return true;
  }
  async succeed(id: string, result: unknown, _at: Date, attemptId: string) {
    if (this.failReceipt) throw new Error('receipt database unavailable');
    const row = this.rows.get(id)!;
    if (row.state !== 'running' || row.attempt_id !== attemptId) return false;
    row.state = 'succeeded';
    row.result = structuredClone(result);
    row.error = null;
    return true;
  }
  async fail(id: string, state: 'failed' | 'unknown', error: string, _at: Date, attemptId: string) {
    const row = this.rows.get(id)!;
    if (row.state !== 'running' || row.attempt_id !== attemptId) return false;
    row.state = state;
    row.error = error;
    return true;
  }
  async markInterrupted() {
    let count = 0;
    for (const row of this.rows.values()) {
      if (row.state === 'running') {
        row.state = 'unknown';
        row.error = 'Gateway stopped while the remote operation was running';
        count++;
      }
    }
    return count;
  }
  async recordRequest(id: string, request: NonNullable<ItemOperation['request_evidence']>[number], _at: Date, attemptId: string) {
    if (this.failRequest) throw new Error('request database unavailable');
    const row = this.rows.get(id)!;
    if (row.state !== 'running' || row.attempt_id !== attemptId) return false;
    (row.request_evidence ??= []).push(structuredClone(request));
    return true;
  }
  async bindResetInput(id: string, previousHash: string, hash: string, input: unknown) {
    const row = this.rows.get(id)!;
    if (row.input_hash !== previousHash || !['planned','failed'].includes(row.state) ||
        canonicalItemOperationInput(row.input_reset) !== canonicalItemOperationInput(itemOperationResetInput(input))) return false;
    row.input_hash = hash; row.input = structuredClone(input); row.input_reset = null; row.state = 'planned'; row.error = null;
    return true;
  }
  async resolve(revisionId: string, role: string, resolution: ItemOperationResolution, actorId: string, at: Date) {
    const row = this.rows.get(this.key(revisionId, role));
    if (row?.state !== 'unknown') return false;
    this.audit.push({
      actorId, at: at.toISOString(), outcome: resolution.outcome,
      previousState: row.state, previousError: row.error, previousAttemptId: row.attempt_id,
    });
    row.state = resolution.outcome === 'succeeded' ? 'succeeded' : 'planned';
    row.result = resolution.outcome === 'succeeded' ? structuredClone(resolution.result) : null;
    row.error = null;
    row.attempt_id = null;
    return true;
  }
}

const fixture = () => {
  const store = new MemoryStore();
  const now = () => new Date('2026-10-03T09:15:00Z');
  const options = { store, now };
  return { store, options, run: <T>(execute: () => Promise<T>, input: unknown = { companyId: 'company-1' }) =>
    durableItemOperation('revision-1', 'create-case', input, execute, options) };
};

describe('stable operation inputs', () => {
  it('object key order does not change identity; arrays retain order', () => {
    assert.equal(hashItemOperationInput({ b: { c: 2, a: 1 }, a: 3 }), hashItemOperationInput({ a: 3, b: { a: 1, c: 2 } }));
    assert.notEqual(hashItemOperationInput([1, 2]), hashItemOperationInput([2, 1]));
  });
  it('omitted optional fields have JSON semantics and dates are stable', () => {
    assert.equal(canonicalItemOperationInput({ empty: undefined, date: new Date('2026-10-03Z') }), '{"date":"2026-10-03T00:00:00.000Z"}');
    assert.equal(canonicalItemOperationInput([undefined, , 1]), '[null,null,1]');
    assert.equal(canonicalItemOperationInput(undefined), 'null');
  });
  it('invalid numbers, bigints and cycles cannot silently collide with valid JSON', () => {
    assert.throws(() => hashItemOperationInput({ n: NaN }), TypeError);
    assert.throws(() => hashItemOperationInput({ n: Infinity }), TypeError);
    assert.throws(() => hashItemOperationInput({ n: 1n }), TypeError);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    assert.throws(() => hashItemOperationInput(cycle), TypeError);
  });
});

describe('durable remote operation', () => {
  it('saves success immediately and replays it without executing twice', async () => {
    const { run, store } = fixture();
    let writes = 0;
    const execute = async () => { writes++; return { caseId: 'case-1' }; };
    assert.deepEqual(await run(execute), { caseId: 'case-1' });
    assert.equal(store.rows.get('revision-1/create-case')!.state, 'succeeded');
    assert.deepEqual(await run(execute), { caseId: 'case-1' });
    assert.equal(writes, 1);
  });
  it('reordered equivalent input replays the same result', async () => {
    const { run } = fixture();
    await run(async () => 'case-1', { companyId: 'c', fields: { a: 1, b: 2 } });
    assert.equal(await run(async () => assert.fail('must replay'), { fields: { b: 2, a: 1 }, companyId: 'c' }), 'case-1');
  });
  it('concurrent duplicate attempts atomically claim one writer', async () => {
    const { run } = fixture();
    let writes = 0;
    let started!: () => void;
    let finish!: (value: string) => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const remote = new Promise<string>((resolve) => { finish = resolve; });
    const first = run(async () => { writes++; started(); return remote; });
    await entered;
    await assert.rejects(run(async () => { writes++; return 'case-duplicate'; }), UnknownItemOperationError);
    finish('case-1');
    assert.equal(await first, 'case-1');
    assert.equal(writes, 1);
  });
  it('simultaneous claims from planned snapshots execute only once', async () => {
    const { run } = fixture();
    let writes = 0;
    const results = await Promise.allSettled([
      run(async () => { writes++; return 'case-1'; }),
      run(async () => { writes++; return 'case-1'; }),
    ]);
    assert.equal(writes, 1);
    assert.ok(results.some((r) => r.status === 'fulfilled' && r.value === 'case-1'));
    for (const result of results) {
      if (result.status === 'rejected') assert.ok(result.reason instanceof UnknownItemOperationError);
    }
  });
  it('different input for the same role is a 409 even after success', async () => {
    const { run } = fixture();
    await run(async () => 'case-1');
    await assert.rejects(run(async () => assert.fail('must not execute'), { companyId: 'company-2' }),
      (error: unknown) => error instanceof ItemOperationConflictError && error.statusCode === 409);
  });
  it('lost remote reply is unknown and a normal retry cannot duplicate its mutation', async () => {
    const { run, store } = fixture();
    let writes = 0;
    await assert.rejects(run(async () => { writes++; throw new Error('socket closed after mutation'); }), UnknownItemOperationError);
    const row = store.rows.get('revision-1/create-case')!;
    assert.equal(row.state, 'unknown');
    assert.match(row.error!, /socket closed/);
    await assert.rejects(run(async () => { writes++; return 'duplicate'; }), UnknownItemOperationError);
    assert.equal(writes, 1);
  });
  it('failure to persist a success receipt also blocks retries', async () => {
    const { run, store } = fixture();
    let writes = 0;
    store.failReceipt = true;
    await assert.rejects(run(async () => { writes++; return 'case-1'; }), UnknownItemOperationError);
    assert.equal(store.rows.get('revision-1/create-case')!.state, 'unknown');
    store.failReceipt = false;
    await assert.rejects(run(async () => { writes++; return 'duplicate'; }), UnknownItemOperationError);
    assert.equal(writes, 1);
  });
  it('an unserializable remote result cannot be reported as a durable success', async () => {
    const { run, store } = fixture();
    await assert.rejects(run(async () => 1n), UnknownItemOperationError);
    assert.equal(store.rows.get('revision-1/create-case')!.state, 'unknown');
  });
  it('only an explicitly definite not-applied error permits a normal retry', async () => {
    const { run, store } = fixture();
    await assert.rejects(run(async () => { throw new DefiniteItemOperationError('local preflight failed before any request'); }), DefiniteItemOperationError);
    assert.equal(store.rows.get('revision-1/create-case')!.state, 'failed');
    assert.equal(await run(async () => 'case-1'), 'case-1');
  });
  it('a structured Twenty validation rejection is failed while 5xx and proxy errors remain unknown', async () => {
    for (const [status, response, expected] of [
      [400, { statusCode: 400, messages: ['Invalid enum value'] }, 'failed'],
      [503, { statusCode: 503, messages: ['Server unavailable'] }, 'unknown'],
      [400, { raw: '<html>proxy error</html>' }, 'unknown'],
    ] as const) {
      const { run, store } = fixture();
      await assert.rejects(run(async () => { throw new TwentyHttpError('POST', '/rest/visits', status, response, JSON.stringify(response)); }));
      assert.equal(store.rows.get('revision-1/create-case')!.state, expected);
    }
  });
  it('a void result is stored as JSON null and replays without executing', async () => {
    const { run, store } = fixture();
    await run(async () => undefined);
    assert.equal(store.rows.get('revision-1/create-case')!.result, null);
    assert.equal(await run(async () => assert.fail('must not repeat void operation')), null);
  });
  it('errors are bounded before storage', async () => {
    const { run, store } = fixture();
    await assert.rejects(run(async () => { throw new Error('bad\n'.repeat(1000)); }), UnknownItemOperationError);
    assert.equal(store.rows.get('revision-1/create-case')!.error!.length, 500);
    assert.ok(!store.rows.get('revision-1/create-case')!.error!.includes('\n'));
  });
});

describe('request evidence is frozen before a remote mutation and fenced by attempt', () => {
  const request = { method: 'PATCH', path: '/rest/supportCases/fixture', body: { caseStatus: 'IN_PROGRESS' } };
  it('records a detached request before execute can mutate its caller payload', async () => {
    const { run, store } = fixture();
    const mutable = structuredClone(request);
    await run(async () => { await recordItemMutationRequest(mutable); mutable.body.caseStatus = 'CLOSED'; return 'case-1'; });
    assert.deepEqual(store.rows.get('revision-1/create-case')!.request_evidence, [request]);
  });
  it('failure to store a request prevents the remote write and permits a later clean attempt', async () => {
    const { run, store } = fixture(); let writes = 0;
    store.failRequest = true;
    await assert.rejects(run(async () => { await recordItemMutationRequest(request); writes++; return 'case-1'; }), DefiniteItemOperationError);
    assert.equal(writes, 0);
    assert.equal(store.rows.get('revision-1/create-case')!.state, 'failed');
    store.failRequest = false;
    await run(async () => { await recordItemMutationRequest(request); writes++; return 'case-1'; });
    assert.equal(writes, 1);
  });
  it('a definitely rejected retry replaces only its own previous-attempt wire evidence', async () => {
    const { run, store } = fixture();
    await assert.rejects(run(async () => { await recordItemMutationRequest(request); throw new DefiniteItemOperationError('rejected'); }));
    const later = { ...request, body: { caseStatus: 'CLOSED' } };
    await run(async () => { await recordItemMutationRequest(later); return 'case-1'; });
    assert.deepEqual(store.rows.get('revision-1/create-case')!.request_evidence, [later]);
  });
  it('concurrent item contexts do not attach one account request to another journal entry', async () => {
    const { store, options } = fixture();
    await Promise.all(['one', 'two'].map((revision) => durableItemOperation(revision, 'update', {}, async () => {
      await Promise.resolve();
      await recordItemMutationRequest({ ...request, path: `/rest/supportCases/${revision}` });
    }, options)));
    assert.equal(store.rows.get('one/update')!.request_evidence![0]!.path, '/rest/supportCases/one');
    assert.equal(store.rows.get('two/update')!.request_evidence![0]!.path, '/rest/supportCases/two');
  });
  it('a second distinct mutation cannot classify an already sent operation as not-applied', async () => {
    const { run, store } = fixture(); let writes = 0;
    await assert.rejects(run(async () => {
      await recordItemMutationRequest(request); writes++;
      await recordItemMutationRequest({ ...request, body: { caseStatus: 'CLOSED' } }); writes++;
    }), UnknownItemOperationError);
    assert.equal(writes, 1);
    assert.equal(store.rows.get('revision-1/create-case')!.state, 'unknown');
  });
});

describe('explicit unapplied reset binds only the payload authorized before writes', () => {
  const previous = { companyId: 'company-1', fields: { severity: 'LOW' }, target: null };
  const corrected = { companyId: 'company-1', fields: { severity: 'HIGH' }, target: null };
  it('failed input cannot change without the queue authorizing a safe reset', async () => {
    const { store, options } = fixture();
    await assert.rejects(durableItemOperation('revision-1','visit:create',previous,async()=>{ throw new DefiniteItemOperationError('validation'); },options));
    await assert.rejects(durableItemOperation('revision-1','visit:create',corrected,async()=>assert.fail('must not mutate'),options),ItemOperationConflictError);
    store.rows.get('revision-1/visit:create')!.input_reset = itemOperationResetInput(corrected);
    assert.equal(await durableItemOperation('revision-1','visit:create',corrected,async()=>'visit-1',options),'visit-1');
    assert.equal(store.rows.get('revision-1/visit:create')!.input_reset,null);
  });
  it('a reset prepares later planned steps before the first corrected step succeeds', async () => {
    const { store, options } = fixture();
    for (const role of ['visit:create','support:update']) {
      await store.getOrCreate('revision-1',role,hashItemOperationInput(previous),previous);
      store.rows.get(`revision-1/${role}`)!.input_reset = itemOperationResetInput(corrected);
    }
    assert.equal(await durableItemOperation('revision-1','visit:create',corrected,async()=>'visit-1',options),'visit-1');
    const exactTarget = { ...corrected, targetId: 'known-support-id' };
    await durableItemOperation('revision-1','support:update',exactTarget,async()=>undefined,options);
    assert.equal(store.rows.get('revision-1/support:update')!.state,'succeeded');
    assert.deepEqual(store.rows.get('revision-1/support:update')!.input,exactTarget);
  });
  it('an old caller cannot claim a planned reset using the previous matching input hash', async () => {
    const { store, options } = fixture();
    await store.getOrCreate('revision-1','visit:create',hashItemOperationInput(previous),previous);
    store.rows.get('revision-1/visit:create')!.input_reset = itemOperationResetInput(corrected);
    await assert.rejects(durableItemOperation('revision-1','visit:create',previous,async()=>assert.fail('stale write'),options),ItemOperationConflictError);
    assert.equal(store.rows.get('revision-1/visit:create')!.state,'planned');
  });
});

describe('controlled reconciliation and interruption recovery', () => {
  const unknown = async () => {
    const f = fixture();
    await assert.rejects(f.run(async () => { throw new Error('reply lost'); }), UnknownItemOperationError);
    return f;
  };
  it('verified CRM readback resolves success, with operator and previous-state audit', async () => {
    const { run, store, options } = await unknown();
    assert.equal(await resolveUnknownItemOperation('revision-1', 'create-case', { outcome: 'succeeded', result: 'case-1' }, 'operator-1', options), true);
    assert.equal(await run(async () => assert.fail('verified mutation must not repeat')), 'case-1');
    const { previousAttemptId, ...audit } = store.audit[0]!;
    assert.deepEqual(audit, {
      actorId: 'operator-1', at: '2026-10-03T09:15:00.000Z', outcome: 'succeeded',
      previousState: 'unknown', previousError: 'reply lost',
    });
    assert.match(String(previousAttemptId), /^[a-f0-9-]{36}$/);
    assert.equal(await resolveUnknownItemOperation('revision-1', 'create-case', { outcome: 'not_applied' }, 'operator-1', options), false);
  });
  it('explicit verified not-applied resolution permits exactly one next writer', async () => {
    const { run, store, options } = await unknown();
    assert.equal(await resolveUnknownItemOperation('revision-1', 'create-case', { outcome: 'not_applied' }, 'operator-1', options), true);
    assert.equal(store.rows.get('revision-1/create-case')!.state, 'planned');
    assert.equal(await run(async () => 'case-1'), 'case-1');
    assert.equal(store.audit[0]!.outcome, 'not_applied');
  });
  it('blank operator and an unproven retry label cannot resolve unknown', async () => {
    const { store, options } = await unknown();
    await assert.rejects(resolveUnknownItemOperation('revision-1', 'create-case', { outcome: 'not_applied' }, ' ', options), TypeError);
    await assert.rejects(resolveUnknownItemOperation('revision-1', 'create-case', { outcome: 'retry' } as unknown as ItemOperationResolution, 'operator-1', options), TypeError);
    assert.equal(store.rows.get('revision-1/create-case')!.state, 'unknown');
    assert.equal(store.audit.length, 0);
  });
  it('startup moves only interrupted running operations to unknown without executing', async () => {
    const { store, options, run } = fixture();
    await run(async () => 'case-1');
    const created = await store.getOrCreate('revision-2', 'create-case', hashItemOperationInput({}), {});
    await store.claim(created.id, created.input_hash, options.now(), 'interrupted-attempt');
    await store.getOrCreate('revision-3', 'create-case', hashItemOperationInput({}), {});
    assert.equal(await markInterruptedItemOperationsUnknown(options), 1);
    assert.equal(store.rows.get('revision-1/create-case')!.state, 'succeeded');
    assert.equal(store.rows.get('revision-2/create-case')!.state, 'unknown');
    assert.equal(store.rows.get('revision-3/create-case')!.state, 'planned');
    assert.equal(await markInterruptedItemOperationsUnknown(options), 0);
    await assert.rejects(durableItemOperation('revision-2', 'create-case', {}, async () => assert.fail('interrupted operation must not retry'), options), UnknownItemOperationError);
  });
  it('a late receipt from an older attempt cannot overwrite or fail the new writer', async () => {
    const { store, options, run } = fixture();
    let entered!: () => void;
    let finishOld!: (value: string) => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const oldReply = new Promise<string>((resolve) => { finishOld = resolve; });
    const older = run(async () => { entered(); return oldReply; });
    await started;
    const oldToken = store.rows.get('revision-1/create-case')!.attempt_id;
    // Simulate an interruption/reconciliation race to verify the CAS fence.
    await markInterruptedItemOperationsUnknown(options);
    assert.equal(await resolveUnknownItemOperation('revision-1', 'create-case', { outcome: 'not_applied' }, 'operator-1', options), true);
    let newerEntered!: () => void;
    let finishNew!: (value: string) => void;
    const newerStarted = new Promise<void>((resolve) => { newerEntered = resolve; });
    const newReply = new Promise<string>((resolve) => { finishNew = resolve; });
    const newer = run(async () => { newerEntered(); return newReply; });
    await newerStarted;
    const newToken = store.rows.get('revision-1/create-case')!.attempt_id;
    assert.notEqual(oldToken, newToken);
    finishOld('stale-case-id');
    await assert.rejects(older, UnknownItemOperationError);
    assert.equal(store.rows.get('revision-1/create-case')!.state, 'running');
    assert.equal(store.rows.get('revision-1/create-case')!.attempt_id, newToken);
    assert.equal(store.rows.get('revision-1/create-case')!.result, null);
    finishNew('verified-case-id');
    assert.equal(await newer, 'verified-case-id');
    assert.equal(await run(async () => assert.fail('new receipt must replay')), 'verified-case-id');
  });
});
