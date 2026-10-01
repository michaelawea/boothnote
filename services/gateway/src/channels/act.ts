/**
 * ══════════════════════════════════════════════════════════════════
 *  撤回链接（D148 · docs/dingtalk-confirm-pool.md §2）
 *
 *  钉钉来源不做确认（D143）：汇报发出 60 秒后自动写 CRM。汇报第 2 行有一条撤回链接。
 *
 *  · token 是 16 字节随机串，库里只存 sha256（`action_link`）—— **不碰 JWT**：
 *    `userFromToken` 不校验 aud（auth.ts），同一把密钥签出来的东西会被当成会话。
 *  · **GET 只出页面，只有 POST 有副作用。** 钉钉给链接生成卡片预览、杀毒软件扫链接，都是 GET。
 *  · 页面网关直出、不跑脚本：表单 POST（`enctype=text/plain`，Fastify 自带解析）。
 *    页面里出现的每一个字都转义 —— 标题来自 agent，而 agent 读的是群里任何人都能发的原话。
 *  · 能力只有一样：**撤回这一版的排队**。撤回的最坏后果是「没入库」，
 *    `@我 入库 #N` 就能恢复 —— 所以「拿到链接的人都能点」可以接受（链接证明不了身份）。
 *    补偿是群里回一行 @本人（outbound 的 notice）。
 * ══════════════════════════════════════════════════════════════════ */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { env } from '../env.ts';
import { sql } from '../db.ts';
import { AUTO_PLACEHOLDER_MS, withdrawAutoCommit } from '../confirm.ts';

const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');

/** 签一条撤回链接。返回完整 URL；没配公网地址就返回 null（不发坏链接，D67）。 */
export const issueWithdrawLink = async (
  stagingId: string,
  ownerId: string,
  queueId: string,
  expiresAt: Date,
): Promise<string | null> => {
  if (!env.captureUrl) return null;
  const token = randomBytes(16).toString('base64url');
  await sql`
    insert into action_link (token_hash, staging_id, queue_id, action, owner_id, expires_at)
    values (${hashOf(token)}, ${stagingId}, ${queueId}, 'withdraw', ${ownerId}, ${expiresAt})`;
  // Caddy 把 /api/* 剥掉前缀转给网关（Caddyfile:38）
  return `${env.captureUrl}/api/a/${token}`;
};

type LinkRow = {
  staging_id: string;
  /** 链接签发时绑的那一次排队。 */
  queue_id: string;
  /** 这一版现在的排队（没在排就是 null）。两者不等 = 链接是上一次倒计时的，作废。 */
  current_queue: string | null;
  owner_id: string;
  expires_at: Date;
  status: string;
  confirm_after: Date | null;
  withdrawn_at: Date | null;
  superseded_by: string | null;
  ref_no: string | null;
  title: string | null;
};

const lookup = async (token: string): Promise<LinkRow | null> => {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const [r] = await sql<LinkRow[]>`
    select l.staging_id, l.queue_id, s.confirm_payload->>'queueId' as current_queue,
           l.owner_id, l.expires_at, s.status, s.confirm_after, s.withdrawn_at,
           s.superseded_by, t.ref_no::text as ref_no, s.title
    from action_link l
    join staging s on s.id = l.staging_id
    left join thread t on t.id = s.thread_id
    where l.token_hash = ${hashOf(token)} and l.action = 'withdraw'`;
  return r ?? null;
};

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** 这一版现在是什么样子 —— 页面和 POST 的回答共用一份。 */
export type LinkView =
  | { kind: 'countdown'; seconds: number }
  /** 排上了、汇报还在发（两段式的第一段）。 */
  | { kind: 'sending' }
  /** 这条链接是上一次倒计时的 —— 那一次已经撤回 / 入库失败过，现在又排上的是新的一次。 */
  | { kind: 'stale' }
  | { kind: 'committing' }
  | { kind: 'committed' }
  | { kind: 'withdrawn' }
  | { kind: 'superseded' }
  | { kind: 'not_queued' }
  | { kind: 'gone' };

export const viewOf = (r: LinkRow | null, now = new Date()): LinkView => {
  if (!r) return { kind: 'gone' };
  if (r.status === 'superseded' || r.superseded_by) return { kind: 'superseded' };
  if (r.status === 'confirmed') return { kind: 'committed' };
  if (r.status === 'committing') return { kind: 'committing' };
  if (r.status === 'confirming' && r.current_queue !== r.queue_id) return { kind: 'stale' };
  if (r.status === 'confirming' && r.confirm_after && r.confirm_after > now) {
    const ms = r.confirm_after.getTime() - now.getTime();
    if (ms > AUTO_PLACEHOLDER_MS / 2) return { kind: 'sending' };
    return { kind: 'countdown', seconds: Math.max(1, Math.ceil(ms / 1000)) };
  }
  if (r.status === 'confirming') return { kind: 'committing' }; // 到点了、心跳还没认领
  if (r.withdrawn_at) return { kind: 'withdrawn' };
  return { kind: 'not_queued' };
};

const MESSAGE: Record<LinkView['kind'], (ref: string, v: LinkView) => string> = {
  countdown: (ref, v) => `#${ref} 待入库，约 ${(v as any).seconds} 秒后自动写入 CRM。`,
  sending: (ref) => `#${ref} 的汇报正在发出，倒计时还没开始。几秒后刷新这一页。`,
  stale: (ref) => `这条链接是 #${ref} 上一次倒计时的，已经作废。看群里最新那条汇报里的链接。`,
  committing: (ref) => `#${ref} 正在写入 CRM，已经来不及撤回。入库后要改：在群里 @我 #${ref} + 修改内容。`,
  committed: (ref) => `#${ref} 已入库，撤回只在入库前有效。要改：在群里 @我 #${ref} + 修改内容。`,
  withdrawn: (ref) => `#${ref} 已撤回，没有写入 CRM。要按原样入库：在群里 @我「入库 #${ref}」。`,
  superseded: (ref) => `#${ref} 这一版已经被后来的修改取代了，看群里最新那条汇报。`,
  not_queued: (ref) => `#${ref} 现在不在入库倒计时里（未入库），没有可撤回的。`,
  gone: () => '这条链接无效或已过期。',
};

const page = (title: string, body: string, form: boolean): string => `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Boothnote · ${esc(title)}</title>
<style>
:root{--bg:#fff;--fg:#111;--muted:#666;--line:#ddd;--btn:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--muted:#999;--line:#333;--btn:#f04438}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:520px;margin:0 auto;padding:32px 16px}
h1{font-size:18px;margin:0 0 12px}p{margin:0 0 16px}.muted{color:var(--muted);font-size:14px}
button{width:100%;padding:14px;border:0;border-radius:10px;background:var(--btn);color:#fff;font-size:17px;font-weight:600}
</style></head><body><main>
<h1>${esc(title)}</h1><p>${esc(body)}</p>
${form ? '<form method="post" enctype="text/plain"><button type="submit">撤回，不写入 CRM</button></form><p class="muted">撤回后：在群里 @我 #编号 + 修改内容，或 @我「入库 #编号」按原样入库。</p>' : ''}
</main></body></html>`;

const send = (reply: any, code: number, html: string) => {
  reply.code(code);
  reply.header('Content-Type', 'text/html; charset=utf-8');
  reply.header('Cache-Control', 'no-store');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Robots-Tag', 'noindex, nofollow');
  // 不跑任何脚本；只允许内联样式和提交回自己
  reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'");
  return html;
};

/** 审计：谁点的我们不知道（链接证明不了身份），但哪一版、什么结果、什么客户端要留下。 */
const audit = async (r: LinkRow, result: string, ua: string | undefined) => {
  await sql`
    insert into channel_event (channel, event_key, kind, app_user_id, raw)
    values ('dingtalk', ${`click:${r.staging_id}:${Date.now()}:${randomBytes(3).toString('hex')}`}, 'click',
            ${r.owner_id}, ${sql.json({ stagingId: r.staging_id, result, ua: String(ua ?? '').slice(0, 200) } as never)})
    on conflict (channel, event_key) do nothing`;
};

export const registerActLinks = (app: FastifyInstance) => {
  app.get('/a/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const r = await lookup(token);
    // 过没过期不影响「看」：页面只报这一版现在的样子；能不能撤由倒计时决定（POST 那边）
    const v = viewOf(r);
    const ref = r?.ref_no ?? '?';
    if (!r) return send(reply, 404, page('链接无效', MESSAGE.gone(ref, v), false));
    return send(reply, 200, page(`#${ref} ${r.title ?? ''}`.trim(), MESSAGE[v.kind](ref, v), v.kind === 'countdown'));
  });

  app.post('/a/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const r = await lookup(token);
    if (!r) return send(reply, 404, page('链接无效', MESSAGE.gone('?', { kind: 'gone' }), false));
    const ref = r.ref_no ?? '?';
    const before = viewOf(r);
    if (before.kind !== 'countdown') {
      await audit(r, `noop:${before.kind}`, req.headers['user-agent']);
      return send(reply, 409, page(`#${ref}`, MESSAGE[before.kind](ref, before), false));
    }
    const ok = await withdrawAutoCommit(r.staging_id, r.queue_id);
    await audit(r, ok ? 'withdrawn' : 'too_late', req.headers['user-agent']);
    const after = viewOf(await lookup(token));
    return send(reply, ok ? 200 : 409, page(`#${ref}`, MESSAGE[after.kind](ref, after), false));
  });
};
