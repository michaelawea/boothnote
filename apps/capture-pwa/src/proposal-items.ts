import type { Company } from './db';

export type ProposalItemView = {
  itemId: string;
  revisionId: string;
  revision: number;
  stagingId: string;
  recordType: string;
  action: 'create' | 'append' | 'update';
  companyId: string | null;
  companyCode: string | null;
  target: { type: string; id: string; companyId: string; code?: string } | null;
  fields: Record<string, unknown>;
  confidence: Record<string, string>;
  evidenceRefs: Array<{ inboxId?: string; messageId?: string; attachmentId?: string; quote?: string }>;
  status: 'ready' | 'confirming' | 'committing' | 'confirmed' | 'failed' | 'unknown' | 'withdrawn' | 'superseded';
  confirmAfter: string | null;
  twentyRefs: Record<string, string> | null;
  createdRecords: unknown;
  error: string | null;
};

export type ItemSelection = {
  itemId: string;
  revision: number;
  companyId?: string;
  fields?: Record<string, unknown>;
  supportCaseId?: string;
};

export type ItemDraft = { company?: Company; fields?: Record<string, unknown> };
export const itemRevisionKey = (item: Pick<ProposalItemView, 'itemId' | 'revision'>): string =>
  `${item.itemId}:${item.revision}`;

/** A selection applies to one exact proposal version, never to its next revision. */
export const itemCanConfirm = (item: ProposalItemView): boolean =>
  item.status === 'ready' || item.status === 'failed';

export const itemCompanyId = (item: ProposalItemView, draft?: ItemDraft): string | null =>
  item.target?.companyId ?? draft?.company?.id ?? item.companyId;

export const selectedItemPayload = (
  items: ProposalItemView[], selected: ReadonlySet<string>, drafts: Record<string, ItemDraft>,
): ItemSelection[] => items.flatMap((item) => {
  const key = itemRevisionKey(item);
  if (!selected.has(key) || !itemCanConfirm(item)) return [];
  const draft = drafts[key];
  const companyId = itemCompanyId(item, draft);
  if (!companyId) return [];
  return [{
    itemId: item.itemId, revision: item.revision, companyId,
    ...(draft?.fields && Object.keys(draft.fields).length ? { fields: draft.fields } : {}),
  }];
});

export const proposalItemCounts = (items: ProposalItemView[]) => {
  const counts = { total: items.length, confirmed: 0, ready: 0, working: 0, failed: 0, unknown: 0, inactive: 0 };
  for (const item of items) {
    if (item.status === 'confirmed') counts.confirmed++;
    else if (item.status === 'ready') counts.ready++;
    else if (item.status === 'confirming' || item.status === 'committing') counts.working++;
    else if (item.status === 'failed') counts.failed++;
    else if (item.status === 'unknown') counts.unknown++;
    else counts.inactive++;
  }
  return counts;
};
