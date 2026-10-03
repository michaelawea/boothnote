/**
 * **agent 与外界的唯一接触面。**
 *
 * 这个文件夹里除了这一个文件，没有任何一行 `import` 指向 agent 之外。
 * 所以「agent 依赖了什么」这个问题，答案完整地写在下面 —— 不用翻网关的源码。
 *
 * 为什么值得单独一个文件（维护者 2026-08-05，issue #17）：
 *   agent 原来散在 `services/gateway/src/agent/` 里，改它要在网关的源码树里穿来穿去，
 *   而「它到底能碰到什么」只能靠 grep。搬出来之后：
 *   **要看边界看这一个文件，要改行为看 prompt.ts 和 skills/。**
 *
 * 🔴 **想给 agent 加写 CRM 的能力，第一步一定是往这个文件里加一行。**
 *    那一行就是 code review 要挡的地方 —— 边界不再靠「谁记得住 Ring 3 有哪些」。
 *    下面的写入清单**恰好三个函数**，而且都属于 D47 那一个被明确批准的例外。
 *
 * ⚠️ 位置约束：这个文件夹必须留在 `services/gateway/` 之下。
 *    Node 的模块解析只往**祖先目录**找 `node_modules`，而依赖装在
 *    `services/gateway/node_modules`。挪到仓库顶层就得先把仓库改成 npm workspace，
 *    那会动到 Dockerfile / CI / deploy.sh 三条已经烧过手的路径（D29 / D65）。
 */

// ── 数据库。agent 只写 `staging`，`inbox` 由触发器挡住（§4.2 第 2 条）──────
export { sql } from '../../src/db.ts';
export { companySuggestion } from '../../../../shared/company-suggestion.mjs';
export { ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS } from '../../../../shared/company-types.mjs';

// ── 配置。模型名、上限、开关都在这里 ─────────────────────────────────
export { env } from '../../src/env.ts';

// ── CRM 只读。客户、项目、商机、售后、情报清单，全是 list/get ──────────
export {
  getCompanyByCode,
  listIntelItems,
  listIntelValues,
  listOpenSupportCases,
  listOpportunities,
  listProductFitments,
  listProjects,
  listWorkItems,
  listProjectDocs,
  listCompanies,
  listSuppliers,
  searchProjects,
  findProjectByCode,
  type Company,
} from '../../src/twenty.ts';

/**
 * ── 项目编号（D91）。**读 Twenty、写 `staging`，一个字都不进 CRM** ──────
 *
 * 放在这里而不是上面那段只读清单里，是因为它确实会写 ——
 * 但写的是 `staging.extracted.project.projectCode`，和 agent 别处写提案同一块地方。
 * 它没有能力创建 CRM 里的项目：编号只是一张**待确认阶段就稳定下来的名牌**，
 * 真正建项目仍然只有人在核对卡上按下去之后、由 `confirm.ts` 做（Ring 3 一条没变）。
 *
 * 为什么非要提前发号：不发的话，同一个项目的两条对话在看板上没有任何键可以并起来
 * （issue #18），而用项目名当键是 §4.2 第 3 条明令禁止的。
 */
export { pendingProjectProposals, reserveProjectCode } from '../../src/projectCode.ts';

// Verified candidates and durable questions stay behind the gateway boundary.
export { readCompanyTargetCandidates, readProjectTargetCandidates, candidateText, registerCandidates } from '../../src/targetCandidates.ts';
export { createAgentQuestion, bindExplicitCandidate, resolveExplicitCandidate, persistAgentQuestions } from '../../src/questions.ts';
export type { AgentQuestionInput } from '../../src/questions.ts';
export { proposeRecords, listThreadItems, hasProposalItems } from '../../src/proposal-items.ts';

/**
 * ── 🔴 唯一的三个「会写进 CRM」的函数 ─────────────────────────────────
 *
 * 这是 **D47 明确批准的例外**，不是漏网的：
 * 「现有字段装不下的事，它当场造一个情报字段来装」。
 * 落点是 `IntelItem`（清单项）+ `IntelValue`（这次的值），
 * **不是** Company / Opportunity / Project 上的任何一格 —— 那些仍然只能由
 * 人在核对卡上按了之后，由 `confirm.ts` 写。
 *
 * 四条护栏在 `skills/intel-field.ts` 里，缺一条这个工具就会变成灾难：
 *   ① 造之前查重，命中就复用   ② 一条速记最多造 1 个
 *   ③ 新造的 weight = 0        ④ createdByAgent + sourceInboxId 可追溯
 *
 * ⚠️ **往这一段加函数 = 扩大 agent 的写权限。** 加之前先改规划文档 §3。
 */
export { createIntelItem, createIntelValue, upsertContributor } from '../../src/twenty.ts';

// ── 品牌名匹配（变音符 / 法律后缀折叠）────────────────────────────────
export { findSimilar, similarity } from '../../src/match.ts';

// ── 情报完整度。🔴 和 `/gaps` 端点共用同一份实现，不许各算各的 ──────────
export { computeGaps } from '../../src/gaps.ts';

/**
 * ⚠️ **`enums.ts` 故意留在 agent 这边，而网关反过来 import 它。**
 *
 * 它是枚举的唯一真相源：agent 的 `list_enums`、网关的 `/enums`、
 * `confirm.ts` 的白名单、核对卡上的选项，四处必须是同一份。
 * 放两份的代价刚刚在 issue #17 里付过一次 —— `list_enums` 用 V1、
 * `/enums` 用 V2，于是 agent 手上根本没有「项目」这个记录类型。
 */
