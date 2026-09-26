import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

import { sql } from '../db.ts';
import { env } from '../env.ts';
import { normalizeDingtalk, deriveClientId } from '../channels/payload.ts';

/**
 * 钉钉渠道 · 集成测试（T93）—— 打真实 HTTP + 真实库。
 *
 * 跑法：./scripts/test.sh integration（一次性环境；stack 会 export CHANNEL_DINGTALK_SECRET）。
 * 没配 secret 时整档 skip —— 「跳过」和「通过」要分得开，所以 skip 会在输出里点名。
 */

const BASE = process.env.GATEWAY_URL ?? `http://localhost:${env.port}`;

// ── 安全闸门：非本地一律拒跑（和 api.test.ts 同一道，同一句咒语才放行）──
const isLocal = (u: string) => /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(u);
if (!isLocal(BASE) || !/@(localhost|127\.0\.0\.1)[:/]/.test(env.databaseUrl)) {
  const target = (() => {
    try {
      return new URL(BASE).host;
    } catch {
      return BASE;
    }
  })();
  if (process.env.ALLOW_NONLOCAL_TESTS !== target) {
    console.error(`\n🔴 渠道集成测试只对本地跑（会建账号、发速记）。GATEWAY_URL=${BASE}\n`);
    process.exit(1);
  }
}

/**
 * 🔴 **这个文件必须排在 `api.test.ts` 之前跑，而且不能与它并行。**
 *
 * `api.test.ts` 末尾那条「暴力破解 8 次锁 15 分钟」会把本机 IP 锁进网关内存，
 * 之后这里所有 `/admin` 调用一律 429（CI 上 2026-08-17 实测撞到）。
 * 顺序写死在 `scripts/integration-stack.sh` 和 `.github/workflows/ci.yml` 两处。
 */
const SECRET = process.env.CHANNEL_DINGTALK_SECRET ?? '';
const ADMIN = process.env.ADMIN_TOKEN ?? '';
const RUN = Boolean(SECRET);
if (!RUN) console.error('⏭ CHANNEL_DINGTALK_SECRET 没配 —— 渠道整档 skip（用 ./scripts/test.sh integration 跑）');

const SUFFIX = randomUUID().slice(0, 8);
const GROUP = `itest 渠道群 ${SUFFIX}`;

// ⚠️ 顶层收尾：sql 连接池不关，这个子进程**永远不退出**（node --test 会一直等它）。
after(async () => {
  await sql.end({ timeout: 5 });
});

/** 这个 sender 名下有几条 inbox。**不数全局** —— api.test.ts 和本文件是并行的两个子进程，全局计数在并发下就是碰运气。 */
const inboxCountOf = async (sender: string): Promise<number> => {
  const [row] = await sql<Array<{ n: number }>>`
    select count(*)::int as n from inbox i
    join channel_identity ci on ci.app_user_id = i.user_id
    where ci.channel = 'dingtalk' and ci.channel_user_id = ${sender}`;
  return row?.n ?? 0;
};

let msgClock = 1_755_400_000_000; // send_time 逐条 +1s —— 幂等键靠它区分「不同消息」

const post = async (message: Record<string, unknown>, secret = SECRET) => {
  const res = await fetch(`${BASE}/channels/dingtalk/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Channel-Secret': secret },
    body: JSON.stringify({ message }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
};

const event = (content: string, sender: string, extra: Record<string, unknown> = {}) => ({
  content,
  images: [],
  sender,
  send_time: (msgClock += 1000),
  group_name: GROUP,
  mentioned_users: [],
  ...extra,
});

const admin = async (path: string, body?: unknown) => {
  const res = await fetch(`${BASE}/admin${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Admin-Token': ADMIN, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
};

describe('钉钉渠道 · 入口', { skip: !RUN }, () => {
  it('错 secret → 401；对的才进得来', async () => {
    const bad = await post(event('测试', `u-${SUFFIX}`), 'wrong-secret');
    assert.equal(bad.status, 401);
  });

  it('第一条消息：自动建号 + 自动登记群 + 落 inbox（source=dingtalk）+ 回 ack', async () => {
    const sender = `alice-${SUFFIX}`;
    const r = await post(event('刚跟 Alpin 聊完，他们想把逆变器换成 3000W，Q4 送样', sender));
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.kind, 'ack');
    assert.ok(r.json.noteId);
    // ding 是完整的一条钉钉消息，节点③原样透传
    assert.equal(r.json.ding.msgtype, 'markdown');
    assert.deepEqual(r.json.ding.at, { atUserIds: [sender], isAtAll: false });
    // 没配 webhook 的群，ack 要诚实说「去 PWA 看」
    assert.match(r.json.ding.markdown.text, /PWA/);

    // 自动建号：channel_identity → app_user（staff · 登不进 PWA 的随机密码）
    const [ident] = await sql<Array<{ user_code: string; role: string }>>`
      select u.user_code, u.role from channel_identity ci join app_user u on u.id = ci.app_user_id
      where ci.channel = 'dingtalk' and ci.channel_user_id = ${sender}`;
    assert.ok(ident, '应当自动建号');
    assert.match(ident!.user_code, /^dd-/);
    assert.equal(ident!.role, 'staff');

    // inbox：source=dingtalk · 开了对话（渠道每一条都是说给 AI 听的）
    const [row] = await sql<Array<{ source: string; thread_id: string | null; text: string }>>`
      select source, thread_id, text from inbox where id = ${r.json.noteId}`;
    assert.equal(row!.source, 'dingtalk');
    assert.ok(row!.thread_id, '渠道速记要开对话');
    assert.match(row!.text, /Alpin/);

    // 群自动登记
    const [convo] = await sql<Array<{ title: string | null }>>`
      select title from channel_conversation where channel = 'dingtalk' and conversation_key = ${GROUP}`;
    assert.equal(convo!.title, GROUP);

    // 原始报文进只增日志
    const [evt] = await sql<Array<{ kind: string }>>`
      select kind from channel_event where inbox_id = ${r.json.noteId}`;
    assert.equal(evt!.kind, 'message');
  });

  it('🔴 幂等：同一份报文重放（流程重试）→ 不重录，回「已经收过了」', async () => {
    const sender = `bob-${SUFFIX}`;
    const msg = event('Heron 那边说想上 2000W 逆变器，下月回访', sender);
    const first = await post(msg);
    assert.equal(first.json.kind, 'ack');
    const again = await post(msg); // 一字不差重放
    assert.equal(again.json.kind, 'final');
    assert.match(again.json.ding.markdown.text, /已经收过了/);
    const [cnt] = await sql<Array<{ n: number }>>`
      select count(*)::int as n from inbox where id = ${first.json.noteId} or id = ${again.json.noteId}`;
    assert.equal(cnt!.n, 1, '库里只能有一条');
  });

  it('🔴 L1 门卫：「记录一下相关信息」拒收 —— 不进 inbox，只留 reject 日志', async () => {
    const sender = `carol-${SUFFIX}`;
    const r = await post(event('记录一下相关信息', sender));
    assert.equal(r.json.kind, 'final');
    assert.match(r.json.ding.markdown.text, /只能看到 @ 我的这一条/);
    assert.equal(await inboxCountOf(sender), 0, 'inbox 一条都不能有');
    const [rej] = await sql<Array<{ n: number }>>`
      select count(*)::int as n from channel_event
      where channel = 'dingtalk' and kind = 'reject' and sender = ${sender}`;
    assert.equal(rej!.n, 1, '拒收要留日志 —— 「不进 inbox」不等于丢');
  });

  it('D127 路由：「问：」强制转实验室 —— 不落 inbox、落 lab_run、ack 说清转给了谁', async () => {
    const sender = `router-${SUFFIX}`;
    const r = await post(event('问：VLC2430 的最大输入电压是多少', sender));
    assert.equal(r.status, 200);
    assert.equal(r.json.kind, 'ack');
    assert.match(r.json.ding.markdown.text, /实验室/);
    // 这个群没配 webhook —— ack 必须当场说出来，不许让人等一条永远不来的消息
    assert.match(r.json.ding.markdown.text, /没配回执机器人/);
    assert.equal(await inboxCountOf(sender), 0, '提问不落 inbox');
    const [run] = await sql<Array<{ prompt: string }>>`
      select prompt from lab_run
      where channel = 'dingtalk-lab' and sender = ${sender}
      order by created_at desc limit 1`;
    assert.ok(run, '路由到实验室的每一轮都要记 lab_run');
    assert.match(run!.prompt, /VLC2430/);
    // 路由决定进账本 —— 分错方向时要查得出「当时是谁、按什么理由分的」
    const [evt] = await sql<Array<{ raw: { route: string; via: string } }>>`
      select raw from channel_event
      where channel = 'dingtalk' and kind = 'route' and sender = ${sender}`;
    assert.equal(evt!.raw.route, 'lab');
    assert.equal(evt!.raw.via, 'rule');
  });

  it('🔴 D127 路由：模型不可用时一切进速记 —— fail-open 的方向必须是 capture', async () => {
    // 一次性环境 AGENT_ENABLED=0（router-off 分支）；CI 里 key 是占位符（fallback 分支）——
    // 两种配置走的分支不同，结果必须相同（§2.42①：只在某种配置下成立的断言等于没有断言）
    const sender = `routerfb-${SUFFIX}`;
    const r = await post(event('VLB100 电池的循环寿命大概是多少次呢？', sender));
    assert.equal(r.json.kind, 'ack');
    assert.match(r.json.ding.markdown.text, /速记/);
    assert.equal(await inboxCountOf(sender), 1, '回退方向必须是速记 —— 情报丢了不可再生');
  });

  it('D128 路由：chat 决定被复用 → 日常助手直答（模型没开给兜底），不落 inbox 不落 lab_run', async () => {
    // 一次性环境没有模型，chat 这个去向靠「重放复用第一次的路由决定」这条确定性路径进 ——
    // 顺带把上一轮没有直接测过的「决定复用」机制也钉住了
    const sender = `chat-${SUFFIX}`;
    const msg = event('随便聊聊，测试一下你在不在', sender);
    const ev = normalizeDingtalk({ message: msg })!;
    await sql`
      insert into channel_event (channel, event_key, kind, conversation_key, sender, raw)
      values ('dingtalk', ${`route:${deriveClientId(ev)}`}, 'route', ${ev.conversationKey}, ${sender},
              ${sql.json({ route: 'chat', via: 'model', reason: '其他' } as never)})`;

    const r = await post(msg);
    assert.equal(r.status, 200);
    assert.equal(r.json.kind, 'final', '日常助手同步直答，不 ack');
    assert.match(r.json.ding.markdown.text, /日常助手/, '模型没开时要给兜底话术');
    assert.equal(await inboxCountOf(sender), 0, '杂项不落 inbox');
    const [runs] = await sql<Array<{ n: number }>>`
      select count(*)::int as n from lab_run where sender = ${sender}`;
    assert.equal(runs!.n, 0, '杂项不落 lab_run');
    const [evt] = await sql<Array<{ n: number }>>`
      select count(*)::int as n from channel_event
      where channel = 'dingtalk-chat' and sender = ${sender}`;
    assert.equal(evt!.n, 1, 'chat 那条线自己的幂等账');
  });

  it('命令层：帮助 / 确认 都同步终局，不落 inbox', async () => {
    const sender = `dave-${SUFFIX}`;
    const help = await post(event('帮助', sender));
    assert.equal(help.json.kind, 'final');
    assert.match(help.json.ding.markdown.text, /用法/);
    const confirm = await post(event('确认', sender));
    assert.match(confirm.json.ding.markdown.text, /还没开通/);
    assert.equal(await inboxCountOf(sender), 0);
  });

  it('会话路由①：bot 追问后 30 分钟内的下一条 → 接回同一条对话', async () => {
    const sender = `emma-${SUFFIX}`;
    const first = await post(event('Rosenfeld 想换电池，方案还没定', sender));
    const [i1] = await sql<Array<{ thread_id: string }>>`
      select thread_id from inbox where id = ${first.json.noteId}`;
    /**
     * ⚠️ 先等这条的 agent 管线**收尾**（一次性环境里 Twenty 是死端口 →
     * 临时故障重试 3 次后终局 failed，并往对话里插一条收尾消息）。
     * 不等的话，收尾消息可能插在我们的「追问」之后 —— 路由看的是**最新一条**
     * agent 消息，测试就会按时序随机红（判据：要靠运气才成立的断言等于没有断言）。
     */
    for (let i = 0; i < 60; i++) {
      const [m] = await sql<Array<{ n: number }>>`
        select count(*)::int as n from thread_message
        where thread_id = ${i1!.thread_id} and role = 'agent'`;
      if (m!.n > 0) break;
      await new Promise((s) => setTimeout(s, 500));
    }
    // 模拟 agent 追问（loop 在 waiting_user 时收尾写的就是这句；append-only 表插入随便）
    await sql`
      insert into thread_message (thread_id, role, text)
      values (${i1!.thread_id}, 'agent', '他们现在用的是哪家的电池？')`;
    const second = await post(event('现在用的是 Voltaro 的', sender));
    const [i2] = await sql<Array<{ thread_id: string }>>`
      select thread_id from inbox where id = ${second.json.noteId}`;
    assert.equal(i2!.thread_id, i1!.thread_id, '在回答问题 → 同一条对话');
  });

  it('会话路由④：没有追问在等时，普通新内容**新开** —— Alpin 完 2 分钟后的 Heron 是两条', async () => {
    const sender = `frank-${SUFFIX}`;
    const first = await post(event('Istra 的售后：水泵异响，客户催得急', sender));
    const second = await post(event('Dellmanns 想了解太阳能方案', sender));
    const [i1] = await sql<Array<{ thread_id: string }>>`select thread_id from inbox where id = ${first.json.noteId}`;
    const [i2] = await sql<Array<{ thread_id: string }>>`select thread_id from inbox where id = ${second.json.noteId}`;
    assert.notEqual(i2!.thread_id, i1!.thread_id, '默认新开 —— 错并线比错开新条贵');
  });

  it('会话路由③：「更正 …」接回上一条（各人各记：B 的更正碰不到 A 的对话）', async () => {
    const a = `gina-${SUFFIX}`;
    const b = `hank-${SUFFIX}`;
    const first = await post(event('Neumeyer 要 3000W 逆变器带 CI-Bus', a));
    const [ia] = await sql<Array<{ thread_id: string }>>`select thread_id from inbox where id = ${first.json.noteId}`;
    // B 发「更正」：B 名下没有历史 → 按新速记记（D76：任何渠道都不给改别人的开口子）
    const fromB = await post(event('更正：不是 Neumeyer 是 Frankel', b));
    const [ib] = await sql<Array<{ thread_id: string }>>`select thread_id from inbox where id = ${fromB.json.noteId}`;
    assert.notEqual(ib!.thread_id, ia!.thread_id, 'B 的更正绝不能落进 A 的对话');
    // A 自己更正 → 接回自己那条
    const fromA = await post(event('更正：型号是 2000W 不是 3000W', a));
    const [ia2] = await sql<Array<{ thread_id: string }>>`select thread_id from inbox where id = ${fromA.json.noteId}`;
    assert.equal(ia2!.thread_id, ia!.thread_id);
  });

  it('管理台：改绑之后，同一个钉钉 ID 之后的记录归到已有账号名下', async () => {
    const sender = `ivy-${SUFFIX}`;
    await post(event('Brückner 项目今天过了样品评审', sender)); // 触发自动建号
    // 建一个「已有账号」，把身份改绑过去
    const made = await admin('/users', { userCode: `t-ch-${SUFFIX}`, displayName: '渠道测试人', role: 'staff' });
    assert.equal(made.status, 201);
    const list = await admin('/channels');
    const ident = list.json.identities.find((x: any) => x.channel_user_id === sender);
    assert.ok(ident, '身份该在管理台列表里');
    const re = await admin(`/channels/identities/${ident.id}/rebind`, { userCode: `t-ch-${SUFFIX}` });
    assert.equal(re.status, 200);
    const r2 = await post(event('Brückner 补充：SOP 定在 3 月', sender));
    const [row] = await sql<Array<{ user_code: string }>>`
      select u.user_code from inbox i join app_user u on u.id = i.user_id where i.id = ${r2.json.noteId}`;
    assert.equal(row!.user_code, `t-ch-${SUFFIX}`, '改绑只影响之后的记录 —— 这一条就是「之后」');
  });

  it('管理台：webhook 校验（非 https 拒）+ 补发密码只回显一次', async () => {
    const list = await admin('/channels');
    const convo = list.json.conversations.find((c: any) => c.conversation_key === GROUP);
    assert.ok(convo);
    const bad = await admin(`/channels/conversations/${convo.id}`, { webhookUrl: 'http://not-https' });
    assert.equal(bad.status, 400);
    const pw = await admin(`/users/t-ch-${SUFFIX}/password`, {}); // ⚠️ 要空 body —— 无 body 的话辅助函数会发成 GET
    assert.equal(pw.status, 200);
    assert.ok(pw.json.password?.length >= 8, '新密码只在这次响应里出现');
  });
});

describe('钉钉渠道 · 出站回执（真 webhook 往返）', { skip: !RUN }, () => {
  let server: Server | null = null;
  // ⚠️ close() 只等连接自然结束 —— 网关的 fetch 是 keep-alive 的，不 destroy 掉
  //    这些连接，server 永远关不完，这个测试子进程就永远不退出（实测挂了 23 分钟）。
  after(() => {
    server?.closeAllConnections?.();
    server?.close();
  });

  /**
   * 这一组**不走 HTTP 入口、直接造库里的三行**（inbox + staging + channel_event）——
   * 出站 ticker 只看库。走入口的话 enqueue 会把 staging 推进 agent 管线，
   * 到底停在 ready 还是 failed 取决于 AGENT_ENABLED，断言就变成
   * 「只在某种配置下才成立」（§2.42① 点名禁止的那种）。
   */
  const fabricate = async (opts: { group: string; sender: string; webhook?: string }) => {
    // ⚠️ webhook 要在 staging=ready 落库**之前**配好 —— ticker 3 秒一跳，
    //    反过来的话它可能抢在中间那几毫秒把这条记成 receipt_skipped（只记一次，救不回）。
    await sql`
      insert into channel_conversation (channel, conversation_key, title, webhook_url)
      values ('dingtalk', ${opts.group}, ${opts.group}, ${opts.webhook ?? null})
      on conflict (channel, conversation_key) do update set webhook_url = excluded.webhook_url`;
    const [u] = await sql<Array<{ id: string }>>`
      insert into app_user (user_code, display_name, password_hash, role)
      values (${`t-out-${randomUUID().slice(0, 8)}`}, '出站测试', 'x', 'staff')
      returning id`;
    const [i] = await sql<Array<{ id: string }>>`
      insert into inbox (client_id, user_id, text, source)
      values (${randomUUID()}, ${u!.id}, 'Castella 想把整车电气升级到锂电方案', 'dingtalk')
      returning id`;
    await sql`
      insert into channel_event (channel, event_key, kind, conversation_key, sender, app_user_id, inbox_id)
      values ('dingtalk', ${`msg:${randomUUID()}`}, 'message', ${opts.group}, ${opts.sender}, ${u!.id}, ${i!.id})`;
    const [s] = await sql<Array<{ id: string }>>`
      insert into staging (inbox_id, status, extracted, title)
      values (${i!.id}, 'ready',
              ${sql.json({ recordType: 'fitment', category: 'BATTERY' } as never)},
              'Castella 锂电升级')
      returning id`;
    return { inboxId: i!.id, stagingId: s!.id };
  };

  it('staging 到 ready → 回执打到群 webhook · 投递账落 channel_event · 🔴 只发一次', async () => {
    const got: any[] = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        got.push(JSON.parse(body));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ errcode: 0 }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const hookPort = (server!.address() as { port: number }).port;

    const sender = `judy-${SUFFIX}`;
    const { inboxId } = await fabricate({
      group: `itest 回执群 ${SUFFIX}`,
      sender,
      webhook: `http://127.0.0.1:${hookPort}/hook`,
    });

    // ticker 3 秒一跳 —— 最多等 15 秒
    let receipt: any = null;
    for (let i = 0; i < 30 && !receipt; i++) {
      await new Promise((s) => setTimeout(s, 500));
      receipt = got[0] ?? null;
    }
    assert.ok(receipt, '15 秒内该有回执打到 webhook');
    assert.equal(receipt.msgtype, 'markdown');
    assert.match(receipt.markdown.text, /待确认/);
    assert.doesNotMatch(receipt.markdown.text, /已入库/);
    assert.match(receipt.markdown.text, /Castella 锂电升级/);
    assert.deepEqual(receipt.at.atUserIds, [sender]);

    const [evt] = await sql<Array<{ n: number }>>`
      select count(*)::int as n from channel_event
      where channel = 'dingtalk' and kind = 'receipt' and inbox_id = ${inboxId}`;
    assert.equal(evt!.n, 1, '投递账要落 channel_event');

    // 再等两跳，确认**不会重发**（event_key 唯一挡着）
    await new Promise((s) => setTimeout(s, 7000));
    assert.equal(got.length, 1, '回执只许发一次');
  });

  it('没配 webhook 的群：记 receipt_skipped，不空转、不假装发过', async () => {
    const { inboxId } = await fabricate({ group: `itest 无回执群 ${SUFFIX}`, sender: `kate-${SUFFIX}` });
    let kind: string | null = null;
    for (let i = 0; i < 30 && !kind; i++) {
      await new Promise((s) => setTimeout(s, 500));
      const [evt] = await sql<Array<{ kind: string }>>`
        select kind from channel_event
        where channel = 'dingtalk' and inbox_id = ${inboxId} and kind like 'receipt%'`;
      kind = evt?.kind ?? null;
    }
    assert.equal(kind, 'receipt_skipped');
  });
});

describe('管理台 · 投递口一键测试（probe）', { skip: !RUN }, () => {
  let server: Server | null = null;
  after(() => {
    server?.closeAllConnections?.();
    server?.close();
  });

  const makeConvo = async (group: string, webhook: string | null) => {
    const [row] = await sql<Array<{ id: string }>>`
      insert into channel_conversation (channel, conversation_key, title, webhook_url)
      values ('dingtalk', ${group}, ${group}, ${webhook})
      on conflict (channel, conversation_key) do update set webhook_url = excluded.webhook_url
      returning id`;
    return row!.id;
  };

  it('没配 webhook → 409，说清先保存再测', async () => {
    const id = await makeConvo(`itest probe 无口群 ${SUFFIX}`, null);
    const r = await admin(`/channels/conversations/${id}/probe`, {});
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'no_webhook');
  });

  it('不存在的群 → 404', async () => {
    const r = await admin(`/channels/conversations/${randomUUID()}/probe`, {});
    assert.equal(r.status, 404);
  });

  it('真 webhook 往返：报文由真实代码拼 · @ 两样都在 · 回包带「去群里看」· 列表判出类型', async () => {
    const got: any[] = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        got.push(JSON.parse(body));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ errcode: 0 }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server!.address() as { port: number }).port;

    const group = `itest probe 群 ${SUFFIX}`;
    const id = await makeConvo(group, `http://127.0.0.1:${port}/hook`);
    const sender = `probe-${SUFFIX}`;
    const r = await admin(`/channels/conversations/${id}/probe`, { sender });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.kind, 'robot');
    // 🔴 「回包 200 ≠ 送达」这句判据必须回到点按钮的人眼前（§2.52）
    assert.match(r.json.note, /去群里/);

    assert.equal(got.length, 1, '只发一条测试消息');
    const body = got[0];
    // 自定义机器人：原样的钉钉报文，不许包 keyword 信封
    assert.equal(body.msgtype, 'markdown');
    assert.equal(body.keyword, undefined);
    assert.match(body.markdown.text, /投递口测试/);
    // @ 要真 @：atUserIds 和正文里的 @<userid> 两样都得有（§2.52⑥）
    assert.deepEqual(body.at.atUserIds, [sender]);
    assert.match(body.markdown.text, new RegExp(`@${sender}`));

    // GET /admin/channels 判出投递口类型 + 实验室消息数那一列
    const list = await admin('/channels');
    const convo = list.json.conversations.find((c: any) => c.conversation_key === group);
    assert.equal(convo.webhook_kind, 'robot');
    assert.equal(typeof convo.lab_count, 'number');
  });
});
