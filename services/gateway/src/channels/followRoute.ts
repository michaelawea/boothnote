/**
 * ══════════════════════════════════════════════════════════════════
 *  二轮对话的执行半边（D146）：命令 · 接到某一条上 · 接不上就先存下
 *
 *  「接在哪条上」的判断在 followup.ts（纯函数）；这里只管照着做，而且做得**可停**：
 *  任何一步拿不准（上一句还在整理、正在写入、别人的 #N），都是
 *  **原话先存进 inbox（不进 agent 队列）+ 如实说一句** —— 绝不猜着接上去。
 *  原话存下来是因为情报不可再生（§4.2 第 2 条）；不进队列是因为它还没被允许改任何东西。
 * ══════════════════════════════════════════════════════════════════ */
import { randomUUID } from 'node:crypto';

import { sql } from '../db.ts';
import { env } from '../env.ts';
import { ingestNote, saveBlob } from '../ingest.ts';
import { armAutoCommit, cancelConfirm, queueAutoCommit } from '../confirm.ts';
import { inheritance } from '../supersede.ts';
import { listCompanies } from '../twenty.ts';
import { enqueue } from '../../agent/src/index.ts';
import { RECORD_TYPE_LABELS } from '../../agent/src/enums.ts';
import type { ChannelEvent } from './payload.ts';
import { md, type DingMessage } from './render.ts';
import { askFor, renderReport, type ReportState } from './report.ts';
import { commitGate } from './commitGate.ts';
import { issueWithdrawLink } from './act.ts';
import {
  askOpenQuestion,
  autoSeconds,
  clearOpenQuestion,
  latestOf,
  reportBaseOf,
  threadByRef,
  withThreadLock,
} from './items.ts';
import type { Command } from './followup.ts';

/** 钉钉图片落成附件。返回存下了几张（下载失败的不影响文字部分）。 */
export const downloadImages = async (inboxId: string, images: string[]): Promise<number> => {
  let saved = 0;
  for (const url of images.slice(0, 5)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > env.attachmentInlineMaxBytes) continue;
      const mime = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0]!.trim();
      const ext = mime.includes('png') ? 'png' : mime.includes('gif') ? 'gif' : 'jpg';
      const rel = await saveBlob(buf, `dingtalk.${ext}`);
      await sql`
        insert into attachment (inbox_id, kind, filename, mime, bytes, path)
        values (${inboxId}, 'image', ${`dingtalk.${ext}`}, ${mime}, ${buf.length}, ${rel})`;
      saved++;
    } catch (e) {
      console.warn(`  ⚠️ 钉钉图片没下载成（${String(e).slice(0, 80)}）—— 这条速记照常处理`);
    }
  }
  return saved;
};

/** 图片下载完**再**进 agent 队列 —— 先 enqueue 的话 agent 开跑时附件还没落库。 */
export const downloadImagesThenEnqueue = async (inboxId: string, images: string[]) => {
  await downloadImages(inboxId, images);
  enqueue(inboxId);
};

export type Reply = { kind: 'final' | 'ack'; ding: DingMessage; noteId: string | null };

const logEvent = async (
  kind: string,
  ev: ChannelEvent,
  eventKey: string,
  userId: string,
  inboxId: string | null,
  raw: unknown,
) => {
  await sql`
    insert into channel_event (channel, event_key, kind, conversation_key, sender, app_user_id, inbox_id, raw)
    values ('dingtalk', ${eventKey}, ${kind}, ${ev.conversationKey}, ${ev.sender}, ${userId}, ${inboxId},
            ${raw ? sql.json(raw as never) : null})
    on conflict (channel, event_key) do nothing`;
};

/**
 * 接不上：原话存进 inbox（`toAgent:false` → 没有 thread → 不进 agent 队列，
 * `resumePending` 也不会捡它，D31 那条判据），记一笔 park，如实回一句。
 * 图片也落成附件（不进队列）—— 「原话已保存」要对图片同样成立；原始报文进 park 事件。
 */
export const park = async (ev: ChannelEvent, userId: string, clientId: string, why: string): Promise<Reply> => {
  const r = await ingestNote({
    userId,
    clientId,
    text: ev.text,
    companyCode: null,
    visitLabel: null,
    deviceCreatedAt: ev.sentAt,
    threadId: null,
    toAgent: false,
    source: 'dingtalk',
    files: [],
  });
  // 同一句被并发重放：第一份已经处理了（接上了 / 存下了）—— 别再回一句「未处理」吓人
  if (r.duplicate) {
    return { kind: 'final', ding: md('这条我已经收过了，不再重复处理。', ev.sender), noteId: r.inboxId };
  }
  await logEvent('park', ev, `park:${clientId}`, userId, r.inboxId, { why, raw: ev.raw });
  const imgs = ev.images.length ? await downloadImages(r.inboxId, ev.images) : 0;
  const imgNote = ev.images.length
    ? imgs === ev.images.length
      ? `（含 ${imgs} 张图）`
      : `（图片 ${ev.images.length} 张里存下了 ${imgs} 张）`
    : '';
  return { kind: 'final', ding: md(`**未处理**：${why}\n原话已保存${imgNote}，不会丢。`, ev.sender), noteId: r.inboxId };
};

/**
 * 把这句话接到某一条（thread）上：出新一版、进 agent 队列。
 *
 * 线程锁里判「那一条现在是什么样子」（items.ts withThreadLock 的注释）：
 *   倒计时中   → 先取消排队（`cancelConfirm` 原子：和心跳认领抢同一行，只有一边赢）
 *   已入库     → 新一版带 `replaces`（D108）→ 入库时原地更新，不出第二份
 *   未入库     → 照常；上一版若自己带着 `replaces`（交接还没完成）就**往后传**
 *   还在整理 / 正在写入 → 接不上，先存下
 */
export const attach = async (
  ev: ChannelEvent,
  userId: string,
  clientId: string,
  target: { threadId: string; refNo: number | null },
  via: string,
): Promise<Reply> => {
  const [t] = await sql<Array<{ user_id: string; ref_no: string | null }>>`
    select user_id, ref_no::text from thread where id = ${target.threadId} and deleted_at is null`;
  if (!t) return park(ev, userId, clientId, '找不到要改的那一条（可能已删除）。');
  const ref = t.ref_no ?? String(target.refNo ?? '?');
  // D76：任何渠道都不给改别人的开口子
  if (t.user_id !== userId) return park(ev, userId, clientId, `#${ref} 不是你录的，只有录入人本人能改。`);

  const outcome = await withThreadLock(target.threadId, async () => {
    const { latest, busy } = await latestOf(target.threadId);
    if (busy) return { block: `#${ref} 上一句还在整理，汇报出来后再改。` };
    let cancelled = false;
    let replaces: unknown = null;
    if (latest) {
      if (latest.status === 'committing') return { block: `#${ref} 正在写入 CRM，几秒后再改。` };
      if (latest.status === 'confirming') {
        if (!(await cancelConfirm(latest.id))) return { block: `#${ref} 正在写入 CRM，几秒后再改。` };
        cancelled = true;
      }
      if (latest.status === 'confirmed') {
        const [own] = await sql<Array<{ company_id: string | null; refs: any; created: any; updated_at: string }>>`
          select confirm_payload->>'companyId' as company_id, twenty_refs as refs,
                 created_records as created, updated_at
          from staging where id = ${latest.id}`;
        replaces = inheritance({
          stagingId: latest.id,
          companyId: own?.company_id ?? null,
          refs: own?.refs ?? {},
          createdRecords: own?.created ?? [],
          updatedAt: own?.updated_at ?? '',
        });
      } else if (latest.replaces?.stagingId) {
        replaces = latest.replaces; // 交接还没完成 —— 往后传，否则多轮修改后所有权断在半路
      }
    }
    const r = await ingestNote({
      userId,
      clientId,
      text: ev.text,
      companyCode: null,
      visitLabel: null,
      deviceCreatedAt: ev.sentAt,
      threadId: target.threadId,
      toAgent: true,
      source: 'dingtalk',
      files: [],
    });
    if (!r.duplicate && replaces) {
      await sql`update staging set replaces = ${sql.json(replaces as never)} where id = ${r.stagingId}`;
    }
    return { r, cancelled, committed: latest?.status === 'confirmed' };
  });

  if ('block' in outcome) return park(ev, userId, clientId, outcome.block!);
  const { r, cancelled, committed } = outcome;
  if (r.duplicate) {
    return { kind: 'final', ding: md('这条我已经收过了，不再重复记录。', ev.sender), noteId: r.inboxId };
  }
  await logEvent('message', ev, `msg:${clientId}`, userId, r.inboxId, ev.raw);
  await logEvent('follow', ev, `follow:${clientId}`, userId, r.inboxId, { threadId: target.threadId, refNo: ref, via });
  await clearOpenQuestion(ev.conversationKey, userId, target.threadId);
  if (ev.images.length) void downloadImagesThenEnqueue(r.inboxId, ev.images);
  else enqueue(r.inboxId);
  const notes = [
    cancelled && '上一版的入库倒计时已取消。',
    committed && `#${ref} 已在 CRM 里，这次修改入库时原地更新那几条记录。`,
  ].filter(Boolean);
  return {
    kind: 'ack',
    ding: md(`**已接收** · 转给速记（修改 #${ref}）\n整理完会重新汇报。${notes.length ? `\n${notes.join('\n')}` : ''}`, ev.sender),
    noteId: r.inboxId,
  };
};

/** #N → 那条 thread，并核对是不是本人的。 */
const ownThread = async (
  refNo: number,
  userId: string,
): Promise<{ id: string } | { error: string }> => {
  const t = await threadByRef(refNo);
  if (!t) return { error: `没有 #${refNo} 这一条。` };
  if (t.user_id !== userId) return { error: `#${refNo} 不是你录的，只有录入人本人能操作。` };
  return { id: t.id };
};

export const attachByRef = async (
  ev: ChannelEvent,
  userId: string,
  clientId: string,
  refNo: number,
): Promise<Reply> => {
  const t = await threadByRef(refNo);
  if (!t) return park(ev, userId, clientId, `没有 #${refNo} 这一条。`);
  return attach(ev, userId, clientId, { threadId: t.id, refNo }, 'ref');
};

// ── 命令 ─────────────────────────────────────────────────────────

const HINT =
  '**撤回**：点汇报第 2 行的「撤回」链接（只在入库前的倒计时内有效）。\n' +
  '**按原样入库**：@我「入库 #编号」。\n' +
  '**重看某一条**：@我「#编号」。\n' +
  '**看我还没入库的**：@我「待办」。';

/**
 * 一条 thread 现在的状态，给「待办」和「#N」用。
 * `redo`（这一版接管的是已入库的那一版）时措辞是「本次修改未入库」——
 * 说整条「未入库」是假话，CRM 里上一版好好地在着。
 */
const describe = async (threadId: string) => {
  const { latest, busy } = await latestOf(threadId);
  if (!latest) return null;
  const gate = commitGate({
    status: latest.status,
    partial: latest.partial,
    extracted: latest.extracted ?? {},
    confidence: latest.confidence ?? {},
    suggestedCompany: latest.suggested_company,
  });
  const redo = Boolean((latest.replaces as { stagingId?: string } | null)?.stagingId);
  const not = redo ? '本次修改未入库（CRM 里仍是上一版）' : '未入库';
  const state = busy
    ? '整理中'
    : latest.status === 'confirmed'
      ? '已入库'
      : latest.status === 'committing'
        ? '正在写入'
        : latest.status === 'confirming'
          ? '待入库（倒计时中）'
          : latest.status === 'failed'
            ? `${not}（处理失败）`
            : latest.withdrawn_at
              ? `${not}（已撤回）`
              : `${not}${[...gate.hard, ...gate.soft].length ? `（${[...gate.hard, ...gate.soft].join('；')}）` : ''}`;
  return { latest, busy, gate, state };
};

export const runCommand = async (
  command: Command,
  ev: ChannelEvent,
  userId: string,
  clientId: string,
  renderHelp: (sender: string) => DingMessage,
): Promise<Reply> => {
  const final = (text: string): Reply => ({ kind: 'final', ding: md(text, ev.sender), noteId: null });
  // 同一条命令被流程重放：只执行一次（「入库 #N」执行两次的话，第二次会回一句让人困惑的「状态刚变了」）
  const [fresh] = await sql<Array<{ id: string }>>`
    insert into channel_event (channel, event_key, kind, conversation_key, sender, app_user_id, raw)
    values ('dingtalk', ${`cmd:${clientId}`}, 'command', ${ev.conversationKey}, ${ev.sender}, ${userId},
            ${sql.json({ command } as never)})
    on conflict (channel, event_key) do nothing
    returning id`;
  if (!fresh) return final('这条命令我已经处理过了。');

  if (command.cmd === 'help') return { kind: 'final', ding: renderHelp(ev.sender), noteId: null };
  if (command.cmd === 'hint') return final(HINT);

  if (command.cmd === 'todo') {
    const threads = await sql<Array<{ tid: string; ref_no: string | null }>>`
      select distinct on (i.thread_id) i.thread_id as tid, t.ref_no::text as ref_no
      from channel_event e
      join inbox i on i.id = e.inbox_id
      join thread t on t.id = i.thread_id
      where e.channel = 'dingtalk' and e.conversation_key = ${ev.conversationKey}
        and e.app_user_id = ${userId} and e.kind = 'message' and t.deleted_at is null
        and t.ref_no is not null and e.created_at > now() - interval '7 days'
      order by i.thread_id, e.created_at desc`;
    const companies = await listCompanies().catch(() => []);
    const lines: string[] = [];
    for (const th of threads) {
      const d = await describe(th.tid);
      if (!d || d.latest.status === 'confirmed') continue;
      const x = d.latest.extracted ?? {};
      const code = String(x['companyCode'] ?? '');
      const company = companies.find((c) => c.code === code)?.name ?? (code || '客户未对上');
      const type = RECORD_TYPE_LABELS[String(x['recordType'] ?? 'fitment')] ?? '速记';
      lines.push(`- #${th.ref_no} ${type} · ${company} · ${d.state}`);
    }
    const [cnt] = await sql<Array<{ n: number }>>`
      select count(*)::int as n from channel_event e
      join staging s on s.inbox_id = e.inbox_id
      where e.channel = 'dingtalk' and e.kind = 'park' and e.conversation_key = ${ev.conversationKey}
        and e.app_user_id = ${userId} and s.thread_id is null and s.note_deleted_at is null
        and e.created_at > now() - interval '7 days'`;
    const n = cnt?.n ?? 0;
    if (!lines.length && !n) return final('**待办**：没有未入库的条目。');
    return final(
      `**待办**（近 7 天，未入库）\n${lines.slice(0, 15).join('\n')}` +
        (lines.length > 15 ? `\n- 另有 ${lines.length - 15} 条未列出` : '') +
        (n ? `\n另有 ${n} 句话没接上任何一条（原话已保存，PWA 速记页里看得到）。` : ''),
    );
  }

  // resend / force：都要先找到本人的那一条
  const own = await ownThread(command.refNo, userId);
  if ('error' in own) return final(`**未处理**：${own.error}`);
  const d = await describe(own.id);
  if (!d) return final(`**未处理**：#${command.refNo} 里没有可用的内容。`);
  if (d.busy) return final(`#${command.refNo} 还在整理，汇报出来后再试。`);
  const v = d.latest;

  if (v.status === 'confirmed') {
    return final(`#### #${command.refNo} · 已入库\n**状态**：已写入 CRM。要改：@我 #${command.refNo} + 修改内容。`);
  }
  if (v.status === 'committing') return final(`#${command.refNo} 正在写入 CRM。`);

  let base;
  try {
    base = await reportBaseOf(v, own.id);
  } catch {
    return final(`**未处理**：CRM 暂时连不上（读不到客户名单），稍后再试。`);
  }
  const now = Date.now();
  const [q] = await sql<Array<{ queue_id: string | null }>>`
    select confirm_payload->>'queueId' as queue_id from staging where id = ${v.id}`;

  if (command.cmd === 'resend') {
    let state: ReportState;
    const left = v.confirm_after ? v.confirm_after.getTime() - now : 0;
    if (v.status === 'confirming' && left > 12 * 60 * 60_000) {
      state = { kind: 'not_queued', why: '汇报正在发出，倒计时还没开始 —— 几秒后再 @我「#' + command.refNo + '」' };
    } else if (v.status === 'confirming' && left > 0 && q?.queue_id) {
      const url = await issueWithdrawLink(v.id, userId, q.queue_id, new Date(v.confirm_after!.getTime() + 10 * 60_000));
      state = { kind: 'countdown', seconds: Math.ceil(left / 1000), withdrawUrl: url };
    } else if (v.status === 'failed') {
      state = { kind: 'failed', error: v.error ?? '处理失败' };
    } else {
      state = v.withdrawn_at
        ? { kind: 'not_queued', why: `已撤回。按原样入库：@我「入库 #${command.refNo}」` }
        : base.gate.auto
          ? { kind: 'not_queued', why: `还没排入库：@我「入库 #${command.refNo}」` }
          : { kind: 'held', hard: base.gate.hard, soft: base.gate.soft };
      const ask = askFor(base.questions, base.gate);
      if (ask) await askOpenQuestion(ev.conversationKey, userId, own.id, v.id, ask);
    }
    return { kind: 'final', ding: renderReport({ ...base, sender: ev.sender, state }), noteId: null };
  }

  // ── 入库 #N：人说「就按现在这样入库」——只越得过 soft，越不过 hard（D144）
  if (v.status === 'confirming') {
    return final(`#${command.refNo} 已经在入库倒计时里。`);
  }
  if (base.gate.hard.length || v.status === 'failed') {
    const why = v.status === 'failed' ? ['这一条没处理成'] : base.gate.hard;
    return final(`**未入库**：#${command.refNo} 不能入库 —— ${why.join('；')}。\n先 @我 补一句（带上 #${command.refNo}）。`);
  }
  const queueId = randomUUID();
  const queued = await withThreadLock(own.id, async () => {
    const { latest, busy } = await latestOf(own.id);
    if (busy || !latest || latest.id !== v.id) return null;
    return queueAutoCommit(v.id, userId, { companyId: base.companyId!, queueId }, true);
  });
  if (!queued) return final(`**未入库**：#${command.refNo} 的状态刚变了，@我「#${command.refNo}」看最新的。`);
  // 「入库 #N」的回复就是这次同步响应本身（流程原样发回群里）—— 撤回链接先签好，再开始倒计时
  const secs = autoSeconds() || 10;
  const url = await issueWithdrawLink(v.id, userId, queueId, new Date(now + (secs + 600) * 1000));
  const at = await armAutoCommit(v.id, queueId, secs);
  if (!at) return final(`**未入库**：#${command.refNo} 的状态刚变了，@我「#${command.refNo}」看最新的。`);
  await logEvent('queued', ev, `queued:${v.id}:${at.getTime()}`, userId, v.inbox_id, { stagingId: v.id, at, force: true, queueId });
  await clearOpenQuestion(ev.conversationKey, userId, own.id);
  return {
    kind: 'final',
    ding: renderReport({ ...base, sender: ev.sender, state: { kind: 'countdown', seconds: secs, withdrawUrl: url } }),
    noteId: null,
  };
};
