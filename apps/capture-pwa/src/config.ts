/**
 * 前端配置的**唯一来源**。auth.ts 和 sync.ts 都从这里取，不各自读 env。
 *
 * ── 为什么本地和线上都用 `/api`（同一个相对路径）──────────────────
 *
 *   线上：Caddy 把 `capture 域名/api/*` 反代到 gateway:4000（同源，零 CORS）
 *   本地：Vite dev server 把 `/api` 代理到 http://localhost:4000（见 vite.config.ts）
 *
 * 两边路径一模一样 → **代码里没有任何 if (本地)**，也就不存在
 * 「本地好好的、上线就 404」这类问题。切换靠的是各自的代理配置，不是代码分支。
 *
 * 历史教训（2026-07-31 生产实测）：`sync.ts` 曾经用「`VITE_GATEWAY_URL` 没设 =
 * 走模拟上传」做判断，而 `auth.ts` 默认 `/api` —— 两个文件对同一件事的判断不一致，
 * 结果本地登录 404、上传却静默假装成功。**默认值必须只有一处。**
 */

/** 网关根路径。除非明确指定，本地与线上都是 `/api`。 */
export const API_BASE = (import.meta.env.VITE_GATEWAY_URL as string | undefined) || '/api';

/**
 * 模拟上传 —— **必须显式开启**（`VITE_MOCK_UPLOAD=1`）。
 * 只在「没有后端、纯调 UI」时用。绝不能靠「某个环境变量忘了设」进入这个模式：
 * 那会让上传失败看起来像成功。
 */
export const MOCK_UPLOAD = import.meta.env.VITE_MOCK_UPLOAD === '1';

export const api = (path: string) => `${API_BASE}${path}`;

/**
 * 这一份包是什么时候构建的（D83）。由 `vite.config.ts` 的 `define` 在构建时写死。
 *
 * 它**不是**「有没有新版本」的判据 —— 那件事只有 Service Worker 能回答
 * （见 `update.ts`）。这里只是给人一个能报出来的标识：
 * 「我手机上显示的是 2026-08-08 01:42Z」比「我这边好像是旧的」可查得多。
 */
declare const __BUILD_ID__: string;
export const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
