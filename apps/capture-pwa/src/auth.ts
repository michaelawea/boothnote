import { useEffect, useState } from 'react';

import { API_BASE as GATEWAY } from './config';
import { t } from './i18n';

/**
 * 登录态。**token 只在这个文件里存取，页面不碰 localStorage。**
 *
 * 三条约束决定了它的形状：
 *
 * ① **展馆会断网 → 有缓存的登录态直接放行**，`/me` 在后台校验。
 *    把启动挡在一次网络请求后面 = 网一断整个采集端就废了（§00「网断了照常录」/ R10）。
 *    所以：**只有服务端明确回 401 才登出，网络错误绝不登出。**
 *
 * ② **撤权要立即生效（D35⑤）** → 那次后台 `/me` 拿到 401 必须真的踢出去。
 *    网关每次请求都查库（`is_active` + `token_version`），所以 401 是可信的信号。
 *
 * ③ **网关是唯一写入闸门（§4.2 第1条 / D35④）** → PWA 手里只有这个 90 天 JWT，
 *    永远没有 Twenty 的 API key。作用域过滤全在服务端，前端只负责显示。
 */

const KEY = 'boothnote-session';

export type Role = 'admin' | 'management' | 'staff' | 'user';

/** 与 `docs/gateway-contract.md` §2 的 `user` 对象逐字段对齐。 */
export type User = {
  userCode: string;
  displayName: string;
  role: Role;
  canSeeBoard: boolean;
  canManageUsers: boolean;
  /**
   * 界面语言（D80）。**跟账号走，不跟浏览器走** —— 换设备、换浏览器、清缓存都还在。
   * 服务端 `app_user.locale` 是真相源；它同时决定 `/enums` 给哪种标签。
   * 老版本的服务端不返回这个字段，所以 `i18n.ts` 里按 `=== 'en'` 判，缺省即中文。
   */
  locale?: 'zh' | 'en';
  /**
   * 看板链接。**服务端按 role 决定发不发** —— `user` 角色的响应里根本没有这个字段。
   * 所以「看不到看板」不是前端藏起来了，是它手上就没有地址（§4.2 第4条）。
   */
  boardUrl?: string;
};

export type Session = { token: string; user: User };

/** 服务端明确拒绝（凭据不对 / 过期 / 撤权）。区别于网络不通。 */
export class AuthError extends Error {}

const load = (): Session | null => {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return s?.token && s?.user?.userCode ? s : null;
  } catch {
    return null; // 存的东西坏了就当没登录，不要在启动路径上抛
  }
};

let session: Session | null = load();

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

export const onAuthChange = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

export const getSession = () => session;

const setSession = (s: Session | null) => {
  session = s;
  if (s) localStorage.setItem(KEY, JSON.stringify(s));
  else localStorage.removeItem(KEY);
  emit();
};

export const login = async (userCode: string, password: string): Promise<void> => {
  let res: Response;
  try {
    res = await fetch(`${GATEWAY}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userCode: userCode.trim(), password }),
    });
  } catch {
    // 网络不通 —— 说清楚是连不上，不要让人以为是密码错了
    throw new AuthError(t('连不上服务器。检查网络后重试。'));
  }
  // 用户不存在与密码错误，服务端返回的是同一个错误（不泄漏账号是否存在）
  if (res.status === 401) throw new AuthError(t('代号或密码不对'));
  if (!res.ok) throw new AuthError(t('登录失败（HTTP {a}）', { a: res.status }));

  const json = (await res.json()) as Session;
  setSession({ token: json.token, user: json.user });
};

export const logout = () => setSession(null);

/**
 * 换掉登录态里的 user 对象，token 不动。
 *
 * 唯一的调用方是「改界面语言」（D83）——服务端 `PATCH /me` 回来的那份 user
 * 是**新的真相**，不能只在本地改一个字段：`locale` 之外还挂着 role / boardUrl，
 * 手工拼一份等于给自己留一处会分叉的副本。整份换掉，和 `revalidate()` 一样。
 */
export const applyUser = (user: User): void => {
  if (!session) return;
  setSession({ token: session.token, user });
};

/**
 * 带 token 的 fetch。
 * **401 = 服务端明确拒绝 → 当场清掉登录态**（撤权立即生效）。
 * 其余错误原样返回给调用方，由它决定要不要重试。
 */
export const authFetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const s = session;
  if (!s) throw new AuthError(t('未登录'));

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${s.token}`);

  const res = await fetch(`${GATEWAY}${path}`, { ...init, headers });
  if (res.status === 401) {
    setSession(null);
    throw new AuthError(t('登录已失效，请重新登录'));
  }
  return res;
};

/**
 * 带进度的上传。**`fetch` 做不到这件事** ——
 * 它没有上传侧的进度事件（`ReadableStream` + duplex 在 Safari 上不能用），
 * 而 `XMLHttpRequest.upload.onprogress` 有，而且到处都能用。
 *
 * 为什么值得为它多写一段：传一张 8 MB 的展台照片，在展馆的 4G 上要十几秒。
 * 这十几秒里如果只有一个「待传」两个字，人不知道它是在传、卡住了、还是已经完了 ——
 * **不知道的时候他会再点一次**（2026-08-03 实测就是这么来的）。
 *
 * ⚠️ 401 的处理必须和 `authFetch` **完全一致**，所以放在同一个文件里：
 * 撤权立即生效这条性质不能有两份实现，否则迟早分叉。
 */
export type UploadResult = { status: number; ok: boolean; text: string };

export const authUpload = (
  path: string,
  body: FormData,
  opts: { onProgress?: (loaded: number, total: number) => void; timeoutMs?: number } = {},
): Promise<UploadResult> => {
  const s = session;
  if (!s) return Promise.reject(new AuthError(t('未登录')));

  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${GATEWAY}${path}`);
    xhr.setRequestHeader('Authorization', `Bearer ${s.token}`);
    // 没有超时的话，一次挂住的上传会把整个队列永远堵死
    xhr.timeout = opts.timeoutMs ?? 90_000;

    xhr.upload.onprogress = (e) => {
      // lengthComputable 为 false 时报不出百分比（极少见）——
      // 那时给 -1，界面上退化成一个转圈，而不是显示一个假的百分比
      opts.onProgress?.(e.loaded, e.lengthComputable ? e.total : -1);
    };

    xhr.onload = () => {
      if (xhr.status === 401) {
        setSession(null); // 撤权立即生效 —— 与 authFetch 同一个行为
        reject(new AuthError(t('登录已失效，请重新登录')));
        return;
      }
      resolve({ status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, text: xhr.responseText });
    };
    xhr.onerror = () => reject(new Error(t('网络错误')));
    xhr.ontimeout = () => reject(new Error(t('上传超时')));
    xhr.onabort = () => reject(new Error(t('上传被取消')));

    xhr.send(body);
  });
};

/**
 * 启动时校验一次（契约 §2 `GET /me`）—— 这是撤权生效的检查点。
 *
 * 🔴 网络异常必须**静默吞掉**：离线时保持现有登录态继续工作。
 *    这里一旦 throw 或登出，展馆断网就等于全员被踢下线。
 */
export const revalidate = async (): Promise<void> => {
  const token = session?.token;
  if (!token) return;
  try {
    const res = await authFetch('/me');
    if (!res.ok) return;
    const { user } = (await res.json()) as { user: User };
    setSession({ token, user }); // 角色被改过也跟着更新
  } catch {
    /* 网络不通 → 什么都不做，继续离线用 */
  }
};

export const useSession = (): Session | null => {
  const [s, setS] = useState(getSession());
  useEffect(() => onAuthChange(() => setS(getSession())), []);
  return s;
};
