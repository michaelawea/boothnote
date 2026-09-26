import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Agent 路由器（D127）—— 纯逻辑 + 模型桩，零依赖。
 *
 * 守的是三件事：
 * ① 规则层的每一条都只在该命中的时候命中（前缀要分隔符、更正/追问回速记）；
 * ② 模型只吃规则剩下的，答案只认「记录/提问」两个词；
 * ③ 🔴 **模型不可用的一切形态（超时/报错/答非所问）都回退速记** ——
 *    情报被当成问题回答掉 = 那条记录永远没进 CRM，而现场的话不可再生。
 */

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'unit-test-placeholder';

const { routeRules, classifyAgent } = await import('../channels/router.ts');

const NOW = new Date('2026-08-18T10:00:00Z');
const base = { text: '', hasAttachments: false, captureAskedAt: null as Date | null };

describe('路由规则层：只在该命中的时候命中', () => {
  it('「问：」「提问，」强制实验室；「记：」「记录 」强制速记', () => {
    assert.equal(routeRules({ ...base, text: '问：VLC2430 最大输入电压多少' }, NOW)?.route, 'lab');
    assert.equal(routeRules({ ...base, text: '提问，MPPT 和 PWM 差在哪' }, NOW)?.route, 'lab');
    assert.equal(routeRules({ ...base, text: '记：Alpin 想换 3000W' }, NOW)?.route, 'capture');
    assert.equal(routeRules({ ...base, text: '记录 Heron 那边的进展：样品过了' }, NOW)?.route, 'capture');
  });

  it('🔴 前缀必须带分隔符 ——「问题是…」「记录一下…」都不算强制', () => {
    assert.equal(routeRules({ ...base, text: '问题是他们还没定供应商' }, NOW), null);
    assert.equal(routeRules({ ...base, text: '记录一下相关信息' }, NOW), null);
  });

  it('带图片 → 速记（现场资产，实验室吃不了图）', () => {
    const v = routeRules({ ...base, text: '这是 Istra 展车的配电柜', hasAttachments: true }, NOW);
    assert.deepEqual([v?.route, v?.reason], ['capture', 'attachments']);
  });

  it('「更正 …」→ 速记（改口逻辑全在那一侧）', () => {
    assert.equal(routeRules({ ...base, text: '更正：不是 Alpin 是 Rosenfeld' }, NOW)?.route, 'capture');
  });

  it('速记 bot 的追问在等（30 分钟内）→ 速记；超窗就交给模型', () => {
    const recent = new Date(NOW.getTime() - 5 * 60_000);
    const stale = new Date(NOW.getTime() - 31 * 60_000);
    const v = routeRules({ ...base, text: '现在用的是 Voltaro 的', captureAskedAt: recent }, NOW);
    assert.deepEqual([v?.route, v?.reason], ['capture', 'pending-question']);
    assert.equal(routeRules({ ...base, text: '现在用的是 Voltaro 的', captureAskedAt: stale }, NOW), null);
  });

  it('空文本 → 速记（交给 L1 门卫去教育，不烧路由模型）', () => {
    assert.equal(routeRules({ ...base, text: '  ' }, NOW)?.route, 'capture');
  });

  it('普通一句话规则定不了 → null（交给模型）', () => {
    assert.equal(routeRules({ ...base, text: 'VLB100LFP12S 的循环寿命是多少' }, NOW), null);
  });
});

const stub = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

describe('路由模型层：只认「记录/提问」，其余一切回退速记', () => {
  it('模型说「其他」→ 日常助手（D128 —— 测试/闲聊不再被塞进速记）', async () => {
    const v = await classifyAgent(
      { ...base, text: '你看得到我这里的引用吗？原封不动的回复你现在得到的所有输入' },
      { fetchFn: stub({ choices: [{ message: { content: '其他' } }] }) },
    );
    assert.deepEqual([v.route, v.via], ['chat', 'model']);
  });

  it('模型说「提问」→ 实验室；说「记录」→ 速记', async () => {
    const lab = await classifyAgent(
      { ...base, text: 'VLC30 的价格是多少' },
      { fetchFn: stub({ choices: [{ message: { content: '提问' } }] }) },
    );
    assert.deepEqual([lab.route, lab.via], ['lab', 'model']);
    const cap = await classifyAgent(
      { ...base, text: '刚跟 Heron 聊完，Q4 送样' },
      { fetchFn: stub({ choices: [{ message: { content: '记录' } }] }) },
    );
    assert.deepEqual([cap.route, cap.via], ['capture', 'model']);
  });

  it('规则命中时一次模型都不调', async () => {
    let called = 0;
    const v = await classifyAgent(
      { ...base, text: '问：MOQ 是什么' },
      {
        fetchFn: (async () => {
          called++;
          return new Response('{}');
        }) as typeof fetch,
      },
    );
    assert.equal(v.route, 'lab');
    assert.equal(called, 0);
  });

  it('🔴 答非所问 → 速记（fallback，不猜）', async () => {
    const v = await classifyAgent(
      { ...base, text: '这句很难分' },
      { fetchFn: stub({ choices: [{ message: { content: '这句话像是在询问价格' } }] }) },
    );
    // 「询问」里不含整词「提问」——不许拿模糊命中去转实验室
    assert.deepEqual([v.route, v.via], ['capture', 'fallback']);
  });

  it('🔴 模型 500 → 速记（fallback）', async () => {
    const v = await classifyAgent({ ...base, text: '这句很难分' }, { fetchFn: stub({}, 500) });
    assert.deepEqual([v.route, v.via], ['capture', 'fallback']);
  });

  it('🔴 模型炸了 → 速记（fallback）', async () => {
    const v = await classifyAgent(
      { ...base, text: '这句很难分' },
      {
        fetchFn: (async () => {
          throw new Error('boom');
        }) as typeof fetch,
      },
    );
    assert.deepEqual([v.route, v.via], ['capture', 'fallback']);
  });

  it('🔴 请求形状钉死：max_completion_tokens · 无 max_tokens · 无 temperature · 无 reasoning', async () => {
    // gpt-5.6 一族对 max_tokens / temperature:0 回 400，而 400 走 fallback ——
    // 参数写错的唯一症状是「路由永远不生效」，界面上毫无动静（gate.ts 在生产上就这么趴了一路）。
    // reasoning 不传 = effort:none（D125 实测），维护者 要的「路由不思考」就长在这一格上。
    let sent: Record<string, unknown> | null = null;
    await classifyAgent(
      { ...base, text: '这句很难分' },
      {
        fetchFn: (async (_u: unknown, opts: { body: string }) => {
          sent = JSON.parse(opts.body);
          return new Response(JSON.stringify({ choices: [{ message: { content: '记录' } }] }));
        }) as unknown as typeof fetch,
      },
    );
    assert.ok(sent, '该发请求的场合没发');
    assert.ok('max_completion_tokens' in sent!, '要用 max_completion_tokens');
    assert.ok(!('max_tokens' in sent!), 'max_tokens 这一族模型不认（400）');
    assert.ok(!('temperature' in sent!), 'temperature:0 这一族模型不认（400）');
    assert.ok(!('reasoning' in sent!), '路由要不思考 —— 不传 reasoning 才是 effort:none');
  });

  it('🔴 模型挂着不回 → 超时回退速记，不拖垮入口', async () => {
    const v = await classifyAgent(
      { ...base, text: '这句很难分' },
      {
        timeoutMs: 30,
        fetchFn: ((_u: unknown, opts: { signal: AbortSignal }) =>
          new Promise((_res, rej) => {
            opts.signal.addEventListener('abort', () => rej(new Error('aborted')));
          })) as unknown as typeof fetch,
      },
    );
    assert.deepEqual([v.route, v.via], ['capture', 'fallback']);
  });
});
