import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { canonicalBusinessValue, isUuid, questionAnswerText } from '../../../shared/agent-questions.mjs';
import type { QuestionAction, QuestionAnswerResult, QuestionOption, QuestionSnapshot, TargetBinding, TargetCandidate } from '../../../shared/agent-questions.mjs';
import { sql } from './db.ts';
import { ingestNote, type IngestConnection } from './ingest.ts';
import { validateTargetBinding } from './targetCandidates.ts';
import { reviseProposalItemFromAnswer } from './proposal-items.ts';

type QuestionContext = {
  stagingId: string; inboxId: string; threadId: string | null; userId: string;
  companies: Array<{ id: string; code: string }>;
  questions: QuestionSnapshot[]; targetCandidates?: Map<string, TargetCandidate>;
  itemId?: string; revisionId?: string;
  proposedItems?: Array<{ itemId: string; revisionId: string; revision?: number; companyId: string | null }>;
};
export type AgentQuestionInput = {
  question: string; options?: string[];
  targetOptions?: Array<{ label: string; candidateHandle?: string; action?: QuestionAction }>;
  recommendedIndex?: number; itemId?: string;
};

export class QuestionError extends Error {
  status: number;
  code: string;
  constructor(code: string, status: number, message: string) { super(message); this.code = code; this.status = status; }
}

export const proposalFingerprint = (fields: Record<string, unknown> | null, companyId: string | null = null): string => {
  const business = Object.fromEntries(Object.entries(fields ?? {}).filter(([key]) =>
    !['corrections', 'companySuggestion', 'agentSkipped', 'answeredQuestionId', 'answerToQuestion'].includes(key)));
  return createHash('sha256').update(JSON.stringify(canonicalBusinessValue({ companyId, fields: business }))).digest('hex');
};

/** Option identity and records come from trusted reads, never from model-produced UUID fields. */
export const createAgentQuestion = (ctx: QuestionContext, input: AgentQuestionInput): QuestionSnapshot => {
  const question = String(input.question ?? '').trim().slice(0, 1000);
  if (!question) throw new QuestionError('question_required', 422, '问题不能为空。');
  if (ctx.questions.length) throw new QuestionError('one_question_per_turn', 409, '一轮最多问一个问题。');
  const choices = input.targetOptions?.slice(0, 8).map((option) => {
    const label = String(option.label ?? '').trim().slice(0, 300);
    if (!label) throw new QuestionError('option_required', 422, '选项不能为空。');
    if (!option.candidateHandle) {
      if (!['create', 'clarify'].includes(option.action ?? '')) throw new QuestionError('candidate_required', 422, '关联选项必须引用已检索候选。');
      return { optionId: randomUUID(), label, action: option.action as QuestionAction };
    }
    const candidate = ctx.targetCandidates?.get(option.candidateHandle);
    if (!candidate) throw new QuestionError('unknown_candidate', 422, '候选不在本轮已检索白名单，请先查记录。');
    if (option.action && option.action !== candidate.target.action) throw new QuestionError('target_action_mismatch', 422, '选项动作与目标对象不符。');
    return { optionId: randomUUID(), label, action: candidate.target.action, target: { ...candidate.target } };
  }) ?? input.options?.slice(0, 8).map((label) => ({ optionId: randomUUID(), label: String(label).slice(0, 300), action: 'clarify' as const }));
  const companyIds = new Set(choices?.flatMap((choice) => 'target' in choice && choice.target ? [choice.target.companyId] : []));
  if (companyIds.size > 1) throw new QuestionError('mixed_company_options', 422, '一次目标确认只能针对一家客户的一个事项。');
  const requestedItemId = input.itemId ?? ctx.itemId;
  const item = requestedItemId ? ctx.proposedItems?.find((entry) => entry.itemId === requestedItemId)
    : ctx.proposedItems?.length === 1 ? ctx.proposedItems[0] : undefined;
  if (ctx.proposedItems?.length && requestedItemId && !item) throw new QuestionError('question_item_invalid', 422, 'itemId不属于本轮提案，请读取已提交的事项身份。');
  if (!requestedItemId && (ctx.proposedItems?.length ?? 0) > 1) throw new QuestionError('question_item_required', 422, '多个独立事项的提问必须传itemId，不能猜第一项。');
  if (item && companyIds.size && item.companyId !== [...companyIds][0]) throw new QuestionError('target_company_mismatch', 422, '候选客户与所问事项不一致。');
  const snapshot: QuestionSnapshot = {
    questionId: randomUUID(), question, kind: companyIds.size ? 'target' : 'clarify',
    options: input.options, choices,
    ...(input.recommendedIndex !== undefined && choices?.[input.recommendedIndex] ? { recommendedOptionId: choices[input.recommendedIndex]!.optionId } : {}),
    stagingId: ctx.stagingId, ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
    ...(item?.itemId ?? requestedItemId ? { itemId: item?.itemId ?? requestedItemId } : {}),
    ...(item?.revisionId ?? ctx.revisionId ? { revisionId: item?.revisionId ?? ctx.revisionId } : {}),
    companyId: companyIds.size ? [...companyIds][0]! : null,
  };
  ctx.questions.push(snapshot);
  return snapshot;
};

/** Match whole identifiers so PRJ-12 cannot accidentally bind a reference to PRJ-123. */
export const containsExplicitTargetIdentifier = (text: string, target: Pick<TargetBinding, 'id' | 'code'>): boolean => {
  const original = text.toUpperCase();
  return [target.code, target.id].filter((key): key is string => !!key).some((key) => {
    const literal = [...key.toUpperCase().replace(/\s+/g, '')].map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
    return !!literal && new RegExp(`(^|[^A-Z0-9-])${literal}(?![A-Z0-9-])`).test(original);
  });
};

/** Explicit identifiers may prefill a proposal; "the most recent one" is not an explicit identifier. */
export const resolveExplicitCandidate = async (ctx: QuestionContext, handle: string, companyCode?: string): Promise<TargetBinding> => {
  const candidate = ctx.targetCandidates?.get(handle);
  if (!candidate) throw new QuestionError('unknown_candidate', 422, '先检索目标，再引用候选句柄。');
  const [row] = await sql<Array<{ text: string | null; edited_text: string | null; transcript: string | null; extracted: any }>>`
    select i.text, s.edited_text, s.transcript, s.extracted from staging s join inbox i on i.id = s.inbox_id
    where s.id = ${ctx.stagingId} and s.inbox_id=${ctx.inboxId} and i.user_id = ${ctx.userId}
      and s.note_deleted_at is null and s.record_deleted_at is null`;
  if (!row) throw new QuestionError('question_source_invalid', 404, '原记录已经不可用。');
  const original = String(row.edited_text ?? (row.text?.trim() ? row.text : row.transcript) ?? '');
  if (!containsExplicitTargetIdentifier(original, candidate.target)) throw new QuestionError('target_not_explicit', 422, '原话没有明确指定这个编号，请用 ask_user 推荐确认。');
  const company = ctx.companies.find((entry) => entry.code === (companyCode ?? row.extracted?.companyCode));
  if (!company || company.id !== candidate.target.companyId) throw new QuestionError('target_company_mismatch', 422, '目标与提案客户不一致。');
  await validateTargetBinding(candidate.target, company.id, ctx.userId);
  return { ...candidate.target };
};

export const bindExplicitCandidate = async (ctx: QuestionContext, handle: string): Promise<TargetBinding> => {
  const target = await resolveExplicitCandidate(ctx, handle);
  await sql`update staging set extracted = extracted || ${sql.json({ targetBinding: target } as never)} where id = ${ctx.stagingId}`;
  return target;
};

type SourceProposal = { fields: any; companyId: string | null; target?: TargetBinding | null; itemId?: string; revisionId?: string; revision?: number; fingerprint: string };
const sourceProposal = async (connection: IngestConnection, question: QuestionSnapshot, userId: string, lock = false): Promise<SourceProposal> => {
  if (question.itemId) {
    const rows = await connection.unsafe<Array<{ fields: any; company_id: string | null; id: string; revision: number; target: TargetBinding | null; status: string }>>(
      `select r.fields, r.company_id, r.id, r.revision,r.target,r.status from proposal_item p join proposal_revision r on r.item_id=p.id and r.revision=p.current_revision
       join staging s on s.id=r.staging_id
       where p.id=$1 and p.user_id=$2 and p.deleted_at is null and s.note_deleted_at is null and s.record_deleted_at is null ${lock ? 'for update of p,r,s' : ''}`, [question.itemId, userId]);
    const row = rows[0];
    if (!row || !['ready','failed'].includes(row.status)) throw new QuestionError('question_stale', 409, '原事项已经不可用，请重新核对。');
    return { fields: row.fields, companyId: row.company_id, target: row.target, itemId: question.itemId, revisionId: row.id, revision: row.revision, fingerprint: proposalFingerprint(row.fields, row.company_id) };
  }
  const rows = await connection.unsafe<Array<{ extracted: any; resolved_company_id: string | null; status: string; note_deleted_at: Date | null; record_deleted_at: Date | null }>>(
    `select s.extracted, s.resolved_company_id, s.status,s.note_deleted_at,s.record_deleted_at from staging s join inbox i on i.id=s.inbox_id
     where s.id=$1 and i.user_id=$2 ${lock ? 'for update of s' : ''}`, [question.stagingId!, userId]);
  const row = rows[0];
  if (!row || row.note_deleted_at || row.record_deleted_at || !['ready', 'failed', 'extracting'].includes(row.status)) throw new QuestionError('question_stale', 409, '这版提案已被取代、删除或提交，请重新核对。');
  return { fields: row.extracted, companyId: row.resolved_company_id, fingerprint: proposalFingerprint(row.extracted, row.resolved_company_id) };
};

export const persistAgentQuestions = async (ctx: QuestionContext, sourceMessageId: string, connection: IngestConnection = sql): Promise<QuestionSnapshot[]> => {
  if (!ctx.threadId || !ctx.questions.length) return [];
  const [message] = await connection<Array<{ id: string }>>`
    select m.id from thread_message m join thread t on t.id=m.thread_id
    where m.id=${sourceMessageId} and m.thread_id=${ctx.threadId} and t.user_id=${ctx.userId}
      and m.inbox_id=${ctx.inboxId} and m.role='agent'`;
  if (!message) throw new QuestionError('question_source_invalid', 422, '问题来源消息必须属于当前录入人的对话。');
  const durable: QuestionSnapshot[] = [];
  for (const draft of ctx.questions) {
    // Resolve one-item calls automatically; multiple-item calls must identify the specific item.
    const revisions = await connection.unsafe<Array<{ item_id: string; id: string }>>(
      `select r.item_id,r.id from proposal_revision r join proposal_item p on p.id=r.item_id
       where r.staging_id=$1 and p.user_id=$2 and r.revision=p.current_revision`, [ctx.stagingId, ctx.userId]);
    const match = draft.itemId ? revisions.find((row) => row.item_id === draft.itemId) : revisions.length === 1 ? revisions[0] : undefined;
    if (draft.itemId && !match) throw new QuestionError('question_item_invalid', 422, '问题事项不属于本次提案。');
    if (!draft.itemId && revisions.length > 1) throw new QuestionError('question_item_required', 422, '多事项提问必须指定 itemId，不能猜第一项。');
    const candidate = { ...draft, ...(match ? { itemId: match.item_id, revisionId: match.id } : {}) };
    const source = await sourceProposal(connection, candidate, ctx.userId);
    const company = source.companyId ?? ctx.companies.find((entry) => entry.code === source.fields?.companyCode)?.id ?? null;
    if (draft.companyId && draft.companyId !== company) throw new QuestionError('target_company_mismatch', 422, '问题候选与来源事项客户不一致。');
    const snapshot: QuestionSnapshot = {
      ...candidate, threadId: ctx.threadId, sourceMessageId, stagingId: ctx.stagingId,
      companyId: company, proposalFingerprint: source.fingerprint,
      expectedRevision: source.revisionId ?? source.fingerprint, status: 'pending',
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    };
    await connection`insert into agent_question (id,user_id,thread_id,staging_id,source_message_id,item_id,revision_id,proposal_fingerprint,snapshot,expires_at)
      values (${snapshot.questionId},${ctx.userId},${ctx.threadId},${ctx.stagingId},${sourceMessageId},${snapshot.itemId ?? null},${snapshot.revisionId ?? null},${source.fingerprint},${connection.json(snapshot as never)},${snapshot.expiresAt!})
      on conflict(id) do nothing`;
    durable.push(snapshot);
  }
  return durable;
};

export const hydrateQuestionsForThread = async <T extends { meta?: any }>(threadId: string, userId: string, messages: T[]): Promise<T[]> => {
  const rows = await sql<Array<{ id: string; snapshot: QuestionSnapshot; expires_at: Date; option_id: string | null; answered_at: Date | null }>>`
    select q.id,q.snapshot,q.expires_at,a.option_id,a.created_at as answered_at
    from agent_question q left join agent_question_answer a on a.question_id=q.id
    where q.thread_id=${threadId} and q.user_id=${userId}`;
  const snapshots = new Map<string, QuestionSnapshot>();
  for (const row of rows) {
    let status: QuestionSnapshot['status'] = row.answered_at ? 'answered' : row.expires_at.getTime() <= Date.now() ? 'expired' : 'pending';
    if (status === 'pending') {
      try {
        const current = await sourceProposal(sql, row.snapshot, userId);
        if (current.fingerprint !== row.snapshot.proposalFingerprint || (row.snapshot.revisionId && row.snapshot.revisionId !== current.revisionId)) status = 'stale';
      } catch (error) { if (error instanceof QuestionError) status = 'stale'; else throw error; }
    }
    snapshots.set(row.id, { ...row.snapshot, status, selectedOptionId: row.option_id, answeredAt: row.answered_at?.toISOString() ?? null });
  }
  return messages.map((message) => ({ ...message, meta: { ...message.meta, questions: (message.meta?.questions ?? []).map((question: QuestionSnapshot) => snapshots.get(question.questionId) ?? question) } }));
};

const answerResult = (row: any, question: QuestionSnapshot, duplicate: boolean): QuestionAnswerResult => ({
  duplicate, inboxId: row.inbox_id, stagingId: row.staging_id, threadId: question.threadId!,
  newMessageId: row.new_message_id ?? null, questionId: question.questionId,
  selectedOptionId: row.option_id ?? null, target: row.target ?? null, requiresAgent: row.requires_agent,
});

/** Free text can refer to this specific question; never guess a question from a thread's latest row. */
export const resolveQuestionOption = (question: QuestionSnapshot, optionId?: string, text?: string): QuestionOption | undefined => {
  if (optionId) return question.choices?.find((choice) => choice.optionId === optionId);
  const value = String(text ?? '').trim().replace(/[。.!！?？]$/, '').toLocaleLowerCase();
  const exact = question.choices?.filter((choice) => choice.label.trim().toLocaleLowerCase() === value) ?? [];
  if (exact.length === 1) return exact[0];
  const ordinal = value.match(/^(?:第)?([1-8一二三四五六七八])(?:个|项|条)?$/) ?? value.match(/^(?:option|choice)\s+([1-8])$/);
  if (ordinal) {
    const n = /^\d$/.test(ordinal[1]!) ? Number(ordinal[1]) : '一二三四五六七八'.indexOf(ordinal[1]!) + 1;
    return question.choices?.[n - 1];
  }
  if (['就这个','推荐的','选推荐项','就是这条','是','yes','recommended','this one'].includes(value) && question.recommendedOptionId) {
    return question.choices?.find((choice) => choice.optionId === question.recommendedOptionId);
  }
  return undefined;
};

export const answerQuestion = async (input: {
  questionId: string; threadId: string; userId: string; clientId: string;
  optionId?: string; text?: string; expectedRevision: string;
}): Promise<QuestionAnswerResult> => {
  if (![input.questionId, input.threadId, input.userId, input.clientId].every(isUuid) || !input.expectedRevision) {
    throw new QuestionError('bad_question_answer', 422, '答案必须包含有效的问题、客户端标识和版本。');
  }
  return sql.begin(async (tx) => {
    // Serialize both same-client replay and answers on the same question, across gateway processes.
    await tx`select pg_advisory_xact_lock(hashtext(${`question-answer:${input.clientId}`}))`;
    const [stored] = await tx<Array<{ snapshot: QuestionSnapshot; expires_at: Date }>>`
      select q.snapshot,q.expires_at from agent_question q join thread t on t.id=q.thread_id
      where q.id=${input.questionId} and q.thread_id=${input.threadId} and q.user_id=${input.userId}
        and t.user_id=${input.userId} and t.deleted_at is null for update of q`;
    if (!stored) throw new QuestionError('question_not_found', 404, '问题不存在或不属于这条对话。');
    const question = stored.snapshot;
    const selected = resolveQuestionOption(question, input.optionId, input.text);
    const selectedOptionId = selected?.optionId ?? null;
    const [duplicate] = await tx`select * from agent_question_answer where client_id=${input.clientId}`;
    if (duplicate) {
      if (duplicate.user_id !== input.userId || duplicate.question_id !== input.questionId || (duplicate.option_id ?? null) !== selectedOptionId || duplicate.text !== questionAnswerText(question, selectedOptionId ?? undefined, input.text)) {
        throw new QuestionError('answer_client_conflict', 409, '这次答案的客户端标识已被另一答案使用。');
      }
      return answerResult(duplicate, question, true);
    }
    const [answered] = await tx`select id from agent_question_answer where question_id=${input.questionId}`;
    if (answered) throw new QuestionError('question_answered', 409, '这道问题已在另一页面或设备回答，请刷新后核对。');
    if (stored.expires_at.getTime() <= Date.now()) throw new QuestionError('question_expired', 409, '问题已过期，请重新核对目标。');
    const source = await sourceProposal(tx, question, input.userId, true);
    if (input.expectedRevision !== question.expectedRevision || source.fingerprint !== question.proposalFingerprint || (question.revisionId && source.revisionId !== question.revisionId)) {
      throw new QuestionError('question_stale', 409, '提案已修改，旧答案不能应用到新版本。');
    }
    if (input.optionId && !selected) throw new QuestionError('unknown_option', 422, '选项不属于这道问题。');
    const text = questionAnswerText(question, selectedOptionId ?? undefined, input.text);
    if (!text) throw new QuestionError('answer_required', 422, '请选一项或补充说明。');
    if (text.length > 20_000) throw new QuestionError('answer_too_long', 422, '补充说明太长，请分开记录；原文仍保存在本机。');
    const target = selected?.target ?? (selected?.action === 'create' ? null : source.target ?? source.fields?.targetBinding ?? null);
    if (target) await validateTargetBinding(target, question.companyId!, input.userId, tx);
    // A foreign or already-used inbox clientId must not be silently treated as this answer.
    const [used] = await tx`select id from inbox where client_id=${input.clientId}`;
    if (used) throw new QuestionError('answer_client_conflict', 409, '客户端标识已用于另一条原文。');
    const note = await ingestNote({ userId: input.userId, clientId: input.clientId, text,
      companyCode: source.fields?.companyCode ?? null, visitLabel: null, deviceCreatedAt: null,
      threadId: input.threadId, toAgent: true, source: 'followup' }, tx);
    const requiresAgent = !selected || selected.action === 'clarify';
    let fields = { ...source.fields, answeredQuestionId: question.questionId, answerToQuestion: { stagingId: question.stagingId, itemId: question.itemId, revisionId: question.revisionId } };
    if (target?.type === 'staging' && !target.itemId) {
      const [basis] = await tx<Array<{ extracted: any; status: string }>>`
        select s.extracted,s.status from staging s join inbox i on i.id=s.inbox_id
        where s.id=${target.id} and i.user_id=${input.userId} for update of s`;
      if (!basis || !['ready','failed'].includes(basis.status)) throw new QuestionError('target_changed', 409, '待确认目标已变化。');
      const sourceType = fields.recordType ?? 'fitment';
      const basisType = basis.extracted?.recordType ?? 'fitment';
      if (sourceType !== basisType && !(['project','followup'].includes(sourceType) && ['project','followup'].includes(basisType))) {
        throw new QuestionError('target_type_mismatch', 422, '这份待确认草稿属于另一种事项，不能把售后接到项目上。');
      }
      fields = { ...basis.extracted, ...fields, details: [...new Set([basis.extracted?.details, fields.details].filter(Boolean))].join('\n\n') };
      // The old draft is consumed in this transaction; committing must use its CRM binding, if any,
      // rather than validating a staging row that has intentionally become superseded.
      if (basis.extracted?.targetBinding && basis.extracted.targetBinding.type !== 'staging') fields.targetBinding = basis.extracted.targetBinding;
      else delete fields.targetBinding;
      await tx`update staging set status='superseded',superseded_by=${note.stagingId} where id=${target.id}`;
    }
    if (target?.type === 'staging' && target.itemId) {
      const [basis] = await tx<Array<{ fields: any; record_type: string; company_id: string | null; status: string }>>`
        select r.fields,r.record_type,r.company_id,r.status from proposal_item p
        join proposal_revision r on r.item_id=p.id and r.revision=p.current_revision join staging s on s.id=r.staging_id
        where p.id=${target.itemId} and p.user_id=${input.userId} and r.id=${target.revisionId!}
          and r.revision=${target.expectedRevision!} and p.deleted_at is null
          and s.note_deleted_at is null and s.record_deleted_at is null for update of p,r,s`;
      if (!basis || basis.company_id !== question.companyId || !['ready','failed'].includes(basis.status)) throw new QuestionError('target_changed', 409, '待确认事项已修改。');
      const sourceType = fields.recordType ?? 'fitment';
      if (sourceType !== basis.record_type && !(['project','followup'].includes(sourceType) && ['project','followup'].includes(basis.record_type))) throw new QuestionError('target_type_mismatch', 422, '目标属于另一种业务事项。');
      fields = { ...basis.fields, ...fields, details: [...new Set([basis.fields?.details, fields.details].filter(Boolean))].join('\n\n') };
    }
    if (target && target.type !== 'staging') fields.targetBinding = target;
    else if (target?.itemId) delete fields.targetBinding;
    else if (selected?.action === 'create') {
      delete fields.targetBinding;
      delete fields.projectCode;
      delete fields.supportCaseId;
      if (fields.project) fields.project = { ...fields.project, projectCode: '' };
      if (fields.workItems) fields.workItems = fields.workItems.map((item: any) => { const { itemCode: _code, ...fresh } = item; return fresh; });
    }
    if (target?.type === 'project') fields.project = { ...(fields.project ?? {}), projectCode: target.code, name: fields.project?.name ?? selected?.label };
    if (target?.type === 'workItem') {
      const matching = fields.workItems?.find((item: any) => item.itemCode === target.code);
      if (!matching && fields.workItems?.length > 1) throw new QuestionError('work_item_scope_ambiguous', 409, '这份提案有多个任务，请先明确这次只跟进哪一项。');
      const item = matching ?? fields.workItems?.[0] ?? { body: fields.details };
      fields.workItems = [{ ...item, itemCode: target.code, title: item.title ?? selected?.label }];
    }
    await tx`update staging set extracted=${tx.json(fields as never)}, resolved_company_id=${question.companyId ?? null},
      status=${requiresAgent ? 'pending' : 'ready'} where id=${note.stagingId}`;
    const revisionItemId = question.itemId ?? target?.itemId;
    if (revisionItemId) {
      await reviseProposalItemFromAnswer({ itemId: revisionItemId, expectedRevision: source.revision ?? target!.expectedRevision!, stagingId: note.stagingId,
        inboxId: note.inboxId, userId: input.userId, target: selected?.action === 'create' ? null : target ?? undefined, fields }, tx);
    }
    if (!question.itemId) {
      await tx`update staging set status='superseded',superseded_by=${note.stagingId}
        where id=${question.stagingId!} and status in ('ready','failed')`;
    }
    if (!requiresAgent) {
      const [user] = await tx<Array<{ locale: string }>>`select locale from app_user where id=${input.userId}`;
      const message = user?.locale === 'en'
        ? selected?.action === 'create' ? 'New item selected. Review the proposal before confirming.' : `Selected “${selected?.label}”. The target is filled in; review the proposal before confirming.`
        : selected?.action === 'create' ? '已选择新建。核对提案后再确认入库。' : `已选择「${selected?.label}」。目标已填好，核对提案后再确认入库。`;
      await tx`insert into thread_message(thread_id,role,text,inbox_id,meta)
        values(${input.threadId},'agent',${message},${note.inboxId},${tx.json({ stagingId: note.stagingId, answeredQuestionId: question.questionId } as never)})`;
    }
    const [answer] = await tx`insert into agent_question_answer(question_id,client_id,user_id,inbox_id,staging_id,option_id,text,target,requires_agent)
      values(${input.questionId},${input.clientId},${input.userId},${note.inboxId},${note.stagingId},${selectedOptionId},${text},${target ? tx.json(target as never) : null},${requiresAgent}) returning *`;
    return answerResult({ ...answer, new_message_id: note.newMessageId }, question, false);
  });
};

/** loop uses this to continue the question's exact source, rather than thread's latest proposal. */
export const answeredQuestionForInbox = async (inboxId: string, connection: IngestConnection = sql) => {
  const [row] = await connection`select q.snapshot,a.target from agent_question_answer a join agent_question q on q.id=a.question_id where a.inbox_id=${inboxId}`;
  return row ? { question: row.snapshot as QuestionSnapshot, target: row.target as TargetBinding | null } : null;
};

export type QuestionTransaction = postgres.TransactionSql;
