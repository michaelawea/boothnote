import {
  keepCategory, keepStage, keepConfidence, keepCaseStatus, keepSeverity,
  keepThreadType, keepPriority, keepItemStatus, keepDocSource,
  RECORD_TYPES_V2, CASE_STATUSES, SEVERITIES, chainRank, isValidChain,
} from '../agent/src/enums.ts';
import { companySuggestion } from '../../../shared/company-suggestion.mjs';

export type ItemStatus = 'ready' | 'confirming' | 'committing' | 'confirmed' | 'failed' | 'unknown' | 'withdrawn' | 'superseded';
export type ItemTarget = { type: 'supportCase' | 'project' | 'workItem'; id: string; companyId: string; code?: string; action?: 'append' | 'update' };
export type EvidenceRef = { inboxId?: string; messageId?: string; attachmentId?: string; quote?: string };
export type ProposalItemView = {
  itemId: string; revisionId: string; revision: number; stagingId: string;
  recordType: string; action: 'create' | 'append' | 'update';
  companyId: string | null; companyCode: string | null; target: ItemTarget | null;
  fields: Record<string, unknown>; confidence: Record<string, string>; evidenceRefs: EvidenceRef[];
  status: ItemStatus; confirmAfter: string | null;
  twentyRefs: Record<string, string> | null;
  createdRecords: Array<{ object: string; id: string; name: string }>;
  error: string | null;
};
export type ItemSelection = { itemId: string; revision: number; companyId?: string; fields?: Record<string, unknown>; supportCaseId?: string };
export class ProposalItemError extends Error {
  status: number;
  code: string;
  field?: string;
  constructor(code: string, status = 409, message = code, field?: string) {
    super(message);
    this.name = 'ProposalItemError';
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

export const validateItemTarget = (type:string,action:string,target:ItemTarget|null|undefined) => {
  if (!target) return;
  if (action==='create') throw new ProposalItemError('create_item_cannot_have_target',422);
  if (type==='support' && target.type!=='supportCase') throw new ProposalItemError('incompatible_item_target',422);
  if (type==='fitment') throw new ProposalItemError('incompatible_item_target',422);
  if ((type==='project' || type==='followup') && !['project','workItem'].includes(target.type)) throw new ProposalItemError('incompatible_item_target',422);
};

/** Counts refer to business items, never Visit + SupportCase object counts. */
export const summaryProposalItems = (items: Pick<ProposalItemView, 'status'>[]) => {
  const count = { total: items.length, ready: 0, confirming: 0, committing: 0, confirmed: 0, failed: 0, unknown: 0, withdrawn: 0, superseded: 0 };
  for (const it of items) count[it.status]++;
  const active = count.total - count.superseded - count.withdrawn;
  const partial = count.confirmed > 0 && count.confirmed < active;
  const status = count.unknown ? 'unknown' : count.committing ? 'committing' : count.confirming ? 'confirming' :
    active > 0 && count.confirmed === active ? 'confirmed' : partial ? 'partial' :
      count.failed && !count.ready ? 'failed' : !active && count.withdrawn ? 'withdrawn' : !active && count.superseded ? 'superseded' : 'ready';
  return { ...count, status, partial };
};

const text = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : undefined;
const date = (v: unknown): string | undefined => {
  const value=text(v);
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0,10)===value ? value : undefined;
};
const pickText = (raw: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.flatMap((key) => {
  const value = text(raw[key]); return value === undefined ? [] : [[key, value]];
}));

const ITEM_TEXT_FIELDS = [
  'supplierName', 'modelName', 'decisionWindow', 'annualVehicles', 'demandQuantity', 'demandBreakdown',
  'targetPrice', 'ownerTeam', 'summary', 'details', 'customerChain', 'sourceCompanyName',
];
const ITEM_BUSINESS_FIELDS = new Set([
  ...ITEM_TEXT_FIELDS, 'category', 'stage', 'sourceConfidence', 'budgetEur',
  'caseStatus', 'severity', 'deliveryBatch', 'affectedUnits',
  'project', 'projectCode', 'workItems', 'document',
  'suggested_company', 'suggestedCompanyFields', 'chain', 'corrections',
]);

/** Existing server metadata and untrusted relations are ignored, never forwarded to CRM. */
export const IGNORED_ITEM_FIELDS = [
  'recordType', 'companyCode', 'companySuggestion', 'targetBinding',
  'answeredQuestionId', 'answerToQuestion', 'agentSkipped', 'proposalVersion', 'itemCount', 'legacyDispositionRequired',
  'companyId', 'supportCaseId', 'projectId', 'supplierId', 'recordedById', 'sourceInboxId',
  'workItemId', 'productFitmentId', 'opportunityId', 'projectDocId', 'visitId', 'followupId',
  'attachmentId', 'blockedById', 'twentyRefs',
] as const;
const ignoredItemFields = new Set<string>(IGNORED_ITEM_FIELDS);
const invalidField = (code: string, field: string) => new ProposalItemError(code, 422, `${code}: ${field}`, field);

/** Same business enums as the legacy tools; unsupported business fields must be corrected explicitly. */
export const sanitizeItemFields = (raw: Record<string, unknown>, type: string): Record<string, unknown> => {
  if (!(RECORD_TYPES_V2 as readonly string[]).includes(type)) throw invalidField('invalid_record_type', 'recordType');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidField('invalid_item_fields', 'fields');
  for (const key of Object.keys(raw)) {
    if (!ITEM_BUSINESS_FIELDS.has(key) && !ignoredItemFields.has(key)) throw invalidField('unknown_item_field', key);
  }
  const f: Record<string, unknown> = { ...pickText(raw, ITEM_TEXT_FIELDS), recordType: type };
  const suggestion=text(raw['suggested_company']);
  if (suggestion) {
    f['suggested_company']=suggestion;
    f['suggestedCompanyFields']=companySuggestion(suggestion,raw['suggestedCompanyFields']);
  }
  for (const [key, keep] of [['category', keepCategory], ['stage', keepStage], ['sourceConfidence', keepConfidence]] as const) {
    if (raw[key] != null && raw[key] !== '') {
      const kept = keep(raw[key]); if (kept == null) throw invalidField(`invalid_${key}`, key);
      f[key] = kept;
    }
  }
  if (raw['chain'] != null) {
    if (!Array.isArray(raw['chain'])) throw invalidField('invalid_chain', 'chain');
    const chain = raw['chain'].map((entry: unknown, index: number) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalidField('invalid_chain', `chain[${index}]`);
      const node = entry as Record<string, unknown>;
      const name = text(node['name']);
      if (!name) throw invalidField('invalid_chain', `chain[${index}].name`);
      const role = typeof node['role'] === 'string' ? node['role'].toUpperCase() : '';
      if (chainRank(role) < 0) throw invalidField('invalid_chain', `chain[${index}].role`);
      return { name, role };
    });
    if (!isValidChain(chain.map((entry) => entry.role))) throw invalidField('invalid_chain_order', 'chain');
    f['chain'] = chain;
  }
  if (raw['corrections'] != null) {
    if (!Array.isArray(raw['corrections'])) throw invalidField('invalid_corrections', 'corrections');
    f['corrections'] = raw['corrections'].map((entry: unknown, index: number) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalidField('invalid_corrections', `corrections[${index}]`);
      const correction = entry as Record<string, unknown>;
      for (const key of ['heard', 'corrected']) {
        if (typeof correction[key] !== 'string') throw invalidField('invalid_corrections', `corrections[${index}].${key}`);
      }
      return { heard: correction['heard'], corrected: correction['corrected'] };
    });
  }
  if (typeof raw['budgetEur'] === 'number' && Number.isFinite(raw['budgetEur']) && raw['budgetEur'] > 0) f['budgetEur'] = Math.round(raw['budgetEur']);
  if (type === 'support') {
    if (raw['caseStatus'] != null) {
      if (!(CASE_STATUSES as readonly unknown[]).includes(raw['caseStatus'])) throw invalidField('invalid_caseStatus', 'caseStatus');
      f['caseStatus'] = keepCaseStatus(raw['caseStatus']);
    }
    if (raw['severity'] != null) {
      if (!(SEVERITIES as readonly unknown[]).includes(raw['severity'])) throw invalidField('invalid_severity', 'severity');
      f['severity'] = keepSeverity(raw['severity']);
    }
    if (text(raw['deliveryBatch'])) f['deliveryBatch'] = text(raw['deliveryBatch']);
    if (raw['affectedUnits'] != null) {
      if (!Number.isInteger(raw['affectedUnits']) || Number(raw['affectedUnits']) <= 0) throw invalidField('invalid_affectedUnits', 'affectedUnits');
      f['affectedUnits'] = raw['affectedUnits'];
    }
  }
  if (type === 'project' || type === 'followup') {
    const p = raw['project'];
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      f['project'] = pickText(p as Record<string, unknown>, ['name','projectCode','ownerTeam','primaryProductName','plannedSop','specSummary','openQuestions']);
      delete (f['project'] as Record<string, unknown>)['plannedSop'];
      if (date((p as Record<string, unknown>)['plannedSop'])) (f['project'] as Record<string, unknown>)['plannedSop']=date((p as Record<string, unknown>)['plannedSop']);
      if ((p as Record<string, unknown>)['projectStage']) {
        const stage = keepStage((p as Record<string, unknown>)['projectStage']);
        if (!stage) throw invalidField('invalid_projectStage', 'project.projectStage');
        (f['project'] as Record<string, unknown>)['projectStage'] = stage;
      }
      for (const key of ['budgetEur','sampleQty']) {
        const n = (p as Record<string, unknown>)[key];
        if (typeof n === 'number' && Number.isFinite(n) && n > 0 && (key==='budgetEur' || Number.isInteger(n))) (f['project'] as Record<string, unknown>)[key] = Math.round(n);
      }
    }
    if (text(raw['projectCode'])) f['projectCode'] = text(raw['projectCode']);
    if (Array.isArray(raw['workItems'])) {
      if (raw['workItems'].length>40) throw invalidField('work_item_count_out_of_range', 'workItems');
      f['workItems'] = raw['workItems'].map((w: Record<string, unknown>, index: number) => {
        if (!w || typeof w !== 'object' || Array.isArray(w)) throw invalidField('invalid_work_item', `workItems[${index}]`);
        return { ...pickText(w, ['title','itemCode','body','ownerRole','openQuestions']),
          ...(date(w['dueDate']) ? {dueDate:date(w['dueDate'])} : {}),
          ...(date(w['customerDueDate']) ? {customerDueDate:date(w['customerDueDate'])} : {}),
          threadType: keepThreadType(w['threadType']), priority: keepPriority(w['priority']), itemStatus: keepItemStatus(w['itemStatus']),
          blockedByCodes: typeof w['blockedByCodes']==='string' ? w['blockedByCodes'] :
            Array.isArray(w['blockedByCodes']) ? w['blockedByCodes'].filter((x) => typeof x === 'string').join(',') : '',
        };
      });
    }
    const d = raw['document'];
    if (d && typeof d === 'object' && !Array.isArray(d)) f['document'] = {
      ...pickText(d as Record<string, unknown>, ['name','docCode','version','content','filename']),
      isBaseline: (d as Record<string, unknown>)['isBaseline'] === true,
      docSource: keepDocSource((d as Record<string, unknown>)['docSource']),
    };
  }
  return f;
};
