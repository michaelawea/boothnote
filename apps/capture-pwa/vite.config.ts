import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/** 管理控制台的对外路径。线上由 Caddy 读同一个变量（`infra/caddy/Caddyfile`）。 */
const ADMIN_PATH = process.env.ADMIN_PATH || '/console';

/**
 * 版本号（D83）。**「我的」页上那一行显示的就是它。**
 *
 * 用构建时间而不是 git sha：镜像是在 `infra/caddy/Dockerfile` 里构建的，
 * 那一层只 COPY 了 `apps/capture-pwa/`，**容器里根本没有 .git** ——
 * 读 sha 会在唯一真正重要的那次构建里失败。
 * 时间戳一定拿得到，而人要回答的问题只有「我手上这份是不是最新的」。
 *
 * 时区写 UTC（服务器就是 UTC），不做本地化：版本号是给人对照用的标识，
 * 不是给人读的时刻 —— 两个人在两个时区看到同一个字符串才有意义。
 */
const BUILD_ID =
  process.env.BUILD_ID ||
  new Date().toISOString().replace('T', ' ').slice(0, 16) + 'Z';

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      /**
       * 🔴 **不让插件注入 `registerSW.js` —— 注册这件事只有一份实现。**
       *
       * 插件默认注入的那段是「加载完注册一次」，仅此而已。iOS 上把网页存到桌面之后
       * **它几乎不会再运行第二次**：从桌面图标进来是「恢复」不是「重新加载」，
       * `window.load` 不再触发 → 一次更新检查都不会发生 → 人永远停在旧版本
       * （维护者 2026-08-07 实测，这正是 D83 要修的）。
       *
       * 换成 `src/update.ts` 自己注册：恢复到前台时检查、定时检查、手动检查，
       * 并且**由我们决定什么时候刷新页面**（录音中 / 草稿没存完时不能刷）。
       *
       * 判据同 `deploy-server.sh`：一段承重的流程不能有两份实现，
       * 所以这里必须关掉插件那一份，而不是两个都留着。
       */
      injectRegister: false,
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Boothnote',
        short_name: 'Boothnote',
        description: '展会现场速记与 Agent 录入',
        theme_color: '#1B1B1B',
        background_color: '#FFFFFF',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        /**
         * 🔴 **这两条必须显式写出来，不能靠 `registerType` 带出来。**
         *
         * 插件只有在**它自己注入注册代码**时才会把 `autoUpdate` 翻译成
         * `skipWaiting + clientsClaim`。D83 关掉了注入（`injectRegister: false`），
         * 于是同一个 `registerType: 'autoUpdate'` 生成出来的 `sw.js` **悄悄换了语义** ——
         * 变成「装好之后一直 waiting，等页面发消息才接管」。
         * 构建产物里一个字都没提这件事，是逐字读 `dist/sw.js` 才发现的。
         *
         * 为什么要 skipWaiting 这一档而不是等页面发话：
         * **它是这套更新机制的兜底。** 新 SW 装好就接管，于是「下一次重新加载
         * 一定是新版本」这件事不依赖 `update.ts` 里的任何一行 ——
         * 万一那边有 bug、或者页面在旧代码上跑着（比如从旧版本升上来的那一次），
         * 冷启动仍然会自愈。等页面发话的那种语义则相反：**没人发话就永远卡着**，
         * 而「iOS 上那个 webview 可能永远不被关掉」正是 D83 要修的病根。
         *
         * 页面**什么时候**换过去，仍然由 `src/update.ts` 的闸门说了算 ——
         * SW 接管换的是「以后从缓存拿什么」，看得见的那一下是 `location.reload()`。
         */
        skipWaiting: true,
        clientsClaim: true,

        // 只缓存应用外壳。**不用 Background Sync** —— iOS Safari 不支持它，
        // 上传重试全部由前台的 sync.ts 负责（见 §4.5 / R10）。
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // 测试版只在首次打开时下载；现行界面的离线安装不承担这个包。
        globIgnores: ['**/AssistantThreadView-*.{js,css}'],
        runtimeCaching: [{
          urlPattern: ({ url, sameOrigin }) => sameOrigin && /^\/assets\/AssistantThreadView-[^/]+\.(js|css)$/.test(url.pathname),
          handler: 'CacheFirst',
          options: {
            cacheName: 'assistant-ui-dev',
            cacheableResponse: { statuses: [200] },
            expiration: { maxEntries: 4, maxAgeSeconds: 30 * 24 * 60 * 60 },
          },
        }],
        navigateFallback: 'index.html',
        /**
         * 🔴 **这条 denylist 不是可选项。**
         *
         * `navigateFallback` 会把作用域（`/`）下**所有**导航请求都答成 PWA 的壳。
         * 没有这份名单时，Service Worker 一装上，管理控制台就再也打不开了 ——
         * 浏览器根本不会去问服务器，SW 在网络之前就把请求截胡，直接回速记页。
         *
         * 症状极其骗人：**200、页面正常渲染、只是渲染的是另一个应用**。
         * 不报 404、不报错，清缓存之前谁也查不出来。2026-08-03 实测撞到。
         *
         * 凡是「不由这个 PWA 渲染的路径」都要列在这里。现在有三类：
         *   /console* 管理控制台（路径可由 ADMIN_PATH 改，所以用前缀匹配）
         *   /admin*   网关里控制台的真实路由（直连网关时用）
         *   /api*     网关接口（导航到接口地址的情况少，但列上不吃亏）
         */
        navigateFallbackDenylist: [/^\/console/, /^\/admin/, /^\/api/],
      },
      devOptions: { enabled: true, type: 'module' },
    }),
  ],
  server: {
    port: 5173,
    /**
     * 本地把 `/api` 代理到网关，**让本地和线上用同一个相对路径** ——
     * 线上是 Caddy 做同样的事（`capture 域名/api/*` → gateway:4000）。
     *
     * 于是前端代码里没有任何「本地 / 线上」分支，也就不会出现
     * 「本地好好的、上线就 404」。切换靠代理配置，不靠代码。
     *
     * 网关跑在别处时：`VITE_GATEWAY_ORIGIN=http://1.2.3.4:4000 npm run dev`
     */
    proxy: {
      '/api': {
        target: process.env.VITE_GATEWAY_ORIGIN ?? 'http://localhost:4000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
      /**
       * 管理控制台。**这一条是为了让本地和线上的地址长得一样。**
       *
       * 线上由 Caddy 做同样的事（`infra/caddy/Caddyfile` 里的
       * `handle {$ADMIN_PATH:/console}*` → `uri replace … /admin`）。
       * 没有这一条的话，本地访问 `/console` 会落到 SPA 的兜底路由上 ——
       * **返回 200、返回的是 index.html**，看起来像"进去了"却什么都没有。
       * 这是最容易骗人的一种失败，2026-08-03 实测踩到过。
       *
       * 路径不好猜只是降噪；**真正的门是 `ADMIN_TOKEN`，走 `X-Admin-Token` 请求头**。
       */
      [ADMIN_PATH]: {
        target: process.env.VITE_GATEWAY_ORIGIN ?? 'http://localhost:4000',
        changeOrigin: true,
        // 路径可能带 . - 之类的正则元字符（`/console-a1b2c3`），转义一下再当模式用
        rewrite: (p) => p.replace(new RegExp(`^${ADMIN_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '/admin'),
      },
    },
  },
  // 纯逻辑单元测试（不碰 DOM / 网络）。集成测试在 services/gateway 那边。
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
