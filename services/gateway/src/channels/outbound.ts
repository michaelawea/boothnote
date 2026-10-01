import { randomUUID } from 'node:crypto';

import { env } from '../env.ts';
import { sql } from '../db.ts';
import { armAutoCommit, disarmAutoCommit, queueAutoCommit } from '../confirm.ts';
import { outboundBody, type DingMessage } from './render.ts';
import { askFor, renderNotice, renderReport, type ReportState } from './report.ts';
import { issueWithdrawLink } from './act.ts';
import { askOpenQuestion, autoSeconds, latestOf, reportBaseOf, withThreadLock, type Version } from './items.ts';
import { labelOf } from '../deletion.ts';

/**
 * 出站腿（docs/dingtalk-channel.md §3 · D143–D145）。
 *
 * 一跳做三件事：
 *   ① **汇报**：agent 跑完（ready / 终局 failed）→ 过确信度门槛（D144）→
 *      过了：排 60 秒自动入库 + 发「待入库」汇报（第 2 行撤回链接）；
 *      没过：发「未入库 · 缺什么」汇报，登记一个待回答问题（D146，30 分钟）。
 *   ② **回声**：自动入库那条路上的结局 —— 已入库 / 入库失败 / 已撤回 —— 各回一行 @本人。
 *   ③ 投递失败按 10s/20s/30s/40s 退避，5 次放弃（记 receipt_failed）。
 *
 * 🔴 **先排队、再发送；发不出去就撤掉排队**（D143「发送成功才开始倒计时」）——
 *    反过来（先发后排）的话，发出去的汇报说「60 秒后入库」而排队失败了，是一句假话；
 *    而没发出去就排队，等于一条谁都没看见的记录 60 秒后自己进了 CRM。
 *
 * 触发方式是**轮询**而不是挂进 loop.ts（D120）。投递账记在 `channel_event`：
 *   receipt:<sid>:<rev>  一版内容只汇报一次（rev = extracted + status 的指纹，
 *                        同一版被重跑、内容变了 → 再汇报一次）
 *   receipt:<sid>        **旧键**（D143 之前的回执）—— 认它，部署后历史回执不重发刷屏
 *   queued:<sid>:<ms>    这一版排过自动入库（回声只发给走过这条路的）
 *   notice:<kind>:<sid>… 回声只发一次
 */

type Row = Version & {
  thread_id: string | null;
  rev: string;
  conversation_key: string | null;
  sender: string | null;
};

/** 投递失败的退避账本（内存）。重启丢了也无妨 —— 大不了立刻再试一次。 */
const attempts = new Map<string, { n: number; nextAt: number }>();
const MAX_ATTEMPTS = 5;

export const webhookFor = async (conversationKey: string | null): Promise<string | null> => {
  if (conversationKey) {
    const [c] = await sql<Array<{ webhook_url: string | null }>>`
      select webhook_url from channel_conversation
      where channel = 'dingtalk' and conversation_key = ${conversationKey}`;
    if (c?.webhook_url) return c.webhook_url;
  }
  return env.dingtalkDefaultWebhook || null;
};

const record = async (
  key: string,
  kind: string,
  row: { inbox_id: string; conversation_key: string | null; sender: string | null },
  raw?: unknown,
) => {
  await sql`
    insert into channel_event (channel, event_key, kind, conversation_key, sender, inbox_id, raw)
    values ('dingtalk', ${key}, ${kind}, ${row.conversation_key}, ${row.sender},
            ${row.inbox_id}, ${raw ? sql.json(raw as never) : null})
    on conflict (channel, event_key) do nothing`;
};

/** 发一条。只有 2xx 且钉钉的 errcode 为 0（或没有）才算「钉钉收下了」—— 收下 ≠ 群里看到（§2.52）。 */
export const deliver = async (fetchFn: typeof fetch, webhook: string, ding: DingMessage): Promise<boolean> => {
  try {
    const res = await fetchFn(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(outboundBody(ding, webhook)),
      signal: AbortSignal.timeout(5000),
    });
    const body = res.ok ? ((await res.json().catch(() => ({}))) as { errcode?: number }) : null;
    return Boolean(res.ok && (body?.errcode === undefined || body?.errcode === 0));
  } catch {
    return false;
  }
};

const backoff = (key: string): boolean => {
  const a = attempts.get(key);
  return Boolean(a && a.nextAt > Date.now());
};

/** 失败记一笔；到上限返回 true（调用方记 failed 放弃）。 */
const failOnce = (key: string): boolean => {
  const n = (attempts.get(key)?.n ?? 0) + 1;
  if (n >= MAX_ATTEMPTS) {
    attempts.delete(key);
    return true;
  }
  attempts.set(key, { n, nextAt: Date.now() + n * 10_000 });
  return false;
};

/** 没有 thread 的 staging（老数据 / 测试造的行）补一条 —— `#N` 挂在 thread 上。staging 本来就可以改。 */
const ensureThread = async (row: Row): Promise<string> => {
  if (row.thread_id) return row.thread_id;
  const [t] = await sql<Array<{ id: string }>>`
    insert into thread (user_id, title) values (${row.user_id}, ${'钉钉速记'}) returning id`;
  await sql`update staging set thread_id = ${t!.id} where id = ${row.id} and thread_id is null`;
  return t!.id;
};

// ── ① 汇报 ───────────────────────────────────────────────────────

const reportOne = async (row: Row, fetchFn: typeof fetch) => {
  const key = `receipt:${row.id}:${row.rev}`;
  if (backoff(key)) return;

  const webhook = await webhookFor(row.conversation_key);
  if (!webhook || !row.sender) {
    // 没地方发 / 没人可 @ —— 记 skipped 免得每 3 秒白查一次；**也不排自动入库**（没人看见就不入）
    await record(key, 'receipt_skipped', row);
    return;
  }

  const threadId = await ensureThread(row);
  let base;
  try {
    base = await reportBaseOf(row, threadId);
  } catch (e) {
    // 名单读不到（Twenty 一时不可达）：不记账、退避后重来 —— 不许把它当成「客户不在名单里」硬挡
    attempts.set(key, { n: (attempts.get(key)?.n ?? 0) + 1, nextAt: Date.now() + 30_000 });
    console.warn(`  ⚠️ 钉钉汇报素材没取到（${String(e).slice(0, 100)}），30 秒后重试（staging ${row.id}）`);
    return;
  }
  const secs = autoSeconds();

  /**
   * 🔴 只有一版的**第一次**汇报才自动排队。同一版被重跑过（PWA 重跑、重启后 resumePending
   *    把一条按「处理失败」汇报过的又跑通了）、内容变了再汇报时，人上一次看到的是别的东西 ——
   *    要入库得他自己说「入库 #N」。
   */
  const [prior] = await sql<Array<{ n: number }>>`
    select count(*)::int as n from channel_event
    where channel = 'dingtalk' and kind = 'receipt'
      and (event_key = ${`receipt:${row.id}`} or event_key like ${`receipt:${row.id}:%`})`;
  const reReport = (prior?.n ?? 0) > 0;

  let state: ReportState;
  let queueId: string | null = null;
  if (row.status === 'failed') {
    state = { kind: 'failed', error: row.error ?? '处理失败' };
  } else if (!base.gate.auto) {
    state = { kind: 'held', hard: base.gate.hard, soft: base.gate.soft };
  } else if (secs === 0) {
    state = { kind: 'not_queued', why: `自动入库已关闭。要入库：@我「入库 #${base.refNo}」` };
  } else if (!env.captureUrl) {
    // 撤回链接签不出来（没配公网地址）—— 没有撤回手段的倒计时等于不可撤回，不排
    state = { kind: 'not_queued', why: `网关没配公网地址，签不出撤回链接，所以没自动入库。要入库：@我「入库 #${base.refNo}」` };
  } else if (reReport) {
    state = { kind: 'not_queued', why: `这一版重新整理过，内容可能和上次汇报不同。要入库：@我「入库 #${base.refNo}」` };
  } else {
    /**
     * 两段式（confirm.ts queueAutoCommit 的注释）：线程锁里**占位**排队（心跳认领不到），
     * 送达之后才 arm 开始倒计时；没送达 / 中途出错一律 disarm。
     */
    const qid = randomUUID();
    const why = await withThreadLock(threadId, async () => {
      const { latest, busy } = await latestOf(threadId);
      if (busy) return '同一条里有新的一句正在整理';
      if (!latest || latest.id !== row.id) return '已被同一条里更新的一版取代';
      const ok = await queueAutoCommit(row.id, row.user_id, { companyId: base.companyId!, queueId: qid });
      return ok ? null : '这一版的状态变了，没排上';
    });
    if (why) state = { kind: 'not_queued', why };
    else {
      queueId = qid;
      const url = await issueWithdrawLink(row.id, row.user_id, qid, new Date(Date.now() + (secs + 600) * 1000));
      state = { kind: 'countdown', seconds: secs, withdrawUrl: url };
    }
  }

  let delivered = false;
  let armedAt: Date | null = null;
  try {
    const ding = renderReport({ ...base, sender: row.sender, state });
    delivered = await deliver(fetchFn, webhook, ding);
    if (!delivered) {
      if (failOnce(key)) {
        await record(key, 'receipt_failed', row, ding);
        console.warn(`  ⚠️ 钉钉汇报连续 ${MAX_ATTEMPTS} 次没发出去，放弃（staging ${row.id}）。没有入库，数据没丢。`);
      }
      return;
    }
    attempts.delete(key);
    if (queueId) {
      armedAt = await armAutoCommit(row.id, queueId, secs);
      if (armedAt) {
        await record(`queued:${row.id}:${armedAt.getTime()}`, 'queued', row, { stagingId: row.id, at: armedAt, queueId });
      }
    }
    await record(key, 'receipt', row, ding);
    // 有问题要问（没过门槛的缺口，或 agent 自己的补充问题）→ 登记成这一条的待回答问题
    const ask = askFor(base.questions, state.kind === 'held' ? base.gate : { hard: [], soft: [] });
    if (ask && row.conversation_key) await askOpenQuestion(row.conversation_key, row.user_id, threadId, row.id, ask);
  } finally {
    // 🔴 没送到、或者送到之后 arm 之前出了任何事 —— 撤掉占位（人没看见的东西不许自己进 CRM）
    if (queueId && !armedAt) await disarmAutoCommit(row.id, queueId).catch(() => {});
  }
};

// ── ② 回声 ───────────────────────────────────────────────────────

type NoticeRow = {
  id: string;
  inbox_id: string;
  status: string;
  error: string | null;
  twenty_refs: Record<string, string> | null;
  created_records: Array<{ object: string }> | null;
  withdrawn_at: Date | null;
  ref_no: string | null;
  conversation_key: string | null;
  sender: string | null;
  /** 回声的账键 —— **在 SQL 里算、JS 原样用**：两边各算一遍的话，时间戳精度
   *  （微秒 vs 毫秒）或字符计数（码点 vs UTF-16）一差，「只发一次」就变成每 3 秒发一次。 */
  nkey: string;
  redo: boolean;
};

const noticeOne = async (n: NoticeRow, kind: 'committed' | 'commit_failed' | 'withdrawn', fetchFn: typeof fetch) => {
  const key = n.nkey;
  if (backoff(key)) return;
  const webhook = await webhookFor(n.conversation_key);
  if (!webhook || !n.sender) {
    await record(key, 'notice', n, { skipped: true });
    return;
  }
  const refNo = Number(n.ref_no ?? 0);
  let ding: DingMessage;
  if (kind === 'committed') {
    const created: Record<string, number> = {};
    for (const r of n.created_records ?? []) created[labelOf(r.object)] = (created[labelOf(r.object)] ?? 0) + 1;
    const refs = n.twenty_refs ?? {};
    const updated = [
      refs.opportunityWas !== undefined && refs.opportunityId && '商机',
      refs.projectUpdated && `项目 ${refs.projectUpdated}`,
      refs.workItemsUpdated && `任务线程 ${refs.workItemsUpdated}`,
      refs.recommitted && '上一版写入的记录',
    ].filter(Boolean) as string[];
    ding = renderNotice({ kind, refNo, created, updated }, n.sender);
  } else if (kind === 'commit_failed') {
    ding = renderNotice({ kind, refNo, error: (n.error ?? '').replace(/^入库失败：/, '') }, n.sender);
  } else {
    ding = renderNotice({ kind, refNo, via: 'link', redo: n.redo }, n.sender);
  }
  if (await deliver(fetchFn, webhook, ding)) {
    attempts.delete(key);
    await record(key, 'notice', n, ding);
  } else if (failOnce(key)) {
    await record(key, 'notice', n, { failed: true });
  }
};

let running = false;

/** 一跳。`fetchFn` 只有测试会注入。 */
export const channelTick = async (fetchFn: typeof fetch = fetch): Promise<void> => {
  if (running) return;
  running = true;
  try {
    const rows = await sql<Row[]>`
      select s.id, s.inbox_id, s.status, s.partial, s.error, s.extracted, s.suggested_company,
             s.confirm_after, s.withdrawn_at, s.replaces, s.created_at, s.thread_id, i.user_id,
             left(md5(coalesce(s.extracted::text, '') || s.status), 12) as rev,
             e.conversation_key, e.sender
      from staging s
      join inbox i on i.id = s.inbox_id
      left join lateral (
        select ce.conversation_key, ce.sender from channel_event ce
        where ce.inbox_id = i.id and ce.kind = 'message'
        order by ce.created_at limit 1
      ) e on true
      where i.source = 'dingtalk'
        and s.note_deleted_at is null and s.record_deleted_at is null
        and (
          /**
           * ready 要等 agent 的收尾消息落库（追问在那条消息的 meta 里）——
           * loop 先写 ready（loop.ts「update staging set status」）、后插消息，中间有几毫秒；
           * 没内容 / agent 关着那两条路**不插消息**，所以兜一个 5 秒宽限。
           */
          (s.status = 'ready' and s.withdrawn_at is null
           and (exists (select 1 from thread_message m where m.inbox_id = i.id and m.role = 'agent')
                or s.updated_at < now() - interval '5 seconds'))
          /**
           * 🔴 failed 要等到**终局**才汇报 —— loop 对临时故障会自动重试（2s/4s/8s，上限 3 次）。
           * 终局判据：预算耗尽（attempts>=3），或这行 20 秒没再动过。
           */
          or (s.status = 'failed'
              and (s.attempts >= 3 or s.updated_at < now() - interval '20 seconds'))
        )
        and not exists (
          select 1 from channel_event r
          where r.channel = 'dingtalk'
            and r.event_key in ('receipt:' || s.id::text,
                                'receipt:' || s.id::text || ':' || left(md5(coalesce(s.extracted::text, '') || s.status), 12)))
      order by s.created_at
      limit 10`;
    for (const row of rows) {
      try {
        await reportOne(row, fetchFn);
      } catch (e) {
        console.warn(`  ⚠️ 钉钉汇报这一条失败（${row.id}）：${String(e).slice(0, 160)}`);
      }
    }

    /**
     * 回声只发给**走过自动入库那条路**的（有 queued 事件）——
     * PWA 里确认的、D143 之前的，群里不冒一句突兀的「已入库」。
     */
    const notices = await sql<Array<NoticeRow & { kind: 'committed' | 'commit_failed' | 'withdrawn' }>>`
      select s.id, s.inbox_id, s.status, s.error, s.twenty_refs, s.created_records, s.withdrawn_at,
             t.ref_no::text as ref_no, e.conversation_key, e.sender,
             k.kind, k.nkey, (s.replaces ? 'stagingId') as redo
      from staging s
      cross join lateral (
        select case when s.status = 'confirmed' then 'committed'
                    when s.withdrawn_at is not null then 'withdrawn'
                    else 'commit_failed' end as kind,
               case when s.status = 'confirmed' then 'notice:committed:' || s.id::text
                    when s.withdrawn_at is not null
                      then 'notice:withdrawn:' || s.id::text || ':' || floor(extract(epoch from s.withdrawn_at) * 1000)::bigint::text
                    -- 每排一次队、失败就回一句：带上最近那次排队的时刻（同一个错误第二次失败也要说）
                    else 'notice:commit_failed:' || s.id::text || ':' || coalesce((
                      select max(q.event_key) from channel_event q
                      where q.channel = 'dingtalk' and q.kind = 'queued' and q.inbox_id = s.inbox_id), '')
               end as nkey
      ) k
      join inbox i on i.id = s.inbox_id
      left join thread t on t.id = s.thread_id
      left join lateral (
        select ce.conversation_key, ce.sender from channel_event ce
        where ce.inbox_id = i.id and ce.kind = 'message'
        order by ce.created_at limit 1
      ) e on true
      where i.source = 'dingtalk'
        and exists (select 1 from channel_event q
                    where q.channel = 'dingtalk' and q.kind = 'queued' and q.inbox_id = i.id)
        and (s.status = 'confirmed'
             or (s.status = 'ready' and s.withdrawn_at is not null)
             or (s.status = 'ready' and s.withdrawn_at is null and s.error like '入库失败%'))
        and not exists (select 1 from channel_event x where x.channel = 'dingtalk' and x.event_key = k.nkey)
      limit 10`;
    for (const n of notices) {
      try {
        await noticeOne(n, n.kind, fetchFn);
      } catch (e) {
        console.warn(`  ⚠️ 钉钉回声这一条失败（${n.id}）：${String(e).slice(0, 160)}`);
      }
    }
  } catch (e) {
    console.warn(`  ⚠️ 钉钉出站这一跳失败：${String(e).slice(0, 160)}`);
  } finally {
    running = false;
  }
};

export const startChannelTicker = (): ReturnType<typeof setInterval> | null => {
  if (!env.dingtalkSecret) return null; // 渠道关着就一跳都不跳
  const t = setInterval(() => void channelTick(), 3000);
  (t as { unref?: () => void }).unref?.();
  return t;
};
