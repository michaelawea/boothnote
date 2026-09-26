import { env } from '../env.ts';
import { sql } from '../db.ts';
import { outboundBody, renderReceipt } from './render.ts';

/**
 * 出站腿（docs/dingtalk-channel.md §3）：agent 跑完（ready/failed）→
 * 把回执发回那个群的自定义机器人 webhook。追问也走这条腿 ——
 * 回执里的「还缺 …（回复请 @我）」就是它。
 *
 * 触发方式是**轮询**而不是挂进 loop.ts —— L2 录入 agent 一个字不动（维护者 定的两层边界）。
 * 3 秒一跳、每跳最多 10 条，代价可忽略。
 *
 * 投递账记在 `channel_event`（receipt / receipt_skipped / receipt_failed，
 * `event_key = receipt:<stagingId>` 唯一）——「只发一次」和消息幂等共用同一道唯一键。
 * 回执是装饰不是资产（和 Timeline 同一条判据 D61③）：发不出去数据一个字不丢，
 * 看板上那条记录一直查得到。
 */

type Pending = {
  sid: string;
  status: string;
  partial: boolean;
  error: string | null;
  title: string | null;
  extracted: Record<string, unknown>;
  suggested_company: string | null;
  thread_id: string | null;
  iid: string;
  company_code: string | null;
  conversation_key: string | null;
  sender: string | null;
};

/** 投递失败的退避账本（内存）。重启丢了也无妨 —— 大不了立刻再试一次。 */
const attempts = new Map<string, { n: number; nextAt: number }>();
const MAX_ATTEMPTS = 5;

const webhookFor = async (conversationKey: string | null): Promise<string | null> => {
  if (conversationKey) {
    const [c] = await sql<Array<{ webhook_url: string | null }>>`
      select webhook_url from channel_conversation
      where channel = 'dingtalk' and conversation_key = ${conversationKey}`;
    if (c?.webhook_url) return c.webhook_url;
  }
  return env.dingtalkDefaultWebhook || null;
};

const record = async (kind: string, row: Pending, raw?: unknown) => {
  await sql`
    insert into channel_event (channel, event_key, kind, conversation_key, sender, inbox_id, raw)
    values ('dingtalk', ${`receipt:${row.sid}`}, ${kind}, ${row.conversation_key}, ${row.sender},
            ${row.iid}, ${raw ? sql.json(raw as never) : null})
    on conflict (channel, event_key) do nothing`;
};

let running = false;

/** 一跳。`fetchFn` 只有测试会注入。 */
export const channelTick = async (fetchFn: typeof fetch = fetch): Promise<void> => {
  if (running) return;
  running = true;
  try {
    const rows = await sql<Pending[]>`
      select s.id as sid, s.status, s.partial, s.error, s.title, s.extracted,
             s.suggested_company, s.thread_id,
             i.id as iid, i.company_code, e.conversation_key, e.sender
      from staging s
      join inbox i on i.id = s.inbox_id
      left join lateral (
        select ce.conversation_key, ce.sender from channel_event ce
        where ce.inbox_id = i.id and ce.kind = 'message'
        order by ce.created_at limit 1
      ) e on true
      where i.source = 'dingtalk'
        and (
          s.status = 'ready'
          /**
           * 🔴 failed 要等到**终局**才发回执 —— loop 对临时故障会自动重试（2s/4s/8s，
           * 上限 3 次）。第一次 failed 就发「没处理成」，重试成功之后它就是一句假话，
           * 而回执只发一次（event_key 唯一），真正的 ready 回执反而永远发不出去。
           * 终局判据：预算耗尽（attempts>=3），或这行 20 秒没再动过
           * （非临时故障不重试，updated_at 停住；重试窗口最长 2+4+8=14s < 20s）。
           */
          or (s.status = 'failed'
              and (s.attempts >= 3 or s.updated_at < now() - interval '20 seconds'))
        )
        and not exists (
          select 1 from channel_event r
          where r.channel = 'dingtalk' and r.event_key = 'receipt:' || s.id::text)
      limit 10`;

    for (const row of rows) {
      const a = attempts.get(row.sid);
      if (a && a.nextAt > Date.now()) continue;

      const webhook = await webhookFor(row.conversation_key);
      if (!webhook || !row.sender) {
        // 没地方发 / 没人可 @ —— 记 skipped 免得每 3 秒白查一次。ack 那边已经说过「去 PWA 看」。
        await record('receipt_skipped', row);
        continue;
      }

      // 「还缺」那一行：最近一条以问号收尾的 agent 消息（和 route.ts 的判据同一条）
      let askText: string | null = null;
      if (row.thread_id) {
        const [ask] = await sql<Array<{ text: string }>>`
          select text from thread_message
          where thread_id = ${row.thread_id} and role = 'agent'
          order by created_at desc limit 1`;
        const t = String(ask?.text ?? '').trim();
        if (/[?？]$/.test(t)) askText = t;
      }

      const ding = renderReceipt({
        sender: row.sender,
        status: row.status,
        partial: Boolean(row.partial),
        error: row.error,
        title: row.title,
        extracted: row.extracted ?? {},
        companyCode: row.company_code,
        suggestedCompany: row.suggested_company,
        askText,
      });

      let delivered = false;
      try {
        const res = await fetchFn(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(outboundBody(ding, webhook)),
          signal: AbortSignal.timeout(5000),
        });
        const body = res.ok ? ((await res.json().catch(() => ({}))) as { errcode?: number }) : null;
        delivered = Boolean(res.ok && (body?.errcode === undefined || body?.errcode === 0));
      } catch {
        delivered = false;
      }

      if (delivered) {
        attempts.delete(row.sid);
        await record('receipt', row, ding);
      } else {
        const n = (a?.n ?? 0) + 1;
        if (n >= MAX_ATTEMPTS) {
          attempts.delete(row.sid);
          await record('receipt_failed', row, ding);
          console.warn(`  ⚠️ 钉钉回执连续 ${MAX_ATTEMPTS} 次没发出去，放弃（staging ${row.sid}）。数据没丢，PWA 里能看到。`);
        } else {
          attempts.set(row.sid, { n, nextAt: Date.now() + n * 10_000 }); // 10s/20s/30s/40s 退避
        }
      }
    }
  } catch (e) {
    console.warn(`  ⚠️ 钉钉出站这一跳失败：${String(e).slice(0, 120)}`);
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
