import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { transient } from '../loop.ts';

/**
 * 「这个错值不值得再试一次」（零依赖）。
 *
 * 判错的两个方向代价完全不对称：
 *   · 该重试的没重试 → 现场那句话停在半路，而它只是等一会儿就能成
 *   · 不该重试的重试了 → 每次重启烧一遍模型钱，还把队列占满，
 *     让**新来的那条**超时走兜底（2026-08-04 实测：50 条积压导致 agent 60 秒超时）
 *
 * 所以这张表宁可漏判，不可错判。
 */

describe('临时故障的判定', () => {
  it('上游过载 —— 就是这条把 T01 卡住的', () => {
    assert.ok(transient('Our servers are currently overloaded. Please try again later.'));
  });

  it('限流与 5xx', () => {
    for (const m of [
      'Rate limit reached for gpt-5.6-luna',
      'Too Many Requests',
      'Twenty POST /rest/visits → 429 Limit reached',
      'upstream returned 503',
      'HTTP 502 Bad Gateway',
      'status 504',
    ]) {
      assert.ok(transient(m), `应判成临时：${m}`);
    }
  });

  it('网络抖动', () => {
    for (const m of ['fetch failed', 'ECONNRESET', 'ETIMEDOUT', 'socket hang up', 'request timed out']) {
      assert.ok(transient(m), `应判成临时：${m}`);
    }
  });

  it('🔴 输入本身有问题的**一律不重试** —— 重试多少次都一样，只是烧钱', () => {
    for (const m of [
      'unsupported Unicode escape sequence',
      'invalid input syntax for type uuid',
      '400 Function tools with reasoning_effort are not supported',
      'insert or update on table "_visit" violates foreign key constraint',
      'Invalid value "company" for field "appliesTo"',
    ]) {
      assert.ok(!transient(m), `不该重试：${m}`);
    }
  });

  it('🔴 401/403 不重试 —— key 不对，等多久都不会自己好', () => {
    assert.ok(!transient('401 Unauthorized'));
    assert.ok(!transient('403 Forbidden: invalid api key'));
  });
});
