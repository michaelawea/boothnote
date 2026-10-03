import type postgres from 'postgres';
import type { TargetBinding } from '../../../shared/agent-questions.mjs';
import { sql } from './db.ts';
import { env } from './env.ts';
import { listCompanies, readTwentyRecord, type RecordRef, type TwentyRecordType } from './twenty.ts';
import { validateTargetBinding } from './targetCandidates.ts';
import { hashItemOperationInput, markInterruptedItemOperationsUnknown } from './item-operations.ts';
import { sanitizeItemFields, summaryProposalItems, ProposalItemError, validateItemTarget,
  type ProposalItemView, type ItemSelection, type ItemTarget, type EvidenceRef, type ItemStatus } from './proposal-model.ts';

export { summaryProposalItems, ProposalItemError, sanitizeItemFields } from './proposal-model.ts';
export type { ProposalItemView, ItemSelection, ItemTarget, EvidenceRef } from './proposal-model.ts';
type Tx = postgres.TransactionSql;
type RevisionRow = {
  id: string; item_id: string; staging_id: string; revision: number; record_type: string; proposal_input_hash: string;
  action: 'create' | 'append' | 'update'; company_id: string | null; company_code: string | null;
  target: ItemTarget | null; fields: Record<string, unknown>; confidence: Record<string, string>;
  evidence_refs: EvidenceRef[]; status: ItemStatus; confirm_after: Date | string | null;
  confirm_payload: { companyId: string; fields?: Record<string, unknown>; supportCaseId?: string; recommit?: boolean } | null;
  confirm_by: string | null; twenty_refs: Record<string, string> | null;
  created_records: Array<{ object: string; id: string; name: string }>; error: string | null;
};
const view = (r: RevisionRow): ProposalItemView => ({
  itemId: r.item_id, revisionId: r.id, revision: r.revision, stagingId: r.staging_id,
  recordType: r.record_type, action: r.action, companyId: r.company_id, companyCode: r.company_code,
  target: r.target, fields: { ...r.fields, ...(r.confirm_payload?.fields ?? {}) }, confidence: r.confidence ?? {},
  evidenceRefs: r.evidence_refs ?? [], status: r.status,
  confirmAfter: r.confirm_after ? new Date(r.confirm_after).toISOString() : null,
  twentyRefs: r.twenty_refs, createdRecords: r.created_records ?? [], error: r.error,
});

export const hasProposalItems = async (stagingId: string): Promise<boolean> => {
  const [r] = await sql<Array<{ yes: boolean }>>`select exists(select 1 from proposal_revision where staging_id=${stagingId}) as yes`;
  return r?.yes === true;
};
export const listProposalItems = async (stagingId: string, connection?:Tx): Promise<ProposalItemView[]> => {
  const db=connection??sql;
  // A batch may receive several tool calls; one business item is counted once at its latest batch revision.
  return (await db<RevisionRow[]>`select distinct on (r.item_id) r.*,
    case when r.revision<i.current_revision then 'superseded' else r.status end as status
    from proposal_revision r join proposal_item i on i.id=r.item_id
    where r.staging_id=${stagingId} order by r.item_id,r.revision desc`).map(view);
};
export const listThreadItems = async (threadId: string, userId: string): Promise<ProposalItemView[]> =>
  (await sql<RevisionRow[]>`select r.* from proposal_revision r join proposal_item i on i.id=r.item_id join staging s on s.id=r.staging_id
    where (i.thread_id=${threadId} or s.thread_id=${threadId}) and i.user_id=${userId} and r.revision=i.current_revision
      and r.status not in ('superseded','withdrawn')
    order by i.created_at, i.id`).map(view);

export type RecordProposal = {
  key: string; itemId?: string; expectedRevision?: number; recordType: string;
  action?: 'create' | 'append' | 'update'; companyCode?: string | null; target?: ItemTarget | null;
  fields: Record<string, unknown>; confidence?: Record<string, string>; evidenceRefs?: EvidenceRef[];
};
export type ProposeRecordsInput = {
  stagingId: string; inboxId: string; threadId: string | null; userId: string; records: RecordProposal[];
};

/** An existing item keeps its CRM identity; selecting another target requires a new item. */
export const validateOwnedItemTarget = (
  refs: Record<string, string>, target: ItemTarget | null | undefined,
  links: Array<{ object: string; id: string }> = [],
): void => {
  if (!target) return;
  const primary = refs[{ supportCase: 'supportCaseId', project: 'projectId', workItem: 'workItemId' }[target.type]];
  // A primary case/project is authoritative even if historical links include other targets.
  const allowed = primary ? [primary] : links.filter((link) => link.object === target.type).map((link) => link.id);
  if (allowed.length && !allowed.includes(target.id)) {
    throw new ProposalItemError('item_target_change_requires_new_item', 409,
      '已入库事项不能改接另一条 CRM 记录；请明确新建另一事项，并保留原事项的归属。');
  }
};

const itemLinks = async (connection: Tx | typeof sql, itemId: string): Promise<Array<{ object: string; id: string }>> =>
  connection<Array<{ object: string; id: string }>>`select object_type as object,record_id as id from item_record_link where item_id=${itemId}`;

const hasPartialItemWrites = async (connection: Tx | typeof sql, itemId: string, revisionId: string): Promise<boolean> => {
  const [row] = await connection<Array<{ partial: boolean }>>`select (
    exists(select 1 from item_operation where revision_id=${revisionId} and state in ('succeeded','running','unknown'))
    or (exists(select 1 from item_record_link where item_id=${itemId} and created_here)
      and not exists(select 1 from proposal_revision where item_id=${itemId} and status='confirmed'))
  ) as partial`;
  return row?.partial === true;
};

/** A partially executed revision must be finalized before it can be withdrawn or rewritten. */
export const hasItemRemoteEffects = (itemId: string, revisionId: string, transaction?: Tx): Promise<boolean> =>
  hasPartialItemWrites(transaction ?? sql,itemId,revisionId);

const validateEvidence = async (tx: Tx, refs: EvidenceRef[], input: ProposeRecordsInput) => {
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object') throw new ProposalItemError('invalid_evidence', 422);
    let inboxId = ref.inboxId;
    if (ref.messageId) {
      const [m] = await tx<Array<{ inbox_id: string | null }>>`select m.inbox_id from thread_message m
        join thread t on t.id=m.thread_id where m.id=${ref.messageId}
        and t.user_id=${input.userId} and t.id=${input.threadId}`;
      if (!m?.inbox_id) throw new ProposalItemError('invalid_evidence_message', 422);
      inboxId = m.inbox_id;
    }
    if (ref.attachmentId) {
      const [a] = await tx<Array<{ inbox_id: string }>>`select a.inbox_id from attachment a join inbox i on i.id=a.inbox_id
        where a.id=${ref.attachmentId} and i.user_id=${input.userId}`;
      if (!a) throw new ProposalItemError('invalid_evidence_attachment', 422);
      if (inboxId && inboxId !== a.inbox_id) throw new ProposalItemError('evidence_source_mismatch', 422);
      inboxId = a.inbox_id;
    }
    if (!inboxId) throw new ProposalItemError('missing_evidence_source', 422);
    const [source] = await tx`select id from inbox where id=${inboxId} and user_id=${input.userId}
      and (id=${input.inboxId} or thread_id=${input.threadId})`;
    if (!source) throw new ProposalItemError('invalid_evidence_source', 422);
  }
};

/** No implicit "latest item" inheritance. Model retries use a per-batch proposal key. */
export const proposeRecords = async (input: ProposeRecordsInput, transaction?: Tx): Promise<ProposalItemView[]> => {
  if (!Array.isArray(input.records) || !input.records.length || input.records.length > 20) throw new ProposalItemError('item_count_out_of_range', 422);
  if (new Set(input.records.map((r) => r.key)).size !== input.records.length) throw new ProposalItemError('duplicate_proposal_key', 422);
  const companies = await listCompanies();
  const perform = async (tx: Tx) => {
    const [batch] = await tx`select s.id from staging s join inbox i on i.id=s.inbox_id
      where s.id=${input.stagingId} and i.id=${input.inboxId} and i.user_id=${input.userId}
      and (i.thread_id=${input.threadId} or (i.thread_id is null and ${input.threadId}::uuid is null)) for update of s`;
    if (!batch) throw new ProposalItemError('proposal_batch_not_found', 404);
    const results: ProposalItemView[] = [];
    const priorBatches=new Set<string>();
    for (const proposal of input.records) {
      if (!proposal.key || proposal.key.length > 120) throw new ProposalItemError('invalid_proposal_key', 422);
      const inputHash = hashItemOperationInput({ ...proposal, fields: sanitizeItemFields(proposal.fields, proposal.recordType) });
      const [existing] = await tx<RevisionRow[]>`select * from proposal_revision
        where staging_id=${input.stagingId} and proposal_key=${proposal.key}`;
      if (existing) {
        // Repeating a tool call must not silently create a fourth ticket or rewrite a queued revision.
        if (inputHash !== existing.proposal_input_hash) {
          throw new ProposalItemError('proposal_key_content_conflict');
        }
        results.push(view(existing)); continue;
      }
      let previous: RevisionRow | undefined;
      let itemId: string;
      let ownRefs: Record<string, string> = {};
      if (proposal.itemId) {
        const [identity] = await tx<Array<{ id: string; current_revision: number; thread_id: string | null; company_id:string|null; twenty_refs:Record<string,string> }>>`select id,current_revision,thread_id,company_id,twenty_refs
          from proposal_item where id=${proposal.itemId} and user_id=${input.userId} for update`;
        if (!identity) throw new ProposalItemError('item_not_found', 404);
        if (proposal.expectedRevision !== identity.current_revision) throw new ProposalItemError('stale_item_revision');
        [previous] = await tx<RevisionRow[]>`select * from proposal_revision where item_id=${identity.id} and revision=${identity.current_revision} for update`;
        if (previous && ['confirming','committing','unknown'].includes(previous.status)) throw new ProposalItemError('item_busy_or_unknown');
        if (previous && ['withdrawn','superseded'].includes(previous.status)) throw new ProposalItemError('item_withdrawn_or_superseded');
        if (previous && ['ready','failed'].includes(previous.status) && await hasPartialItemWrites(tx,identity.id,previous.id)) {
          throw new ProposalItemError('partial_item_requires_recovery',409,
            '这一版已有部分 CRM 操作成功；请先核对并恢复原版本，再创建更正版。');
        }
        ownRefs = identity.twenty_refs ?? {};
        itemId = identity.id;
      } else {
        const [identity] = await tx<Array<{ id: string }>>`insert into proposal_item(user_id,thread_id)
          values(${input.userId},${input.threadId}) returning id`;
        itemId = identity!.id;
      }
      const action = proposal.action ?? previous?.action ?? 'create';
      if (!['create','append','update'].includes(action)) throw new ProposalItemError('invalid_item_action', 422);
      const companyCode = proposal.companyCode === undefined ? previous?.company_code ?? null : proposal.companyCode;
      const company = companyCode ? companies.find((c) => c.code === companyCode) : null;
      if (companyCode && !company) throw new ProposalItemError('invalid_item_company', 422);
      if (previous) {
        const [owner]=await tx<Array<{company_id:string|null}>>`select company_id from proposal_item where id=${itemId}`;
        if (owner?.company_id && owner.company_id!==company?.id) throw new ProposalItemError('item_company_change_requires_new_item',422);
        const [committedType]=await tx<Array<{record_type:string}>>`select record_type from proposal_revision
          where item_id=${itemId} and status='confirmed' order by revision desc limit 1`;
        if (committedType && committedType.record_type!==proposal.recordType) throw new ProposalItemError('item_type_change_requires_new_item',422);
      }
      const fields = {
        ...(previous?.fields ?? {}), ...(previous?.confirm_payload?.fields ?? {}),
        ...sanitizeItemFields(proposal.fields, proposal.recordType),
        companyCode, recordType: proposal.recordType,
      };
      const target = proposal.target === undefined ? previous?.target ?? null : proposal.target;
      validateItemTarget(proposal.recordType,action,target);
      if (previous && proposal.action==='create' && target===null &&
          ['supportCaseId','projectId','workItemId','productFitmentId','opportunityId','projectDocId'].some((key)=>ownRefs[key])) {
        throw new ProposalItemError('item_create_requires_new_item',409,
          '新建业务事项必须使用新的事项身份；原事项及其 CRM 归属会保留。');
      }
      if (previous) validateOwnedItemTarget(ownRefs,target,await itemLinks(tx,itemId));
      if (previous && previous.status==='confirmed' && previous.record_type!==proposal.recordType) throw new ProposalItemError('item_type_change_requires_new_item',422);
      if (target && (!company || target.companyId !== company.id)) throw new ProposalItemError('target_company_mismatch', 422);
      if (!previous && action !== 'create' && !target) throw new ProposalItemError('missing_item_target', 422);
      const evidence = proposal.evidenceRefs?.length ? proposal.evidenceRefs : [{ inboxId: input.inboxId }];
      await validateEvidence(tx, evidence, input);
      const revision = (previous?.revision ?? 0) + 1;
      const [r] = await tx<RevisionRow[]>`insert into proposal_revision
        (item_id,staging_id,revision,parent_revision_id,proposal_key,proposal_input_hash,record_type,action,company_id,company_code,target,fields,confidence,evidence_refs)
        values(${itemId},${input.stagingId},${revision},${previous?.id ?? null},${proposal.key},${inputHash},${proposal.recordType},${action},
          ${company?.id ?? null},${companyCode},${tx.json(target as never)},${tx.json(fields as never)},
          ${tx.json((proposal.confidence ?? previous?.confidence ?? {}) as never)},${tx.json(evidence as never)}) returning *`;
      await tx`update proposal_item set current_revision=${revision} where id=${itemId}`;
      if (previous && previous.status !== 'confirmed') await tx`update proposal_revision set status='superseded',updated_at=now() where id=${previous.id}`;
      if (previous && previous.staging_id!==input.stagingId) priorBatches.add(previous.staging_id);
      results.push(view(r!));
    }
    await tx`update staging set extracted=jsonb_strip_nulls(jsonb_build_object(
      'proposalVersion',2,'itemCount',(select count(distinct item_id) from proposal_revision where staging_id=${input.stagingId}),
      'answerToQuestion',extracted->'answerToQuestion','answeredQuestionId',extracted->'answeredQuestionId')),
      resolved_company_id=null,suggested_company=null where id=${input.stagingId}`;
    for (const stagingId of priorBatches) await refreshProposalBatch(stagingId,tx);
    return results;
  };
  return transaction ? perform(transaction) : sql.begin(perform);
};

export const reviseProposalItemFromAnswer = async (args: {
  itemId: string; expectedRevision: number; stagingId: string; inboxId: string; userId: string;
  target?: TargetBinding | null; fields?: Record<string, unknown>;
}, tx?: Tx): Promise<ProposalItemView> => {
  const db = tx ?? sql;
  const [source] = await db<Array<RevisionRow & { thread_id: string | null }>>`select r.*,i.thread_id from proposal_revision r
    join proposal_item i on i.id=r.item_id where i.id=${args.itemId} and i.user_id=${args.userId}
    and r.revision=${args.expectedRevision}`;
  if (!source) throw new ProposalItemError('source_item_not_found', 404);
  const [answerInbox]=await db<Array<{thread_id:string|null}>>`select thread_id from inbox where id=${args.inboxId} and user_id=${args.userId}`;
  if (!answerInbox) throw new ProposalItemError('answer_input_not_found',404);
  const targetItemId=args.target?.type==='staging' && args.target.itemId ? args.target.itemId : args.itemId;
  const targetRevision=args.target?.type==='staging' && args.target.expectedRevision ? args.target.expectedRevision : args.expectedRevision;
  const target=args.target?.type==='staging' || args.target?.action==='continue' ? undefined : args.target as ItemTarget|null|undefined;
  const [basis]=targetItemId===args.itemId ? [source] : await db<RevisionRow[]>`select r.* from proposal_revision r join proposal_item i on i.id=r.item_id
    where i.id=${targetItemId} and i.user_id=${args.userId} and r.revision=${targetRevision} and i.current_revision=r.revision`;
  if (!basis) throw new ProposalItemError('target_item_not_found',404);
  if (basis.record_type!==source.record_type && !(['project','followup'].includes(basis.record_type)&&['project','followup'].includes(source.record_type))) throw new ProposalItemError('incompatible_pending_item',422);
  const [owned]=await db<Array<{has_refs:boolean}>>`select twenty_refs<>'{}'::jsonb as has_refs from proposal_item where id=${basis.item_id}`;
  const createIndependent=(args.target?.type==='staging' && !args.target.itemId) ||
    (target===null && (basis.status==='confirmed' || owned?.has_refs===true));
  const result = await proposeRecords({ stagingId: args.stagingId, inboxId: args.inboxId, userId: args.userId, threadId: answerInbox.thread_id,
    records: [{ key: `answer:${targetItemId}`, ...(createIndependent ? {} : {itemId:targetItemId,expectedRevision:targetRevision}),
      recordType: basis.record_type, action: target===null ? 'create' : target ? (target.action ?? 'append') : undefined,
      companyCode: basis.company_code, target, fields: args.fields ?? {} }] }, tx);
  if (targetItemId!==args.itemId || createIndependent) {
    await db`update proposal_revision set status='superseded',updated_at=now() where item_id=${args.itemId} and revision=${args.expectedRevision}
      and status in ('ready','failed','withdrawn')`;
  }
  return result[0]!;
};

const validateRevisionTarget = async (target:ItemTarget,companyId:string,userId:string,revisionId:string,action:string) => {
  // A checked successful append may itself have closed the case. Recovery finalizes its receipt,
  // rather than requiring that already-applied operation to see an open case again.
  if (target.type==='supportCase') {
    const role=action==='update' ? 'support:update' : 'support:append';
    const [applied]=await sql<Array<{yes:boolean}>>`select exists(select 1 from item_operation
      where revision_id=${revisionId} and role=${role} and state='succeeded'
      and (input->>'targetId'=${target.id} or input->'target'->>'id'=${target.id})) as yes`;
    if (applied?.yes) {
      const record=await readTwentyRecord('supportCase',target.id);
      if (!record || record.deletedAt) throw new ProposalItemError('item_record_missing',409);
      if ((record.companyId??record.company?.id)!==companyId) throw new ProposalItemError('item_record_company_changed',409);
      return;
    }
  }
  await validateTargetBinding({...target,action:action==='update'?'update':'append'},companyId,userId);
};

export const queueProposalItems = async (stagingId: string, userId: string, selections: ItemSelection[], delayMs = env.confirmDelayMs) => {
  if (!Array.isArray(selections) || !selections.length || selections.length > 20 || new Set(selections.map((x) => x.itemId)).size !== selections.length) {
    throw new ProposalItemError('invalid_item_selection', 422);
  }
  const companies = await listCompanies();
  const items = await listProposalItems(stagingId);
  for (const selection of selections) {
    const it = items.find((x) => x.itemId === selection.itemId && x.revision === selection.revision);
    if (!it) throw new ProposalItemError('stale_item_revision');
    const companyId = selection.companyId ?? it.companyId;
    if (!companyId || !companies.some((c) => c.id === companyId)) throw new ProposalItemError('item_company_required', 422);
    const target = selection.supportCaseId ? { type: 'supportCase' as const, id: selection.supportCaseId, companyId, action: 'append' as const } : it.target;
    validateItemTarget(it.recordType,selection.supportCaseId ? 'append' : it.action,target);
    if (target) await validateRevisionTarget(target,companyId,userId,it.revisionId,selection.supportCaseId?'append':it.action);
  }
  const at = new Date(Date.now() + Math.max(0, delayMs));
  const queued = await sql.begin(async (tx) => {
    const result: Array<{ itemId: string; revision: number; commitAt: string }> = [];
    for (const selection of selections) {
      const [r] = await tx<Array<RevisionRow & { current_revision: number; committed_company: string|null; own_refs:Record<string,string> }>>`select r.*,i.current_revision,i.company_id as committed_company,i.twenty_refs as own_refs from proposal_revision r
        join proposal_item i on i.id=r.item_id join staging s on s.id=r.staging_id join inbox b on b.id=s.inbox_id
        where r.staging_id=${stagingId} and r.item_id=${selection.itemId} and r.revision=${selection.revision}
        and i.user_id=${userId} and b.user_id=${userId} and s.note_deleted_at is null and s.record_deleted_at is null for update of r,i,s`;
      if (!r || r.current_revision !== selection.revision || r.status === 'superseded') throw new ProposalItemError('stale_item_revision');
      if (r.status === 'unknown') throw new ProposalItemError('item_result_unknown');
      if (r.status === 'withdrawn') throw new ProposalItemError('item_withdrawn');
      if (['confirming','committing','confirmed'].includes(r.status)) {
        result.push({ itemId: r.item_id, revision: r.revision, commitAt: r.confirm_after ? new Date(r.confirm_after).toISOString() : at.toISOString() });
        continue;
      }
      const companyId = selection.companyId ?? r.company_id!;
      if (r.committed_company && r.committed_company!==companyId) throw new ProposalItemError('item_company_change_requires_new_item',422,
        '已入库事项不能静默更换客户；请明确新建另一事项并核对原事项。');
      const partialWrites = await hasPartialItemWrites(tx,r.item_id,r.id);
      const fieldEdits = selection.fields ? sanitizeItemFields(selection.fields, r.record_type) :
        partialWrites ? { ...(r.confirm_payload?.fields ?? {}) } : {};
      delete fieldEdits['recordType'];
      const target: ItemTarget | null = selection.supportCaseId ? { type: 'supportCase', id: selection.supportCaseId, companyId, action: 'append' } : r.target;
      validateOwnedItemTarget(r.own_refs ?? {},target,await itemLinks(tx,r.item_id));
      const payload = { companyId, fields: fieldEdits,
        ...(target?.type === 'supportCase' ? { supportCaseId: target.id } : {}), recommit: false };
      const action = selection.supportCaseId ? 'append' : r.action;
      if (partialWrites && (!r.confirm_payload ||
          hashItemOperationInput({companyId,fields:{...r.fields,...fieldEdits},target,action})!==
            hashItemOperationInput({companyId:r.confirm_payload.companyId,fields:{...r.fields,...r.confirm_payload.fields},target:r.target,action:r.action}))) {
        throw new ProposalItemError('partial_item_changes_require_reconciliation',422,
          '这一版已部分写入；恢复时必须保留原客户、目标和字段。请先恢复原版本，再创建更正版。');
      }
      await tx`update proposal_revision set status='confirming',confirm_after=${at},confirm_payload=${tx.json(payload as never)},
        confirm_by=${userId},company_id=${companyId},company_code=${companies.find((c) => c.id===companyId)?.code ?? null},
        target=${tx.json(target as never)},action=${action},error=null,updated_at=now() where id=${r.id}`;
      result.push({ itemId: r.item_id, revision: r.revision, commitAt: at.toISOString() });
    }
    return result;
  });
  await refreshProposalBatch(stagingId);
  return { items: queued, summary: summaryProposalItems(await listProposalItems(stagingId)) };
};

export const cancelProposalItem = async (itemId: string, userId: string, revision: number): Promise<boolean> => {
  const rows = await sql<Array<{ staging_id: string }>>`update proposal_revision r set status='ready',confirm_after=null,
    confirm_payload=case when exists(select 1 from item_operation o where o.revision_id=r.id
      and o.state in ('succeeded','running','unknown')) then r.confirm_payload else null end,
    confirm_by=null,updated_at=now() from proposal_item i
    where r.item_id=i.id and i.id=${itemId} and i.user_id=${userId} and r.revision=${revision} and i.current_revision=${revision}
    and r.status='confirming' and r.confirm_after>now() returning r.staging_id`;
  if (rows[0]) await refreshProposalBatch(rows[0].staging_id);
  return rows.length > 0;
};

export const withdrawProposalItem = async (itemId:string,userId:string,revision:number) => {
  const stagingId=await sql.begin(async(tx)=>{
    const [current]=await tx<RevisionRow[]>`select r.* from proposal_revision r join proposal_item i on i.id=r.item_id
      where i.id=${itemId} and i.user_id=${userId} and r.revision=${revision} and i.current_revision=r.revision for update of i,r`;
    if (!current) throw new ProposalItemError('item_not_found',404);
    if (!['ready','failed','confirming'].includes(current.status)) throw new ProposalItemError('item_not_withdrawable',409,
      '只能撤回尚未写入的事项；已入库事项的 CRM 记录须经过独立删除预览和核对。');
    if (await hasItemRemoteEffects(itemId,current.id,tx)) throw new ProposalItemError('partial_item_requires_recovery',409,
      '这一版已部分写入 CRM；请先核对并恢复原版本，再撤回后续草稿。');
    if (current.status==='confirming' && (!current.confirm_after || new Date(current.confirm_after).getTime()<=Date.now())) throw new ProposalItemError('item_already_due');
    await tx`update proposal_revision set status='withdrawn',confirm_after=null,confirm_payload=null,error=null,updated_at=now() where id=${current.id}`;
    await tx`update proposal_item set deleted_at=now(),deleted_refs='[]'::jsonb where id=${itemId}`;
    return current.staging_id;
  });
  await refreshProposalBatch(stagingId);
  return {withdrawn:true,deleted:[],failed:[],skipped:[]};
};

export const claimDueProposalItems = async (limit = 20): Promise<Array<{ id: string }>> => sql<Array<{ id: string }>>`
  update proposal_revision set status='committing',updated_at=now() where id in (
    select r.id from proposal_revision r join proposal_item i on i.id=r.item_id
    where r.status='confirming' and r.confirm_after<=now() and r.revision=i.current_revision
    order by r.confirm_after limit ${limit} for update of r skip locked
  ) returning id`;

/** Call under the gateway's exclusive writer lease, before admitting any new work. */
export const recoverInterruptedProposalItems = async () => {
  const operations=await markInterruptedItemOperationsUnknown();
  const rows=await sql<Array<{staging_id:string}>>`update proposal_revision set status='unknown',
    error='上次服务在写入途中停止；请核对已执行操作后再继续。',confirm_after=null,updated_at=now()
    where status='committing' returning staging_id`;
  for (const stagingId of new Set(rows.map((r)=>r.staging_id))) await refreshProposalBatch(stagingId);
  return {operations,items:rows.length};
};

export const refreshProposalBatch = async (stagingId: string, connection?:Tx):Promise<ReturnType<typeof summaryProposalItems>> => {
  if (!connection) return sql.begin((tx)=>refreshProposalBatch(stagingId,tx));
  const db=connection;
  // Serialize aggregate reads with their parent update, so a finishing sibling cannot overwrite
  // a newer all-confirmed aggregate with an earlier committing snapshot.
  await db`select id from staging where id=${stagingId} for update`;
  const items = await listProposalItems(stagingId,connection);
  const summary = summaryProposalItems(items);
  const status = summary.status === 'confirmed' ? 'confirmed' : summary.status === 'committing' ? 'committing' : summary.status === 'confirming' ? 'confirming' :
    summary.status==='withdrawn' || summary.status==='superseded' ? 'superseded' :
      (summary.unknown || summary.failed) && !summary.ready && !summary.confirming ? 'failed' : 'ready';
  const detail = `${summary.total} 项：${summary.confirmed} 已入库、${summary.ready} 待核、${summary.unknown} 结果待核、${summary.failed} 失败、${summary.withdrawn} 已撤回`;
  await db`update staging set status=${status},partial=${summary.partial},twenty_refs=null,
    error=${summary.unknown || summary.failed || summary.partial ? detail : null},confirm_after=null where id=${stagingId}`;
  return summary;
};

export type ItemCommitSubject = {
  id: string; inbox_id: string; extracted: Record<string, unknown>;
  confirm_payload: { companyId: string; fields?: Record<string, unknown>; supportCaseId?: string; recommit?: boolean };
  confirm_by: string; twenty_refs: Record<string, string>; replaces: null;
  itemId: string; revision: number; stagingId: string; action: string; target: ItemTarget | null;
  previousFields: Record<string, unknown> | null; createdRecords: Array<{ object: string; id: string; name: string }>;
};
export const loadItemCommitSubject = async (revisionId: string): Promise<ItemCommitSubject> => {
  const [r] = await sql<Array<RevisionRow & { inbox_id: string; own_refs: Record<string, string>; own_created: Array<{ object: string; id: string; name: string }>; current_revision: number; committed_company:string|null }>>`
    select r.*,s.inbox_id,i.twenty_refs as own_refs,i.created_records as own_created,i.current_revision,i.company_id as committed_company
    from proposal_revision r join proposal_item i on i.id=r.item_id join staging s on s.id=r.staging_id where r.id=${revisionId}`;
  if (!r?.confirm_payload?.companyId || !r.confirm_by || r.status !== 'committing' || r.revision !== r.current_revision) throw new ProposalItemError('item_not_claimed');
  if (r.committed_company && r.committed_company!==r.confirm_payload.companyId) throw new ProposalItemError('item_company_change_requires_new_item',422);
  validateOwnedItemTarget(r.own_refs ?? {},r.target,await itemLinks(sql,r.item_id));
  if (r.target) {
    await validateRevisionTarget(r.target,r.confirm_payload.companyId,r.confirm_by,r.id,r.action);
    await recordItemLink(r.item_id,{object:r.target.type,id:r.target.id},false);
  }
  const ownedTypes:Record<string,TwentyRecordType>={visitId:'visit',projectId:'project',productFitmentId:'productFitment',opportunityId:'opportunity',projectDocId:'projectDoc'};
  for (const [key,type] of Object.entries(ownedTypes)) {
    const id=r.own_refs?.[key];
    if (!id) continue;
    const record=await readTwentyRecord(type,id);
    if (!record || record.deletedAt) throw new ProposalItemError('item_record_missing',409);
    if ((record.companyId??record.company?.id)!==r.confirm_payload.companyId) throw new ProposalItemError('item_record_company_changed',409);
  }
  let ownSupportCaseStatus: string | null = null;
  if (r.own_refs?.supportCaseId) {
    const record=await readTwentyRecord('supportCase',r.own_refs.supportCaseId);
    if (!record || record.deletedAt) throw new ProposalItemError('item_record_missing',409);
    if ((record.companyId??record.company?.id)!==r.confirm_payload.companyId) throw new ProposalItemError('item_record_company_changed',409);
    ownSupportCaseStatus=String(record.caseStatus).toUpperCase();
    const newStatus=String(r.confirm_payload.fields?.['caseStatus']??r.fields['caseStatus']??'');
    if (['CLOSED','RESOLVED'].includes(ownSupportCaseStatus) && newStatus!==ownSupportCaseStatus) throw new ProposalItemError('target_closed',409);
  }
  const [prior] = await sql<Array<{ fields: Record<string, unknown>; confirm_payload: { fields?: Record<string, unknown> } | null }>>`
    select fields,confirm_payload from proposal_revision where item_id=${r.item_id} and revision<${r.revision} and status='confirmed'
    order by revision desc limit 1`;
  const prevFields = prior ? { ...prior.fields, ...(prior.confirm_payload?.fields ?? {}) } : null;
  const currentFields={...r.fields,...r.confirm_payload.fields};
  if (ownSupportCaseStatus && ['CLOSED','RESOLVED'].includes(ownSupportCaseStatus) && prevFields &&
      (prevFields['details']!==currentFields['details'] || prevFields['summary']!==currentFields['summary'])) {
    const [applied]=await sql<Array<{yes:boolean}>>`select exists(select 1 from item_operation
      where revision_id=${r.id} and role='support:correction' and state='succeeded'
      and (input->>'targetId'=${r.own_refs.supportCaseId!} or input->'target'->>'id'=${r.own_refs.supportCaseId!})) as yes`;
    if (!applied?.yes) throw new ProposalItemError('target_closed',409,
      '售后问题已结束，不能追加更正正文；请先核对原事项状态。');
  }
  const refs = r.own_refs ?? {};
  return { id: r.id, inbox_id: r.inbox_id, extracted: r.fields,
    confirm_payload: { ...r.confirm_payload, recommit: Object.keys(refs).length > 0 }, confirm_by: r.confirm_by,
    twenty_refs: refs, replaces: null, itemId: r.item_id, revision: r.revision, stagingId: r.staging_id,
    action: r.action, target: r.target, previousFields: prevFields, createdRecords: r.own_created ?? [] };
};

export const recordItemLink = async (itemId: string, record: { object: string; id: string; name?: string }, createdHere: boolean) => {
  await sql`insert into item_record_link(item_id,object_type,record_id,created_here,name)
    values(${itemId},${record.object},${record.id},${createdHere},${record.name ?? null})
    on conflict(item_id,object_type,record_id) do update set created_here=item_record_link.created_here or excluded.created_here`;
};

export const persistItemCommit = async (subject: ItemCommitSubject, refs: Record<string, string>, created: Array<{ object: string; id: string; name: string }>) => {
  const known = new Map(subject.createdRecords.map((r) => [`${r.object}:${r.id}`, r]));
  for (const r of created) known.set(`${r.object}:${r.id}`, r);
  await sql.begin(async (tx) => {
    const [identity] = await tx`select id from proposal_item where id=${subject.itemId} and current_revision=${subject.revision} for update`;
    if (!identity) throw new ProposalItemError('stale_item_revision');
    await tx`update proposal_item set twenty_refs=${tx.json(refs)},created_records=${tx.json([...known.values()] as never)},
      company_id=${subject.confirm_payload.companyId} where id=${subject.itemId}`;
    await tx`update proposal_revision set status='confirmed',twenty_refs=${tx.json(refs)},created_records=${tx.json([...known.values()] as never)},
      confirm_after=null,error=null,updated_at=now() where id=${subject.id}`;
  });
  for (const r of known.values()) await recordItemLink(subject.itemId, r, true);
  for (const [key, object] of [['supportCaseId','supportCase'],['projectId','project'],['opportunityId','opportunity']] as const) {
    if (refs[key]) await recordItemLink(subject.itemId, { object, id: refs[key]! }, known.has(`${object}:${refs[key]}`));
  }
  await refreshProposalBatch(subject.stagingId);
};

export const failProposalItemCommit = async (revisionId: string, error: string, unknown: boolean) => {
  const [r] = await sql<Array<{ staging_id: string }>>`update proposal_revision set status=${unknown ? 'unknown' : 'failed'},
    error=${error.slice(0,500)},confirm_after=null,updated_at=now() where id=${revisionId} returning staging_id`;
  if (r) await refreshProposalBatch(r.staging_id);
};

/** Reconciliation never assumes an HTTP timeout proves that the remote write did not happen. */
export const recoverProposalItem = async (itemId: string, userId: string, revision: number): Promise<boolean> => {
  const rows = await sql<Array<{ staging_id: string }>>`update proposal_revision r set status='ready',error=null,updated_at=now()
    from proposal_item i where r.item_id=i.id and i.id=${itemId} and i.user_id=${userId} and r.revision=${revision}
    and i.current_revision=${revision} and r.status='unknown'
    and not exists(select 1 from item_operation o where o.revision_id=r.id and o.state in ('running','unknown')) returning r.staging_id`;
  if (rows[0]) await refreshProposalBatch(rows[0].staging_id);
  return rows.length > 0;
};

/** Shared CRM records are excluded from destructive ownership operations. */
export const itemDeletionPlan = async (itemId: string, userId: string): Promise<{ refs: RecordRef[]; skipped: Array<{ what: string; why: string }> }> => {
  const [identity] = await sql<Array<{ created_records: RecordRef[] }>>`select created_records from proposal_item where id=${itemId} and user_id=${userId}`;
  if (!identity) throw new ProposalItemError('item_not_found', 404);
  const refs: RecordRef[] = []; const skipped: Array<{ what: string; why: string }> = [];
  for (const r of identity.created_records) {
    const shared = await sql`select 1 from item_record_link l join proposal_item i on i.id=l.item_id
      where l.object_type=${r.object} and l.record_id=${r.id} and l.item_id<>${itemId} and i.deleted_at is null limit 1`;
    if (shared.length) skipped.push({ what: r.name ?? r.object, why: '此记录也被其他事项引用，不能随本事项删除' });
    else refs.push(r);
  }
  return { refs, skipped };
};

export const reconcileItemOperationResult = async (object: 'visit'|'supportCase'|'productFitment'|'project'|'workItem'|'projectDoc', id: string, companyId: string) => {
  if (object === 'supportCase' || object === 'project' || object === 'workItem') {
    const record = await readTwentyRecord(object, id);
    if (!record) throw new ProposalItemError('reconciliation_record_not_found', 404);
    if (record.companyId && record.companyId !== companyId) throw new ProposalItemError('reconciliation_company_mismatch', 422);
    return id;
  }
  throw new ProposalItemError('reconciliation_requires_read_adapter', 422);
};
