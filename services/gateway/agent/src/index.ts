/**
 * agent 模块的**唯一出口**。
 *
 * 上层（index.ts）只 import 这一个文件。这是为了让「将来把 agent 拆成独立进程」
 * 变成一件小事：那时候这个文件换成一个 IPC 客户端，网关那边一行不改。
 * 现在不拆的理由见实施计划 §1.3 —— 同语言、同仓库、一天几十条，
 * 拆出去买到的隔离，抵不上多一套部署和多一个可能挂掉的东西。
 */
export {
  enqueue,
  enqueueTranscribe,
  reapStaleRuns,
  resumePending,
  agentHealth,
  // D89（issue #22）：手动叫停。网关的 POST /threads/:id/abort 只认这一个出口
  abortInbox,
  // D90（issue #23）：人改口重发时归档这条对话的消息史，下一轮从零开始
  forgetThreadHistory,
  __setBinding,
  __setRunsCreated,
} from './loop.ts';
export { loadPlaybooks, playbookNames, labPlaybooks } from './skills.ts';
// 实验室 agent（T94 · D121）：同一个 runtime、空工具表、自己的一份 playbook
export { runLabAgent, labSystemPrompt, labTools, LAB_TOOL_NAMES, type LabContext } from './lab.ts';
export { pricingAllowed, resolveDoc, searchDocs, searchRefs, loadManifest, __resetProducts } from './lab-products.ts';
export { buildDocUrl, __resetSession } from './lab-sharepoint.ts';
export { TOOL_NAMES, FORBIDDEN_TOOL_NAMES, buildSkills, newContext, warnIfColumnSwitchOn } from './tools/index.ts';
export type { SkillContext } from './tools/context.ts';
export { runAgent, openaiBinding, type Skill, type RunResult } from './runtime.ts';
export {
  transcribe,
  industryTerms,
  selfTestTranscribe,
  selfTestState,
  optionalParamState,
  type SelfTest,
} from './transcribe.ts';
export { makeTitle, heuristicTitle, ensureTitle } from './title.ts';
export {
  extractAttachmentText,
  prepareAttachments,
  rejectsInputFile,
  markExtsUnsupported,
  isExtUnsupported,
  type PreparedAttachments,
} from './attachments.ts';
