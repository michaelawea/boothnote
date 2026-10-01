import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录的 .env 是唯一配置源（本地与 VPS 共用一份，只有值不同）。 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const file: Record<string, string> = {};
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m?.[1]) file[m[1]] = (m[2] ?? '').trim().replace(/^["']|["']$/g, '');
  }
} catch {
  /* 容器里靠 process.env */
}

const get = (k: string, fallback?: string): string => {
  const v = process.env[k] ?? file[k] ?? fallback;
  if (v === undefined || v === '') throw new Error(`缺少环境变量 ${k}`);
  return v;
};
const opt = (k: string, fallback = ''): string => process.env[k] ?? file[k] ?? fallback;

/**
 * ⚠️ 这些必填项用 **getter**，不是在模块加载时就求值。
 *
 * 原因：`auth.ts` 只用到 `jwtSecret`，但只要 import 链上碰到本文件，
 * 模块加载就会因为缺 `APP_DATABASE_URL` 直接抛错 —— 于是**纯逻辑的密码哈希
 * 测试也跑不起来**（CI 上没有 `.env`，实测挂在这里）。
 *
 * 改成惰性之后：**用到才校验**。而「启动就发现缺配置」这个性质靠
 * `assertEnv()` 保住 —— index.ts 起服务前显式调一次，一个不缺才继续。
 */
export const env = {
  port: Number(opt('GATEWAY_PORT', '4000')),
  get databaseUrl() {
    return get('APP_DATABASE_URL');
  },
  get jwtSecret() {
    return get('GATEWAY_JWT_SECRET');
  },
  audioDir: opt('GATEWAY_AUDIO_DIR', join(ROOT, 'data', 'audio')),

  get twentyUrl() {
    return get('SERVER_URL').replace(/\/$/, '');
  },
  get twentyKey() {
    return get('TWENTY_API_KEY');
  },

  get openaiKey() {
    return get('OPENAI_API_KEY');
  },
  openaiBaseUrl: opt('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, ''),
  // 转录与抽取分开配，将来换 provider 只动这两行（D27a③）
  transcribeModel: opt('OPENAI_TRANSCRIBE_MODEL', 'gpt-transcribe'),
  extractModel: opt('OPENAI_EXTRACT_MODEL', 'gpt-5.6-luna'),
  /**
   * 起标题用的模型（issue #15）。**默认跟抽取用同一个** ——
   * 默认值必须是这套部署里已经验证过能用的那个，编一个更便宜的型号名字
   * 等于埋一颗「上线才发现 404」的雷。
   *
   * 标题的调用频率比抽取高得多（每条录音一次，而抽取是人按了才跑），
   * 所以留一个键让它能单独指到便宜模型上 —— 改这个键要重启网关。
   */
  titleModel: opt('OPENAI_TITLE_MODEL', '') || opt('OPENAI_EXTRACT_MODEL', 'gpt-5.6-luna'),
  /**
   * 启动时用一段合成静音真发一次转写（issue #19 建议⑤ / D85）。
   *
   * 🔴 默认**开着**，因为这条链路的故障形状是「要等展会现场第一次录音才 400」，
   * 而那正是最贵的时刻。代价是每次网关启动多一次 1 秒计费的调用。
   *
   * 关掉它的唯一正当理由是 **CI**：那里的 `OPENAI_API_KEY` 是占位符，
   * 自检必然红，而一条**天天红的横幅**会把人训练成无视红色 ——
   * 这个仓库已经在冒烟那一项上吃过这个亏。
   */
  transcribeSelfTest: opt('TRANSCRIBE_SELFTEST', '1') !== '0',

  // ── agent（阶段 P）─────────────────────────────────────────────
  /** 关掉它，采集照常，只是不抽字段 —— 三段解耦的服务端一半（集成测试断言这条）。 */
  agentEnabled: opt('AGENT_ENABLED', '1') !== '0',
  /** 硬上限。超了把已经拿到的写进 staging 并标 partial，不让一条卡住整个队列。 */
  agentMaxSteps: Number(opt('AGENT_MAX_STEPS', '8')),
  /**
   * 2026-08-05 从 60s 提到 120s（T51 实测）：CI-Bus 项目类速记 5 轮就吃满 60s
   * （reasoning 模型每轮 ~12s），propose 都交上了、尾巴被切成 timeout。
   * 数据不丢（partial-first），但每条项目速记都顶着「结果可能不全」不像话。
   * 带附件的轮次 loop.ts 还会在这个基础上再加。
   */
  agentTimeoutMs: Number(opt('AGENT_TIMEOUT_MS', '180000')),
  /**
   * 录入 agent 的思考档位（D125，维护者 2026-08-17：「第一个 agent 也开成 high」）。
   *
   * 🔴 在这之前从没传过，而实测发出去的是 **`{"effort":"none"}` —— 思考整个关着**。
   * ⚠️ 开了 high 之后每一轮更慢，所以上面的 `AGENT_TIMEOUT_MS` 默认值
   * 一并从 120s 提到 180s（2026-08-05 那次「5 轮吃满 60s」的观察是**无思考**下的）。
   * 超时不丢数据（partial-first），但顶着「结果可能不全」不好看。
   */
  agentReasoning: opt('AGENT_REASONING', 'high'),
  /**
   * 🔴 D47 留给 维护者 的开关，默认关。
   * 打开之后 propose_intel_field 直接走 Metadata API 在 Company 上建列 ——
   * 代价见规划文档 D47：Twenty 删字段=删数据不可逆、字段全局可见、
   * twenty-schema.mjs 不再是唯一真相源。
   */
  agentCanCreateColumns: opt('AGENT_CAN_CREATE_COLUMNS', '0') === '1',
  /** 单个附件抽出的文本上限（字符）。约 8000 token。**只用于降级路径**（D71）。 */
  attachmentMaxChars: Number(opt('ATTACHMENT_MAX_CHARS', '32000')),
  /**
   * 附件**原生喂给模型**（input_image / input_file）的单文件字节上限（D71）。
   * 超了不是截断，是**整件降级**走本地解析 —— base64 的 PDF 没法按页截，
   * 不解析就不知道页在哪，解析了就回到老路。默认 10MB。
   * ⚠️ 改这里记得 docker-compose.yml 的 gateway.environment 同步（preflight 会对账）。
   */
  attachmentInlineMaxBytes: Number(opt('ATTACHMENT_INLINE_MAX_BYTES', String(10 * 1024 * 1024))),

  /** 确认入库的延迟提交窗口（D48）。这段时间内撤销 = Twenty 里从没写过。 */
  confirmDelayMs: Number(opt('CONFIRM_DELAY_MS', '5000')),

  /**
   * 看板链接。发给谁由**服务端**按 role 决定（§4.2 第4条：前端过滤等于没过滤）。
   *
   * 🔴 **这个值是要发到别人手机上、由浏览器去打开的 —— 它必须是公网地址。**
   *    原来的写法是 `BOARD_URL || twentyUrl`，而线上 compose 里
   *    `SERVER_URL=http://server:3000` 是**容器内网地址**：网关自己连它是对的，
   *    发给手机就是打不开，而且不报错（D67 / §2.25）。
   *    本地开发时 `SERVER_URL=http://localhost:3000` 恰好在同一台机器上 —— 又一次
   *    「默认值在本地恰好是对的」（R18）。
   *
   *    所以顺序改成：显式的 `BOARD_URL` → 由 `CRM_DOMAIN` 推 → 才轮到 `twentyUrl`，
   *    并且**最后一档会被 `assertEnv()` 拦下来**（见那里的 `server:` 检查）。
   */
  get boardUrl() {
    const explicit = opt('BOARD_URL', '');
    if (explicit) return explicit.replace(/\/$/, '');
    // CRM_DOMAIN 是 Caddy 站点块用的那个公网域名，.env 里一定有（preflight 把它列为必填）。
    //
    // 🔴 **协议写死 https://，不要去读 SITE_SCHEME。**
    //    `SITE_SCHEME` 描述的是 **Cloudflare ↔ 源站**那一段（Flexible 下是 `http://`），
    //    **不是浏览器看到的协议** —— 浏览器那一段永远是 HTTPS，这正是 Caddyfile 顶部
    //    「✅ 浏览器仍是 HTTPS，所以 isSecureContext 为 true」说的事。
    //    照 SITE_SCHEME 拼会给手机发一个 http:// 链接，白白掉一次明文跳转。
    const domain = opt('CRM_DOMAIN', '');
    if (domain) return `https://${domain}`.replace(/\/$/, '');
    return this.twentyUrl;
  },

  /** JWT 有效期。展馆里不能有任何需要联网的登录步骤 → 给足 90 天（Q25） */
  tokenDays: Number(opt('GATEWAY_TOKEN_DAYS', '90')),

  /**
   * 管理控制台的 access token。**留空 = 整个控制台 503 关闭**（不是"无需鉴权"）。
   * 通过请求头 `X-Admin-Token` 传，绝不进 URL。
   */
  adminToken: opt('ADMIN_TOKEN', ''),

  /**
   * 订单门户服务端调 `/portal/*` 时带的 `X-Portal-Secret`（D139–D142 · docs/portal-projects.md）。
   * 🔴 **留空 = 整组 `/portal/*` 503**，和 ADMIN_TOKEN 同一条安全默认（D66）——
   * 不配就不存在。只走请求头，绝不进 URL。
   * 用 getter 而不是模块加载时求值：集成测试要能在同一个进程里翻它（env.test.ts 的做法）。
   */
  get portalSecret() {
    return opt('PORTAL_SECRET', '');
  },

  // ── 钉钉渠道（T93 · docs/dingtalk-channel.md）──────────────────────
  /**
   * 钉钉流程调 `POST /channels/dingtalk/events` 时带的 `X-Channel-Secret`。
   * 🔴 **留空 = 整个渠道关闭**（503），和 ADMIN_TOKEN 同一条安全默认（D66）——
   * 不配就不存在，网关行为和没有这个功能时完全一致。展会前保持留空。
   */
  dingtalkSecret: opt('CHANNEL_DINGTALK_SECRET', ''),
  /**
   * 出站回执的兜底 webhook（自定义机器人）。每个群各自的记在
   * `channel_conversation.webhook_url`（管理台配），都没有 → 回执降级，
   * ack 里明说「结果去 PWA 看」。单群试点时配这一个就够。
   */
  dingtalkDefaultWebhook: opt('DINGTALK_DEFAULT_WEBHOOK', ''),
  /**
   * 连接平台的**流程 webhook**（`connector.dingtalk.com/webhook/flow/…`）触发用的关键词。
   *
   * 🔴 那种触发器**扫整个请求体找关键词，找不到就静默丢弃** ——
   * 而它照样回 `HTTP 200 {"data":true,"success":true}`，
   * `trigger_filter_break` 只写在钉钉自己的流程执行日志里（2026-08-17 实测，§2.52）。
   * **我们这一侧没有任何运行时信号能发现被拦了**，所以只能一次发对。
   *
   * 群自定义机器人（`oapi.dingtalk.com/robot/send`）不吃这一套，两种投递口
   * 按 URL 分（`isFlowWebhook`），不靠这个值是否为空来分。
   */
  channelFlowKeyword: opt('CHANNEL_FLOW_KEYWORD', 'agentwork'),
  /**
   * L1 完整性门卫用的模型（docs/dingtalk-channel.md §2）。默认跟抽取同一个 ——
   * 和 titleModel 同一条判据：默认值必须是这套部署里已经验证过能用的。
   * 门卫每条消息都要过，想省钱再单独指到便宜模型上。
   */
  gateModel: opt('GATE_MODEL', '') || opt('OPENAI_EXTRACT_MODEL', 'gpt-5.6-luna'),
  // ── Agent 路由器（D127 · 统一入口分流）──────────────────────────────
  /**
   * `off` = 关掉路由，统一入口的每一条都进速记 —— **就是 D127 之前的行为**，
   * 出问题时的回滚开关（不用回滚代码）。默认开：维护者 2026-08-18 要的就是它。
   */
  routerEnabled: opt('CHANNEL_ROUTER', 'on') !== 'off',
  /**
   * 路由分类用的模型。维护者 定：GPT-5.6-Luna、**不思考**（请求里不带 reasoning ——
   * D125 实测「不传 = effort:none」，这里要的就是这个，所以没有 ROUTER_REASONING 这个键）。
   */
  routerModel: opt('ROUTER_MODEL', '') || opt('OPENAI_EXTRACT_MODEL', 'gpt-5.6-luna'),
  /**
   * 分类超时。到点就按默认路由（capture）走 —— 路由器不许成为入口的单点。
   * 钉钉流程等的是整个同步响应，这里花掉的时间是从那份预算里扣的，要小气。
   */
  routerTimeoutMs: Number(opt('ROUTER_TIMEOUT_MS', '4000')),
  /**
   * 日常助手（D128 · 路由器的第三个去向，channels/chat.ts）：测试/打招呼/杂项。
   * 单次 Luna 直答，无思考无工具；超时给兜底话术，不 ack 不走 webhook。
   */
  chatModel: opt('CHAT_MODEL', '') || opt('OPENAI_EXTRACT_MODEL', 'gpt-5.6-luna'),
  chatTimeoutMs: Number(opt('CHAT_TIMEOUT_MS', '8000')),
  // ── 实验室 agent（T94 · 钉钉里的第二个 bot）───────────────────────
  /**
   * 第二个 bot 的流程调 `/channels/lab/events` 时带的头。
   *
   * 🔴 **默认和录入 bot 共用同一个 secret**（维护者 2026-08-17：「两个入口共用一个 secret 吧」）——
   * 两条流程都是他自己在同一个钉钉工作台里建的，多一个值要配、要记、要轮换，
   * 换来的隔离在这个场景里买不到什么。
   *
   * `CHANNEL_LAB_SECRET` 留成**可选覆盖**：配了就用它，将来真要把两个入口
   * 拆成两把钥匙时改一行就行，不用回来改代码。
   *
   * 两个都空 = 两个 bot 都不存在（503）。只配 LAB 那个 = 只有实验室 bot 开着。
   */
  labSecret: opt('CHANNEL_LAB_SECRET', '') || opt('CHANNEL_DINGTALK_SECRET', ''),
  /**
   * 同一个群 + 同一个人，多少分钟内沿用同一条对话（维护者 2026-08-17 定的形态）。
   * 从**最后一条消息**起算（滑动窗口）。
   */
  labSessionWindowMin: Number(opt('LAB_SESSION_WINDOW_MIN', '30')),
  /**
   * 同步等多久。等到了就一条消息答完（群里干净）；等不到就先回 ack，
   * 答案随后走群 webhook。
   * 🔴 **上限受钉钉流程 HTTP 节点的超时约束**（维护者 那份代码里是 30s），
   *    而公网还隔着 Cloudflare 的 100 秒硬超时。12 秒是留足余量的保守值。
   */
  labSyncWaitMs: Number(opt('LAB_SYNC_WAIT_MS', '12000')),
  /** 空 agent 的步数/时间上限。装了 skill 之后要够它「搜 → 找 → 读 → 答」四步。 */
  labMaxSteps: Number(opt('LAB_MAX_STEPS', '8')),
  labTimeoutMs: Number(opt('LAB_TIMEOUT_MS', '120000')),
  /**
   * 实验室 agent 的模型。留空 = 跟录入 agent 同一个（`OPENAI_EXTRACT_MODEL`）。
   * 两个 agent 分开配，是因为它们的活不一样：录入要快、要便宜、跑得频繁；
   * 实验室是人在问问题、一天几十次，值得用更强的档。
   */
  labModel: opt('LAB_MODEL', '') || opt('OPENAI_EXTRACT_MODEL', 'gpt-5.6-luna'),
  /**
   * 思考档位（`minimal` / `low` / `medium` / `high` / `xhigh` / `max`）。
   *
   * 🔴 **默认 `high`**（维护者 2026-08-17 定）。在这之前从没传过这个字段，
   * 而实测（`onPayload` 截请求体）发出去的是 **`{"effort":"none"}` —— 思考整个关着**，
   * 不是「服务端默认档」。那次编造手册阈值、搜不到就放弃，都发生在无思考状态下。
   * 值不认识就当没设（`labReasoning` 那道校验在 index.ts 的启动横幅里会说出来）。
   */
  labReasoning: opt('LAB_REASONING', 'high'),

  // ── 产品知识 skill（T95 · docs/lab-agent.md）────────────────────
  /**
   * SharePoint 产品文档库的**匿名共享链接**（`Anyone with the link`）。
   *
   * 🔴 **它就是钥匙，按 secret 对待**：进 `.env`、永不进模型上下文、永不进日志。
   * 好处是它的能力**只有那一个文件夹、只读** —— 比原 skill 包里那套委托令牌
   * （含 `mail.send` / `sites.readwrite.all`）安全一个量级，撤销也只是在
   * SharePoint 里删掉这条链接。
   *
   * 留空 = `fetch_document` **整个不注册**，agent 只能查本地资料和索引。
   */
  productDocsShareUrl: opt('PRODUCT_DOCS_SHARE_URL', ''),
  /** 文档库在站点里的路径（下载地址 = 共享链接的 host + 这一段 + 文件路径）。 */
  productDocsLibraryPath: opt(
    'PRODUCT_DOCS_LIBRARY_PATH',
    '/sites/Products/Shared%20Documents',
  ),
  /** 单份文档下载上限。3D 模型有 9MB 的，datasheet 都在 1MB 以内。 */
  productDocsMaxBytes: Number(opt('PRODUCT_DOCS_MAX_BYTES', String(25 * 1024 * 1024))),
  /**
   * EU 分销价那份参考资料的路径（服务器上的文件）。
   * 🔴 **刻意不进 git** —— FOB/DDP/MSRP 进了历史就永远在里面，
   * 而这个 skill 将来可能整个公开。不配 = agent 手上根本没有这份资料。
   */
  productPricingFile: opt('PRODUCT_PRICING_FILE', ''),
  /**
   * 限定只有哪些群能问定价（群名，逗号分隔）。
   *
   * 🔴 **留空 = 所有群都能问**（维护者 2026-08-17：「定价是都可以询问的，
   * 因为钉钉都是我们内部用的，不存在定价泄漏的问题」）。
   *
   * ⚠️ 语义是「**收窄**」不是「**授权**」—— 我第一版做成了「不配就一个群都不给」，
   * 那是我替他做的保守假设，他推翻了。留着这个开关是为了「哪天某个群里进了
   * 经销商/外部人」时改一行就能收窄，而不是回来改代码。
   */
  labPricingGroups: opt('LAB_PRICING_GROUPS', ''),

  /**
   * PWA 的公网地址，用在钉钉回执的「去确认入库」一行。
   * 和 boardUrl 同一条判据（D67）：发到别人手机上的地址必须是公网的。
   * 显式 CAPTURE_URL → 由 CAPTURE_DOMAIN 推 → 空（回执里就不放链接，不放坏链接）。
   */
  get captureUrl() {
    const explicit = opt('CAPTURE_URL', '');
    if (explicit) return explicit.replace(/\/$/, '');
    const domain = opt('CAPTURE_DOMAIN', '');
    return domain ? `https://${domain}` : '';
  },
} as const;

/**
 * 起服务之前显式校验一次 —— **必填项缺一个就别启动**。
 *
 * 这是上面改成 getter 之后必须补上的另一半：惰性读取让纯逻辑模块可测，
 * 但生产环境绝不能「跑起来了，等到半夜有人上传录音时才发现没配 OPENAI_API_KEY」。
 */
export const assertEnv = (): void => {
  const missing: string[] = [];
  for (const k of ['APP_DATABASE_URL', 'GATEWAY_JWT_SECRET', 'SERVER_URL', 'TWENTY_API_KEY', 'OPENAI_API_KEY']) {
    try {
      get(k);
    } catch {
      missing.push(k);
    }
  }
  if (missing.length) {
    console.error(`\n🔴 缺少必填环境变量，服务不启动：\n${missing.map((m) => `   · ${m}`).join('\n')}\n`);
    process.exit(1);
  }

  // ── 会被发到别人手机上的地址，不能是容器内网地址（D67）──────────────
  // ⚠️ 这里**只警告，不 exit**：看板链接是装饰，采集才是资产。
  //    为一个打不开的链接把整个网关拦在门外，那才是真事故（和 D61③ 同一条判据）。
  //    但它必须**吵**：上一次它安静地错了整整一天，直到有人点了才发现。
  try {
    const host = new URL(env.boardUrl).hostname;
    if (host === 'server' || host === 'localhost' || host === '127.0.0.1') {
      console.error(
        `\n🟠 看板链接现在是 ${env.boardUrl} —— 这是**容器内网/本机地址，别人的手机打不开**。` +
          `\n   本地开发可以忽略。线上请在 .env 里设 BOARD_URL=https://<CRM 域名>，` +
          `\n   或确认 CRM_DOMAIN 已经传进了网关容器（docker-compose.yml 的 gateway.environment）。\n`,
      );
    }
  } catch {
    console.error(`\n🟠 BOARD_URL / CRM_DOMAIN 拼出来的不是一个合法 URL，看板按钮会指向一个坏地址。\n`);
  }
};

export const ROOT_DIR = ROOT;
