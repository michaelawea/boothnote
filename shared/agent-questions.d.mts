export type TargetType = 'supportCase' | 'project' | 'workItem' | 'staging';
export type QuestionAction = 'append' | 'update' | 'continue' | 'create' | 'clarify';
export type TargetBinding = {
  type: TargetType;
  id: string;
  companyId: string;
  action: 'append' | 'update' | 'continue';
  code?: string;
  projectId?: string;
  status?: string;
  updatedAt?: string;
  /** A pending batch can contain multiple items: continuation must name the exact one. */
  itemId?: string;
  revisionId?: string;
  expectedRevision?: number;
};
export type TargetCandidate = {
  handle: string;
  target: TargetBinding;
  label: string;
  description: string;
};
export type QuestionOption = {
  optionId: string;
  label: string;
  action: QuestionAction;
  target?: TargetBinding;
};
export type QuestionSnapshot = {
  questionId: string;
  question: string;
  kind: 'clarify' | 'target';
  /** A server-created boundary question distinguishes a pending legacy draft from a new matter. */
  purpose?: 'legacy_disposition';
  legacyStagingId?: string;
  /** Legacy text-only options remain displayable, without asserting a target binding. */
  options?: string[];
  choices?: QuestionOption[];
  recommendedOptionId?: string;
  threadId?: string;
  sourceMessageId?: string;
  stagingId?: string;
  itemId?: string;
  revisionId?: string;
  proposalFingerprint?: string;
  expectedRevision?: string;
  companyId?: string | null;
  status?: 'pending' | 'answered' | 'stale' | 'expired';
  selectedOptionId?: string | null;
  answeredAt?: string | null;
  expiresAt?: string;
};
export type QuestionAnswerRequest = {
  clientId: string;
  optionId?: string;
  text?: string;
  expectedRevision: string;
};
export type QuestionAnswerResult = {
  duplicate: boolean;
  inboxId: string;
  stagingId: string;
  threadId: string;
  newMessageId: string | null;
  questionId: string;
  selectedOptionId: string | null;
  target: TargetBinding | null;
  requiresAgent: boolean;
};
export const TARGET_TYPES: readonly TargetType[];
export const QUESTION_ACTIONS: readonly QuestionAction[];
export function isUuid(value: unknown): value is string;
export function canonicalBusinessValue(value: unknown): unknown;
export function questionAnswerText(question: QuestionSnapshot, optionId?: string, text?: string): string;
