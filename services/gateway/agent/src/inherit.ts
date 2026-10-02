/**
 * 「接管一版已入库的」时，新一版从哪儿起步（D147 · loop.ts）。纯函数。
 *
 * 起点 = 那一版**入库时真正写进去的值**：`extracted` 叠上人在核对卡上改过的
 * `confirm_payload.fields` —— 和 `commitToTwenty` 里 `f = {...extracted, ...fields}` 同一条算法。
 * 只取 extracted 的话，人改过的值（枚举、项目编号）会在下一次原地更新时被打回 agent 原值。
 *
 * 返回 null = 没东西可继承（那一版不存在 / 是空的）。
 */
/** Creation hints are metadata, not a usable record: retain the raw-text fallback. */
export const hasRecordProposal = (fields: Record<string, unknown> | null | undefined): boolean =>
  Object.keys(fields ?? {}).some((key) => key !== 'companySuggestion');

export const committedBase = (
  owner: { extracted?: Record<string, unknown> | null; confirm_payload?: { fields?: Record<string, unknown> } | null } | null,
): Record<string, unknown> | null => {
  if (!owner) return null;
  const base = { ...(owner.extracted ?? {}), ...(owner.confirm_payload?.fields ?? {}) };
  delete base['agentSkipped']; // 兜底标记不随继承传下去（loop.ts 收尾那段同一条理由）
  return hasRecordProposal(base) ? base : null;
};
