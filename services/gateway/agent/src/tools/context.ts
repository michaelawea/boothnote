import type { Company } from '../host.ts';
import type { QuestionSnapshot, TargetCandidate } from '../../../../../shared/agent-questions.mjs';
import type { CompanySuggestion } from '../../../../../shared/company-suggestion.mjs';

/**
 * 一轮 agent 跑动的上下文。
 *
 * 注意这里面**没有** `role`、没有 token、没有任何「这个用户能看什么」的东西。
 * 作用域是网关在把活取出来之前就裁好的（§4.2 第4条），agent 拿到的已经是
 * 它有权处理的那一条 —— 它没有办法把范围扩大，因为它手上根本没有可以扩大的钥匙。
 */
export type SkillContext = {
  inboxId: string;
  stagingId: string;
  threadId: string | null;
  userId: string;
  userCode: string;
  displayName: string;
  companies: Company[];
  suppliers: Array<{ id: string; name: string }>;
  /**
   * 这条速记的附件。**id 必须给到 prompt 里** ——
   * 不给的话 agent 会拿文件名当 id 传给 `read_attachment`，
   * 结果是 `invalid input syntax for type uuid`，白白烧掉一步（2026-08-03 实测）。
   */
  attachments: Array<{ id: string; filename: string }>;
  /** 仅服务端验证过的结构化答案来源，允许重新读原始附件。 */
  relatedInboxIds?: string[];
  /** 仅 durable legacy disposition 的已验证原文可自动成为事项证据。 */
  dispositionSourceInboxId?: string;
  /** 这一轮的步数上限。写进 prompt 让它自己安排顺序，别把 propose_fields 留到最后。 */
  maxSteps: number;
  /**
   * 要**推送**全文的 playbook（D72 的「推」半边）：loop 已经知道类型时
   * （带附件 / 上一轮判成了 project）直接把那本塞进系统提示词，省一步 read_skill。
   * 「拉」（read_skill）仍然可用 —— 模型中途改判时自己能翻到正确的册子。
   */
  pushPlaybooks: string[];
  /**
   * true = 这一轮带着上一轮的完整消息史续跑（D73①）。
   * prompt 据此告诉模型「上下文已经在了，不用再 get_thread」—— 省一步。
   */
  resumed: boolean;
  /**
   * 这条速记从哪个入口来的（`inbox.source`：pwa / dingtalk / …）。
   * D147：钉钉来源不注册 `propose_intel_field` —— 那个工具在 agent 跑的过程中就写 Twenty，
   * 而钉钉来源是「60 秒后自动入库、期间可撤回」（D143），撤回取消不掉一个已经写进去的字段。
   * **必填**（null = 不知道 → 按 PWA 处理）：可选的话，loop 漏传它不会有任何报错，
   * 而钉钉来源会悄悄拿回那个写 CRM 的工具 —— 让 tsc 替我们记着。
   */
  source: string | null;

  /** 护栏②的计数器：一条速记最多造 1 个情报字段。 */
  intelFieldsCreated: number;
  /** agent 想问人的话，落在这里，由 loop 写进对话。 */
  questions: QuestionSnapshot[];
  /** Read tools register trusted handles; target tools can never manufacture arbitrary CRM UUIDs. */
  targetCandidates?: Map<string, TargetCandidate>;
  /** Optional identity supplied by multi-item orchestration, never inferred from thread identity. */
  itemId?: string;
  revisionId?: string;
  proposedItems?: Array<{ itemId: string; revisionId: string; revision?: number; companyId: string | null }>;
  inheritedLegacyStagingId?: string;
  continuedLegacyStagingId?: string;
  legacyDispositionRequired?: boolean;
  questionWarnings?: string[];
  /** 建议按明确公司名或事项 key 归属，不把最后一家客户借给其它事项。 */
  companySuggestions?: Map<string, CompanySuggestion>;
  itemCompanySuggestions?: Map<string, CompanySuggestion>;
  /** 它提议过的新客户名，只提议不建（§4.2 第3条）。 */
  suggestedCompany: string | null;
  /** 已经调用过 propose_fields 没有 —— 用来判断这一轮到底有没有产出。 */
  proposed: boolean;
};

export const newContext = (
  base: Omit<SkillContext, 'intelFieldsCreated' | 'questions' | 'suggestedCompany' | 'proposed'>,
): SkillContext => ({
  ...base,
  intelFieldsCreated: 0,
  questions: [],
  suggestedCompany: null,
  proposed: false,
  targetCandidates: new Map(),
  companySuggestions: new Map(),
  itemCompanySuggestions: new Map(),
});
