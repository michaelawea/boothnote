import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 钉钉渠道 · 纯逻辑单元测试（零依赖，不碰库不碰网）。
 *
 * ⚠️ env 的非 getter 字段在模块加载时求值（agentEnabled），所以先摆环境变量、
 *    再**动态 import** —— 静态 import 会被提升到赋值之前。
 */
process.env.AGENT_ENABLED = '1';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'unit-test-placeholder';
process.env.CAPTURE_URL = 'https://capture.test';

const { normalizeDingtalk, deriveClientId, stripMentions } = await import('../channels/payload.ts');
const { gateRules, gateCheck, GATE_REJECT_TEXT } = await import('../channels/gate.ts');
const { decideRoute, isCorrection } = await import('../channels/routing.ts');
const { renderReceipt, renderAck, md, clampText, isFlowWebhook, outboundBody } = await import(
  '../channels/render.ts'
);

const BODY = {
  message: {
    content: '@Boothnote 刚跟 Alpin 聊完，他们想把逆变器换成 3000W',
    images: ['https://static.dingtalk.com/a.jpg'],
    sender: 'u_demo_0001',
    send_time: 1755400000000,
    group_name: 'Boothnote 项目群',
    mentioned_users: ['Boothnote'],
  },
};

describe('payload：钉钉报文 → 规范化事件', () => {
  it('六字段逐个落位，@ 片段从正文剥掉', () => {
    const ev = normalizeDingtalk(BODY)!;
    assert.equal(ev.channel, 'dingtalk');
    assert.equal(ev.text, '刚跟 Alpin 聊完，他们想把逆变器换成 3000W');
    assert.deepEqual(ev.images, ['https://static.dingtalk.com/a.jpg']);
    assert.equal(ev.sender, 'u_demo_0001');
    assert.equal(ev.sentAt?.getTime(), 1755400000000);
    assert.equal(ev.conversationKey, 'Boothnote 项目群');
  });

  it('images 单个字符串也收；非 URL 的丢掉', () => {
    const ev = normalizeDingtalk({
      message: { ...BODY.message, images: 'https://x.test/b.png' },
    })!;
    assert.deepEqual(ev.images, ['https://x.test/b.png']);
    const ev2 = normalizeDingtalk({ message: { ...BODY.message, images: ['mediaId==', ''] } })!;
    assert.deepEqual(ev2.images, []);
  });

  it('没有 sender 的事件一条都不收 —— 归属是承重件', () => {
    assert.equal(normalizeDingtalk({ message: { ...BODY.message, sender: '' } }), null);
    assert.equal(normalizeDingtalk({}), null);
  });

  it('没有群名（单聊）→ 会话键归一成 direct:<sender>', () => {
    const ev = normalizeDingtalk({ message: { ...BODY.message, group_name: '' } })!;
    assert.equal(ev.conversationKey, 'direct:u_demo_0001');
  });

  it('send_time 不合法 → sentAt 为 null，不炸', () => {
    const ev = normalizeDingtalk({ message: { ...BODY.message, send_time: 'oops' } })!;
    assert.equal(ev.sentAt, null);
  });

  it('幂等键：同报文同键（流程重试天然去重），换内容/换人/换时刻都换键', () => {
    const ev = normalizeDingtalk(BODY)!;
    const a = deriveClientId(ev);
    assert.equal(a, deriveClientId(normalizeDingtalk(BODY)!)); // 确定性
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const diff = (patch: Record<string, unknown>) =>
      deriveClientId(normalizeDingtalk({ message: { ...BODY.message, ...patch } })!);
    assert.notEqual(a, diff({ content: '换了句话' }));
    assert.notEqual(a, diff({ sender: 'someone-else' }));
    assert.notEqual(a, diff({ send_time: 1755400000001 }));
  });

  it('stripMentions 只剥 @ 片段，不动别的', () => {
    assert.equal(stripMentions('@Boothnote Alpin 换 3000W'), 'Alpin 换 3000W');
    assert.equal(stripMentions('Alpin 换 3000W'), 'Alpin 换 3000W');
  });
});

describe('L1 门卫：规则层', () => {
  it('空心壳词拒收 —— 「记录一下相关信息」这一族', () => {
    for (const t of ['记录一下相关信息', '帮我记录一下', '记一下', '整理一下这些内容', '麻烦记录一下刚才的讨论内容']) {
      assert.equal(gateRules(t), 'reject', t);
    }
  });
  it('太短拒收，空串拒收', () => {
    assert.equal(gateRules(''), 'reject');
    assert.equal(gateRules('哈哈'), 'reject');
  });
  it('短但可能有货 → unsure（交给小模型）', () => {
    assert.equal(gateRules('Alpin 换 3000W'), 'unsure');
  });
  it('正常一句话直接放行', () => {
    assert.equal(gateRules('刚跟 Alpin 聊完，他们想把逆变器换成 3000W，Q4 送样'), 'pass');
  });
});

describe('L1 门卫：完整判定（fail-open 是承重性质）', () => {
  it('带图片直接放行 —— 图片本身就是内容', async () => {
    const r = await gateCheck('', true);
    assert.deepEqual(r, { pass: true, via: 'attachments' });
  });

  it('规则拒收时一次模型都不调', async () => {
    let called = 0;
    const r = await gateCheck('记录一下相关信息', false, {
      fetchFn: (async () => {
        called++;
        return new Response('{}');
      }) as typeof fetch,
    });
    assert.equal(r.pass, false);
    assert.equal(called, 0);
  });

  it('unsure + 模型说「空心」→ 拒收', async () => {
    const r = await gateCheck('Alpin 换 3000W', false, {
      fetchFn: (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '空心' } }] }))) as typeof fetch,
    });
    assert.equal(r.pass, false);
    assert.equal(r.via, 'model');
  });

  it('unsure + 模型说「有货」→ 放行', async () => {
    const r = await gateCheck('Alpin 换 3000W', false, {
      fetchFn: (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '有货' } }] }))) as typeof fetch,
    });
    assert.equal(r.pass, true);
  });

  it('🔴 模型炸了 → 放行（宁可 L2 多跑一次，不许把真情报卡在门口）', async () => {
    const r = await gateCheck('Alpin 换 3000W', false, {
      fetchFn: (async () => {
        throw new Error('boom');
      }) as typeof fetch,
    });
    assert.equal(r.pass, true);
  });

  it('🔴 模型挂着不回 → 超时放行', async () => {
    const r = await gateCheck('Alpin 换 3000W', false, {
      timeoutMs: 30,
      fetchFn: ((_u: unknown, opts: { signal: AbortSignal }) =>
        new Promise((_res, rej) => {
          opts.signal.addEventListener('abort', () => rej(new Error('aborted')));
        })) as unknown as typeof fetch,
    });
    assert.equal(r.pass, true);
  });

  it('教育话术里说清「只能看到 @ 我的这一条」', () => {
    assert.match(GATE_REJECT_TEXT, /只能看到 @ 我的这一条/);
  });

  it('🔴 请求形状钉死：max_completion_tokens，无 max_tokens / temperature（gpt-5.6 一族两样都 400）', async () => {
    // 原来这里是 max_tokens + temperature:0 —— 每次调用 400 → fail-open 放行，
    // 门卫的模型档上线以来一次都没真判过，直到 D127 的路由评测把同款坑带出水面。
    let sent: Record<string, unknown> | null = null;
    await gateCheck('Alpin 换 3000W', false, {
      fetchFn: (async (_u: unknown, opts: { body: string }) => {
        sent = JSON.parse(opts.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: '有货' } }] }));
      }) as unknown as typeof fetch,
    });
    assert.ok(sent, '这条该走到模型');
    assert.ok('max_completion_tokens' in sent!);
    assert.ok(!('max_tokens' in sent!));
    assert.ok(!('temperature' in sent!));
  });
});

describe('会话路由：默认新开（代价不对称判据）', () => {
  const now = new Date('2026-08-17T10:00:00Z');
  const min = (n: number) => new Date(now.getTime() - n * 60_000);

  it('没有历史 → 新开', () => {
    assert.deepEqual(decideRoute('随便说点什么', { lastThreadId: null, lastActivityAt: null, lastAskedAt: null }, now), {
      threadId: null,
      via: 'new',
    });
  });

  it('bot 追问 10 分钟内 → 接回原对话（在回答问题）', () => {
    const r = decideRoute('现在用的是 Voltaro', { lastThreadId: 't1', lastActivityAt: min(10), lastAskedAt: min(10) }, now);
    assert.deepEqual(r, { threadId: 't1', via: 'answer' });
  });

  it('追问超 30 分钟 → 不再算回答，新开', () => {
    const r = decideRoute('现在用的是 Voltaro', { lastThreadId: 't1', lastActivityAt: min(40), lastAskedAt: min(40) }, now);
    assert.equal(r.via, 'new');
  });

  it('「更正 …」2 小时内 → 接回原对话走改口', () => {
    const r = decideRoute('更正：不是 Alpin 是 Rosenfeld', { lastThreadId: 't1', lastActivityAt: min(90), lastAskedAt: null }, now);
    assert.deepEqual(r, { threadId: 't1', via: 'correction' });
  });

  it('「更正 …」超 2 小时 → 新开', () => {
    const r = decideRoute('更正：不是 Alpin 是 Rosenfeld', { lastThreadId: 't1', lastActivityAt: min(150), lastAskedAt: null }, now);
    assert.equal(r.via, 'new');
  });

  it('🔴 窗口内的普通新内容**不**续写 —— A 录完 Alpin 两分钟后录 Heron，是两条', () => {
    const r = decideRoute('Heron 想要电池报价', { lastThreadId: 't1', lastActivityAt: min(2), lastAskedAt: null }, now);
    assert.equal(r.via, 'new');
  });

  it('isCorrection 认得住几种说法', () => {
    for (const t of ['更正：xx', '不对，是 Rosenfeld', '改一下客户', '上一条错了', '说错了，是 2000W'])
      assert.equal(isCorrection(t), true, t);
    assert.equal(isCorrection('Alpin 更正了他们的计划'), false);
  });
});

describe('render：回执规格', () => {
  const base = {
    sender: 'u_demo_0001',
    status: 'ready',
    partial: false,
    error: null,
    title: 'Alpin 逆变器升级 3000W',
    extracted: { recordType: 'fitment', category: 'INVERTER', project: { projectCode: 'ALPIN-2026-001' } },
    companyCode: 'ALPIN',
    suggestedCompany: null,
    askText: null,
  };

  it('ready 回执：待确认 · @发送人 · ≤8 行 · 🔴 绝不出现「已入库」', () => {
    const m = renderReceipt(base);
    const text = m.markdown!.text;
    assert.match(text, /待确认/);
    assert.doesNotMatch(text, /已入库/);
    // 「≤8 行」说的是回执正文。末尾那个 `@<userid>` 是 md() 统一拼的通知位（§2.52⑥），不算进来。
    assert.ok(text.replace(/\n\n@\S+$/, '').split('\n').length <= 8);
    assert.deepEqual(m.at, { atUserIds: ['u_demo_0001'], isAtAll: false });
    assert.match(text, /ALPIN-2026-001/);
    assert.match(text, /去确认入库/);
  });

  it('failed 回执：说清没处理成 + 原话没丢', () => {
    const text = renderReceipt({ ...base, status: 'failed', error: '转写超时' }).markdown!.text;
    assert.match(text, /没处理成/);
    assert.match(text, /转写超时/);
    assert.match(text, /原话已保存/);
  });

  it('agent 提议的新客户要标出来「只提议」；没客户要说「确认时要选」', () => {
    const a = renderReceipt({ ...base, companyCode: null, suggestedCompany: 'Neumeyer' }).markdown!.text;
    assert.match(a, /Neumeyer（名单里没有，只提议）/);
    const b = renderReceipt({ ...base, companyCode: null, extracted: {} }).markdown!.text;
    assert.match(b, /未识别 —— 确认时要选/);
  });

  it('追问那一行带「回复请 @我」—— bot 收不到不 @ 它的答案', () => {
    const text = renderReceipt({ ...base, askText: '现在在位的是哪家？' }).markdown!.text;
    assert.match(text, /还缺.*现在在位的是哪家？.*回复请 @我/);
  });

  it('ack 要诚实：没配回执 webhook 就明说「去 PWA 看」，不假装稍后有回执', () => {
    assert.match(renderAck('u', true).markdown!.text, /去 PWA 看/);
    assert.match(renderAck('u', false).markdown!.text, /回执稍后发回群里/);
  });

  it('D127：ack 要说清转给了谁 —— 两种情形都得点名「速记」', () => {
    assert.match(renderAck('u', false).markdown!.text, /速记/);
    assert.match(renderAck('u', true).markdown!.text, /速记/);
  });
});

/**
 * 出站报文的形状（D122 · §2.52，2026-08-17 在真钉钉上实测出来的）。
 *
 * 🔴 这一组是**唯一**能挡住那个故障的东西：关键词对不上时钉钉静默丢消息、
 * 照样回 `HTTP 200 {"data":true,"success":true}`，网关这边一个信号都收不到。
 */
const ROBOT = 'https://oapi.dingtalk.com/robot/send?access_token=abc';
const FLOW = 'https://connector.dingtalk.com/webhook/flow/0000000000000000demo0000';

describe('outboundBody：两种投递口，两种形状', () => {
  it('自定义机器人：原样发，不许包任何东西', () => {
    const ding = md('一句话', 'u1');
    assert.deepEqual(outboundBody(ding, ROBOT), ding);
  });

  it('流程 webhook：包一层 {keyword, ding}，关键词进 body 不进群消息', () => {
    const ding = md('一句话', 'u1');
    const body = outboundBody(ding, FLOW) as { keyword: string; ding: unknown };
    assert.equal(body.keyword, 'agentwork');
    assert.deepEqual(body.ding, ding);
    // 关键词只能在信封上 —— 群里那条消息里不许出现
    assert.doesNotMatch(JSON.stringify(body.ding), /agentwork/);
  });

  it('URL 判据卡在 connector 的 /webhook/flow/ 上，别的一律当机器人', () => {
    assert.equal(isFlowWebhook(FLOW), true);
    assert.equal(isFlowWebhook(ROBOT), false);
    assert.equal(isFlowWebhook('https://connector.dingtalk.com/webhook/other/x'), false);
    assert.equal(isFlowWebhook('https://evil.com/connector.dingtalk.com/webhook/flow/x'), false);
    assert.equal(isFlowWebhook(''), false);
  });
});

describe('@ 那个人：markdown 的 at 列表光放着不算数（§2.52⑥ 真群实测）', () => {
  it('带 sender 时，at 列表和正文里的 @ 串两样都要有', () => {
    const m = md('答案', 'u1');
    assert.deepEqual(m.at, { atUserIds: ['u1'], isAtAll: false });
    assert.match(m.markdown!.text, /@u1$/); // 🔴 少了这一行就是「发出去了但没人被通知」
  });

  it('不带 sender 就一个 @ 都不许有（群公告式的消息不 @ 人）', () => {
    const m = md('答案');
    assert.equal(m.at, undefined);
    assert.doesNotMatch(m.markdown!.text, /@/);
  });

  it('超长回答被截断时，@ 串必须活下来 —— 越长越是人已经划走了', () => {
    const m = md('国'.repeat(20_000), 'u1');
    assert.ok(Buffer.byteLength(m.markdown!.text, 'utf8') <= 18_000);
    assert.match(m.markdown!.text, /@u1$/);
    assert.match(m.markdown!.text, /回答太长/);
  });

  it('回执正文是 #### 开头的，@ 串只能在末尾，不能顶掉标题行', () => {
    const text = renderReceipt({
      sender: 'u1',
      status: 'ready',
      partial: false,
      error: null,
      title: 'Alpin 逆变器升级 3000W',
      extracted: { recordType: 'fitment' },
      companyCode: 'ALPIN',
      suggestedCompany: null,
      askText: null,
    }).markdown!.text;
    assert.match(text, /^#### /);
    assert.match(text, /@u1$/);
  });
});

describe('clampText：超长回答不能整条被钉钉丢掉', () => {
  it('没超就一个字不动', () => {
    assert.equal(clampText('短的'), '短的');
  });

  it('超了截断 + 明说截断了，且截完仍在上限内', () => {
    const out = clampText('国'.repeat(20_000));
    assert.ok(Buffer.byteLength(out, 'utf8') <= 18_000);
    assert.match(out, /回答太长/);
  });

  it('切口不许切出半个字（不能有 U+FFFD）', () => {
    // 每个汉字 3 字节，故意让上限落在字的中间
    for (const max of [100, 101, 102]) {
      const out = clampText('国'.repeat(500), max);
      assert.doesNotMatch(out, /�/);
      assert.ok(Buffer.byteLength(out, 'utf8') <= max);
    }
  });

  it('md() 是唯一的咽喉 —— 任何一条消息都过它', () => {
    const text = md('好'.repeat(20_000)).markdown!.text;
    assert.ok(Buffer.byteLength(text, 'utf8') <= 18_000);
  });
});
