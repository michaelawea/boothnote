import { useEffect, useState } from 'react';

import { anyUploading } from './sync';

/**
 * 版本更新（D83）。**整个 App 里唯一注册 Service Worker 的地方。**
 *
 * ══ 为什么要自己写这一段 ═══════════════════════════════════════
 *
 * `vite-plugin-pwa` 默认会注入一小段 `registerSW.js`，内容只有一句：
 * 「页面 load 完注册一次 sw.js」。在浏览器标签页里这够用 —— 每次打开都是一次 load。
 *
 * 🔴 **但 iOS 把网页存到桌面之后就不是这样了**（维护者 2026-08-07 实测：
 * 「放到桌面……它就没有自动更新，一直显示的是之前的版本」）。从桌面图标进去
 * 多数时候是**恢复**那个还活着的 webview，不是重新加载：
 *   · `window.load` 不再触发 → 那一句注册代码不再运行 → 一次更新检查都不会发生
 *   · 就算某次冷启动真的查到了新版本，`skipWaiting` 让新 SW 立刻接管，
 *     **但页面里已经跑着的那份旧 JS 不会自己换掉** —— 界面还是旧的
 *
 * 所以要补的是两件事，缺一件都不行：
 *   ① **什么时候去问**：切回前台就问一次、开着的时候定时问、人能手动问
 *   ② **问到了之后怎么换**：必须重新加载页面，而重新加载**会丢掉内存里的东西**
 *
 * ══ ② 是这个文件里最要紧的约束 ═════════════════════════════════
 *
 * 展台上正在录的那 90 秒、刚打了一半的字、正在传的附件，全都只在内存里。
 * **「自动更新」绝不能把它们冲掉** —— 那比停在旧版本糟得多。
 *
 * 于是自动刷新只在**同时满足**下面几条时才做：
 *   · 这次检查是「刚打开 / 刚切回前台」触发的（那一刻人还没开始干活）
 *   · `setBusy()` 里没有任何东西（没在录音、没有草稿、AI 对话没开着）
 *   · 没有正在上传的附件（`anyUploading()`）
 *   · 距上次自动刷新超过 10 分钟（万一判断错了，也只会多刷一次，不会成环）
 * 其余情况一律**只挂一条横幅**，让人自己挑时候点。
 *
 * ⚠️ 这个文件里没有一句 `t()` —— 它对外只给状态码，话术在渲染那一层
 * （`App.tsx` / `Me.tsx`）。判据同 D80③：数据与判断存规范形式，只有显示才翻译。
 */

export type UpdateStatus =
  | 'unsupported' // 这个浏览器没有 Service Worker（多半是非 https）
  | 'idle' // 已注册，还没查过
  | 'checking'
  | 'latest' // 查过了，就是最新的
  | 'ready' // 新版本已经下载好，重新加载就换过去
  | 'offline'; // 查不了 —— 连不上，不是「已经最新」

/** 谁触发的这次检查。**只有 start / resume 允许自动刷新**（那一刻人还没开始干活）。 */
export type CheckReason = 'start' | 'resume' | 'timer' | 'manual';

/**
 * 本地开发时插件把 SW 挂在另一个地址上（`devOptions.enabled`）。
 *
 * ⚠️ **两边都是 classic worker，不要传 `type: 'module'`。**
 * `vite.config.ts` 的 `devOptions.type` 写着 `'module'`，但插件实际发出去的
 * 那份 `/dev-sw.js?dev-sw` 用的是 `importScripts`（module worker 里没有这个函数）。
 * 用 module 注册的后果不是报错，而是**悄悄多出一个永远 waiting 的 worker** ——
 * 注册选项变了浏览器就当成另一份，装好之后没人接替它，
 * 于是界面上永远挂着「有新版本」（2026-08-07 在浏览器里撞见，靠 `getRegistrations()` 才看出来）。
 */
const SW_URL = import.meta.env.DEV ? '/dev-sw.js?dev-sw' : '/sw.js';

/** 自动刷新的冷却期。防的是「刷新完又判断成有新版本」那种环。 */
const RELOAD_KEY = 'boothnote-autoreload-at';
const RELOAD_COOLDOWN_MS = 10 * 60_000;
/** 一次 start/resume 检查之后，多久之内装好的新版本仍算「那次检查的结果」。 */
const AUTO_WINDOW_MS = 30_000;
/** 开着不动时的定时检查。查到了也只挂横幅，不会打断人。 */
const TIMER_MS = 30 * 60_000;
/** 切回前台的节流 —— 来回切几下不该变成几次网络请求。 */
const RESUME_GAP_MS = 60_000;

let reg: ServiceWorkerRegistration | null = null;
let status: UpdateStatus = 'idle';
let checkedAt = 0;
/** 页面加载那一刻是谁在控制。**换人了就说明新版本已经接管，而界面还是旧的。** */
let bootController: ServiceWorker | null = null;
let autoUntil = 0;
let lastCheckAt = 0;

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

const set = (s: UpdateStatus) => {
  if (s === status) return;
  status = s;
  emit();
};

// ── 「现在不能刷新」的登记处 ──────────────────────────────────────
// 谁知道自己手上有东西丢不起，谁就来登记一下。用 key 而不是计数，
// 是因为登记方多半在 React 的 effect 里，同一个 key 重复写入必须是幂等的。
const busy = new Set<string>();

/** 登记 / 撤销「现在刷新会丢东西」。`key` 同名会覆盖，可以直接放进 effect。 */
export const setBusy = (key: string, on: boolean): void => {
  if (on) busy.add(key);
  else busy.delete(key);
};

/** 现在自动刷新安不安全。**只用于自动那条路** —— 人手动点的永远照做。 */
export const safeToReload = (): boolean => busy.size === 0 && !anyUploading();

// ── 状态读取 ────────────────────────────────────────────────────

export type UpdateState = { status: UpdateStatus; checkedAt: number };

export const updateState = (): UpdateState => ({ status, checkedAt });

export const onUpdateChange = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** 订阅版本状态。`App` 用它挂横幅，`Me` 用它显示检查结果。 */
export const useUpdate = (): UpdateState => {
  const [s, setS] = useState(updateState);
  useEffect(() => onUpdateChange(() => setS(updateState())), []);
  return s;
};

// ── 换版本 ──────────────────────────────────────────────────────

/**
 * 换到新版本 —— **就是重新加载，没有别的动作。**
 *
 * `vite.config.ts` 里显式开了 `skipWaiting + clientsClaim`：新 SW 一装好就接管，
 * 缓存里已经是新壳了。所以这里不需要跟 SW 握手（那份 `sw.js` 也确实不监听
 * `SKIP_WAITING` 消息 —— 逐字读过构建产物），重新加载就够。
 */
export const applyUpdate = (): void => {
  window.location.reload();
};

/**
 * 「能不能替他刷新」—— **三个条件缺一不可**。
 *
 * 单独拎成纯函数是为了能被测：它错一次的代价不对称 ——
 * 判宽了会吃掉现场录的东西，判严了只是让人多点一下横幅。
 * 所以三条全部是「不满足就退回横幅」，没有一条是「差不多就刷吧」。
 */
export const mayAutoApply = (o: {
  now: number;
  /** 这次 ready 还算不算「刚打开 / 刚切回前台」那次检查的结果 */
  autoUntil: number;
  /** 手上有丢不起的东西（录音 / 草稿 / 上传 / 对话开着） */
  busy: boolean;
  /** 上次自动刷新的时刻。防的是「刷完又判成有新版本」那种环 */
  lastReloadAt: number;
  cooldownMs?: number;
}): boolean => {
  if (o.now > o.autoUntil) return false;
  if (o.busy) return false;
  return o.now - o.lastReloadAt >= (o.cooldownMs ?? RELOAD_COOLDOWN_MS);
};

const autoApplyIfSafe = () => {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
  } catch {
    /* 读不到就当没刷过 —— 冷却期是安全网，不是门 */
  }
  if (!mayAutoApply({ now: Date.now(), autoUntil, busy: !safeToReload(), lastReloadAt: last })) return;
  try {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    /* 无痕模式写不进去 —— 那就退回「只挂横幅」，不要因此不刷新 */
  }
  applyUpdate();
};

const markReady = () => {
  if (status === 'ready') return;
  set('ready');
  autoApplyIfSafe();
};

/**
 * 新版本是不是已经悄悄接管了。
 *
 * 🔴 **不能只靠 `controllerchange` 事件。** iOS 上应用被挂起时 JS 整个停住，
 * 换人这件事可能发生在我们听不见的时候。所以每次检查都再比一次控制者，
 * 拿「事实」兜住「事件」—— 两条路都通向同一个 `markReady()`。
 */
const controllerSwapped = () =>
  Boolean(bootController) &&
  Boolean(navigator.serviceWorker.controller) &&
  navigator.serviceWorker.controller !== bootController;

/**
 * 新版本已经在那儿了 —— 要么已经接管，要么装好了在排队。
 *
 * 🔴 两条都要求 `bootController` 非空：**没有控制者时这一切不算「更新」**。
 * 第一次打开这个 App 的人，SW 装好接管本来就是正常流程，
 * 把它当更新会让他当场吃一次莫名其妙的刷新。
 *
 * ⚠️ `waiting` 那一支在正常情况下不会命中（顶层 `skipWaiting` 让新 SW 从不排队），
 * 留着是因为它一旦命中，说明 SW 的语义被换过了 —— 那时「有新版本」这句话仍然是对的，
 * 而**漏报比误报贵得多**：漏报就是人继续停在旧版本，也就是 D83 要修的那个病。
 */
const pendingVersion = () => controllerSwapped() || Boolean(bootController && reg?.waiting);

// ── 检查 ────────────────────────────────────────────────────────

/**
 * 问一次「有没有新版本」。
 *
 * 🔴 **判据是 Service Worker 的字节比对，不是我们自己存的版本号。**
 * 浏览器拿 `sw.js` 时绕过 HTTP 缓存，Caddy 又给它发 `no-cache`、
 * Cloudflare 那条 Cache Rule 是 Bypass（R17）—— 这条链路上没有任何一层会骗人。
 * 拿 `BUILD_ID` 去跟服务端比反而要新开一个接口、再给它配一遍不缓存，
 * 多一层就多一处会骗人的地方。
 */
export const checkForUpdate = async (reason: CheckReason = 'manual'): Promise<UpdateStatus> => {
  if (!reg) {
    set(navigator.serviceWorker ? 'idle' : 'unsupported');
    return status;
  }
  if (status === 'ready') return status; // 已经查到了，别把它盖回 latest

  lastCheckAt = Date.now();
  if (reason === 'start' || reason === 'resume') autoUntil = Date.now() + AUTO_WINDOW_MS;

  // 挂起期间换过人、或者已经装好在排队 —— 这里立刻就能看出来，一个请求都不用发
  if (pendingVersion()) {
    markReady();
    return status;
  }
  if (!navigator.onLine) {
    set('offline');
    return status;
  }

  set('checking');
  try {
    await reg.update();
  } catch {
    set('offline'); // 连不上 ≠ 已经最新。**这两个必须分开说**，否则离线时会告诉人「你是最新的」
    return status;
  }
  checkedAt = Date.now();
  // 🔴 `update()` 落地不等于新版本能用 —— 它可能还在装，也可能装失败。
  //    所以「就是最新的」这句话只在**确实什么都没在装**的时候才说，
  //    正在装的交给 `watchInstalling()`，装完了才算数、装砸了退回 latest。
  if (pendingVersion()) markReady();
  else if (reg.installing) watchInstalling(reg.installing);
  else set('latest');
  emit(); // checkedAt 变了，即使 status 没变也要让界面重画
  return status;
};

const watchInstalling = (sw: ServiceWorker | null) => {
  if (!sw) return;
  const done = () => {
    if (sw.state === 'installed' || sw.state === 'activated') markReady();
    // redundant = 这一份装砸了或被更新的一份取代。**不能停在「检查中」** ——
    // 一个永远转圈的按钮和一个骗人的结论一样糟。
    else if (sw.state === 'redundant' && status === 'checking') set('latest');
  };
  done();
  sw.addEventListener('statechange', done);
};

/**
 * 启动。**在 `main.tsx` 里调一次**，不要在组件里调 —— React 18 的
 * StrictMode 会把 effect 跑两遍，注册两次没坏处，但定时器会翻倍。
 */
export const initUpdate = (): void => {
  if (!('serviceWorker' in navigator)) {
    set('unsupported');
    return;
  }

  bootController = navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // 🔴 首次安装也会换控制者（workbox 的 `clientsClaim`）。那一次**不是更新** ——
    //    把它当更新会让每个第一次打开这个 App 的人当场吃一次莫名其妙的刷新。
    if (bootController) markReady();
  });

  void navigator.serviceWorker
    .register(SW_URL, { scope: '/', updateViaCache: 'none' })
    .then((r) => {
      reg = r;
      r.addEventListener('updatefound', () => {
        if (bootController) watchInstalling(r.installing);
      });
      /**
       * 🔴 **这一句必须在「发现已经有新版本在排队」之前跑，不能反过来。**
       *
       * 打开的那一刻恰恰是最该自动换过去的时刻 —— 人还没开始录、没打字、
       * 没有东西在传。而 `checkForUpdate('start')` 做的第一件事就是开自动窗口，
       * 之后才去看 `waiting` / 控制者换没换。
       * 先判断再开窗口的写法我写过一版，结果是**一开 App 就挂横幅、永远不自动换** ——
       * 判断先跑，那时窗口还没开，于是每次都退回「让人自己点」（2026-08-07 在浏览器里撞见）。
       */
      return checkForUpdate('start');
    })
    .catch(() => set('unsupported'));

  // ① 切回前台就问一次 —— **这一条才是 iOS 桌面图标真正缺的东西**
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastCheckAt < RESUME_GAP_MS) return;
    void checkForUpdate('resume');
  });

  // ② 一直开着不动的情况。查到了只挂横幅（reason 不是 start/resume）
  window.setInterval(() => {
    if (document.visibilityState === 'visible') void checkForUpdate('timer');
  }, TIMER_MS);
};
