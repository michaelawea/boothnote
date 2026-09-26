import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { env } from '../env.ts';
import { sql } from '../db.ts';
import { hashPassword } from '../auth.ts';
import { ingestNote, saveBlob } from '../ingest.ts';
import { enqueue } from '../../agent/src/index.ts';
import { normalizeDingtalk, deriveClientId, type ChannelEvent } from './payload.ts';
import { gateCheck, GATE_REJECT_TEXT } from './gate.ts';
import { decideRoute, type RouteContext } from './routing.ts';
import { classifyAgent } from './router.ts';
import { runLabForEvent } from './lab.ts';
import { runChatForEvent } from './chat.ts';
import {
  md,
  renderAck,
  renderHelp,
  renderDuplicate,
  renderConfirmHint,
  renderError,
  type DingMessage,
} from './render.ts';

export { startChannelTicker } from './outbound.ts';
export { registerLabChannel } from './lab.ts';

/** 给 `/agent/health` 和启动横幅用。两个 bot 各有各的开关。 */
export const channelStatus = () => ({
  dingtalk: env.dingtalkSecret ? 'on' : 'off',
  lab: env.labSecret ? 'on' : 'off',
  // D127：统一入口的服务端分流。off = 每条都进速记（D127 之前的行为）
  router: env.routerEnabled ? 'on' : 'off',
});

/**
 * 钉钉渠道入口（T93 · docs/dingtalk-channel.md §2–§5 · D127 起是**统一入口**）。
 *
 * 同步半边（这里）：验 secret → 自动建号 → 命令层 → **Agent 路由器（router.ts）**
 *   → 速记：L1 门卫 → 落 inbox → 回 ack「已转给速记」
 *   → 实验室：runLabForEvent（lab.ts）→ 回 ack「已转给实验室助手」
 * 异步半边：速记回执走 outbound.ts 轮询；实验室答案走 runLabForEvent 里的 webhook 投递。
 * 两条腿发回的都是**同一个群的同一条 webhook**（channel_conversation 那一行，D126）。
 *
 * 🔴 **除了鉴权失败，永远 HTTP 200** —— 流程节点对非 2xx 的分支行为不受我们控制，
 *    错误也得是一条给人看的消息（`ding`），不把话语权交给平台的报错分支。
 */

const ok = (kind: 'final' | 'ack', ding: DingMessage, noteId: string | null = null) => ({
  ok: true,
  kind,
  noteId,
  ding,
});

const secretOk = (given: unknown): boolean => {
  if (typeof given !== 'string' || !given || !env.dingtalkSecret) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(env.dingtalkSecret);
  return a.length === b.length && timingSafeEqual(a, b);
};

// ── 按人限频：垃圾 @ 不能无限烧模型（文档 §7）。内存记账，重启清零，够用。──
// D127 之后这一个入口同时服务录入和提问，额度合并成原来两个入口之和的量级。
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
 * 身份：sender → app_user。**没见过的自动建号**（维护者 2026-08-17 拍板，
 * 「创建账号只有 维护者 能做」的唯一例外 —— 群全是企业内部的，bot 进群即授权）。
 *
 * 自动建的账号：随机密码的哈希（**谁也登不进 PWA**，要用 PWA 时管理台补发）、
 * 角色 `staff`、名字先用 ID 尾段占位（管理台可改，也可整个改绑到已有账号）。
 * contributor 投影不在这里做 —— `confirm.ts` 首次入库时自己会补（那边本来就有）。
 */
const ensureChannelUser = async (
  channel: string,
  sender: string,
): Promise<{ id: string; isActive: boolean; isNew: boolean }> => {
  const [hit] = await sql<Array<{ id: string; is_active: boolean }>>`
    select u.id, u.is_active from channel_identity ci
    join app_user u on u.id = ci.app_user_id
    where ci.channel = ${channel} and ci.channel_user_id = ${sender}`;
  if (hit) return { id: hit.id, isActive: hit.is_active, isNew: false };

  const tail = sender.replace(/[^a-zA-Z0-9]/g, '').slice(-8).toLowerCase() || randomUUID().slice(0, 8);
  const pwHash = await hashPassword(randomUUID()); // 随机密码当场丢弃 —— 合法格式、不可登录
  // user_code 撞了就换随机尾巴重试一次（撞 = 同尾段的另一个 sender 先来过）
  for (const code of [`dd-${tail}`, `dd-${randomUUID().slice(0, 8)}`]) {
    try {
      const [u] = await sql<Array<{ id: string }>>`
        insert into app_user (user_code, display_name, password_hash, role)
        values (${code}, ${`钉钉·${tail}`}, ${pwHash}, 'staff')
        returning id`;
      await sql`
        insert into channel_identity (channel, channel_user_id, app_user_id)
        values (${channel}, ${sender}, ${u!.id})
        on conflict (channel, channel_user_id) do nothing`;
      // 并发时另一个请求可能先绑上了 —— 以库里的那条为准
      const [bound] = await sql<Array<{ id: string; is_active: boolean }>>`
        select u.id, u.is_active from channel_identity ci
        join app_user u on u.id = ci.app_user_id
        where ci.channel = ${channel} and ci.channel_user_id = ${sender}`;
      return { id: bound!.id, isActive: bound!.is_active, isNew: bound!.id === u!.id };
    } catch (e) {
      if (!String(e).includes('duplicate key')) throw e;
    }
  }
  throw new Error('channel user_code 两次都撞了');
};

const logEvent = async (
  kind: string,
  ev: Pick<ChannelEvent, 'conversationKey' | 'sender'> | null,
  extra: { eventKey: string; appUserId?: string | null; inboxId?: string | null; raw?: unknown },
) => {
  await sql`
    insert into channel_event (channel, event_key, kind, conversation_key, sender, app_user_id, inbox_id, raw)
    values ('dingtalk', ${extra.eventKey}, ${kind}, ${ev?.conversationKey ?? null}, ${ev?.sender ?? null},
            ${extra.appUserId ?? null}, ${extra.inboxId ?? null}, ${extra.raw ? sql.json(extra.raw as never) : null})
    on conflict (channel, event_key) do nothing`;
};

/** 路由上下文：该 (会话, 发送人) 最近一条对话 + 活动时刻 + agent 是否在等回答。 */
const routeContext = async (ev: ChannelEvent, userId: string): Promise<RouteContext> => {
  const [last] = await sql<Array<{ tid: string }>>`
    select i.thread_id as tid
    from channel_event e join inbox i on i.id = e.inbox_id
    where e.channel = 'dingtalk' and e.conversation_key = ${ev.conversationKey}
      and e.app_user_id = ${userId} and e.kind = 'message' and i.thread_id is not null
    order by e.created_at desc limit 1`;
  if (!last) return { lastThreadId: null, lastActivityAt: null, lastAskedAt: null };

  const [act] = await sql<Array<{ at: Date | null }>>`
    select max(created_at) as at from thread_message where thread_id = ${last.tid}`;
  /**
   * 「在等回答」的判据用**最近一条 agent 消息以问号收尾**当代理 ——
   * loop 在 `waiting_user` 时收尾写的正是那句追问。不依赖 agent_run 的内部列。
   */
  const [ask] = await sql<Array<{ at: Date; text: string }>>`
    select created_at as at, text from thread_message
    where thread_id = ${last.tid} and role = 'agent'
    order by created_at desc limit 1`;
  const asked = ask && /[?？]\s*$/.test(String(ask.text ?? '').trim());
  return {
    lastThreadId: last.tid,
    lastActivityAt: act?.at ?? null,
    lastAskedAt: asked ? ask!.at : null,
  };
};

/** 图片下载完**再**进 agent 队列 —— 先 enqueue 的话 agent 开跑时附件还没落库。 */
const downloadImagesThenEnqueue = async (inboxId: string, images: string[]) => {
  for (const url of images.slice(0, 5)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > env.attachmentInlineMaxBytes) continue;
      const mime = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0]!.trim();
      const ext = mime.includes('png') ? 'png' : mime.includes('gif') ? 'gif' : 'jpg';
      const rel = await saveBlob(buf, `dingtalk.${ext}`);
      await sql`
        insert into attachment (inbox_id, kind, filename, mime, bytes, path)
        values (${inboxId}, 'image', ${`dingtalk.${ext}`}, ${mime}, ${buf.length}, ${rel})`;
    } catch (e) {
      console.warn(`  ⚠️ 钉钉图片没下载成（${String(e).slice(0, 80)}）—— 这条速记照常处理`);
    }
  }
  enqueue(inboxId);
};

export const registerChannels = (app: FastifyInstance) => {
  app.post('/channels/dingtalk/events', async (req, reply) => {
    // 留空 = 渠道不存在（D66 式安全默认）。这是唯一一个非 200 的分支 —— 配置期才会撞到。
    if (!env.dingtalkSecret)
      return reply.code(503).send({
        error: 'channel_disabled',
        hint: '网关进程里 CHANNEL_DINGTALK_SECRET 是空的。查 .env 和 docker-compose 的 gateway environment 两处',
      });
    if (!secretOk(req.headers['x-channel-secret'])) {
      await new Promise((r) => setTimeout(r, 400));
      return reply.code(401).send({ error: 'bad_secret' });
    }

    try {
      const ev = normalizeDingtalk(req.body);
      if (!ev) return ok('final', renderError('报文形状不对，缺 message.sender'));

      // 会话自动登记（bot 进群 = 维护者 授权的，不做白名单工程）
      await sql`
        insert into channel_conversation (channel, conversation_key, title)
        values ('dingtalk', ${ev.conversationKey}, ${ev.conversationTitle})
        on conflict (channel, conversation_key) do update set title = excluded.title`;

      const user = await ensureChannelUser('dingtalk', ev.sender);
      if (!user.isActive) return ok('final', md('这个账号已被停用，找 维护者。', ev.sender));

      // ── 命令层（§4 ⓪）：命令是「按按钮」，不落 inbox ──────────────────
      const t = ev.text.trim();
      if (/^(帮助|help|用法)$/i.test(t)) return ok('final', renderHelp(ev.sender));
      if (/^(确认|撤销)([\s。！!]|$)/.test(t)) return ok('final', renderConfirmHint(ev.sender));

      if (rateLimited(ev.sender))
        return ok('final', md('这一小时内记得有点多，歇一会儿再 @ 我（限频保护）。', ev.sender));

      const ctx = await routeContext(ev, user.id);
      const clientId = deriveClientId(ev);

      /**
       * ── Agent 路由器（D127）：这一句是「要记录」还是「要答案」────────────
       * 在这之前分流靠钉钉流程里的关键词分支；现在一个入口，服务端定。
       * 规则（前缀「问：/记：」· 附件 · 更正 · 待回答的追问）先判，剩下交
       * Luna 无思考分类；**判不动一律进速记**（情报丢了不可再生，问题可以再问）。
       */
      // 🔴 同一条报文重放（流程重试）必须走同一条路 —— 模型是会改主意的，
      //    改了主意就是一条消息两边各答一次。第一次的决定记在账上，重放直接复用。
      const [prevRoute] = await sql<Array<{ raw: { route: 'capture' | 'lab'; via: string; reason: string } | null }>>`
        select raw from channel_event
        where channel = 'dingtalk' and event_key = ${`route:${clientId}`}`;
      const verdict =
        prevRoute?.raw?.route != null
          ? prevRoute.raw
          : await classifyAgent({
              text: ev.text,
              hasAttachments: ev.images.length > 0,
              captureAskedAt: ctx.lastAskedAt,
            });
      await logEvent('route', ev, {
        eventKey: `route:${clientId}`,
        appUserId: user.id,
        raw: { route: verdict.route, via: verdict.via, reason: verdict.reason },
      });

      if (verdict.route === 'lab') {
        // 提问 → 实验室助手。ack 立即说清转给了谁，答案一律走群 webhook（维护者 定的流程）
        const out = await runLabForEvent(ev, { syncWaitMs: 0, routed: true });
        return ok(out.kind, out.ding, null);
      }

      if (verdict.route === 'chat') {
        // 其他杂项 → 日常助手（D128）。单次直答（final），不进任何管道、不依赖 webhook
        const out = await runChatForEvent(ev);
        return ok('final', out.ding, null);
      }

      // ── 以下是速记管道（capture）────────────────────────────────────
      // L1 完整性门卫：拒掉的不进 inbox，只留日志
      const gate = await gateCheck(ev.text, ev.images.length > 0);
      if (!gate.pass) {
        await logEvent('reject', ev, {
          eventKey: `reject:${clientId}`,
          appUserId: user.id,
          raw: ev.raw,
        });
        return ok('final', md(GATE_REJECT_TEXT, ev.sender));
      }

      // 会话路由（§4）：默认新开，续写只认明确信号
      const route = decideRoute(ev.text, ctx, new Date());
      const r = await ingestNote({
        userId: user.id,
        clientId,
        text: ev.text || (ev.images.length ? '（图片）' : ''),
        companyCode: null,
        visitLabel: null,
        deviceCreatedAt: ev.sentAt,
        threadId: route.threadId,
        toAgent: true, // 钉钉渠道的每一条都是「说给 AI 听」的 —— 采集即抽取
        source: 'dingtalk',
        files: [],
      });
      if (r.duplicate) {
        const [s] = await sql<Array<{ status: string }>>`
          select status from staging where id = ${r.stagingId}`;
        return ok('final', renderDuplicate(ev.sender, s?.status ?? 'pending'), r.inboxId);
      }

      await logEvent('message', ev, {
        eventKey: `msg:${clientId}`,
        appUserId: user.id,
        inboxId: r.inboxId,
        raw: ev.raw,
      });

      // 图片在后台下载，下载完才进队列；没图直接进
      if (ev.images.length) void downloadImagesThenEnqueue(r.inboxId, ev.images);
      else enqueue(r.inboxId);

      // ack 要诚实：这个群没配出站 webhook 时，不许假装稍后有回执
      const [convo] = await sql<Array<{ webhook_url: string | null }>>`
        select webhook_url from channel_conversation
        where channel = 'dingtalk' and conversation_key = ${ev.conversationKey}`;
      const degraded = !(convo?.webhook_url || env.dingtalkDefaultWebhook);
      return ok('ack', renderAck(ev.sender, degraded), r.inboxId);
    } catch (e) {
      console.error(`  🔴 钉钉渠道处理失败：${String(e)}`);
      return ok('final', renderError(String(e)));
    }
  });
};
