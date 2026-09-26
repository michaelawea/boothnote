import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { env } from './env.ts';
import { sql } from './db.ts';

/**
 * 一条速记落库的核心 —— **`POST /inbox` 和渠道适配层（钉钉）共用这一份**（T93）。
 *
 * 从 index.ts 的 `POST /inbox` 处理器里原样抽出来的，行为零变化：
 * 幂等检查 → （要走 agent 才）建对话 → 落 inbox → 存附件 → 建 staging → 写对话消息。
 * multipart 解析、改口（supersede）、enqueue 这些各入口不同的部分留在调用方手里。
 *
 * 🔴 这里不 enqueue agent —— 什么时候进队列是入口的事
 *    （HTTP 入口立即进；钉钉入口要先把图片下载完，否则 agent 开跑时附件还没落库）。
 */

export const saveBlob = async (buf: Buffer, name: string) => {
  const now = new Date();
  const rel = join(
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    `${randomUUID()}-${name}`,
  );
  const abs = join(env.audioDir, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, buf);
  return rel;
};

export type IngestFile = { kind: string; buf: Buffer; mime: string; name: string };

export type IngestInput = {
  userId: string;
  /** 幂等键（§4.2 第 6 条）。渠道侧由报文合成（payload.ts 的 deriveClientId）。 */
  clientId: string;
  text: string | null;
  companyCode: string | null;
  visitLabel: string | null;
  deviceCreatedAt: Date | null;
  /** 给了就是续写（会先验属主，不是自己的当没给）。 */
  threadId: string | null;
  /** 只有要走 agent 才开对话 —— 纯速记不在 AI 的历史里留空对话（D31）。 */
  toAgent: boolean;
  /** `note` / `followup` / `import` / `dingtalk` */
  source: string;
  /** 客户端已转好的转写（D69）。只在有音频时落 staging.transcript。 */
  transcript?: string | null;
  audio?: { buf: Buffer; mime: string; name: string } | null;
  audioSeconds?: number | null;
  files?: IngestFile[];
};

/** 回包里的一条附件引用（issue #53）—— 客户端凭它显示 📎 和缩略图，原件走 GET /attachments/:id/file。 */
export type IngestAttachment = { id: string; kind: string; name: string; mime: string; bytes: number };

export type IngestResult = {
  duplicate: boolean;
  inboxId: string;
  stagingId: string;
  threadId: string | null;
  /** 刚插进对话的那条用户消息（改口逻辑要用）。 */
  newMessageId: string | null;
  audioPath: string | null;
  /**
   * 这条速记名下的附件清单。**重传（duplicate）也带** —— 客户端第一次可能是超时了
   * 而服务端其实收下了，第二次回来它得知道那几张图在。
   */
  attachments: IngestAttachment[];
};

/** 一条 inbox 名下的附件清单，按落库顺序。 */
export const attachmentsOf = (inboxId: string) =>
  sql<IngestAttachment[]>`
    select id, kind, filename as name, coalesce(mime, 'application/octet-stream') as mime, bytes
    from attachment where inbox_id = ${inboxId} order by created_at, id`;

export const ingestNote = async (input: IngestInput): Promise<IngestResult> => {
  // 幂等（§4.2 第6条）：同一 clientId 重传直接回原记录
  const [dup] = await sql<Array<{ id: string; sid: string; thread_id: string | null }>>`
    select i.id, s.id as sid, i.thread_id from inbox i join staging s on s.inbox_id = i.id
    where i.client_id = ${input.clientId}`;
  if (dup)
    return {
      duplicate: true,
      inboxId: dup.id,
      stagingId: dup.sid,
      threadId: dup.thread_id,
      newMessageId: null,
      audioPath: null,
      attachments: await attachmentsOf(dup.id),
    };

  const audioPath = input.audio ? await saveBlob(input.audio.buf, input.audio.name) : null;

  let threadId: string | null = input.threadId ?? null;
  if (threadId) {
    const [own] = await sql<Array<{ id: string }>>`
      select id from thread where id = ${threadId} and user_id = ${input.userId}`;
    if (!own) threadId = null; // 不是自己的就当没给（作用域在服务端裁）
  }
  // ⚠️ **续写不是 UPDATE**：同一条对话的第二句话是一条新的 inbox 行，
  //    靠 thread_id 串起来（六个必须有的测试之①）。
  if (!threadId && input.toAgent) {
    const [t] = await sql<Array<{ id: string }>>`
      insert into thread (user_id, title, company_code)
      values (${input.userId}, ${(input.text ?? '').slice(0, 40) || null}, ${input.companyCode})
      returning id`;
    threadId = t!.id;
  }

  const [row] = await sql<Array<{ id: string }>>`
    insert into inbox (client_id, user_id, company_code, text, audio_path, audio_mime,
                       audio_seconds, visit_label, device_created_at, thread_id, source)
    values (${input.clientId}, ${input.userId}, ${input.companyCode},
            ${input.text}, ${audioPath}, ${input.audio?.mime ?? null},
            ${input.audioSeconds ?? null}, ${input.visitLabel},
            ${input.deviceCreatedAt}, ${threadId}, ${input.source})
    returning id`;

  const attachments: IngestAttachment[] = [];
  for (const f of input.files ?? []) {
    const rel = await saveBlob(f.buf, f.name);
    const [a] = await sql<Array<{ id: string }>>`
      insert into attachment (inbox_id, kind, filename, mime, bytes, path)
      values (${row!.id}, ${f.kind}, ${f.name}, ${f.mime}, ${f.buf.length}, ${rel})
      returning id`;
    attachments.push({ id: a!.id, kind: f.kind, name: f.name, mime: f.mime, bytes: f.buf.length });
  }

  // 客户端已转好的就别再转一遍（issue #15）——存 transcript 不存 text，三层各答一个问题
  const clientTranscript = String(input.transcript ?? '').trim().slice(0, 20_000) || null;
  const [st] = await sql<Array<{ id: string }>>`
    insert into staging (inbox_id, thread_id, transcript)
    values (${row!.id}, ${threadId}, ${audioPath ? clientTranscript : null})
    returning id`;

  // 人说的那句话进对话（agent 回的那句由 loop 写）。没有对话就没这一步。
  let newMessageId: string | null = null;
  if (threadId) {
    if (input.text) {
      const [msg] = await sql<Array<{ id: string }>>`
        insert into thread_message (thread_id, role, text, inbox_id)
        values (${threadId}, 'user', ${input.text}, ${row!.id})
        returning id`;
      newMessageId = msg!.id;
    }
    await sql`update thread set last_message_at = now() where id = ${threadId}`;
  }

  return {
    duplicate: false,
    inboxId: row!.id,
    stagingId: st!.id,
    threadId,
    newMessageId,
    audioPath,
    attachments,
  };
};
