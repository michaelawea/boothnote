import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { env } from '../env.ts';
import { sql } from '../db.ts';
import { runLabAgent } from '../../agent/src/index.ts';
import { normalizeDingtalk, deriveClientId, type ChannelEvent } from './payload.ts';
import { md, outboundBody, type DingMessage } from './render.ts';

/**
 * 实验室 agent 的钉钉入口 —— **群里的第二个 bot**（T94 · D121，维护者 2026-08-17）。
 *
 * 「录入 Agent 在钉钉里面，是另一个 bot，两个 bot 不一样」——
 * 所以这里是**另一条流程、另一个 secret、另一个端点**，
 * 和 `/channels/dingtalk/events` 之间零共用状态。
 *
 * ══ 复用了什么 ═══════════════════════════════════════════════
 *
 * 报文归一化（`payload.ts`）· 回执渲染（`render.ts` 的 `md`）· 群 webhook 投递，
 * 三样直接拿来用 —— 这正是渠道适配层当初分层的目的（D117）。
 * **新写的只有「跑空 agent + 会话窗口 + 两条腿投递」这一段。**
 *
 * ══ 回答怎么送出去（维护者：「响应机制和之前的钉钉一样」）═══════
 *
 * 先同步等 `LAB_SYNC_WAIT_MS`（默认 12 秒）：
 *   · 等到了 → **一条消息答完**（群里干净，也不依赖 webhook 配没配）
 *   · 等不到 → 回 ack，答案跑完之后走群 webhook 补发（和录入 bot 同一条腿）
 * 每一轮都记进 `lab_run`，`delivery` 那一格写清楚它到底是怎么送到的 ——
 * 🔴 包括 `dropped`（超时了、群又没配 webhook）。**「人问了但没得到回答」不许是一片静默。**
 */

const secretOk = (given: unknown): boolean => {
  if (typeof given !== 'string' || !given || !env.labSecret) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(env.labSecret);
  return a.length === b.length && timingSafeEqual(a, b);
};

const CHANNEL = 'dingtalk-lab';

// 按人限频。空 agent 也是要烧钱的（同录入 bot 那道）。
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 60_000;
const hits = new Map<string, number[]>();
const rateLimited = (sender: string): boolean => {
  const now = Date.now();
  const arr = (hits.get(sender) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_LIMIT) return true;
  arr.push(now);
  hits.set(sender, arr);
  return false;
};

/**
 * 「这一条接着上一轮，还是重开一条」——**纯逻辑，有单测**。
 *
 * 窗口从上一条消息起算（滑动）。固定时间桶会在整点把一段正在进行的对话拦腰切断。
 */
export const shouldContinue = (lastAt: Date | null, now: Date, windowMin: number): boolean =>
  Boolean(lastAt) && now.getTime() - lastAt!.getTime() < windowMin * 60_000;

/** 取（群, 人）的会话；窗口内沿用，超了换一个新的 session_id。 */
const resolveSession = async (
  conversationKey: string,
  sender: string,
  now: Date,
): Promise<{ sessionId: string; turn: number; fresh: boolean }> => {
  const [row] = await sql<Array<{ session_id: string; last_at: Date; turns: number }>>`
    select session_id, last_at, turns from lab_session
    where channel = ${CHANNEL} and conversation_key = ${conversationKey} and sender = ${sender}`;

  const keep = row ? shouldContinue(row.last_at, now, env.labSessionWindowMin) : false;
  const sessionId = keep ? row!.session_id : randomUUID();
  const turns = (keep ? row!.turns : 0) + 1;

  await sql`
    insert into lab_session (channel, conversation_key, sender, session_id, turns, last_at)
    values (${CHANNEL}, ${conversationKey}, ${sender}, ${sessionId}, ${turns}, ${now})
    on conflict (channel, conversation_key, sender)
      do update set session_id = excluded.session_id,
                    turns      = excluded.turns,
                    last_at    = excluded.last_at`;

  return { sessionId, turn: turns, fresh: !keep };
};

/**
 * 这个群的出站 webhook。**先找实验室 bot 自己的，再退回录入 bot 那条** ——
 * 一个群里的自定义机器人就是个投递口，两个 bot 共用同一个完全正常，
 * 这样 维护者 不用为同一个群配两遍。
 */
const webhookFor = async (conversationKey: string): Promise<string | null> => {
  const [c] = await sql<Array<{ webhook_url: string | null }>>`
    select webhook_url from channel_conversation
    where conversation_key = ${conversationKey} and webhook_url is not null
    order by case when channel = ${CHANNEL} then 0 else 1 end
    limit 1`;
  return c?.webhook_url ?? (env.dingtalkDefaultWebhook || null);
};

const deliver = async (webhook: string, ding: DingMessage): Promise<boolean> => {
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(outboundBody(ding, webhook)),
      signal: AbortSignal.timeout(5000),
    });
    const body = res.ok ? ((await res.json().catch(() => ({}))) as { errcode?: number }) : null;
    return Boolean(res.ok && (body?.errcode === undefined || body?.errcode === 0));
  } catch {
    return false;
  }
};

/** 模型那段话 → 一条钉钉消息。空回答也要给人一句话，不能发一条空消息。 */
export const renderLabReply = (
  text: string,
  sender: string,
  error: string | null,
  stopReason: string,
): DingMessage => {
  const body = String(text ?? '').trim();
  if (body) return md(body, sender);
  if (stopReason === 'timeout' || stopReason === 'max_steps')
    return md('这个问题我想太久了，没答完。换个更具体的问法再试一次？', sender);
  return md(`没答上来${error ? `（${error.slice(0, 100)}）` : ''}。稍后再试，或者找 维护者 看一眼日志。`, sender);
};

export type LabOutcome = { kind: 'final' | 'ack'; ding: DingMessage; runId: string | null };

/**
 * 跑一轮实验室 agent —— **两个入口共用的核心**（D127 抽出来的，行为对旧入口零变化）：
 *
 * · 旧端点 `/channels/lab/events`：`syncWaitMs = env.labSyncWaitMs`（等到了就一条答完）。
 * · 统一入口的路由（route.ts）：`syncWaitMs = 0, routed = true` ——
 *   维护者 定的形态：ack 立即说「转给了谁」，**答案一律走群 webhook**，不再同步等。
 *
 * 会话（lab_session）、账本（lab_run）、幂等键都不区分入口 ——
 * 同群同人从哪个门进来，都是同一段对话、同一套账。
 */
export const runLabForEvent = async (
  ev: ChannelEvent,
  opts: { syncWaitMs: number; routed?: boolean },
): Promise<LabOutcome> => {
  const text = ev.text.trim();
  const now = new Date();
  const { sessionId, turn } = await resolveSession(ev.conversationKey, ev.sender, now);

  const [run] = await sql<Array<{ id: string }>>`
    insert into lab_run (channel, conversation_key, sender, session_id, prompt)
    values (${CHANNEL}, ${ev.conversationKey}, ${ev.sender}, ${sessionId}, ${text})
    returning id`;
  const runId = run!.id;

  /**
   * 🔴 **同一条报文重放不重跑**（流程重试 / 节点重放）——
   * 复用录入那边的合成幂等键：同一份报文算出同一个 key。
   * 空 agent 没有 inbox 那道唯一约束兜底，所以这一层要自己挡。
   */
  const dupKey = deriveClientId(ev);
  const [dup] = await sql<Array<{ id: string }>>`
    insert into channel_event (channel, event_key, kind, conversation_key, sender)
    values (${CHANNEL}, ${`lab:${dupKey}`}, 'message', ${ev.conversationKey}, ${ev.sender})
    on conflict (channel, event_key) do nothing
    returning id`;
  if (!dup) {
    await sql`update lab_run set delivery = 'sync', text = '（重复投递，未重跑）' where id = ${runId}`;
    return { kind: 'final', ding: md('这句我刚回答过了（重复投递），不再跑一遍。', ev.sender), runId };
  }

  // ── 跑 agent ─────────────────────────────────────────────────────
  let answered = false;
  const running = runLabAgent({
    prompt: text,
    sessionId,
    // 工具要靠它做逐群授权（定价那份只在白名单群里可见，T95）
    ctx: { conversationKey: ev.conversationKey, sender: ev.sender },
  })
    .then(async (r) => {
      await sql`
        update lab_run set text = ${r.text}, steps = ${r.steps}, stop_reason = ${r.stopReason},
               trace = ${sql.json(r.trace as never)}, duration_ms = ${r.durationMs},
               error = ${r.error ?? null}
         where id = ${runId}`;
      return r;
    })
    .catch(async (e: Error) => {
      await sql`update lab_run set stop_reason = 'error', error = ${e.message.slice(0, 500)}
                where id = ${runId}`;
      return null;
    });

  if (opts.syncWaitMs > 0) {
    const raced = await Promise.race([
      running,
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), opts.syncWaitMs)),
    ]);
    if (raced !== 'timeout') {
      answered = true;
      const ding = raced
        ? renderLabReply(raced.text, ev.sender, raced.error ?? null, raced.stopReason)
        : md('这条没处理成，稍后再试。', ev.sender);
      await sql`update lab_run set delivery = 'sync' where id = ${runId}`;
      return { kind: 'final', ding, runId };
    }
  }

  /**
   * 异步那条腿：答案跑完走群 webhook。
   * 🔴 **没配 webhook 就要当场说出来** —— 否则人会一直等一条永远不会来的消息。
   */
  const webhook = await webhookFor(ev.conversationKey);
  void running.then(async (r) => {
    if (answered) return;
    if (!webhook) {
      await sql`update lab_run set delivery = 'dropped' where id = ${runId}`;
      console.warn(`  ⚠️ 实验室 agent 答完了但没地方发（群没配 webhook）：lab_run ${runId}`);
      return;
    }
    const ding = r
      ? renderLabReply(r.text, ev.sender, r.error ?? null, r.stopReason)
      : md('这条没处理成，稍后再试。', ev.sender);
    const sent = await deliver(webhook, ding);
    await sql`update lab_run set delivery = ${sent ? 'webhook' : 'dropped'} where id = ${runId}`;
    if (!sent) console.warn(`  ⚠️ 实验室 agent 的回答没发出去：lab_run ${runId}`);
  });

  // ack。路由来的那条要说清「转给了谁」（维护者 2026-08-18 定的流程）
  const roundNote = turn > 1 ? `（第 ${turn} 轮）` : '';
  const ackText = opts.routed
    ? webhook
      ? `🧪 已转给实验室助手，答案稍后发回群里。${roundNote}`
      : '🧪 这条转给了实验室助手 —— 但这个群还没配回执机器人，答案发不回来。让 维护者 去管理台「钉钉渠道」配一下（现在有一键测试）。'
    : webhook
      ? `🤔 这个问题要想一会儿，答完发回群里。${roundNote}`
      : '🤔 这个问题要想一会儿 —— 但这个群还没配回执机器人，答案发不回来。先换个简单点的问法，或者让 维护者 配一下。';
  return { kind: 'ack', ding: md(ackText, ev.sender), runId };
};

export const registerLabChannel = (app: FastifyInstance) => {
  app.post('/channels/lab/events', async (req, reply) => {
    // 留空 = 这个 bot 不存在（D66 式安全默认）。
    // secret 默认和录入 bot 共用（env.ts 里那段），所以这里空着通常意味着两个都没配。
    if (!env.labSecret)
      return reply.code(503).send({
        error: 'lab_disabled',
        hint: '网关进程里 CHANNEL_DINGTALK_SECRET（实验室 bot 默认共用它）和 CHANNEL_LAB_SECRET 都是空的。查 .env 和 docker-compose 的 gateway environment 两处',
      });
    if (!secretOk(req.headers['x-channel-secret'])) {
      await new Promise((r) => setTimeout(r, 400));
      return reply.code(401).send({ error: 'bad_secret' });
    }

    const ok = (kind: 'final' | 'ack', ding: DingMessage, runId: string | null = null) => ({
      ok: true,
      kind,
      runId,
      ding,
    });

    try {
      // 报文形状和录入 bot 完全一样（同一个流程编排平台，同样六个字段）
      const ev = normalizeDingtalk(req.body);
      if (!ev) return ok('final', md('报文形状不对（缺 message.sender），这条我没法处理。'));

      /**
       * 🔴 群自动登记 —— 落在 channel='dingtalk' 那一行，**不是** CHANNEL（dingtalk-lab）。
       * webhook 是「群」的投递口，不是某个 bot 的（两个 bot 共用完全正常，见 webhookFor）；
       * 用同一行意味着：不管哪个 bot 先在群里被 @，管理台上都只出现一行、只配一次。
       * 在这之前只有录入 bot 的入口会登记 —— **只拉了实验室 bot 的群在管理台上根本不存在**，
       * webhook 没地方填，超过同步窗的回答一律 dropped。
       */
      await sql`
        insert into channel_conversation (channel, conversation_key, title)
        values ('dingtalk', ${ev.conversationKey}, ${ev.conversationTitle})
        on conflict (channel, conversation_key) do update set title = excluded.title`;

      const text = ev.text.trim();
      if (!text)
        return ok('final', md('你只 @ 了我但没说内容 —— 我看不到群里其他消息，请把问题写在 @ 我的这一句里。', ev.sender));
      if (/^(帮助|help|用法)$/i.test(text))
        return ok(
          'final',
          md(
            '#### 我是实验室助手\n' +
              '@ 我问问题，同一个群里 ' +
              `${env.labSessionWindowMin} 分钟内算同一段对话（我记得前面聊过什么）。\n` +
              '🔴 **我不负责录入 CRM** —— 要存档的客户情报请 @ 速记机器人。',
            ev.sender,
          ),
        );
      if (rateLimited(ev.sender))
        return ok('final', md('这一小时问得有点多，歇一会儿再来（限频保护）。', ev.sender));

      // 核心抽在 runLabForEvent（D127）—— 这个旧端点保持原行为：先同步等，等不到转异步
      const out = await runLabForEvent(ev, { syncWaitMs: env.labSyncWaitMs });
      return ok(out.kind, out.ding, out.runId);
    } catch (e) {
      console.error(`  🔴 实验室 agent 处理失败：${String(e)}`);
      return ok('final', md(`⚠️ 网关这边出了点问题（${String(e).slice(0, 80)}）。`));
    }
  });
};
