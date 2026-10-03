import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createVisit, twentyRead } from '../twenty.ts';
import { durableItemOperation, UnknownItemOperationError, type ItemOperationStore, type ItemOperation } from '../item-operations.ts';
import { TwentyHttpError } from '../twenty-errors.ts';
import { sql } from '../db.ts';

after(() => sql.end());
const storeFixture = () => {
  let operation: ItemOperation;
  const store: ItemOperationStore = {
    async getOrCreate(revisionId, role, hash, input) {
      operation ??= { id: 'operation-fixture', revision_id: revisionId, role, input_hash: hash, input,
        state: 'planned', result: null, error: null, attempt_id: null, request_evidence: [] };
      return structuredClone(operation);
    },
    async get() { return structuredClone(operation); },
    async claim(_id, _hash, _at, attemptId) {
      if (!['planned','failed'].includes(operation.state)) return false;
      operation.state = 'running'; operation.attempt_id = attemptId; operation.request_evidence = []; return true;
    },
    async succeed(_id, result) { operation.state = 'succeeded'; operation.result = result; return true; },
    async fail(_id, state, error) { operation.state = state; operation.error = error; return true; },
    async recordRequest(_id, request) { operation.request_evidence!.push(structuredClone(request)); return true; },
    async markInterrupted() { return 0; },
    async resolve() { assert.fail('HTTP tests must not invoke reconciliation'); },
  };
  return { store, operation: () => operation };
};

describe('actual Twenty mutation client respects the item journal', () => {
  for (const status of [429, 503]) {
    it(`a create applied before HTTP ${status} is attempted once, then blocks blind replay`, async () => {
      const f = storeFixture(); const saved = globalThis.fetch; let writes = 0;
      globalThis.fetch = async (_url, request) => {
        assert.equal(request?.method,'POST');
        assert.equal(f.operation().request_evidence!.length,1,'wire evidence is saved before fetch');
        writes++;
        return new Response(JSON.stringify({ statusCode: status, messages: ['Reply after applied create'] }), { status });
      };
      const run = () => durableItemOperation('revision-fixture','visit:create',{companyId:'company-fixture',fields:{summary:'Fictional visit'},target:null},
        () => createVisit({ name:'Fictional visit', companyId:'company-fixture' }),{store:f.store});
      try {
        await assert.rejects(run(),UnknownItemOperationError);
        assert.equal(writes,1);
        assert.equal(f.operation().state,'unknown');
        await assert.rejects(run(),UnknownItemOperationError);
        assert.equal(writes,1);
      } finally { globalThis.fetch = saved; }
    });
  }
  it('a trusted structured validation refusal is failed, whereas an HTML proxy refusal is unknown', async () => {
    const saved = globalThis.fetch;
    try {
      for (const [body, state] of [
        [JSON.stringify({statusCode:400,messages:['Invalid field value']}),'failed'],
        ['<html>proxy rejected response</html>','unknown'],
      ]) {
        const f = storeFixture();
        globalThis.fetch = async () => new Response(body,{status:400});
        await assert.rejects(durableItemOperation('revision-fixture','visit:create',{},()=>createVisit({name:'Fictional visit'}),{store:f.store}),
          state==='failed' ? TwentyHttpError : UnknownItemOperationError);
        assert.equal(f.operation().state,state);
      }
    } finally { globalThis.fetch = saved; }
  });
  it('safe reads retain 429 backoff without registering a mutation', async () => {
    const saved = globalThis.fetch; let reads = 0;
    globalThis.fetch = async (_url, request) => {
      assert.equal(request?.method,'GET'); reads++;
      return reads===1 ? new Response('{}',{status:429}) : new Response(JSON.stringify({data:{visits:[]}}));
    };
    try { await twentyRead('/rest/visits'); assert.equal(reads,2); }
    finally { globalThis.fetch = saved; }
  });
});
