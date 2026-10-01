/**
 * ══════════════════════════════════════════════════════════════════
 *  钉钉里的「一条」（D146）：`#N` · 最新一版 · 线程锁 · 待回答问题 · 汇报素材
 *
 *  人说的「那一条」= 一条 thread（`thread.ref_no`，跨版本不变）；
 *  它的「现在」= 这条 thread 里**最新的、没被取代的**那一版 staging。
 *
 *  出站（outbound.ts）、命令（followup.ts）、撤回页（act.ts）都从这里取同一份答案 ——
 *  「这一条现在是什么状态」只有一个实现。
 * ══════════════════════════════════════════════════════════════════ */
import { sql } from '../db.ts';
import { env } from '../env.ts';
import { listCompanies, findOpportunity, findProjectByCode, findWorkItemByCode } from '../twenty.ts';
import { commitGate, type GateResult } from './commitGate.ts';
import { ANSWER_WINDOW_MS, CORRECTION_WINDOW_MS } from './routing.ts';
import { diffOf, planOf, type Lookups, type ReportView } from './report.ts';

/** 待回答问题的有效期（D146，维护者 2026-10-01 定 30 分钟 —— 和 routing.ts 的回答窗口同一个数）。 */
export const QUESTION_TTL_MS = ANSWER_WINDOW_MS;

/**
 * 同一条 thread 上「接上一句修改」和「给某一版排自动入库」必须串行（D143）。
 *
 * 不串行的话：出站刚判完「V1 是最新一版」、还没排队，这时一句修改接上来出了 V2 ——
 * V1 照样排上、60 秒后入库，V2 出来时 V1 已经不是 ready，loop 不继承也不交接 →
 * CRM 里第二份（#37 的形状）。
 *
 * **进程内的互斥，不是数据库锁**：一个库上本来就只能有一个网关（CLAUDE.md 判据，
 * 两个网关的心跳会抢同一批 staging）。数据库 advisory lock 要占住一个连接等锁，
 * 而锁里的查询走的是全局连接池 —— 10 个并发等锁就能把池子坐满、自己卡死自己。
 * 进程内的 Promise 链等锁时一个连接都不占。
 */
const threadLocks = new Map<string, Promise<unknown>>();
export const withThreadLock = async <T,>(threadId: string, fn: () => Promise<T>): Promise<T> => {
  const prev = threadLocks.get(threadId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  threadLocks.set(threadId, tail);
  try {
    return await run;
  } finally {
    if (threadLocks.get(threadId) === tail) threadLocks.delete(threadId);
  }
};

/** 给 thread 发一个 `#N`（只在第一次汇报时发，之后不变）。 */
export const ensureRefNo = async (threadId: string): Promise<number> => {
  const [r] = await sql<Array<{ ref_no: string }>>`
    update thread set ref_no = nextval('thread_ref_no_seq')
    where id = ${threadId} and ref_no is null
    returning ref_no::text`;
  if (r) return Number(r.ref_no);
  const [t] = await sql<Array<{ ref_no: string }>>`select ref_no::text from thread where id = ${threadId}`;
  return Number(t!.ref_no);
};

export type Version = {
  id: string;
  inbox_id: string;
  status: string;
  partial: boolean;
  error: string | null;
  extracted: Record<string, unknown>;
  /** 每一格的把握度 —— 存在 `staging.confidence` 这一列，**不在** extracted 里（write.ts）。 */
  confidence: Record<string, unknown> | null;
  suggested_company: string | null;
  confirm_after: Date | null;
  withdrawn_at: Date | null;
  replaces: { stagingId?: string } | null;
  created_at: Date;
  user_id: string;
};

/**
 * 「这一版还在跑」：pending / transcribing / extracting，**以及失败了但 loop 还会自动重试的**
 * （临时故障 2s/4s/8s 重试，上限 3 次 —— 和出站「failed 要等终局」是同一条判据）。
 * 漏掉后者的话，重试那一轮会和人的更正同时跑，后跑完的那一轮把前一版取代掉。
 */
export const isRunning = (r: { status: string; attempts?: number; updated_at?: Date }): boolean =>
  ['pending', 'transcribing', 'extracting'].includes(r.status) ||
  (r.status === 'failed' &&
    (r.attempts ?? 0) < 3 &&
    Boolean(r.updated_at) &&
    Date.now() - r.updated_at!.getTime() < 20_000);

/**
 * 这条 thread 现在的样子：最新一版（不含被取代的、看板上删掉的），以及有没有一版还在跑。
 * ⚠️ **速记删掉（note_deleted_at）的不排除** —— 那只是 PWA 速记页上不显示了，
 *    CRM 里的记录还在、所有权还在它手上；排除它的话 #N 改它会在 CRM 里新建第二份。
 */
export const latestOf = async (
  threadId: string,
): Promise<{ latest: Version | null; busy: boolean }> => {
  const rows = await sql<Array<Version & { attempts: number; updated_at: Date }>>`
    select s.id, s.inbox_id, s.status, s.partial, s.error, s.extracted, s.confidence, s.suggested_company,
           s.confirm_after, s.withdrawn_at, s.replaces, s.created_at, i.user_id, s.attempts, s.updated_at
    from staging s join inbox i on i.id = s.inbox_id
    where s.thread_id = ${threadId} and s.status <> 'superseded' and s.record_deleted_at is null
    order by s.created_at desc limit 5`;
  return { latest: rows[0] ?? null, busy: rows.some(isRunning) };
};

export const threadByRef = async (refNo: number): Promise<{ id: string; user_id: string } | null> => {
  const [t] = await sql<Array<{ id: string; user_id: string }>>`
    select id, user_id from thread where ref_no = ${refNo} and deleted_at is null`;
  return t ?? null;
};

// ── 待回答问题（一条 thread 一个；恰好一个时才直接当回答）──────────

export type OpenQuestion = { threadId: string; stagingId: string; question: string; refNo: number | null };

/** 这个人在这个群里没过期的待回答问题（新的在前）。 */
export const openQuestionsOf = async (conversationKey: string, userId: string): Promise<OpenQuestion[]> => {
  const rows = await sql<Array<{ thread_id: string; staging_id: string; question: string; ref_no: string | null }>>`
    select q.thread_id, q.staging_id, q.question, t.ref_no::text as ref_no
    from channel_open_question q join thread t on t.id = q.thread_id
    where q.channel = 'dingtalk' and q.conversation_key = ${conversationKey}
      and q.app_user_id = ${userId} and q.expires_at > now() and t.deleted_at is null
    order by q.asked_at desc`;
  return rows.map((q) => ({
    threadId: q.thread_id,
    stagingId: q.staging_id,
    question: q.question,
    refNo: q.ref_no ? Number(q.ref_no) : null,
  }));
};

/** bot 就某一条问了一个问题（同一条再问就覆盖它自己那一个）。 */
export const askOpenQuestion = async (
  conversationKey: string,
  userId: string,
  threadId: string,
  stagingId: string,
  question: string,
) => {
  await sql`
    insert into channel_open_question
      (channel, conversation_key, app_user_id, thread_id, staging_id, question, asked_at, expires_at)
    values ('dingtalk', ${conversationKey}, ${userId}, ${threadId}, ${stagingId}, ${question}, now(),
            ${new Date(Date.now() + QUESTION_TTL_MS)})
    on conflict (channel, conversation_key, app_user_id, thread_id) do update set
      staging_id = excluded.staging_id, question = excluded.question,
      asked_at = excluded.asked_at, expires_at = excluded.expires_at`;
};

/** 这一条的问题答过了（或这一条被接上了一句话）—— 只清这一条的，别的条照旧等。 */
export const clearOpenQuestion = async (conversationKey: string, userId: string, threadId: string) => {
  await sql`
    delete from channel_open_question
    where channel = 'dingtalk' and conversation_key = ${conversationKey}
      and app_user_id = ${userId} and thread_id = ${threadId}`;
};

/** 「更正 …」接到哪条上：本人在这个群里 2 小时内最近的那一条。 */
export const recentItemOf = async (
  conversationKey: string,
  userId: string,
  withinMs = CORRECTION_WINDOW_MS,
): Promise<{ threadId: string; refNo: number | null } | null> => {
  const [r] = await sql<Array<{ tid: string; ref_no: string | null }>>`
    select i.thread_id as tid, t.ref_no::text as ref_no
    from channel_event e
    join inbox i on i.id = e.inbox_id
    join thread t on t.id = i.thread_id
    where e.channel = 'dingtalk' and e.conversation_key = ${conversationKey}
      and e.app_user_id = ${userId} and e.kind = 'message' and i.thread_id is not null
      and t.deleted_at is null
      and e.created_at > ${new Date(Date.now() - withinMs)}
    order by e.created_at desc limit 1`;
  return r ? { threadId: r.tid, refNo: r.ref_no ? Number(r.ref_no) : null } : null;
};

// ── 汇报素材 ─────────────────────────────────────────────────────

const twentyLookups: Lookups = {
  findOpportunity: (companyId, category) => findOpportunity(companyId, category),
  findProjectByCode: (code) => findProjectByCode(code),
  findWorkItemByCode: (code) => findWorkItemByCode(code),
};

export type ReportBase = Omit<ReportView, 'state' | 'sender'> & {
  gate: GateResult;
  companyId: string | null;
  threadId: string;
};

/**
 * 一版的汇报素材（状态那一格由调用方定：倒计时 / 未入库 / 失败）。
 *
 * 客户名单查不到这个代号时按「客户没对上」处理 —— 代号是 agent 交的，
 * 名单是 Twenty 的，两边对不上就不能入库（D28），而不是拿一个对不上的代号去写。
 */
export const reportBaseOf = async (v: Version, threadId: string, look: Lookups = twentyLookups): Promise<ReportBase> => {
  const x = v.extracted ?? {};
  const refNo = await ensureRefNo(threadId);
  const [cnt] = await sql<Array<{ n: number }>>`
    select count(*)::int as n from staging
    where thread_id = ${threadId} and created_at <= ${v.created_at}`;

  // 上一版：被这一版取代的那条；没有就是交接来的那条已入库版（D108）
  const [prev] = await sql<Array<{ extracted: any; fields: any }>>`
    select extracted, confirm_payload->'fields' as fields from staging
    where superseded_by = ${v.id}
       or id = ${(v.replaces?.stagingId as string | undefined) ?? '00000000-0000-0000-0000-000000000000'}
    order by created_at desc limit 1`;
  const prevX = prev ? { ...(prev.extracted ?? {}), ...(prev.fields ?? {}) } : null;

  const code = String(x['companyCode'] ?? '').trim();
  /**
   * 🔴 名单读不到（Twenty 一时不可达）**要抛**，不能吞成空名单 ——
   * 吞掉的话这一条会被当成「客户代号不在名单里」硬挡、汇报账键当场用掉、之后再也不重报。
   * 抛出去：出站这一跳不记账，退避后重来。
   */
  const companies = code ? await listCompanies() : [];
  const company = code ? companies.find((c) => c.code === code) ?? null : null;

  const gate = commitGate({
    status: v.status,
    partial: v.partial,
    extracted: x,
    confidence: v.confidence ?? {},
    suggestedCompany: v.suggested_company,
  });
  if (code && !company) {
    gate.hard.push(`客户代号 ${code} 在名单里查不到`);
    gate.auto = false;
  }

  /**
   * D108 + 客户变了：`commitToTwenty` 不会原地更新，而是**软删上一版写入的那几条、按新客户重建**。
   * 60 秒后自动做这件事太重了 —— 挡成 soft，要人说「入库 #N」，汇报里逐条列出会被软删的。
   */
  const inherited = (v.replaces ?? null) as { stagingId?: string; companyId?: string | null; refs?: Record<string, unknown>; createdRecords?: unknown[] } | null;
  const movedCompany = Boolean(inherited?.companyId && company && inherited.companyId !== company.id);
  if (movedCompany) {
    const was = companies.find((c) => c.id === inherited!.companyId)?.name ?? '上一版的客户';
    const n = Array.isArray(inherited!.createdRecords) ? inherited!.createdRecords.length : 0;
    gate.soft.push(`客户由 ${was} 改成了 ${company!.name}：上一版写入的 ${n} 条会软删（可恢复）并按新客户重建`);
    gate.auto = false;
  }

  const [msg] = await sql<Array<{ meta: any }>>`
    select meta from thread_message
    where inbox_id = ${v.inbox_id} and role = 'agent'
    order by created_at desc limit 1`;
  const questions = ((msg?.meta?.questions ?? []) as Array<{ question?: string }>)
    .map((q) => String(q?.question ?? '').trim())
    .filter(Boolean);

  const plan = await planOf(
    x,
    {
      companyId: company?.id ?? null,
      companyName: company?.name ?? null,
      // 和 commitToTwenty 同一条：客户变了就退回 create 模式（上一版的那几条被软删）
      prevRefs: inherited?.stagingId && !movedCompany ? ((inherited.refs ?? {}) as Record<string, unknown>) : null,
      softDeleted: movedCompany && Array.isArray(inherited?.createdRecords) ? inherited!.createdRecords!.length : 0,
    },
    look,
  );

  return {
    refNo,
    version: cnt?.n ?? 1,
    extracted: x,
    companyLabel: company ? `${company.name}（${company.code}）` : null,
    suggestedCompany: v.suggested_company,
    diff: diffOf(prevX, x),
    plan,
    warn: gate.warn,
    questions,
    gate,
    companyId: company?.id ?? null,
    threadId,
    redo: Boolean(inherited?.stagingId),
  };
};

/** 倒计时的秒数（`0` = 自动入库关着）。 */
export const autoSeconds = (): number => env.dingtalkAutoCommitSeconds;
