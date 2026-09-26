import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 日常助手（D128）—— 纯逻辑 + 模型桩，零依赖（runChatForEvent 的幂等走集成档）。
 *
 * 守的是：① 单次直答的所有失败形态（关着/超时/报错/空回答）都归成 null，
 * 调用方永远有兜底话术可发；② 请求形状不许回到 §2.53 那个 400 坑。
 */

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'unit-test-placeholder';

const { chatOnce, CHAT_FALLBACK } = await import('../channels/chat.ts');

const stub = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

describe('日常助手：单次直答', () => {
  it('模型答了 → 原样给（去掉首尾空白）', async () => {
    const out = await chatOnce('在吗', {
      enabled: true,
      fetchFn: stub({ choices: [{ message: { content: '  在的，这条线通着。 ' } }] }),
    });
    assert.equal(out, '在的，这条线通着。');
  });

  it('🔴 关着（AGENT_ENABLED=0 的形态）→ null，且一次请求都不发', async () => {
    let called = 0;
    const out = await chatOnce('在吗', {
      enabled: false,
      fetchFn: (async () => {
        called++;
        return new Response('{}');
      }) as typeof fetch,
    });
    assert.equal(out, null);
    assert.equal(called, 0);
  });

  it('🔴 500 / 抛异常 / 空回答 → 一律 null（调用方发兜底话术）', async () => {
    assert.equal(await chatOnce('在吗', { enabled: true, fetchFn: stub({}, 500) }), null);
    assert.equal(
      await chatOnce('在吗', {
        enabled: true,
        fetchFn: (async () => {
          throw new Error('boom');
        }) as typeof fetch,
      }),
      null,
    );
    assert.equal(
      await chatOnce('在吗', { enabled: true, fetchFn: stub({ choices: [{ message: { content: '   ' } }] }) }),
      null,
    );
  });

  it('🔴 挂着不回 → 超时 null，不拖垮同步响应', async () => {
    const out = await chatOnce('在吗', {
      enabled: true,
      timeoutMs: 30,
      fetchFn: ((_u: unknown, opts: { signal: AbortSignal }) =>
        new Promise((_res, rej) => {
          opts.signal.addEventListener('abort', () => rej(new Error('aborted')));
        })) as unknown as typeof fetch,
    });
    assert.equal(out, null);
  });

  it('🔴 请求形状钉死：system+user 两条 · max_completion_tokens · 无 max_tokens/temperature/reasoning', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 回调里赋值，TS 收窄看不见
    let sent: any = null;
    await chatOnce('测试', {
      enabled: true,
      fetchFn: (async (_u: unknown, opts: { body: string }) => {
        sent = JSON.parse(opts.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      }) as unknown as typeof fetch,
    });
    assert.ok(sent);
    const msgs = sent.messages as Array<{ role: string; content: string }>;
    assert.deepEqual(
      msgs.map((m) => m.role),
      ['system', 'user'],
    );
    // 引用/上下文看不到这件事写死在 system 里 —— 生产上第一条测试消息问的就是这个
    assert.match(msgs[0]!.content, /只能看到 @ 你的这一条/);
    assert.ok('max_completion_tokens' in sent!);
    assert.ok(!('max_tokens' in sent!) && !('temperature' in sent!) && !('reasoning' in sent!));
  });

  it('兜底话术把三条线说清楚（人被兜底时要知道另外两条线还能用）', () => {
    assert.match(CHAT_FALLBACK, /记录/);
    assert.match(CHAT_FALLBACK, /提问/);
  });
});
