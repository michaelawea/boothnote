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

/**
 * 等这条 thread 里没有还在跑的那一版 —— 判据和 items.ts `isRunning` 同一条：
 * pending / transcribing / extracting，**以及失败了但 loop 还会重试的**。
 * 一次性环境里 Twenty 是死端口，loop 取客户名单那一步就失败 → 2s/4s/8s 重试三次才到终局
 * （这时候接一句更正上去会被如实挡回「上一句还在整理」—— 那是对的）。
 */
const settled = async (threadId: string) => {
  for (let i = 0; i < 80; i++) {
    const [b] = await sql<Array<{ n: number }>>`
      select count(*)::int as n from staging
      where thread_id = ${threadId}
        and (status in ('pending','transcribing','extracting')
             or (status = 'failed' and attempts < 3 and updated_at > now() - interval '20 seconds'))`;
    if (!b!.n) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`thread ${threadId} 40 秒还没整理完`);
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
    // D145 之后每条直答都以「日常助手：」开头 —— 断言兜底话术本身才有的字，不然恒真
    assert.match(r.json.ding.markdown.text, /没接上话/, '模型没开时要给兜底话术');
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
    // D143 之后钉钉不做确认 —— 「确认 / 撤回」回一句怎么操作（撤回点链接、入库 #N）
    const confirm = await post(event('确认', sender));
    assert.match(confirm.json.ding.markdown.text, /撤回/);
    assert.match(confirm.json.ding.markdown.text, /入库 #编号/);
    assert.equal(await inboxCountOf(sender), 0);
  });

  it('会话路由①（D146）：有待回答问题时，下一句不像提问的 → 接回那一条，问题用掉', async () => {
    const sender = `emma-${SUFFIX}`;
    const first = await post(event('Rosenfeld 想换电池，方案还没定', sender));
    const [i1] = await sql<Array<{ thread_id: string; user_id: string; sid: string }>>`
      select i.thread_id, i.user_id, s.id as sid from inbox i join staging s on s.inbox_id = i.id
      where i.id = ${first.json.noteId}`;
    await settled(i1!.thread_id);
    // 出站发「未入库 · 缺 X」汇报时会登记这个问题；这里直接造它（出站要 webhook，不是这条测的东西）
    await sql`
      insert into channel_open_question (channel, conversation_key, app_user_id, thread_id, staging_id, question, expires_at)
      values ('dingtalk', ${GROUP}, ${i1!.user_id}, ${i1!.thread_id}, ${i1!.sid}, '他们现在用的是哪家的电池？',
              now() + interval '30 minutes')
      on conflict (channel, conversation_key, app_user_id, thread_id) do update set
        staging_id = excluded.staging_id, expires_at = excluded.expires_at`;
    // 像提问的不当回答（真问题该去实验室）
    const q = await post(event('Voltaro 的电池保修几年？', sender));
    if (q.json.noteId) {
      const [iq] = await sql<Array<{ thread_id: string | null }>>`select thread_id from inbox where id = ${q.json.noteId}`;
      assert.notEqual(iq!.thread_id, i1!.thread_id, '提问不许并进这一条');
    }
    const second = await post(event('现在用的是 Voltaro 的', sender));
    const [i2] = await sql<Array<{ thread_id: string }>>`
      select thread_id from inbox where id = ${second.json.noteId}`;
    assert.equal(i2!.thread_id, i1!.thread_id, `在回答问题 → 同一条对话（bot 回的是：${second.json.ding?.markdown?.text}）`);
    assert.match(second.json.ding.markdown.text, /修改 #/);
    const [left] = await sql<Array<{ n: number }>>`
      select count(*)::int as n from channel_open_question
      where conversation_key = ${GROUP} and app_user_id = ${i1!.user_id}`;
    assert.equal(left!.n, 0, '答过的问题要用掉 —— 否则下一句无关的话也会被当成回答');
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
    // A 自己更正 → 接回自己那条（先等第一句整理完 —— 还在整理时接不上，会先存下，D146）
    await settled(ia!.thread_id);
    const fromA = await post(event('更正：型号是 2000W 不是 3000W', a));
    const [ia2] = await sql<Array<{ thread_id: string }>>`select thread_id from inbox where id = ${fromA.json.noteId}`;
    assert.equal(ia2!.thread_id, ia!.thread_id, `bot 回的是：${fromA.json.ding?.markdown?.text}`);
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
              ${sql.json({ recordType: 'fitment', category: 'BATTERY', summary: 'Castella 锂电升级' } as never)},
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
    // D145：状态先行。这条没客户 → 硬挡（D28），未入库、不出撤回链接、不排队
    assert.match(receipt.markdown.text, /^#### #\d+ 选型情报 · 未入库\n\*\*状态\*\*：未入库。原因：客户没对上名单/);
    assert.doesNotMatch(receipt.markdown.text, /已入库/);
    assert.doesNotMatch(receipt.markdown.text, /\[撤回\]/);
    assert.match(receipt.markdown.text, /Castella 锂电升级/);
    assert.deepEqual(receipt.at.atUserIds, [sender]);

    const [evt] = await sql<Array<{ n: number }>>`
      select count(*)::int as n from channel_event
      where channel = 'dingtalk' and kind = 'receipt' and inbox_id = ${inboxId}`;
    assert.equal(evt!.n, 1, '投递账要落 channel_event');
    const [st] = await sql<Array<{ status: string }>>`select status from staging where inbox_id = ${inboxId}`;
    assert.equal(st!.status, 'ready', '🔴 没过门槛的绝不排自动入库');
    // 缺口登记成这个人在这个群的待回答问题（D146）—— 下一句直接说就接回这一条
    const [q] = await sql<Array<{ question: string }>>`
      select q.question from channel_open_question q join inbox i on i.user_id = q.app_user_id
      where i.id = ${inboxId}`;
    assert.match(q!.question, /客户没对上名单/);

    // 再等两跳，确认**不会重发**（event_key 唯一挡着）
    await new Promise((s) => setTimeout(s, 7000));
    assert.equal(got.length, 1, '回执只许发一次');
  });

  it('🔴 D143 之前已经发过回执的（旧键 receipt:<sid>）→ 部署后不重发（不刷屏、也不会被补排自动入库）', async () => {
    const got: any[] = [];
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        got.push(JSON.parse(body));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ errcode: 0 }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const port = (srv.address() as { port: number }).port;
      const group = `itest 旧回执群 ${SUFFIX}`;
      await sql`
        insert into channel_conversation (channel, conversation_key, title, webhook_url)
        values ('dingtalk', ${group}, ${group}, ${`http://127.0.0.1:${port}/hook`})
        on conflict (channel, conversation_key) do update set webhook_url = excluded.webhook_url`;
      const [u] = await sql<Array<{ id: string }>>`
        insert into app_user (user_code, display_name, password_hash, role)
        values (${`t-old-${randomUUID().slice(0, 8)}`}, '旧回执', 'x', 'staff') returning id`;
      const [i] = await sql<Array<{ id: string }>>`
        insert into inbox (client_id, user_id, text, source) values (${randomUUID()}, ${u!.id}, '旧的一条', 'dingtalk')
        returning id`;
      await sql`
        insert into channel_event (channel, event_key, kind, conversation_key, sender, app_user_id, inbox_id)
        values ('dingtalk', ${`msg:${randomUUID()}`}, 'message', ${group}, ${`old-${SUFFIX}`}, ${u!.id}, ${i!.id})`;
      // 先插 staging（非 ready），再记旧键，最后才放成 ready —— 免得 ticker 抢在旧键落库之前
      const [st] = await sql<Array<{ id: string }>>`
        -- ⚠️ 不带 companyCode：带了的话出站要读客户名单，一次性环境里 Twenty 是死端口 →
        --    汇报素材取不到、退避重试，**旧键认不认都发不出去** —— 这条断言就恒真了（变异测试抓出来的）
        insert into staging (inbox_id, status, extracted) values (${i!.id}, 'extracting',
          ${sql.json({ recordType: 'fitment', category: 'INVERTER', modelName: 'X' } as never)})
        returning id`;
      await sql`
        insert into channel_event (channel, event_key, kind, inbox_id)
        values ('dingtalk', ${`receipt:${st!.id}`}, 'receipt', ${i!.id})`;
      await sql`update staging set status = 'ready', updated_at = now() - interval '1 minute' where id = ${st!.id}`;
      await new Promise((r) => setTimeout(r, 8000)); // 两跳多
      assert.equal(got.length, 0, '旧键在 —— 一条都不许发');
      const [now] = await sql<Array<{ status: string }>>`select status from staging where id = ${st!.id}`;
      assert.equal(now!.status, 'ready', '更不许被补排自动入库');
    } finally {
      srv.closeAllConnections?.();
      srv.close();
    }
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

/**
 * D143–D148：自动入库 + 撤回链接 + 二轮对话。
 *
 * 「这一条」的各种状态**直接造在库里**（thread + inbox + staging + message 事件）——
 * 和上面出站那组同一个理由：走入口的话 staging 停在哪个状态取决于 AGENT_ENABLED，
 * 断言就变成「只在某种配置下才成立」（§2.42①）。
 *
 * ⚠️ 「过了门槛 → 排上 60 秒倒计时」那一格要能解析客户（listCompanies 读 Twenty），
 *    一次性环境里 Twenty 是死端口 —— 那一格只在 `--with-twenty` 和真群里验（docs §7 眼睛验收）。
 */
describe('钉钉渠道 · 自动入库 / 撤回 / 二轮对话（D143–D148）', { skip: !RUN }, () => {
  const userOf = async (sender: string): Promise<string> => {
    await post(event('帮助', sender)); // 命令也会自动建号
    const [u] = await sql<Array<{ id: string }>>`
      select app_user_id as id from channel_identity where channel = 'dingtalk' and channel_user_id = ${sender}`;
    return u!.id;
  };

  const fab = async (
    userId: string,
    sender: string,
    st: { status: string; extracted?: Record<string, unknown>; confirmAfter?: Date | null; title?: string; payload?: unknown; refs?: unknown; msgAt?: Date },
  ) => {
    const [t] = await sql<Array<{ id: string; ref_no: string }>>`
      insert into thread (user_id, title, ref_no) values (${userId}, '钉钉速记', nextval('thread_ref_no_seq'))
      returning id, ref_no::text`;
    const [i] = await sql<Array<{ id: string }>>`
      insert into inbox (client_id, user_id, text, source, thread_id)
      values (${randomUUID()}, ${userId}, 'Alpin 逆变器 3000W', 'dingtalk', ${t!.id}) returning id`;
    // channel_event 只增不改 —— 要一条「3 小时前」的消息就在插入时写好时刻（不碰触发器）
    await sql`
      insert into channel_event (channel, event_key, kind, conversation_key, sender, app_user_id, inbox_id, created_at)
      values ('dingtalk', ${`msg:${randomUUID()}`}, 'message', ${GROUP}, ${sender}, ${userId}, ${i!.id},
              ${st.msgAt ?? new Date()})`;
    const [s] = await sql<Array<{ id: string }>>`
      insert into staging (inbox_id, thread_id, status, extracted, confirm_after, title, confirm_payload, twenty_refs)
      values (${i!.id}, ${t!.id}, ${st.status}, ${sql.json((st.extracted ?? { recordType: 'fitment' }) as never)},
              ${st.confirmAfter ?? null}, ${st.title ?? null},
              ${st.payload ? sql.json(st.payload as never) : null}, ${st.refs ? sql.json(st.refs as never) : null})
      returning id`;
    return { threadId: t!.id, refNo: Number(t!.ref_no), stagingId: s!.id, inboxId: i!.id };
  };

  /** 签一条撤回链接，绑在某一次排队（queueId）上 —— 和 act.ts issueWithdrawLink 同一个形状。 */
  const link = async (stagingId: string, ownerId: string, queueId: string): Promise<string> => {
    const { createHash, randomBytes } = await import('node:crypto');
    const token = randomBytes(16).toString('base64url');
    await sql`
      insert into action_link (token_hash, staging_id, queue_id, action, owner_id, expires_at)
      values (${createHash('sha256').update(token).digest('hex')}, ${stagingId}, ${queueId}, 'withdraw', ${ownerId},
              now() + interval '10 minutes')`;
    return token;
  };
  /** 一版「正在倒计时」的样子：confirm_payload 里带着这一次排队的 queueId。 */
  const counting = (inSec: number, queueId: string) => ({
    status: 'confirming',
    confirmAfter: new Date(Date.now() + inSec * 1000),
    payload: { companyId: '00000000-0000-0000-0000-0000000000c1', queueId },
  });

  const stagingOf = async (id: string) =>
    (await sql<Array<{ status: string; withdrawn_at: Date | null; confirm_after: Date | null }>>`
      select status, withdrawn_at, confirm_after from staging where id = ${id}`)[0]!;

  it('🔴 撤回链接：GET 只出页面、库一个字不动（链接预览 / 杀毒扫描都是 GET）', async () => {
    const sender = `wendy-${SUFFIX}`;
    const uid = await userOf(sender);
    const q = randomUUID();
    const it1 = await fab(uid, sender, { ...counting(60, q), title: '<script>alert(1)</script>Alpin' });
    const token = await link(it1.stagingId, uid, q);
    const before = await sql`select row_to_json(s)::text as j from staging s where id = ${it1.stagingId}`;
    for (let k = 0; k < 5; k++) {
      const r = await fetch(`${BASE}/a/${token}`);
      assert.equal(r.status, 200);
      const html = await r.text();
      assert.match(html, /<form method="post"/);
      assert.doesNotMatch(html, /<script>alert/, '🔴 标题来自 agent（读的是群里任何人都能发的原话）—— 必须转义');
      assert.match(html, /&lt;script&gt;/);
      assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    }
    const after2 = await sql`select row_to_json(s)::text as j from staging s where id = ${it1.stagingId}`;
    assert.equal(after2[0]!.j, before[0]!.j, 'GET 之后 staging 整行必须一模一样');
  });

  it('撤回链接：倒计时内 POST → 取消排队 + 记 withdrawn_at；再点 → 409；窗口外 → 409 不动', async () => {
    const sender = `xena-${SUFFIX}`;
    const uid = await userOf(sender);
    const q1 = randomUUID();
    const live = await fab(uid, sender, counting(60, q1));
    const token = await link(live.stagingId, uid, q1);
    const r = await fetch(`${BASE}/a/${token}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '' });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /已撤回，没有写入 CRM/);
    const s1 = await stagingOf(live.stagingId);
    assert.equal(s1.status, 'ready');
    assert.ok(s1.withdrawn_at, '撤回要留痕 —— 出站据此不再给它排队，并回一行群回声');
    const again = await fetch(`${BASE}/a/${token}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '' });
    assert.equal(again.status, 409);

    // 到点了（心跳还没认领）→ 撤不了，诚实说来不及
    const q2 = randomUUID();
    const late = await fab(uid, sender, counting(-1, q2));
    const t2 = await link(late.stagingId, uid, q2);
    const r2 = await fetch(`${BASE}/a/${t2}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '' });
    assert.equal(r2.status, 409);
    // 心跳 1 秒一跳：这一刻它可能已经认领（正在写入）或写失败退回了 ready —— 两种都不是「可撤回」
    assert.match(await r2.text(), /来不及撤回|不在入库倒计时里/);
    assert.equal((await stagingOf(late.stagingId)).withdrawn_at, null);

    // 审计：每一次点击都留一笔（链接证明不了身份，至少要知道哪一版被点了什么）
    const [c] = await sql<Array<{ n: number }>>`
      select count(*)::int as n from channel_event where kind = 'click' and raw->>'stagingId' = ${live.stagingId}`;
    assert.equal(c!.n, 2);
  });

  it('撤回链接：瞎编的 token → 404', async () => {
    const r = await fetch(`${BASE}/a/AAAAAAAAAAAAAAAAAAAAAA`);
    assert.equal(r.status, 404);
  });

  it('🔴 入库 #N：客户没对上 → 拒（hard 越不过），状态不动', async () => {
    const sender = `yuri-${SUFFIX}`;
    const uid = await userOf(sender);
    const it1 = await fab(uid, sender, { status: 'ready', extracted: { recordType: 'fitment', category: 'INVERTER', modelName: 'X' } });
    const r = await post(event(`入库 #${it1.refNo}`, sender));
    assert.equal(r.json.kind, 'final');
    assert.match(r.json.ding.markdown.text, /不能入库/);
    assert.match(r.json.ding.markdown.text, /客户没对上名单/);
    assert.equal((await stagingOf(it1.stagingId)).status, 'ready');
  });

  it('🔴 #N 是别人的 → 不接、原话先存下（不进 agent 队列）、那一条一个字不动（D76）', async () => {
    const a = `zack-${SUFFIX}`;
    const b = `abby-${SUFFIX}`;
    const ua = await userOf(a);
    await userOf(b);
    const it1 = await fab(ua, a, { status: 'ready' });
    const r = await post(event(`#${it1.refNo} 型号改成 2000W`, b));
    assert.match(r.json.ding.markdown.text, /不是你录的/);
    assert.match(r.json.ding.markdown.text, /原话已保存/);
    const [n] = await sql<Array<{ n: number }>>`select count(*)::int as n from staging where thread_id = ${it1.threadId}`;
    assert.equal(n!.n, 1, '别人的那一条不许多出一版');
    const [p] = await sql<Array<{ thread_id: string | null; status: string }>>`
      select i.thread_id, s.status from inbox i join staging s on s.inbox_id = i.id where i.id = ${r.json.noteId}`;
    assert.equal(p!.thread_id, null, '存下的原话没有 thread —— resumePending 也不会捡它去跑 agent（D31）');
    assert.equal(p!.status, 'pending');
  });

  it('#N 那一条上一句还在整理 → 不接、先存下，不和它抢（V3 继承 V1 会丢掉 V2）', async () => {
    const sender = `bert-${SUFFIX}`;
    const uid = await userOf(sender);
    const it1 = await fab(uid, sender, { status: 'extracting' });
    const r = await post(event(`#${it1.refNo} 送样改到 Q1`, sender));
    assert.match(r.json.ding.markdown.text, /还在整理/);
    const [n] = await sql<Array<{ n: number }>>`select count(*)::int as n from staging where thread_id = ${it1.threadId}`;
    assert.equal(n!.n, 1);
  });

  it('🔴 #N 在倒计时里 → 先取消上一版的排队，再出新一版（只有最后一版会入库）', async () => {
    const sender = `cleo-${SUFFIX}`;
    const uid = await userOf(sender);
    const it1 = await fab(uid, sender, { status: 'confirming', confirmAfter: new Date(Date.now() + 60_000) });
    const r = await post(event(`#${it1.refNo} 型号是 2000 的`, sender));
    assert.equal(r.json.kind, 'ack');
    assert.match(r.json.ding.markdown.text, /修改 #\d+/);
    assert.match(r.json.ding.markdown.text, /倒计时已取消/);
    const s1 = await stagingOf(it1.stagingId);
    assert.equal(s1.status, 'ready', '上一版回到 ready —— 新一版出来后由 loop 取代它');
    assert.equal(s1.withdrawn_at, null, '这不是撤回，是被修改取代');
    const [i2] = await sql<Array<{ thread_id: string }>>`select thread_id from inbox where id = ${r.json.noteId}`;
    assert.equal(i2!.thread_id, it1.threadId);
  });

  it('🔴 #N 已入库 → 新一版带 replaces（D108），入库时原地更新、不出第二份', async () => {
    const sender = `dora-${SUFFIX}`;
    const uid = await userOf(sender);
    const it1 = await fab(uid, sender, {
      status: 'confirmed',
      extracted: { recordType: 'fitment', companyCode: 'ALPIN', category: 'INVERTER', modelName: '3000' },
      payload: { companyId: '00000000-0000-0000-0000-0000000000c1' },
      refs: { visitId: 'v1', productFitmentId: 'pf1' },
    });
    const r = await post(event(`#${it1.refNo} 型号是 2000 的`, sender));
    assert.match(r.json.ding.markdown.text, /原地更新/);
    const [s2] = await sql<Array<{ replaces: any }>>`select replaces from staging where inbox_id = ${r.json.noteId}`;
    assert.equal(s2!.replaces?.stagingId, it1.stagingId);
    assert.equal(s2!.replaces?.refs?.productFitmentId, 'pf1');
    assert.equal(s2!.replaces?.companyId, '00000000-0000-0000-0000-0000000000c1');
    assert.equal((await stagingOf(it1.stagingId)).status, 'confirmed', '所有权在入库成功那一刻才转移（D108）');
  });

  it('待办：列出本人在这个群里没入库的，已入库的不列', async () => {
    const sender = `ella-${SUFFIX}`;
    const uid = await userOf(sender);
    const held = await fab(uid, sender, { status: 'ready', extracted: { recordType: 'fitment' } });
    const done = await fab(uid, sender, { status: 'confirmed' });
    const r = await post(event('待办', sender));
    assert.equal(r.json.kind, 'final');
    assert.match(r.json.ding.markdown.text, new RegExp(`#${held.refNo} .*未入库`));
    assert.doesNotMatch(r.json.ding.markdown.text, new RegExp(`#${done.refNo} `));
  });

  it('🔴 queueAutoCommit 的守卫全在同一条 where 里：只排 ready 且没被取代/撤回/删掉的；force 只越过撤回', async () => {
    const { queueAutoCommit } = await import('../confirm.ts');
    const sender = `gail-${SUFFIX}`;
    const uid = await userOf(sender);
    const pay = () => ({ companyId: '00000000-0000-0000-0000-0000000000c1', queueId: randomUUID() });
    for (const status of ['extracting', 'failed', 'confirming', 'confirmed', 'superseded']) {
      const it1 = await fab(uid, sender, { status });
      assert.equal(await queueAutoCommit(it1.stagingId, uid, pay()), null, status);
    }
    const ok = await fab(uid, sender, { status: 'ready' });
    assert.ok(await queueAutoCommit(ok.stagingId, uid, pay()), 'ready 的要排得上');
    assert.equal((await stagingOf(ok.stagingId)).status, 'confirming');

    const wd = await fab(uid, sender, { status: 'ready' });
    await sql`update staging set withdrawn_at = now() where id = ${wd.stagingId}`;
    assert.equal(await queueAutoCommit(wd.stagingId, uid, pay()), null, '撤回过的：出站不许自己再排');
    assert.ok(await queueAutoCommit(wd.stagingId, uid, pay(), true), '人说「入库 #N」（force）才排');
    assert.equal((await stagingOf(wd.stagingId)).withdrawn_at, null, '排上了就清掉撤回标记');

    const del = await fab(uid, sender, { status: 'ready' });
    await sql`update staging set note_deleted_at = now() where id = ${del.stagingId}`;
    assert.equal(await queueAutoCommit(del.stagingId, uid, pay(), true), null, '删掉的连 force 都不排');
    await sql`update staging set status = 'ready', confirm_after = null where id in (${ok.stagingId}, ${wd.stagingId})`;
  });

  it('🔴 两段式：排队只占位（心跳认领不到）→ 送达才 arm 开始倒计时；没送达 disarm；只认自己那一次', async () => {
    const { queueAutoCommit, armAutoCommit, disarmAutoCommit } = await import('../confirm.ts');
    const sender = `hugo-${SUFFIX}`;
    const uid = await userOf(sender);
    const it1 = await fab(uid, sender, { status: 'ready' });
    const q = randomUUID();
    await queueAutoCommit(it1.stagingId, uid, { companyId: '00000000-0000-0000-0000-0000000000c1', queueId: q });
    const placed = await stagingOf(it1.stagingId);
    assert.ok(placed.confirm_after!.getTime() - Date.now() > 12 * 3600_000, '占位远在未来 —— 心跳不会去认领一条人还没看见的');
    assert.equal(await armAutoCommit(it1.stagingId, randomUUID(), 60), null, '别人的 queueId arm 不了');
    assert.equal(await disarmAutoCommit(it1.stagingId, randomUUID()), false, '别人的 queueId 撤不了');
    const at = await armAutoCommit(it1.stagingId, q, 60);
    assert.ok(at && at.getTime() - Date.now() < 61_000, 'arm 之后倒计时从这一刻开始');
    assert.equal(await disarmAutoCommit(it1.stagingId, q), true);
    assert.equal((await stagingOf(it1.stagingId)).status, 'ready');
  });

  it('🔴 进程在「排上」和「送达」之间被杀 → 重启时占位被收回成 ready（之后重新汇报），已 arm 的不动', async () => {
    const { recoverUnarmedAutoCommits } = await import('../confirm.ts');
    const sender = `ivan-${SUFFIX}`;
    const uid = await userOf(sender);
    const orphan = await fab(uid, sender, { ...counting(24 * 3600, randomUUID()) });
    const armed = await fab(uid, sender, counting(60, randomUUID()));
    await recoverUnarmedAutoCommits();
    assert.equal((await stagingOf(orphan.stagingId)).status, 'ready');
    assert.equal((await stagingOf(armed.stagingId)).status, 'confirming');
    await sql`update staging set status = 'ready', confirm_after = null where id = ${armed.stagingId}`;
  });

  it('🔴 撤回链接绑的是「那一次排队」：撤回后「入库 #N」重新排上，旧链接撤不掉新的倒计时', async () => {
    const sender = `jane-${SUFFIX}`;
    const uid = await userOf(sender);
    const q1 = randomUUID();
    const it1 = await fab(uid, sender, counting(60, q1));
    const old = await link(it1.stagingId, uid, q1);
    const post1 = () => fetch(`${BASE}/a/${old}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '' });
    assert.equal((await post1()).status, 200);
    // 人说「入库 #N」→ 新的一次排队（新 queueId）
    await sql`update staging set status = 'confirming', confirm_after = now() + interval '60 seconds',
              confirm_payload = ${sql.json({ companyId: '00000000-0000-0000-0000-0000000000c1', queueId: randomUUID() } as never)},
              withdrawn_at = null where id = ${it1.stagingId}`;
    const r = await post1();
    assert.equal(r.status, 409);
    assert.match(await r.text(), /上一次倒计时的，已经作废/);
    assert.equal((await stagingOf(it1.stagingId)).status, 'confirming', '新的倒计时一个字没动');
    await sql`update staging set status = 'ready', confirm_after = null where id = ${it1.stagingId}`;
  });

  it('🔴 「客户没对上」那一条在等回答时，直接说出客户名 → 接回这一条（不是当成「别家客户」新开）', async () => {
    const sender = `kurt-${SUFFIX}`;
    const uid = await userOf(sender);
    const it1 = await fab(uid, sender, { status: 'ready', extracted: { recordType: 'fitment', category: 'INVERTER' } });
    await sql`
      insert into channel_open_question (channel, conversation_key, app_user_id, thread_id, staging_id, question, expires_at)
      values ('dingtalk', ${GROUP}, ${uid}, ${it1.threadId}, ${it1.stagingId}, '补充：客户没对上名单', now() + interval '30 minutes')`;
    const r = await post(event('是 Alpin 的', sender));
    const [i] = await sql<Array<{ thread_id: string }>>`select thread_id from inbox where id = ${r.json.noteId}`;
    assert.equal(i!.thread_id, it1.threadId);
  });

  it('🔴 同时有两条在等回答 → 不猜：原话存下、请带 #编号，两条都不动', async () => {
    const sender = `lena-${SUFFIX}`;
    const uid = await userOf(sender);
    const a = await fab(uid, sender, { status: 'ready' });
    const b = await fab(uid, sender, { status: 'ready' });
    for (const x of [a, b]) {
      await sql`
        insert into channel_open_question (channel, conversation_key, app_user_id, thread_id, staging_id, question, expires_at)
        values ('dingtalk', ${GROUP}, ${uid}, ${x.threadId}, ${x.stagingId}, '几台？', now() + interval '30 minutes')`;
    }
    const r = await post(event('200 台', sender));
    assert.match(r.json.ding.markdown.text, /不知道是在答哪一条/);
    assert.match(r.json.ding.markdown.text, new RegExp(`#${a.refNo}`));
    for (const x of [a, b]) {
      const [n] = await sql<Array<{ n: number }>>`select count(*)::int as n from staging where thread_id = ${x.threadId}`;
      assert.equal(n!.n, 1);
    }
  });

  it('窗口：过期的待回答问题不再吸话；3 小时前的那一条，「更正 …」也不再接', async () => {
    const sender = `mona-${SUFFIX}`;
    const uid = await userOf(sender);
    const it1 = await fab(uid, sender, { status: 'ready', msgAt: new Date(Date.now() - 3 * 3600_000) });
    await sql`
      insert into channel_open_question (channel, conversation_key, app_user_id, thread_id, staging_id, question, asked_at, expires_at)
      values ('dingtalk', ${GROUP}, ${uid}, ${it1.threadId}, ${it1.stagingId}, '几台？',
              now() - interval '31 minutes', now() - interval '1 minute')`;
    const r1 = await post(event('大概 200 台吧', sender));
    const r2 = await post(event('更正：是 3000W', sender));
    for (const r of [r1, r2]) {
      const [i] = await sql<Array<{ thread_id: string | null }>>`select thread_id from inbox where id = ${r.json.noteId}`;
      assert.notEqual(i?.thread_id, it1.threadId);
    }
  });

  it('命令被流程重放 → 只执行一次', async () => {
    const sender = `nina-${SUFFIX}`;
    await userOf(sender);
    const msg = event('待办', sender);
    const first = await post(msg);
    assert.match(first.json.ding.markdown.text, /待办/);
    const again = await post(msg);
    assert.match(again.json.ding.markdown.text, /已经处理过了/);
  });

  it('#N 单独一句 → 同步重发这一条的汇报（webhook 没送到 / 链接过期时的出路），不出新一版', async () => {
    const sender = `fred-${SUFFIX}`;
    const uid = await userOf(sender);
    const it1 = await fab(uid, sender, { status: 'ready', extracted: { recordType: 'fitment', summary: 'Alpin 换逆变器' } });
    const r = await post(event(`#${it1.refNo}`, sender));
    assert.equal(r.json.kind, 'final');
    assert.match(r.json.ding.markdown.text, new RegExp(`^#### #${it1.refNo} 选型情报 · 未入库`));
    assert.match(r.json.ding.markdown.text, /Alpin 换逆变器/);
    const [n] = await sql<Array<{ n: number }>>`select count(*)::int as n from staging where thread_id = ${it1.threadId}`;
    assert.equal(n!.n, 1);
  });
});

/**
 * D143 整条链：过门槛 → 汇报（待入库 + 撤回链接）→ 倒计时 → 心跳写 Twenty → 群里回「已入库」；
 * 以及：汇报 → 点撤回 → 群里回「已撤回」、CRM 一条没写。
 *
 * 要真 Twenty（门槛要按名单解析客户，入库要真写）—— 一次性环境里 skip 并说明；
 * `./scripts/integration-stack.sh --with-twenty` 跑得到，末尾 purge-test-records 按 twenty_refs 清掉。
 */
const twentyUp = await fetch(`${env.twentyUrl}/rest/companies?limit=1`, {
  headers: { Authorization: `Bearer ${env.twentyKey}` },
  signal: AbortSignal.timeout(4000),
})
  .then((r) => r.ok || r.status === 429)
  .catch(() => false);

describe('钉钉渠道 · 自动入库整条链（要真 Twenty）', { skip: !RUN ? 'secret 没配' : !twentyUp ? '要真 Twenty（--with-twenty）' : false }, () => {
  let server: Server | null = null;
  const got: any[] = [];
  after(() => {
    server?.closeAllConnections?.();
    server?.close();
  });

  const waitFor = async <T,>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const v = await fn();
      if (v) return v as T;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`${ms / 1000} 秒内没等到：${what}`);
  };

  const setup = async () => {
    if (!server) {
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
    }
    const port = (server!.address() as { port: number }).port;
    const group = `itest 自动入库群 ${SUFFIX}`;
    await sql`
      insert into channel_conversation (channel, conversation_key, title, webhook_url)
      values ('dingtalk', ${group}, ${group}, ${`http://127.0.0.1:${port}/hook`})
      on conflict (channel, conversation_key) do update set webhook_url = excluded.webhook_url`;
    // 名单里随便一家真客户（门槛按名单解析客户 —— D28）
    const r = await fetch(`${env.twentyUrl}/rest/companies?limit=60`, { headers: { Authorization: `Bearer ${env.twentyKey}` } });
    const code = ((await r.json()) as any)?.data?.companies?.find((c: any) => c.accountCode)?.accountCode;
    assert.ok(code, 'Twenty 里得有一家带 accountCode 的客户');
    return { group, code: code as string };
  };

  const fabReady = async (group: string, sender: string, code: string, tag: string) => {
    const [u] = await sql<Array<{ id: string }>>`
      insert into app_user (user_code, display_name, password_hash, role)
      values (${`t-auto-${randomUUID().slice(0, 8)}`}, '自动入库测试', 'x', 'staff') returning id`;
    const [t] = await sql<Array<{ id: string }>>`insert into thread (user_id, title) values (${u!.id}, 'itest') returning id`;
    const [i] = await sql<Array<{ id: string }>>`
      insert into inbox (client_id, user_id, text, source, thread_id)
      values (${randomUUID()}, ${u!.id}, ${`itest ${tag}`}, 'dingtalk', ${t!.id}) returning id`;
    await sql`
      insert into channel_event (channel, event_key, kind, conversation_key, sender, app_user_id, inbox_id)
      values ('dingtalk', ${`msg:${randomUUID()}`}, 'message', ${group}, ${sender}, ${u!.id}, ${i!.id})`;
    const [s] = await sql<Array<{ id: string }>>`
      insert into staging (inbox_id, thread_id, status, extracted) values (${i!.id}, ${t!.id}, 'extracting',
        ${sql.json({ recordType: 'fitment', companyCode: code, category: 'INVERTER', modelName: `ITEST-${tag}`,
                     summary: `itest 自动入库 ${tag}` } as never)})
      returning id`;
    // agent 的收尾消息（出站等它落库才汇报）→ 再放成 ready
    await sql`insert into thread_message (thread_id, role, text, inbox_id, meta)
              values (${t!.id}, 'agent', '已整理', ${i!.id}, ${sql.json({ questions: [] } as never)})`;
    await sql`update staging set status = 'ready' where id = ${s!.id}`;
    return { stagingId: s!.id, sender };
  };

  const msgsFor = (sender: string) => got.filter((m) => m?.at?.atUserIds?.[0] === sender);

  it('🔴 过门槛 → 「待入库」汇报（第 2 行撤回链接）→ 倒计时 → 写进 CRM → 群里回「已入库」', async () => {
    const { group, code } = await setup();
    const { stagingId, sender } = await fabReady(group, `auto-${SUFFIX}`, code, 'A');
    const report = await waitFor(async () => msgsFor(sender)[0], 20_000, '待入库汇报');
    const text: string = report.markdown.text;
    assert.match(text, /^#### #\d+ 选型情报 · 待入库\n\*\*状态\*\*：待入库，\d+ 秒后自动写入 CRM。\[撤回\]\(/);
    assert.match(text, /拟写入 CRM/);
    const st = await waitFor(async () => {
      const [r] = await sql<Array<{ status: string; created_records: any }>>`
        select status, created_records from staging where id = ${stagingId}`;
      return r!.status === 'confirmed' ? r : null;
    }, 60_000, '入库');
    assert.ok(Array.isArray(st.created_records) && st.created_records.length >= 2, '至少建了拜访 + 选型情报');
    const notice = await waitFor(async () => msgsFor(sender).find((m) => /已入库/.test(m.markdown.text)), 20_000, '已入库回声');
    assert.match(notice.markdown.text, /^#### #\d+ · 已入库/);
  });

  it('🔴 汇报 → 点撤回链接 → CRM 一条没写、群里回「已撤回」；之后不再自己排队', async () => {
    const { group, code } = await setup();
    const { stagingId, sender } = await fabReady(group, `wd-${SUFFIX}`, code, 'B');
    const report = await waitFor(async () => msgsFor(sender)[0], 20_000, '待入库汇报');
    const url = /\[撤回\]\(([^)]+)\)/.exec(report.markdown.text)?.[1];
    assert.ok(url, '汇报里要有撤回链接');
    const token = url!.split('/a/')[1]!;
    const r = await fetch(`${BASE}/a/${token}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '' });
    assert.equal(r.status, 200);
    const notice = await waitFor(async () => msgsFor(sender).find((m) => /已撤回/.test(m.markdown.text)), 20_000, '已撤回回声');
    assert.match(notice.markdown.text, /没有写入 CRM/);
    await new Promise((s) => setTimeout(s, 12_000)); // 过了原来的倒计时 + 几跳
    const [now] = await sql<Array<{ status: string; twenty_refs: any }>>`
      select status, twenty_refs from staging where id = ${stagingId}`;
    assert.equal(now!.status, 'ready');
    assert.equal(now!.twenty_refs, null, 'CRM 一条都不许写');
  });
});
