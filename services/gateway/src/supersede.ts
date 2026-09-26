/**
 * ══════════════════════════════════════════════════════════════════
 *  改口重发：这一句会盖掉哪几轮，其中哪几轮**已经进了 CRM**（issue #37 · D108）
 *
 *  这个文件只回答一个问题，而且要在**两个地方**给出同一个答案：
 *    · 人按发送之前（预览卡：「会改写下面这几条记录」）
 *    · 真的发出去那一刻（`POST /inbox` 的 supersede 分支）
 *
 *  🔴 **两处必须共用一份判断** —— 这条判据 D93 已经写过一次
 *  （`deletion.ts` 的文件头）：分两份实现的话，总有一天对话框说的
 *  和实际做的不是一回事，而这种不一致人只有在事后才发现得了。
 *
 *  ── 为什么「已入库的那几轮」要单独拎出来 ──────────────────────────
 *
 *  改口本来只让**还没入库**的提案退场（`status in ('ready','failed')`，
 *  issue #14 定的边界）。已入库的那些原来一个都不碰 —— 于是这一轮照常
 *  新建一份，CRM 里两版并存。#37 就是这么发生的。
 *
 *  现在改成：**最近那一条已入库的，把记录的所有权交给这一轮**（见 migration 014）。
 *  交接的意向记在改口那一刻，所有权真正转移是在提交成功那一刻。
 * ══════════════════════════════════════════════════════════════════ */
import { sql } from './db.ts';

/** 一轮已经入库的提案 —— 它现在还拥有 CRM 里那几条记录。 */
export type CommittedRound = {
  stagingId: string;
  /** 它入库时定下的客户。改口那一轮如果认成了别家，就不能原地更新（见 migration 014）。 */
  companyId: string | null;
  refs: Record<string, unknown> | null;
  createdRecords: unknown;
  /** 谁先谁后 —— 只继承最近的那一条。 */
  updatedAt: string;
};

export type SupersedeScope = {
  /** 被盖掉的消息（含它之后 agent 的回应）。 */
  messageIds: string[];
  /** 这些消息对应的 inbox id（没有的那些是 agent 回复）。 */
  inboxIds: string[];
  /** 其中**已经入库**的那几轮，按时间倒序 —— `[0]` 就是要交接的那一条。 */
  committed: CommittedRound[];
};

/**
 * 「改这条消息，会盖掉哪些东西」。
 *
 * 作用域在**服务端**裁（§4.2 第4条）：只能改自己这条对话里、自己说的那句话。
 * 拿不到目标消息就返回 `null` —— 调用方据此回 4xx 或如实说「没取代成」。
 *
 * ⚠️ `excludeMessageId` 是新插的那一条自己（发送时才有；预览时没有）。
 */
export const scopeOf = async (
  /** 被改的那条消息（人在界面上点「编辑」的那一条）。 */
  targetMessageId: string,
  threadId: string,
  userId: string,
  excludeMessageId?: string | null,
): Promise<SupersedeScope | null> => {
  const [target] = await sql<Array<{ id: string; created_at: string }>>`
    select m.id, m.created_at from thread_message m
    join thread t on t.id = m.thread_id
    where m.id = ${targetMessageId} and m.thread_id = ${threadId}
      and t.user_id = ${userId} and m.role = 'user'`;
  if (!target) return null;

  // 被改的那条 + 它之后的全部（含 agent 的回应）。新插的那条自己排除在外。
  const stale = await sql<Array<{ id: string; inbox_id: string | null }>>`
    select id, inbox_id from thread_message
    where thread_id = ${threadId} and created_at >= ${target.created_at}
      and id <> ${excludeMessageId ?? '00000000-0000-0000-0000-000000000000'}`;

  const inboxIds = stale.map((m) => m.inbox_id).filter((x): x is string => Boolean(x));
  const committed = inboxIds.length
    ? await sql<CommittedRound[]>`
        select id as "stagingId",
               confirm_payload->>'companyId' as "companyId",
               twenty_refs as refs,
               created_records as "createdRecords",
               updated_at as "updatedAt"
        from staging
        where inbox_id = any(${inboxIds}) and status = 'confirmed'
        order by updated_at desc`
    : [];

  return { messageIds: stale.map((m) => m.id), inboxIds, committed };
};

/**
 * 交接给这一轮的那一条 —— **最近的那一版已入库的**。
 *
 * ⚠️ 其余的一个字不动，由调用方如实报出来（`otherCommitted`）：
 *    update-in-place 只能对着一套记录做，而「另外还有 N 版在 CRM 里」
 *    这件事人必须看得见。
 */
export const ownerOf = (scope: SupersedeScope): CommittedRound | null => scope.committed[0] ?? null;

/** 落进 `staging.replaces` 的那一份（结构见 migration 014 的文件头）。 */
export const inheritance = (owner: CommittedRound) => ({
  stagingId: owner.stagingId,
  companyId: owner.companyId,
  refs: owner.refs ?? {},
  createdRecords: Array.isArray(owner.createdRecords) ? owner.createdRecords : [],
  at: new Date().toISOString(),
});

/** `staging.replaces` 读回来的形状。 */
export type Inheritance = ReturnType<typeof inheritance>;

/** 这一份继承里到底有几条真记录（`workItems` 那种计数不算）。 */
export const inheritedCount = (inh: Inheritance | null): number =>
  Array.isArray(inh?.createdRecords) ? inh!.createdRecords.length : 0;
