import { join } from 'node:path';

import { Type } from '@earendil-works/pi-ai';

import { env } from './host.ts';
import { labPlaybooks } from './skills.ts';
import { productTools, groundingWarning, type ProductContext } from './lab-products.ts';
import {
  appendThreadHistory,
  loadThreadHistory,
  keepThinking,
  openaiBinding,
  runAgent,
  type ModelBinding,
  type RunResult,
  type Skill,
} from './runtime.ts';

export { keepThinking };

/**
 * 实验室 agent —— **同一个 runtime，空工具表，自己的一份 playbook**（T94 · D121）。
 *
 * 它存在的理由只有一个：维护者 之后要往里面装 Skill。所以这里**刻意什么都不做** ——
 * 装配好机器（工具循环 · 渐进披露 · 多轮消息史 · 轨迹 · 超时/叫停 · 记账），
 * 然后把功能那一格留空。往 `agent/skills-lab/` 丢一本 SKILL.md、重启网关，它就有了。
 *
 * ══ 和录入 agent 的关系：**零共用状态** ═══════════════════════════
 *
 *   · 工具：录入 agent 有 15 个；这里**只有 1 个**（`read_skill`）。
 *     🔴 边界靠「没注册」，不靠 prompt 里写「请不要」（Ring 3 那条纪律原样成立）。
 *     这个文件**不 import `tools/`**，所以它连一条能写 CRM 的路径都够不着 ——
 *     `__tests__/lab.test.ts` 逐字对账工具清单，谁手滑加一个就红。
 *   · playbook：`agent/skills-lab/`，和录入那份互不可见（`skills.ts` 的两个库实例）。
 *   · 消息史：`<audioDir>/agent-lab-sessions/`，和录入那份分开 ——
 *     两边同一个 threadId 撞在一起，模型会读到完全不相干的上一轮。
 *
 * ══ 为什么 `read_skill` 必须有 ═══════════════════════════════════
 *
 * 渐进披露（D72）是「索引进 prompt，全文按需拉」。**没有这个工具，
 * 索引就是一张点不开的目录** —— 模型看得见有哪本手册，却永远读不到内容。
 * 所以「空白」的下限是 1 个工具，不是 0 个。
 */

const SESSION_DIR = () => join(env.audioDir, 'agent-lab-sessions');

/** 唯一的工具。和录入那边的同名工具是**两份绑定**：这份只看 lab 的库。 */
const readSkillTool = (): Skill => ({
  name: 'read_skill',
  label: '翻手册',
  description:
    '读一本 skill 的全文。系统提示词的 <available_skills> 列了有哪些 —— ' +
    '判断出哪一本相关之后，**先读它再动手**。参数是手册名，不是文件路径。',
  parameters: Type.Object({
    name: Type.String({ description: '手册名，来自 <available_skills> 的 <name>' }),
  }),
  execute: async ({ name }: { name: string }) => {
    if (!labPlaybooks.get(name)) {
      const have = labPlaybooks.names();
      return {
        text: have.length
          ? `没有叫「${name}」的手册。现有：${have.join(' / ')}。`
          : '手册库是空的 —— 这个 agent 还没装任何 skill，按常识直接回答就行。',
      };
    }
    return { text: labPlaybooks.block(name) };
  },
});

/**
 * 工具清单的唯一真相源（测试逐字对账，同 `tools/index.ts` 的 TOOL_NAMES）。
 *
 * `fetch_document` 只在配了共享链接时才在场 —— **能力靠「注册没注册」，
 * 不靠运行时 if**（T95）。所以这里列的是「全都配齐时的完整清单」。
 */
export const LAB_TOOL_NAMES = ['read_skill', 'search_specs', 'find_document', 'fetch_document'] as const;

export const labTools = (ctx: LabContext = {}): Skill[] => [readSkillTool(), ...productTools(ctx)];

/**
 * 系统提示词。**刻意极短** —— 它是底座，不是人格。
 * 具体怎么干活的说明，将来由 `agent/skills-lab/` 里的 SKILL.md 提供（改了不发版）。
 *
 * 🔴 唯一一条业务性的话是「我不负责录入」：群里有**两个 bot**，
 * 而人把要存档的客户情报说给这一个的话，那句话就只是聊天记录 ——
 * 它不会进 inbox、不会进 CRM，**而且没有任何东西会告诉他**。
 * 归属说错的代价这个项目付过（§4.2 第 3 条），所以这句话进底座 prompt，不进 skill。
 */
export const labSystemPrompt = (): string => {
  const index = labPlaybooks.index();
  return [
    '你是 Voltline 欧洲 B2B 团队钉钉群里的助手。用中文回答，简短、直接、不寒暄。',
    '',
    '你**不负责录入 CRM**：群里另有一个「速记」机器人管客户情报的记录与入库。',
    '有人把要存档的客户信息说给你时，回一句「这条要存进 CRM 的话，请 @ 速记机器人」，',
    '**不要假装已经记下了** —— 你没有任何写数据库的能力。',
    '',
    '不知道就说不知道。不编造客户、产品、日期或数字。',
    index ? `\n${index}` : '',
  ]
    .filter((s) => s !== null)
    .join('\n')
    .trim();
};

/**
 * 这一轮是谁、在哪个群问的。**工具要靠它做逐群授权**（定价那份，T95）——
 * 授权判断放在工具里，不放在 prompt 里。
 */
export type LabContext = ProductContext;

export type LabRunInput = {
  prompt: string;
  /** 同一个 session 会带上之前几轮的消息史（D73①）。 */
  sessionId: string;
  ctx?: LabContext;
  signal?: AbortSignal;
  /** 测试注入 faux provider。 */
  binding?: ModelBinding;
  maxSteps?: number;
  timeoutMs?: number;
};

/**
 * 跑一轮。**不落任何业务库** —— 调用方（`src/channels/lab.ts`）负责记账与投递。
 *
 * 消息史：跑之前读、跑完追加。读失败一律当空数组（降级成全新一轮，不炸）——
 * 和录入那边同一条判据：消息史是增益，不是结论的真相源。
 */
export const runLabAgent = async (input: LabRunInput): Promise<RunResult> => {
  await labPlaybooks.load();
  const dir = SESSION_DIR();
  const history = await loadThreadHistory(dir, input.sessionId);

  /**
   * 这一轮工具交出去的原文。跑完拿它做**出处核对** —— 实测它会把记忆里的
   * 阈值写成「手册列出的」，而那本手册里一个数都没有（`lab-products.ts` 那段注释）。
   */
  const evidence: string[] = [];
  const ctx = { ...(input.ctx ?? {}), evidence };

  const result = await runAgent({
    systemPrompt: labSystemPrompt(),
    prompt: input.prompt,
    skills: labTools(ctx),
    maxSteps: input.maxSteps ?? env.labMaxSteps,
    timeoutMs: input.timeoutMs ?? env.labTimeoutMs,
    // 实验室 agent 有自己的模型和思考档位（和录入 agent 分开，D125）
    binding: input.binding ?? openaiBinding(env.labModel),
    reasoning: keepThinking(env.labReasoning),
    signal: input.signal,
    history,
    // prompt 缓存的钥匙（D71）——同一条对话续跑时前缀走缓存价
    sessionId: input.sessionId,
  });

  await appendThreadHistory(dir, input.sessionId, history.length, result.messages);

  /**
   * 🔴 自称有文档出处、却对不上原文的数字，如实补一句 —— 不改答案，只把不确定说出来。
   *
   * ⚠️ **人自己在问题里给的数字也算「有据」**（问「24V 600Ah 怎么配」时那两个数）——
   * 不把 prompt 算进证据池的话，第一句就会被自己的警告点名。
   */
  const warn = groundingWarning(result.text, [input.prompt, ...evidence].join('\n'));
  return warn ? { ...result, text: `${result.text}${warn}` } : result;
};
