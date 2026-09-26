import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { env } from './env.ts';
import { sql, type Role } from './db.ts';
import { hashPassword } from './auth.ts';
import { upsertContributor } from './twenty.ts';
import { ADMIN_HTML } from './admin-page.ts';
import { md, outboundBody, isFlowWebhook } from './channels/render.ts';

/**
 * 管理控制台。**与 PWA 完全分开** —— 不进 PWA 的包，销售的手机上永远没有这段代码。
 *
 * 鉴权：`.env` 里的 `ADMIN_TOKEN`，走请求头 `X-Admin-Token`。
 *
 * 🔴 **token 绝不进 URL。** URL 会落进 Caddy 访问日志、Cloudflare 日志、浏览器历史、
 *    以及任何一次截图。路径可以不好猜（`ADMIN_PATH`），但那是降噪，不是安全。
 *
 * ⚠️ 现在是 Cloudflare Flexible（R16）：Cloudflare 到源站那一段是明文，
 *    **这个 token 和新建的密码都会在那一段裸奔**。发正式账号之前必须切 Full (strict)。
 */

const ROLES: Role[] = ['admin', 'management', 'staff', 'user'];

/** 恒定时间比较，避免按字符逐位试探。 */
const tokenOk = (given: string | undefined): boolean => {
  if (!given || !env.adminToken) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(env.adminToken);
  return a.length === b.length && timingSafeEqual(a, b);
};

// 极简暴力破解防护：同一 IP 连续失败 8 次锁 15 分钟。
// 量级是一个人偶尔用一次，不需要更复杂的东西。
const fails = new Map<string, { n: number; until: number }>();
const LOCK_MS = 15 * 60_000;
const MAX_FAILS = 8;

export const registerAdmin = (app: FastifyInstance) => {
  const guard = async (req: any, reply: any) => {
    if (!env.adminToken) {
      // ⚠️ 别把这条读成「.env 里没写」。2026-08-04 实测：.env 里写得好好的，
      //    但 docker-compose 的 gateway 段根本没把它传进容器（D66）。
      //    所以提示必须同时指到两处，否则人会盯着一个正确的 .env 反复怀疑自己。
      return reply.code(503).send({
        error: 'admin_disabled',
        hint: '网关进程里 ADMIN_TOKEN 是空的。查两处：.env 有没有这一行；docker-compose.yml 的 gateway environment 有没有把它传进来',
      });
    }
    const ip = req.ip ?? 'unknown';
    const rec = fails.get(ip);
    if (rec && rec.until > Date.now()) {
      return reply.code(429).send({ error: 'locked', retryAfterSec: Math.ceil((rec.until - Date.now()) / 1000) });
    }
    if (!tokenOk(req.headers['x-admin-token'] as string | undefined)) {
      const n = (rec?.n ?? 0) + 1;
      fails.set(ip, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
      // 故意慢一点，让暴力破解不划算
      await new Promise((r) => setTimeout(r, 400));
      return reply.code(401).send({ error: 'bad_token' });
    }
    fails.delete(ip);
  };

  // ── 页面本身。不带 token 也能拿到 HTML（它只是个壳），数据全靠下面的接口。──
  app.get('/admin', async (_req, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8');
    // 管理台永远不该被缓存 —— 边缘缓存一个后台页面是没必要的暴露面
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    return ADMIN_HTML;
  });

  // ── 列表 ────────────────────────────────────────────────────────
  app.get('/admin/users', { preHandler: guard }, async () => {
    const rows = await sql`
      select u.user_code, u.display_name, u.role, u.is_active, u.created_at,
             (select count(*)::int from inbox i where i.user_id = u.id) as note_count
      from app_user u order by u.created_at`;
    return { items: rows };
  });

  // ── 新建 ────────────────────────────────────────────────────────
  app.post('/admin/users', { preHandler: guard }, async (req, reply) => {
    const { userCode, displayName, role, password } = (req.body ?? {}) as {
      userCode?: string; displayName?: string; role?: Role; password?: string;
    };

    const code = (userCode ?? '').trim().toLowerCase();
    const name = (displayName ?? '').trim();
    if (!/^[a-z0-9][a-z0-9._-]{1,30}$/.test(code))
      return reply.code(400).send({ error: 'bad_user_code', hint: '只能用小写字母、数字、. _ -，2–31 位' });
    if (!name) return reply.code(400).send({ error: 'missing_display_name' });
    if (role && !ROLES.includes(role)) return reply.code(400).send({ error: 'bad_role' });
    if (password && password.length < 8)
      return reply.code(400).send({ error: 'weak_password', hint: '至少 8 位' });

    // 留空就服务端生成。无论哪种，**只在这次响应里出现一次**，之后既看不了也改不了。
    const pw = password || randomBytes(9).toString('base64url');

    const [row] = await sql<Array<{ user_code: string }>>`
      insert into app_user (user_code, display_name, password_hash, role)
      values (${code}, ${name}, ${await hashPassword(pw)}, ${role ?? 'user'})
      on conflict (user_code) do nothing
      returning user_code`;
    if (!row) return reply.code(409).send({ error: 'exists' });

    // 同步一份投影到 Twenty，让 recordedBy 指得过去（D34 / D35④：只有代号和名字）
    let contributor: string | null = null;
    try {
      contributor = await upsertContributor(code, name);
    } catch {
      /* Twenty 不可达不该挡住建账号 —— 下次有人确认入库时会补建 */
    }
    return reply.code(201).send({ userCode: code, password: pw, contributorSynced: Boolean(contributor) });
  });

  // ── 停用 / 启用 ─────────────────────────────────────────────────
  // 「删除」在这个系统里就是停用：`inbox.user_id` 有外键，而原文只增不改（§4.2 第2条），
  // 真删会连着删掉他录过的所有速记。停用 + token_version+1 让他**当场下线**（D35⑤）。
  app.post('/admin/users/:code/deactivate', { preHandler: guard }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const [row] = await sql`
      update app_user set is_active = false, token_version = token_version + 1
      where user_code = ${code} returning user_code`;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { ok: true, note: '已停用，其已签发的 token 立即失效；速记全部保留' };
  });

  app.post('/admin/users/:code/activate', { preHandler: guard }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const [row] = await sql`
      update app_user set is_active = true where user_code = ${code} returning user_code`;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { ok: true, note: '已启用。密码没变 —— 忘了只能停用后重建。' };
  });

  // ── 真删：只在这个账号一条速记都没有时允许 ────────────────────────
  app.delete('/admin/users/:code', { preHandler: guard }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const [u] = await sql<Array<{ id: string; n: number }>>`
      select u.id, (select count(*)::int from inbox i where i.user_id = u.id) as n
      from app_user u where u.user_code = ${code}`;
    if (!u) return reply.code(404).send({ error: 'not_found' });
    if (u.n > 0)
      return reply.code(409).send({
        error: 'has_notes',
        noteCount: u.n,
        hint: '这个账号名下有速记，删了会一起没。请改用「停用」——原文只增不改（§4.2 第2条）。',
      });
    await sql`delete from app_user where id = ${u.id}`;
    return { ok: true };
  });

  // ── 补发密码：钉钉自动建的号（T93）要用 PWA 时走这里 ────────────────
  // 服务端生成、**只在这次响应里出现一次**；token_version+1 把可能在别处登着的会话踢下线。
  app.post('/admin/users/:code/password', { preHandler: guard }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const pw = randomBytes(9).toString('base64url');
    const [row] = await sql`
      update app_user set password_hash = ${await hashPassword(pw)}, token_version = token_version + 1
      where user_code = ${code} returning user_code`;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { ok: true, password: pw, note: '只显示这一次' };
  });

  // ── 钉钉渠道（T93 · docs/dingtalk-channel.md §5）────────────────────
  app.get('/admin/channels', { preHandler: guard }, async () => {
    const rows = await sql<
      Array<{ webhook_url: string | null } & Record<string, unknown>>
    >`
      select c.id, c.channel, c.conversation_key, c.title, c.webhook_url, c.is_active, c.created_at,
             (select count(*)::int from channel_event e
               where e.channel = c.channel and e.conversation_key = c.conversation_key
                 and e.kind = 'message') as message_count,
             (select count(*)::int from channel_event e
               where e.channel = 'dingtalk-lab' and e.conversation_key = c.conversation_key
                 and e.kind = 'message') as lab_count
      from channel_conversation c order by c.created_at`;
    // 投递口类型在服务端判（isFlowWebhook 是唯一真相源）—— 页面不再自己认 URL
    const conversations = rows.map((c) => ({
      ...c,
      webhook_kind: c.webhook_url ? (isFlowWebhook(c.webhook_url) ? 'flow' : 'robot') : null,
    }));
    const identities = await sql`
      select ci.id, ci.channel, ci.channel_user_id, ci.created_at,
             u.user_code, u.display_name, u.role, u.is_active,
             (select count(*)::int from inbox i where i.user_id = u.id) as note_count
      from channel_identity ci join app_user u on u.id = ci.app_user_id
      order by ci.created_at`;
    return { conversations, identities };
  });

  // 群的出站 webhook（自定义机器人）。传空串 = 清掉（回执降级，ack 会说「去 PWA 看」）。
  app.post('/admin/channels/conversations/:id', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { webhookUrl } = (req.body ?? {}) as { webhookUrl?: string };
    const url = String(webhookUrl ?? '').trim();
    if (url && !/^https:\/\//.test(url))
      return reply.code(400).send({ error: 'bad_webhook', hint: '要 https:// 开头（钉钉自定义机器人的 webhook）' });
    const [row] = await sql`
      update channel_conversation set webhook_url = ${url || null}
      where id = ${id} returning id`;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  /**
   * 一键自测这个群的投递口 —— `scripts/probe-flow-webhook.mjs` 的管理台版（D122）。
   * 用**真实代码**（`md()` + `outboundBody()`）拼报文原样打过去，手编报文验不了
   * 要验的东西：恰恰是这两个函数拼出来的字节和钉钉那边对不对得上。
   *
   * 🔴 回包对「送达」和「被静默丢弃」说的是同一句话（§2.52 —— 流程 webhook 被关键词
   *    拦掉时照回 200 `{"success":true}`），所以这里的 `ok:true` 只代表「发出去了」，
   *    响应里必须把「去群里用眼睛看」原样带给点按钮的人。
   *
   * body 可带 `sender`（钉钉 userid）：带上就顺便测 @ —— 那个洞（markdown 光有
   * atUserIds 不真 @）只在补发那条腿上承重，配置时不测就没人会测。
   */
  app.post('/admin/channels/conversations/:id/probe', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { sender } = (req.body ?? {}) as { sender?: string };
    const [c] = await sql<Array<{ webhook_url: string | null; title: string | null }>>`
      select webhook_url, title from channel_conversation where id = ${id}`;
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (!c.webhook_url)
      return reply.code(409).send({ error: 'no_webhook', hint: '先填上 webhook 保存，再点测试' });

    const who = String(sender ?? '').trim() || undefined;
    const ding = md(
      `#### 投递口测试\n看到这条说明「${c.title ?? '这个群'}」的回执 webhook 通了。` +
        (who ? '\n上面 @ 到人了的话，@ 也没问题。' : ''),
      who,
    );

    let httpStatus = 0;
    let respText = '';
    let sent = false;
    try {
      const res = await fetch(c.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(outboundBody(ding, c.webhook_url)),
        signal: AbortSignal.timeout(8000),
      });
      httpStatus = res.status;
      respText = (await res.text().catch(() => '')).slice(0, 200);
      let errcode: number | undefined;
      try {
        errcode = (JSON.parse(respText) as { errcode?: number }).errcode;
      } catch {
        /* 流程 webhook 的回包没有 errcode */
      }
      sent = res.ok && (errcode === undefined || errcode === 0);
    } catch (e) {
      respText = String(e).slice(0, 200);
    }

    return {
      ok: sent,
      kind: isFlowWebhook(c.webhook_url) ? 'flow' : 'robot',
      httpStatus,
      response: respText,
      note: '回包 200 ≠ 送达 —— 唯一算数的验证是去群里用眼睛看这条消息在不在。',
    };
  });

  /**
   * 改绑：把一个钉钉身份指到**已有账号**上（老用户预绑，免得自动建号给他分裂出第二个号）。
   * ⚠️ 只影响**之后**的记录 —— 已经录在自动号名下的不搬（recordedBy 是历史事实）。
   */
  app.post('/admin/channels/identities/:id/rebind', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { userCode } = (req.body ?? {}) as { userCode?: string };
    const code = String(userCode ?? '').trim().toLowerCase();
    if (!code) return reply.code(400).send({ error: 'missing_user_code' });
    const [u] = await sql<Array<{ id: string }>>`
      select id from app_user where user_code = ${code}`;
    if (!u) return reply.code(404).send({ error: 'user_not_found' });
    const [row] = await sql`
      update channel_identity set app_user_id = ${u.id} where id = ${id} returning id`;
    if (!row) return reply.code(404).send({ error: 'identity_not_found' });
    return { ok: true, note: '只影响之后的记录；已录的留在原账号名下' };
  });
};
