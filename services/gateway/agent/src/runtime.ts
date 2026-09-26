import {
  Agent,
  JsonlSessionStorage,
  Session,
  formatSkillInvocation,
  formatSkillsForSystemPrompt,
  loadSkills,
  type AgentMessage,
  type AgentTool,
  type Skill as PiSkillFile,
  type SkillDiagnostic,
} from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import {
  createModels,
  createProvider,
  type Model,
  type MutableModels,
  type StreamFunction,
} from '@earendil-works/pi-ai';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';

import { env } from './host.ts';

/**
 * Pi 的**唯一**接触面。
 *
 * 规划文档 §2 记了一条实测风险：Pi 迭代极快（82k 星、版本号已到 0.83，
 * 而且搜到过 `pi-agent-core@0.67.4` 依赖一个没发出来的 `pi-ai@^0.67.4`、装不上
 * 的真实 issue）。对策有两条 ——
 *   ① `package.json` 锁死精确版本（不用 `^`），升级是主动动作不是副作用；
 *   ② Pi 只在这个文件里出现。要换框架，改这一个文件，九个 skill 一行不动。
 *
 * 所以这个模块**只导出我们自己的类型**：`Skill` / `RunResult`。
 * 上层（loop.ts、skills/*）看不见 `Agent`、看不见 `AgentTool`。
 */

// ── 我们自己的工具类型（不是 Pi 的）────────────────────────────────
/** 原生喂给模型的图片（D71）。data 是 base64（不带 data: 前缀）。 */
export type NativeImage = { data: string; mimeType: string };
/** 原生喂给模型的文档（D71）。走 Responses API 的 `input_file`。 */
export type NativeFile = { filename: string; mime: string; data: string };

export type SkillResult = {
  /** 回给模型看的文本。 */
  text: string;
  /** 给日志和界面看的结构化细节，模型看不到。 */
  details?: unknown;
  /**
   * 工具想让模型**直接看**的图（D71）。
   * Pi 的 ToolResultMessage 原生支持 ImageContent，Responses 绑定会把它
   * 映射成 `input_image`（openai-responses-shared.js 的 convertToolResultOutput）——
   * 条件是 model 声明了 image 输入，我们声明了。
   */
  images?: NativeImage[];
  /**
   * true = 这个工具调完就收工（D73②：ask_user 在字段已交过的前提下问出问题后，
   * 剩下的就是等人）。映射到 Pi 工具结果的 `terminate` —— 跳过后续的模型轮次。
   */
  terminate?: boolean;
};

export type Skill = {
  name: string;
  label: string;
  description: string;
  /** TypeBox schema。一份定义同时当 JSON Schema 和 TS 类型，不写两遍。 */
  parameters: any;
  execute: (params: any, signal?: AbortSignal) => Promise<SkillResult>;
};

export type TraceEntry = {
  tool: string;
  ms: number;
  ok: boolean;
  /** 出错时是错误消息，成功时是回给模型那段文本的前 200 字 */
  summary: string;
  args?: unknown;
};

/**
 * `aborted` = **人自己按了停止**（D89 · issue #22）。
 *
 * 🔴 它和 `timeout` / `error` 是三件事，不能合并：
 *   · timeout 是「它太慢」—— 值得排查、值得调上限
 *   · error   是「它坏了」  —— 要看 error 里那句话
 *   · aborted 是「人不想要了」—— **一切正常**，不该出现在故障统计里，
 *     也不该在核对卡上写「失败」。核对卡上要说的是「你叫停了，已经跑到的都在」。
 */
export type StopReason = 'done' | 'max_steps' | 'timeout' | 'error' | 'aborted';

/**
 * 进度回调。**Pi 的事件流本来就有**（`agent.subscribe`），
 * 这里只是把它翻译成人话再往上抛 —— 上层不需要认识 Pi 的事件类型。
 *
 * 为什么值得做：展会现场按下去之后转圈十几秒，人不知道它是在干活还是已经死了，
 * 而**不知道的那几秒里他会再按一次**。给出「在查客户 · 第 3 步」这一行，
 * 等待就从「盲盒」变成「看得见的进度」。
 */
export type Progress = {
  /** 人话，直接显示。 */
  stage: string;
  /** 已经走到第几步（turn），从 1 开始。 */
  steps: number;
  /** 当前在调的工具名，没有就是模型在生成。 */
  tool?: string;
  /** 已经跑完的工具，给界面打勾用。 */
  done: TraceEntry[];
};
export type OnProgress = (p: Progress) => void;

export type RunResult = {
  /** 模型最后说的那段话（不含工具调用）。 */
  text: string;
  steps: number;
  stopReason: StopReason;
  trace: TraceEntry[];
  durationMs: number;
  error?: string;
  /**
   * 这一轮结束时的完整消息史（含恢复进来的部分，D73①）。
   * 上层用 `appendThreadHistory()` 把新增部分落盘；对上层是不透明数组。
   */
  messages: unknown[];
};

/** 测试用：把模型换成 pi-ai 的 fauxProvider，不发任何网络请求。 */
export type ModelBinding = {
  model: Model<any>;
  streamFn: StreamFunction<any, any>;
};

// ── 标准 SKILL.md（D72）—— Pi 的 skill 系统经这里转出口 ─────────────
/**
 * playbook = 一本标准 SKILL.md（agentskills.io 格式，YAML frontmatter + 正文）。
 * 类型是我们自己的名字 —— 上层（skills.ts / tools/*）看不见 Pi 的 `Skill`。
 */
export type Playbook = PiSkillFile;

/** 递归扫一个目录里的全部 SKILL.md。Pi 的 loadSkills 要一个 ExecutionEnv —— 这里喂 Node 的。 */
export const loadPlaybookFiles = (
  dir: string,
): Promise<{ skills: Playbook[]; diagnostics: SkillDiagnostic[] }> =>
  loadSkills(new NodeExecutionEnv({ cwd: dir }), dir);

/** agentskills.io 风格的 <available_skills> 索引块（只列 name/description —— 渐进披露）。 */
export const formatPlaybookIndex = (playbooks: Playbook[]): string =>
  formatSkillsForSystemPrompt(playbooks);

/** 一本 playbook 的全文调用块（<skill name=...>正文</skill>）。 */
export const formatPlaybook = (p: Playbook): string => formatSkillInvocation(p);

/**
 * 思考档位。**我们自己的类型**（和 Pi 的 `ThinkingLevel` 值域一致但不 import 它）——
 * 「Pi 只在这个文件里出现」那条纪律对类型同样成立。
 *
 * Responses 绑定会把它翻成请求里的 `reasoning: { effort }`。
 *
 * 🔴 **不传不等于「用服务端默认」，实测发出去的是 `{"effort":"none"}`** ——
 * 也就是**思考整个关着**（2026-08-17 用 `onPayload` 截请求体验的）。
 * 传了 `high` 才是 `{"effort":"high","summary":"auto"}`。
 * ⚠️ 所以 2026-08-17 之前**两个 agent 都在无思考状态下跑** ——
 * 实验室 agent 那次编造手册阈值、以及搜不到就放弃，都发生在这个状态下。
 */
export type Thinking = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const THINKING: readonly Thinking[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * `.env` 里那个字符串 → 合法档位。**纯函数。**
 * 不认识的当没设（于是走 `effort:none`），并吵一句 —— 悄悄降级最糟。
 */
export const keepThinking = (v: string | null | undefined): Thinking | undefined => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return undefined;
  if ((THINKING as readonly string[]).includes(s)) return s as Thinking;
  console.warn(`  🟠 思考档位 "${v}" 不认识（${THINKING.join('/')}）—— 这一轮按「不设」跑`);
  return undefined;
};

// ── OpenAI 绑定 ────────────────────────────────────────────────────
/** 按模型 id 缓存 —— 录入 agent 和实验室 agent 可以用不同的模型。 */
const cachedByModel = new Map<string, ModelBinding>();

/**
 * 不用 pi-ai 内置的 `openaiProvider()`。
 *
 * 理由很具体：内置 provider 的模型列表是**打包时生成的静态目录**，
 * 而我们的模型名来自 `.env`（现在是 `gpt-5.6-luna`）。走内置目录的话，
 * `getModel("openai", ...)` 会返回 undefined —— 而且是在展会现场第一次
 * 抽字段的时候。这里自己建一个 provider，模型就是 `.env` 里那个字符串，
 * pi-ai 的目录跟不跟得上与我们无关。
 */
export const openaiBinding = (modelId?: string): ModelBinding => {
  const id = modelId?.trim() || env.extractModel;
  const hit = cachedByModel.get(id);
  if (hit) return hit;

  /**
   * 🔴 走 **Responses API**，不是 chat/completions。这不是偏好，是实测撞出来的：
   *
   *   400 Function tools with reasoning_effort are not supported for gpt-5.6-luna
   *       in /v1/chat/completions. To use function tools, use /v1/responses …
   *
   * 也就是说 —— **带工具 + 这个模型 + chat/completions = 必然失败**，而且失败得很安静：
   * 模型回一条空的 assistant 消息，Pi 记 stopReason=error，
   * 上层如果不看 errorMessage（我第一版就没看）就会当成「它没什么好说的」，
   * staging 一片空白，谁也不会去查。这条注释留着，免得有人把它改回 completions。
   */
  const model: Model<'openai-responses'> = {
    id,
    name: id,
    api: 'openai-responses',
    provider: `boothnote-openai-${id}`,
    baseUrl: env.openaiBaseUrl,
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };

  const models: MutableModels = createModels();
  models.setProvider(
    createProvider({
      id: `boothnote-openai-${id}`,
      name: 'OpenAI（网关持有的那把 key）',
      baseUrl: env.openaiBaseUrl,
      // key 从 env.ts 拿（它同时读 process.env 和仓库根的 .env）。
      // 不用 pi-ai 的 envApiKeyAuth —— 那个只看 process.env，容器外跑就拿不到。
      auth: {
        apiKey: {
          name: 'OpenAI API key',
          resolve: async () => ({ auth: { apiKey: env.openaiKey }, source: 'OPENAI_API_KEY' }),
        },
      },
      models: [model],
      api: openAIResponsesApi(),
    }),
  );

  const binding = { model, streamFn: models.streamSimple.bind(models) as StreamFunction<any, any> };
  cachedByModel.set(id, binding);
  return binding;
};

// ── 跑一轮 ─────────────────────────────────────────────────────────
export type RunInput = {
  systemPrompt: string;
  /** 纯文字部分。音频在到这里之前已经转好（D46b 对音频仍成立）。 */
  prompt: string;
  skills: Skill[];
  maxSteps?: number;
  timeoutMs?: number;
  /** 测试注入。省略则用 OpenAI。 */
  binding?: ModelBinding;
  /**
   * 思考档位 → 请求里的 `reasoning: { effort }`。
   * 🔴 **不传实测是 `effort:"none"`（思考关着），不是服务端默认。** 见上面 `Thinking` 那段。
   */
  reasoning?: Thinking;
  /** 每走一步回调一次，让界面上能看见它在干什么。 */
  onProgress?: OnProgress;
  /**
   * 🔴 **OpenAI 的 prompt 缓存键**（D71）。传 inboxId。
   * pi-ai 会把它写成请求里的 `prompt_cache_key`（openai-responses.js 的 buildParams）。
   * 2026-08-05 之前**从没设过** —— 一轮 8 步对话，每一步都在全价重算同一段前缀。
   * 对带附件的轮次这不是省小钱：一个 5MB PDF × 8 步 = 8 次全价输入。
   */
  sessionId?: string;
  /** 原生给模型看的图片（D71）。随首条 user 消息进 `input_image`。 */
  images?: NativeImage[];
  /** 原生给模型看的文档（D71）。经 `onPayload` 拼成 `input_file`。 */
  files?: NativeFile[];
  /**
   * 上一轮（同一条对话）的完整消息史（D73①）。灌进 initialState.messages ——
   * 模型记得自己上一轮**为什么**这么填，「把优先级改成紧急」才真的只改那一格。
   * 来自 `loadThreadHistory()`，对上层是不透明数组。
   */
  history?: unknown[];
  /**
   * 出口契约（D73③）：第一遍跑完后调一次。返回一句话 = 还欠着产出，
   * 把这句话**追问**给模型再跑一小轮（步数上限 +2）；返回 null = 收工。
   * 只追问一次 —— 追问也不交，就轮到 loop 的兜底和标黄。
   */
  exitCheck?: () => Promise<string | null> | string | null;
  /**
   * 外面递进来的「停止」信号（D89 · issue #22）。
   *
   * 🔴 **它和 `timeoutMs` 那个内部计时器走同一条路**（`agent.abort()`），
   * 区别只在 `stopReason` 记什么。合并成一个的话，「人叫停的」和「跑太久的」
   * 在 `agent_run` 里就分不开 —— 而那两件事的处置完全不同（后者要去调上限）。
   *
   * 进来时就已经 abort 的（人在排队期间点的停止）**不发任何模型请求**：
   * 直接以 `aborted` 收工，让上层照常走兜底和落库。
   */
  signal?: AbortSignal;
};

/**
 * 文件占位符（D71）。带随机 nonce —— 将来 session 恢复（D73）时，
 * 上一轮消息里的旧占位符**不能**匹配到这一轮的文件，否则旧消息会被塞进新文件。
 * 恢复逻辑用 `FILE_MARKER_RE` 把旧占位符换成一句说明。
 */
export const FILE_MARKER_RE = /⟦files:[0-9a-f-]+⟧/g;

/**
 * 把 `input_file` 项拼进 Responses 请求体（D71 的核心一步，纯函数，有测试）。
 *
 * 在**已经拼好的** OpenAI Responses 请求里找到带占位符的那条 user 消息：
 * 原地删掉占位符、把文件追加进它的 content。顺带把历史消息里残留的旧占位符
 * （session 恢复的场景）换成一句人话 —— 别让模型看见乱码。
 *
 * 原地改并返回同一个对象 —— pi-ai 的 `onPayload` 约定：返回非 undefined 就用返回值。
 */
export const spliceFilesIntoPayload = (
  payload: unknown,
  marker: string,
  files: NativeFile[],
): unknown => {
  const p = payload as { input?: Array<Record<string, any>> };
  if (!Array.isArray(p?.input)) return undefined;
  for (const item of p.input) {
    if (item?.role !== 'user' || !Array.isArray(item?.content)) continue;
    for (const c of item.content) {
      if (c?.type !== 'input_text' || typeof c.text !== 'string') continue;
      if (marker && c.text.includes(marker)) {
        c.text = c.text.split(marker).join('').trimEnd();
        item.content.push(
          ...files.map((f) => ({
            type: 'input_file',
            filename: f.filename,
            file_data: `data:${f.mime};base64,${f.data}`,
          })),
        );
      }
      c.text = c.text.replace(FILE_MARKER_RE, '（此处的附件在更早一轮已看过，内容不再重发）');
    }
  }
  return p;
};

/**
 * 硬上限存在的理由（§1.6）：展会一天几十条，一条卡住后面全在等。
 * 超了就把**已经拿到的**写进 staging 并标 partial —— 宁可少抽两个字段。
 */
export const runAgent = async (input: RunInput): Promise<RunResult> => {
  const maxSteps = input.maxSteps ?? env.agentMaxSteps;
  const timeoutMs = input.timeoutMs ?? env.agentTimeoutMs;
  const started = Date.now();
  const trace: TraceEntry[] = [];
  let stopReason: StopReason = 'done';
  let error: string | undefined;

  const binding = input.binding ?? openaiBinding();

  /**
   * ── 附件原生直通（D71）────────────────────────────────────────────
   *
   * pi-ai 的统一消息类型只有 text/image，没有「文件」。但它给了 `onPayload`：
   * 发请求前可以整体改写 provider 请求体。所以做法是 ——
   * prompt 末尾放一个带 nonce 的占位符，`onPayload` 在**已经拼好的**
   * Responses 请求里找到它，原地删掉并把 `input_file` 项追加进那条 user 消息。
   *
   * 为什么不直接改 pi-ai：锁死版本 + 「Pi 只在这个文件出现」（规划文档 §2）。
   * 为什么带 nonce：session 恢复（D73）时，上一轮消息里的旧占位符
   * 绝不能吃进这一轮的文件。
   */
  const files = input.files ?? [];
  const marker = files.length ? `⟦files:${crypto.randomUUID()}⟧` : '';
  const prompt = marker ? `${input.prompt}\n\n${marker}` : input.prompt;

  /**
   * 永远包一层 onPayload：带文件时拼 input_file；**不带文件时也要跑**占位符清理 ——
   * session 恢复（D73）的历史消息里可能残留上一轮的 `⟦files:…⟧`，
   * 不清掉模型会看见乱码。faux binding（测试）走不到 openai-responses，包了无害。
   */
  const streamFn: StreamFunction<any, any> = (model, ctx2, opts) =>
    binding.streamFn(model, ctx2, {
      ...(opts ?? {}),
      // 思考档位。给了才带这个字段 —— 不给就是服务端默认，和以前一模一样
      ...(input.reasoning ? { reasoning: input.reasoning } : {}),
      onPayload: (payload: unknown) => spliceFilesIntoPayload(payload, marker, files),
    } as never);

  const tools: AgentTool<any>[] = input.skills.map((s) => ({
    name: s.name,
    label: s.label,
    description: s.description,
    parameters: s.parameters,
    // 串行执行。九个工具里有几个会写库，并发跑起来「一条速记最多造 1 个字段」
    // 这条护栏会被两个并发调用同时绕过去。
    executionMode: 'sequential',
    execute: async (_id: string, params: any, signal?: AbortSignal) => {
      const t0 = Date.now();
      // 工具的 label 就是给人看的那句话（「查客户」「读附件」…），直接用
      input.onProgress?.({ stage: s.label, steps, tool: s.name, done: trace.slice() });
      try {
        const r = await s.execute(params, signal);
        trace.push({
          tool: s.name,
          ms: Date.now() - t0,
          ok: true,
          summary: r.text.slice(0, 200),
          args: params,
        });
        // 工具带回来的图（D71：read_attachment 把原图递给模型）跟文本一起进结果
        const content: Array<Record<string, unknown>> = [{ type: 'text', text: r.text }];
        for (const img of r.images ?? []) {
          content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
        }
        return {
          content: content as never,
          details: r.details ?? {},
          // D73②：ask_user 问出问题后收工 —— Pi 的 terminate 跳过后续模型轮次
          ...(r.terminate === true ? { terminate: true } : {}),
        };
      } catch (e) {
        const msg = (e as Error).message.slice(0, 300);
        trace.push({ tool: s.name, ms: Date.now() - t0, ok: false, summary: msg, args: params });
        // Pi 的约定是抛异常，它会捕获并以 isError 报给模型 —— 模型能自己换个问法重试
        throw e;
      }
    },
  }));

  const agent = new Agent({
    initialState: {
      systemPrompt: input.systemPrompt,
      model: binding.model,
      tools,
      /**
       * D73①：同一条对话的上一轮消息史。模型带着「上一轮为什么这么填」续跑，
       * 而不是从一份抄来的 JSON 起点重新猜。空数组 = 全新一轮。
       */
      messages: (input.history ?? []) as never,
    },
    streamFn: streamFn as never,
    toolExecution: 'sequential',
    /**
     * 🔴 prompt 缓存的钥匙（D71）。pi-ai 把它转成 `prompt_cache_key`，
     * 同一轮的 8 步对话前缀从第 2 步起走缓存价。不设 = 全价重算。
     */
    sessionId: input.sessionId,
  });

  let text = '';
  let steps = 0;
  // 步数上限是可伸的：出口契约追问那一小轮 +2（D73③）。cap 只在追问时动一次。
  let cap = maxSteps;

  agent.subscribe((event) => {
    if (event.type === 'turn_start') {
      steps++;
      if (steps > cap) {
        stopReason = 'max_steps';
        agent.abort();
      } else {
        // 每一轮开头模型都在「想下一步干什么」。这一段可能要好几秒，
        // 不报出来的话界面上就是一段没有任何解释的空白。
        input.onProgress?.({ stage: '在想', steps, done: trace.slice() });
      }
    }
    if (event.type === 'message_end' && (event as any).message?.role === 'assistant') {
      const content = (event as any).message.content;
      if (Array.isArray(content)) {
        const t = content
          .filter((c: any) => c?.type === 'text')
          .map((c: any) => c.text)
          .join('')
          .trim();
        if (t) text = t;
      }
    }
  });

  const timer = setTimeout(() => {
    stopReason = 'timeout';
    agent.abort();
  }, timeoutMs);

  /**
   * 人按的停止（D89）。和上面那个计时器同一条路，只是记的原因不同。
   * `stopReason === 'done'` 那道判断保证先到的那个说了算 ——
   * 超时和叫停在同一毫秒撞上时，不去争谁改写谁。
   */
  const onAbort = () => {
    if (stopReason === 'done') stopReason = 'aborted';
    agent.abort();
  };
  input.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    // 🔴 排队期间就被叫停的，**一次模型请求都不发**。
    //    进到这里才发现已经 abort 还照发的话，就是「点了停止还烧一次钱」。
    if (input.signal?.aborted) {
      stopReason = 'aborted';
      throw new DOMException('aborted before start', 'AbortError');
    }
    // 图片原生随首条消息进去（D71）—— Pi 的 prompt(text, images) 本来就支持
    const imgs = (input.images ?? []).map((i) => ({
      type: 'image' as const,
      data: i.data,
      mimeType: i.mimeType,
    }));
    await agent.prompt(prompt, imgs.length ? imgs : undefined);
    await agent.waitForIdle();

    /**
     * ── 出口契约（D73③）────────────────────────────────────────────
     *
     * 跑完还欠着产出（没调 propose_fields / 判成 project 没提案）时，
     * **点名追问一轮**，而不是直接伪造兜底 —— 一次追问几分钱，
     * 换的是「模型自己补交」而不是「系统替它编」。只追问一次；
     * 追问也不交，才轮到 loop.ts 的原文兜底和核对卡标黄。
     */
    if (stopReason === 'done' && !agent.state.errorMessage && input.exitCheck) {
      const nudge = await input.exitCheck();
      if (nudge) {
        cap += 2;
        trace.push({ tool: 'follow_up', ms: 0, ok: true, summary: nudge.slice(0, 200) });
        input.onProgress?.({ stage: '差一步，追问一句', steps, done: trace.slice() });
        await agent.prompt(nudge);
        await agent.waitForIdle();
      }
    }
  } catch (e) {
    if (stopReason === 'done') {
      stopReason = 'error';
      error = (e as Error).message.slice(0, 500);
    }
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
  }

  /**
   * 🔴 **无论如何都要看一眼 `errorMessage`。**
   *
   * 这一行是实测补上的。Pi 遇到 provider 报错时不抛异常 —— 它把错误记在
   * 那条 assistant 消息上（`stopReason: 'error'` + `errorMessage`），
   * 然后正常走完 `agent_end`。于是 `agent.prompt()` 顺利 resolve，
   * 我第一版只在「非正常结束」时才读 errorMessage，结果一个 400 被报成
   * `stopReason: 'done'`、`trace: []`、`text: ''` ——
   * **看起来就像模型觉得这句话没什么好抽的**，而不是像一次失败。
   * staging 一片空白，谁也不会去查。
   */
  const fromPi = agent.state.errorMessage;
  /**
   * ⚠️ **人叫停的那一轮不收 Pi 的 errorMessage**（D89）。
   * `agent.abort()` 之后 Pi 会在那条消息上留一句「aborted」之类的话 ——
   * 收下来它就会一路流进 `staging.error`，核对卡上写着一句像故障的英文，
   * 而实际上什么都没坏，是人自己按的停止。
   */
  if (fromPi && !error && stopReason !== 'aborted') {
    error = fromPi.slice(0, 500);
    if (stopReason === 'done') stopReason = 'error';
  }

  return {
    text,
    steps: Math.min(steps, cap),
    stopReason,
    trace,
    durationMs: Date.now() - started,
    error,
    // D73①：整个消息史交还给上层落盘 —— 下一轮同 thread 的续跑从这里恢复
    messages: agent.state.messages.slice(),
  };
};

// ── 同一条对话的消息史落盘 / 恢复（D73①）─────────────────────────────
/**
 * 落点：`<dir>/<threadId>.jsonl`，用的是 Pi 的 JSONL session 存储
 * （append-only、崩溃安全、带 session 树 —— 我们只用「一条直线」那部分）。
 * dir 放在 audioDir 下面：那是唯一挂了 volume 的持久化目录，备份脚本顺带（T35）。
 */
const sessionFsFor = (dir: string) => new NodeExecutionEnv({ cwd: dir });
const sessionFile = (dir: string, threadId: string) => `${dir}/${threadId}.jsonl`;

/**
 * 图片不进 JSONL：一张展台照 base64 后几 MB，每轮续跑还会原样重发。
 * 模型已经看过它；要重看走 read_attachment（原图还在 audioDir 里）。
 */
const shrinkForStorage = (m: AgentMessage): AgentMessage => {
  const msg = m as { content?: unknown };
  if (!Array.isArray(msg.content)) return m;
  return {
    ...m,
    content: msg.content.map((c: any) =>
      c?.type === 'image' ? { type: 'text', text: '【图片已看过 —— 要重看用 read_attachment】' } : c,
    ),
  } as AgentMessage;
};

/**
 * 把一条对话的消息史**归档**，让下一轮从零开始（D90 · issue #23）。
 *
 * 🔴 人改口重发时必须做这一步。不做的话，D73① 的续跑会把**已经被撤回的那句话**
 * 原样灌回模型 —— 模型看到的是「他说了 A，然后又说了 A′」，
 * 于是它按续写理解（「在 A 的基础上补充 A′」），而人的意思是「A 那句话作废，看 A′」。
 * 那正是 issue #23 开头抱怨的「唯一的补救是再说一遍」，一个字都没改善。
 *
 * **归档不是删除**：文件改名成 `<threadId>.superseded-xxxxxxxx.jsonl` 留在原地，
 * `loadThreadHistory` 只认 `<threadId>.jsonl` 所以不会再读到它。
 * 代价说清楚：这条对话**更早那几轮**的推理过程也一起退场了 ——
 * 精确截断需要把 thread_message 的序号对到 Pi 的消息序号上，而两者不是一一对应
 * （一轮里有工具调用、工具结果、追问）。宁可整条重来，也不要截错位置：
 * 截错的后果是模型带着半截上下文跑，比没有上下文更难查。
 *
 * 失败只 warn 不抛 —— 消息史是增益，改口重发本身不能因为它挂掉。
 */
export const resetThreadSession = async (dir: string, threadId: string): Promise<boolean> => {
  try {
    const fs = sessionFsFor(dir);
    const path = sessionFile(dir, threadId);
    const ex = await fs.exists(path);
    if (!ex.ok || !ex.value) return false;
    const { rename } = await import('node:fs/promises');
    await rename(path, `${dir}/${threadId}.superseded-${crypto.randomUUID().slice(0, 8)}.jsonl`);
    return true;
  } catch (e) {
    console.warn(`  🟠 归档对话消息史失败（${threadId}）：${(e as Error).message.slice(0, 200)}`);
    return false;
  }
};

/** 读回一条对话的消息史。没有 / 读不了一律空数组 —— 续跑降级成全新一轮，不炸。 */
export const loadThreadHistory = async (dir: string, threadId: string): Promise<unknown[]> => {
  try {
    const fs = sessionFsFor(dir);
    const path = sessionFile(dir, threadId);
    const ex = await fs.exists(path);
    if (!ex.ok || !ex.value) return [];
    const storage = await JsonlSessionStorage.open(fs, path);
    const ctx = await new Session(storage).buildContext();
    return ctx.messages;
  } catch (e) {
    console.warn(`  🟠 读对话消息史失败（${threadId}）：${(e as Error).message.slice(0, 200)}`);
    return [];
  }
};

/**
 * 把这一轮**新增**的消息追加进对话的 JSONL（`skip` = 恢复进来的那部分长度）。
 * 失败只 warn 不抛 —— 消息史是增益，staging 才是结论的真相源。
 */
export const appendThreadHistory = async (
  dir: string,
  threadId: string,
  skip: number,
  messages: unknown[],
): Promise<void> => {
  try {
    const fs = sessionFsFor(dir);
    await fs.createDir(dir);
    const path = sessionFile(dir, threadId);
    const ex = await fs.exists(path);
    const storage =
      ex.ok && ex.value
        ? await JsonlSessionStorage.open(fs, path)
        : await JsonlSessionStorage.create(fs, path, { cwd: dir, sessionId: threadId });
    const session = new Session(storage);
    for (const m of (messages as AgentMessage[]).slice(skip)) {
      await session.appendMessage(shrinkForStorage(m));
    }
  } catch (e) {
    console.warn(`  🟠 写对话消息史失败（${threadId}）：${(e as Error).message.slice(0, 200)}`);
  }
};
