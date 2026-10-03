import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { TargetBinding, TargetCandidate, TargetType } from '../../../shared/agent-questions.mjs';
import { isUuid } from '../../../shared/agent-questions.mjs';
import { sql } from './db.ts';
import { twentyRead, readTwentyRecord } from './twenty.ts';

export type CandidateSearch = {
  status: 'ok' | 'error' | 'incomplete';
  candidates: TargetCandidate[];
  error?: string;
};
export type CandidateRead = (path: string) => Promise<any>;
const collectionNames = { supportCase: 'supportCases', project: 'projects', workItem: 'workItems' } as const;
const closed = new Set(['CLOSED', 'RESOLVED']);
const richText = (value: any) => typeof value === 'string' ? value : value?.markdown ?? '';
const ownCompany = (row: any) => row?.companyId ?? row?.company?.id ?? null;

/** Bounded pagination never turns an unread page or malformed response into an empty library. */
export const readCandidatePages = async (
  collection: string, filter: string, read: CandidateRead = twentyRead, maxPages = 8,
): Promise<{ rows: any[]; complete: boolean }> => {
  const rows: any[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const result = await read(`/rest/${collection}?filter=${encodeURIComponent(filter)}&limit=50&depth=1${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ''}`);
    const batch = result?.data?.[collection];
    if (!Array.isArray(batch)) throw new Error(`Invalid ${collection} response`);
    rows.push(...batch);
    const info = result?.pageInfo ?? result?.data?.pageInfo;
    if (info?.hasNextPage === false || (!info?.hasNextPage && batch.length < 50)) {
      return { rows, complete: true };
    }
    // A full page without pagination metadata cannot establish an exhaustive negative result.
    if (!info?.hasNextPage || !info?.endCursor || seenCursors.has(info.endCursor)) {
      return { rows, complete: false };
    }
    cursor = String(info.endCursor);
    seenCursors.add(cursor);
  }
  return { rows, complete: false };
};

export const toTargetCandidate = (type: Exclude<TargetType, 'staging'>, row: any, companyId: string): TargetCandidate | null => {
  if (!isUuid(row?.id) || ownCompany(row) !== companyId) return null;
  const status = String(row.caseStatus ?? row.projectStage ?? row.itemStatus ?? '');
  const code = String(row.projectCode ?? row.itemCode ?? '').trim();
  const description = richText(row.issueDescription ?? row.body ?? row.specSummary).slice(0, 1800);
  const target: TargetBinding = {
    type, id: row.id, companyId, action: type === 'supportCase' ? 'append' : 'update',
    ...(code ? { code } : {}), ...(status ? { status } : {}),
    ...(row.projectId ?? row.project?.id ? { projectId: row.projectId ?? row.project.id } : {}),
    ...(row.updatedAt ? { updatedAt: String(row.updatedAt) } : {}),
  };
  return { handle: randomUUID(), target, label: `${code ? `${code} · ` : ''}${String(row.name ?? type)}`, description };
};

export const readCrmCandidates = async (
  type: Exclude<TargetType, 'staging'>, companyId: string,
  { read = twentyRead, query = '', projectId }: { read?: CandidateRead; query?: string; projectId?: string } = {},
): Promise<CandidateSearch> => {
  try {
    if (isUuid(query.trim())) {
      const result = await read(`/rest/${collectionNames[type]}/${query.trim()}`);
      const row = result?.data?.[type] ?? result?.data;
      if (!row || !isUuid(row.id)) throw new Error(`Invalid ${type} record response`);
      const candidate = toTargetCandidate(type, row, companyId);
      return { status: 'ok', candidates: candidate ? [candidate] : [] };
    }
    const filter = projectId ? `projectId[eq]:${projectId}` : `companyId[eq]:${companyId}`;
    const page = await readCandidatePages(collectionNames[type], filter, read);
    const norm = (v: string) => v.trim().toLocaleLowerCase();
    const wanted = norm(query);
    const candidates = page.rows.map((row) => toTargetCandidate(type, row, companyId))
      .filter((candidate): candidate is TargetCandidate => !!candidate)
      .filter((candidate) => wanted
        ? norm(`${candidate.label} ${candidate.description} ${candidate.target.id}`).includes(wanted)
        : type !== 'supportCase' || !closed.has(candidate.target.status?.toUpperCase() ?? ''));
    return { status: page.complete ? 'ok' : 'incomplete', candidates };
  } catch (error) {
    return { status: 'error', candidates: [], error: String((error as Error).message).slice(0, 200) };
  }
};

export const readPendingCandidates = async (companyId: string, companyCode: string, userId: string, excludeId: string): Promise<CandidateSearch> => {
  try {
    const items = await sql<Array<{ staging_id: string; item_id: string; id: string; revision: number; fields: any }>>`
      select r.staging_id,r.item_id,r.id,r.revision,r.fields
      from proposal_item p join proposal_revision r on r.item_id=p.id and r.revision=p.current_revision
      join staging s on s.id=r.staging_id
      where p.user_id=${userId} and p.deleted_at is null and r.company_id=${companyId} and r.staging_id<>${excludeId}
        and r.status in ('ready','failed') and s.note_deleted_at is null and s.record_deleted_at is null
      order by r.created_at desc limit 51`;
    // These are potential *write* targets, unlike the shared project-code lookup: own drafts only.
    const rows = await sql<Array<{ id: string; extracted: any; resolved_company_id: string | null; thread_id: string | null }>>`
      select s.id, s.extracted, s.resolved_company_id, s.thread_id
      from staging s join inbox i on i.id = s.inbox_id
      where i.user_id = ${userId} and s.id <> ${excludeId}
        and s.status in ('ready','failed') and s.superseded_by is null
        and s.record_deleted_at is null and s.note_deleted_at is null
        and not exists(select 1 from proposal_revision r where r.staging_id=s.id)
        and (s.resolved_company_id = ${companyId} or (s.resolved_company_id is null and s.extracted->>'companyCode' = ${companyCode}))
      order by s.created_at desc limit 51`;
    return {
      status: rows.length > 50 || items.length > 50 ? 'incomplete' : 'ok',
      candidates: [...items.slice(0, 50).map((row): TargetCandidate => ({
        handle: randomUUID(), target: { type: 'staging', id: row.staging_id, companyId, action: 'continue',
          itemId: row.item_id, revisionId: row.id, expectedRevision: row.revision },
        label: `待确认 · ${row.fields?.summary ?? row.fields?.project?.name ?? row.item_id.slice(0, 8)}`,
        description: String(row.fields?.details ?? '').slice(0, 1800),
      })), ...rows.slice(0, 50).map((row): TargetCandidate => ({
        handle: randomUUID(), target: { type: 'staging', id: row.id, companyId, action: 'continue', status: 'ready' },
        label: `待确认 · ${row.extracted?.summary ?? row.extracted?.project?.name ?? row.id.slice(0, 8)}`,
        description: String(row.extracted?.details ?? '').slice(0, 1800),
      }))],
    };
  } catch (error) {
    return { status: 'error', candidates: [], error: String((error as Error).message).slice(0, 200) };
  }
};

export const readCompanyTargetCandidates = async (companyId: string, companyCode: string, userId: string, stagingId: string, query = '') => {
  const [supportCases, projects, workItems, pending] = await Promise.all([
    readCrmCandidates('supportCase', companyId, { query }),
    readCrmCandidates('project', companyId, { query }),
    readCrmCandidates('workItem', companyId, { query }),
    readPendingCandidates(companyId, companyCode, userId, stagingId),
  ]);
  return { supportCases, projects, workItems, pending };
};

export const readProjectTargetCandidates = async (companyId: string, projectId: string) =>
  readCrmCandidates('workItem', companyId, { projectId });

export const registerCandidates = (ctx: { targetCandidates?: Map<string, TargetCandidate> }, searches: CandidateSearch[]) => {
  ctx.targetCandidates ??= new Map();
  for (const search of searches) for (const candidate of search.candidates) ctx.targetCandidates.set(candidate.handle, candidate);
};

/** Handles and distinguishing evidence must be in text: SkillResult.details is invisible to the model. */
export const candidateText = (heading: string, search: CandidateSearch): string => {
  const warning = search.status === 'error'
    ? '检索失败，不能据此认定不存在或自动新建；先保留提案，可重试或说明。'
    : search.status === 'incomplete' ? '列表未完整读取，不能据此认定不存在。' : search.candidates.length ? '' : '完整检索：没有匹配候选。';
  return [heading, warning, ...search.candidates.slice(0, 12).map((candidate) =>
    JSON.stringify({ candidateHandle: candidate.handle, type: candidate.target.type, companyId: candidate.target.companyId,
      title: candidate.label, code: candidate.target.code, status: candidate.target.status,
      itemId: candidate.target.itemId, revisionId: candidate.target.revisionId,
      evidence: candidate.description, closed: closed.has(candidate.target.status?.toUpperCase() ?? '') })),
    ...(search.candidates.length > 12 ? ['已显示前 12 条；用 query/编号缩小范围，不能自动选最近一条。'] : []),
  ].filter(Boolean).join('\n');
};

export class TargetValidationError extends Error {
  status: number;
  code: string;
  constructor(code: string, status: number, message: string) { super(message); this.code = code; this.status = status; }
}

export const validateTargetBinding = async (
  target: TargetBinding, expectedCompanyId: string, userId?: string, connection: typeof sql | postgres.TransactionSql = sql,
): Promise<void> => {
  if (!isUuid(target?.id) || !isUuid(expectedCompanyId) || target.companyId !== expectedCompanyId) {
    throw new TargetValidationError('target_company_mismatch', 422, '目标客户与提案客户不一致。');
  }
  if (target.type === 'staging') {
    if (!userId) throw new TargetValidationError('target_not_found', 404, '目标不可用。');
    if (target.itemId) {
      const [item] = await connection<Array<{ company_id: string; id: string; revision: number; status: string }>>`
        select r.company_id,r.id,r.revision,r.status from proposal_item p
        join proposal_revision r on r.item_id=p.id and r.revision=p.current_revision
        join staging s on s.id=r.staging_id
        where p.id=${target.itemId} and p.user_id=${userId} and p.deleted_at is null and r.staging_id=${target.id}
          and s.note_deleted_at is null and s.record_deleted_at is null`;
      if (!item || item.company_id !== expectedCompanyId) throw new TargetValidationError('target_not_found', 404, '目标事项不可用。');
      if (item.id !== target.revisionId || item.revision !== target.expectedRevision || !['ready','failed'].includes(item.status)) {
        throw new TargetValidationError('target_changed', 409, '待确认目标已修改，请重新核对。');
      }
      return;
    }
    const [row] = await connection<Array<{ status: string; resolved_company_id: string | null; company_code: string | null; extracted: any }>>`
      select s.status, s.resolved_company_id, i.company_code, s.extracted
      from staging s join inbox i on i.id = s.inbox_id
      where s.id = ${target.id} and i.user_id = ${userId} and s.record_deleted_at is null and s.note_deleted_at is null
        and s.superseded_by is null`;
    if (!row) throw new TargetValidationError('target_not_found', 404, '原待确认事项已经不可用。');
    if (!['ready', 'failed'].includes(row.status)) throw new TargetValidationError('target_changed', 409, '原事项状态已变化，请重新核对。');
    if (row.resolved_company_id && row.resolved_company_id !== expectedCompanyId) {
      throw new TargetValidationError('target_company_mismatch', 422, '原事项客户已变化。');
    }
    const company = await twentyRead(`/rest/companies/${expectedCompanyId}`).catch(() => {
      throw new TargetValidationError('target_lookup_failed', 502, '暂时无法校验目标客户，稍后重试。');
    });
    const code = company?.data?.company?.accountCode ?? company?.data?.accountCode;
    if (!row.resolved_company_id && row.extracted?.companyCode !== code) {
      throw new TargetValidationError('target_company_mismatch', 422, '原事项客户与提案客户不一致。');
    }
    return;
  }
  let row: any;
  try { row = await readTwentyRecord(target.type, target.id); } catch {
    throw new TargetValidationError('target_lookup_failed', 502, '暂时无法校验目标，保留提案并稍后重试。');
  }
  if (!row || row.deletedAt) throw new TargetValidationError('target_not_found', 404, '目标不存在或已删除。');
  if (ownCompany(row) !== expectedCompanyId) throw new TargetValidationError('target_company_mismatch', 422, '目标属于另一客户。');
  const actualStatus = String(row.caseStatus ?? row.projectStage ?? row.itemStatus ?? '');
  if (target.status && target.status !== actualStatus) throw new TargetValidationError('target_changed', 409, '目标状态已变化，请重新核对。');
  if (target.updatedAt && row.updatedAt && target.updatedAt !== String(row.updatedAt)) throw new TargetValidationError('target_changed', 409, '目标内容已变化，请重新核对。');
  if (target.type === 'supportCase' && closed.has(actualStatus.toUpperCase())) throw new TargetValidationError('target_closed', 409, '这条售后已结束，不能静默追加或重新打开。');
  if (target.code && String(row.projectCode ?? row.itemCode ?? '').trim() !== target.code) throw new TargetValidationError('target_changed', 409, '目标编号已变化。');
  if (target.projectId && (row.projectId ?? row.project?.id) !== target.projectId) throw new TargetValidationError('target_changed', 409, '任务所属项目已变化。');
};
