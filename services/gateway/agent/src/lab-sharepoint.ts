import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { env } from './host.ts';
import { extractAttachmentText } from './attachments.ts';
import type { DocEntry } from './lab-products.ts';

/**
 * SharePoint 文档下载 —— **零 Microsoft 凭据**（T95 · D124）。
 *
 * ══ 为什么不用 Graph ═══════════════════════════════════════════
 *
 * 原 skill 包里带的是 维护者 **本人账号的委托令牌缓存 + client secret**，
 * 已授权的 scope 包括 `mail.send` / `mail.readwrite` / `files.readwrite.all` /
 * `sites.readwrite.all` —— 拿到它的人可以用他的身份收发邮件、改日历、
 * 读写他能碰到的所有文件。放上一台面向群聊的服务器，代价太大。
 *
 * 2026-08-17 实测（维护者 给的那条 `Anyone with the link` 共享链接）：
 *   · 打开共享链接 → 302 + 一个 `FedAuth` cookie（`urn:spo:tenantanon`）
 *   · 带这个 cookie 按路径直取文件 → 200 · application/pdf · 字节数与 manifest 分毫不差
 *   · **不带 cookie → 403**
 * 所以这条链接本身就是钥匙，而且它的能力**只有这一个文件夹、只读**。
 *
 * ══ 那把钥匙怎么保管 ═══════════════════════════════════════════
 *
 * `PRODUCT_DOCS_SHARE_URL` 进 `.env`，按 secret 对待：
 *   🔴 **永不进模型上下文、永不进回执、永不打进日志**（下面 catch 里连报错都截短、不带 URL）。
 * 撤销它不需要动任何凭据 —— 在 SharePoint 里删掉那条共享链接即可，
 * 这也是它比 Graph 那条路好的地方之一。
 */

type Session = { cookie: string; at: number };
let session: Session | null = null;
/** cookie 是会话级的，实测报文里的有效期约 24 小时。留足余量，12 小时换一次。 */
const SESSION_TTL_MS = 12 * 60 * 60_000;

const cookieFrom = (res: Response): string | null => {
  // Node 的 fetch 用 getSetCookie() 才拿得到多条 Set-Cookie
  const all = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  const raw = all.length ? all : [res.headers.get('set-cookie') ?? ''];
  for (const line of raw) {
    const m = /(?:^|,\s*)(FedAuth=[^;]+)/.exec(line);
    if (m) return m[1]!;
  }
  return null;
};

/**
 * 拿一个匿名会话。**不跟随跳转** —— cookie 就在第一跳的 302 上，
 * 跟随下去只会多打几次没必要的请求。
 */
const openSession = async (force = false): Promise<string> => {
  if (!force && session && Date.now() - session.at < SESSION_TTL_MS) return session.cookie;
  if (!env.productDocsShareUrl) throw new Error('没配共享链接');
  const res = await fetch(env.productDocsShareUrl, {
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  const cookie = cookieFrom(res);
  if (!cookie) {
    // 🔴 报错里绝不带 URL —— 它会流进 staging/日志/群消息
    throw new Error(`共享链接没换到会话（HTTP ${res.status}）—— 链接可能被撤销或改了共享设置`);
  }
  session = { cookie, at: Date.now() };
  return cookie;
};

/**
 * 唯一允许的 host = **共享链接自己的 host**（运维配的，不是模型给的）。
 * 以前写死成一个常量；从链接推出来是等价的闸门 —— 模型碰不到 `.env`。
 */
const host = (): string => new URL(env.productDocsShareUrl).origin;
/** 文档库在站点里的路径。有默认值，生产不用配。 */
const library = (): string => env.productDocsLibraryPath.replace(/\/+$/, '');

/**
 * 拼下载地址。**纯函数**，逐段百分号编码（路径里有空格和中文）。
 *
 * 🔴 拼好之后再验一次「还在那个库底下」——防的是路径里塞 `..` 或整段绝对 URL
 * （`resolveDoc` 那道已经挡了，这是第二道；两道都单独变异过）。
 */
export const buildDocUrl = (actualPath: string): string => {
  const clean = String(actualPath ?? '').trim().replace(/^\/+/, '');
  if (!clean || clean.includes('..')) throw new Error('非法路径');
  const enc = clean.split('/').map(encodeURIComponent).join('/');
  const base = `${host()}${library()}/`;
  const url = `${base}${enc}?download=1`;
  if (!url.startsWith(base)) throw new Error('路径越界');
  return url;
};

const cacheRel = (e: DocEntry): string =>
  join('product-docs', createHash('sha1').update(e.actual_path).digest('hex').slice(0, 16), e.name);

/**
 * 下载一份文档并抽成文字。
 *
 * · 缓存到 `<audioDir>/product-docs/<hash>/<name>` —— 同一份 datasheet 不重复下
 *   （那个库一共 2.6GB，重复下载既慢又费带宽）
 * · 解析复用既有的 officeparser worker（`extractAttachmentText`），
 *   带超时、带截断、坏文件不炸
 * · 403 只重试一次（换一个新 cookie）—— 共享链接被撤时不该无限重试
 */
export const fetchDocument = async (entry: DocEntry): Promise<string> => {
  const rel = cacheRel(entry);
  const abs = join(env.audioDir, rel);

  const cached = await stat(abs).then((s) => s.size > 0).catch(() => false);
  if (!cached) {
    const url = buildDocUrl(entry.actual_path);
    let res = await fetch(url, {
      headers: { cookie: await openSession() },
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 401 || res.status === 403) {
      res = await fetch(url, {
        headers: { cookie: await openSession(true) },
        signal: AbortSignal.timeout(60_000),
      });
    }
    if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）—— 共享链接可能已失效`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('下载到的是空文件');
    if (buf.length > env.productDocsMaxBytes)
      throw new Error(`文件 ${(buf.length / 1048576).toFixed(1)}MB，超过上限`);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf);
  }

  const r = await extractAttachmentText({
    path: rel,
    filename: entry.name,
    mime: null,
    kind: 'file',
  });
  const head = `【${entry.name}｜${entry.doctype}｜${entry.sku}${cached ? '｜缓存' : ''}】\n`;
  return head + (r.text || '（这份文档解析不出文字，可能是扫描件）');
};

export const __resetSession = (): void => {
  session = null;
};
