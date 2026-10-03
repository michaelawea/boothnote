import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDefiniteTwentyRejection, TwentyHttpError } from '../twenty-errors.ts';

const error = (status: number, response: unknown) => new TwentyHttpError('POST', '/rest/visits', status, response, JSON.stringify(response));

describe('only trustworthy explicit Twenty rejections permit retries', () => {
  for (const status of [400, 401, 403, 404, 422]) {
    it(`recognizes structured application rejection ${status}`, () => {
      assert.equal(isDefiniteTwentyRejection(error(status, { statusCode: status, messages: ['Request rejected'] })), true);
    });
  }
  for (const status of [408, 409, 429, 500, 502, 503]) {
    it(`keeps HTTP ${status} uncertain even with an error envelope`, () => {
      assert.equal(isDefiniteTwentyRejection(error(status, { statusCode: status, messages: ['Error'] })), false);
    });
  }
  it('plain proxy bodies, mismatched status and incomplete envelopes remain uncertain', () => {
    for (const response of [{ raw: '<html>proxy failure</html>' }, { statusCode: 500, messages: ['Error'] },
      { statusCode: 400 }, { statusCode: 400, messages: [] }, { statusCode: 400, messages: [null] }]) {
      assert.equal(isDefiniteTwentyRejection(error(400, response)), false);
    }
  });
  it('duplicate-key errors cannot authorize blind recreation of a possibly existing record', () => {
    assert.equal(isDefiniteTwentyRejection(error(400, { statusCode: 400, messages: ['A duplicate entry was detected'] })), false);
  });
  it('network errors are never definite and response text remains bounded', () => {
    assert.equal(isDefiniteTwentyRejection(new Error('socket closed')), false);
    assert.ok(new TwentyHttpError('POST', '/rest/visits', 503, {}, 'x'.repeat(2000)).message.length < 400);
  });
});
