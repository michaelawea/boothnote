import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { env } from './host.ts';
import { sql } from './host.ts';
import type { NativeFile, NativeImage } from './runtime.ts';

/**
 * 附件 → **原生喂给模型**（D71，修订 D46b）。
 *
 * 2026-08-05 之前这里的主线是「一切解析成纯文本」：图片被视觉模型压成 200 字转述，
 * PDF 被 officeparser 拍平（表格 / 图纸 / 版式全丢），扫描件直接解析成空串。
 * issue #17 里「附件里的时间线只是一堆详情」有一部分根源就是模型从没见过原件。
 *
 * 新主线：**模型的眼睛优先于本地解析器。**
 *   图片            → `input_image`（base64，随首条消息）
 *   pdf/docx/pptx/xlsx → `input_file`（base64，runtime.ts 的 onPayload 拼进请求）
 *   纯文本          → 还是文字（它本来就是文字，没有「原生」可言）
 *
 * 降级是第二主线而不是异常分支（「任何一段挂掉，前一段的数据都还在」）：
 *   超字节门槛 / 探测过不支持的格式 / odt 这类不在直通名单里的 → 走原来的
 *   officeparser 链路；坏文件、空文件 → 一律「只记文件名」，绝不让一个附件
 *   把整条速记拖成 failed。销售说的话永远是主，附件是佐证。
 */

const OFFICE = new Set(['.pdf', '.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods']);
const PLAIN = new Set(['.txt', '.md', '.csv', '.json', '.log', '.html', '.htm', '.xml', '.rtf']);
const IMAGE = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif']);

/** 能走 `input_file` 直通的文档格式（维护者 2026-08-05 给的口径，配探测兜底）。 */
const NATIVE_DOC: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

/**
 * ── 格式探测三态（D71 护栏②）───────────────────────────────────────
 *
 * 判据和 `transcribe.ts` 的 `extendedParams` 一模一样：
 * **接口参数是猜不得的东西 —— 猜错了不会在启动时报错，而是展会现场第一次
 * 传附件时 400。** 所以带上去试，被拒就按扩展名记下来退回本地解析；
 * 重启网关 = 重新探测。pdf 按 维护者 给的信息应当直接可用，
 * docx/pptx/xlsx 让探测说话。
 */
const extUnsupported = new Set<string>();
export const isExtUnsupported = (ext: string): boolean => extUnsupported.has(ext);
export const markExtsUnsupported = (exts: string[]): void => {
  for (const e of exts) extUnsupported.add(e);
};
/** 测试注入用。 */
export const __resetProbe = (): void => extUnsupported.clear();

/**
 * 报文看着像「模型/接口不收这种文件」，而不是网络抖动或别的参数错。
 * ⚠️ 宁可漏判也别错判：错判成「格式不支持」会让这个格式**在重启前永远降级**，
 * 而漏判只是这一条多失败一次（attempts 预算兜着）。
 */
export const rejectsInputFile = (msg: string): boolean =>
  /invalid|unsupported|unrecognized|not supported|unable to (parse|process|read)|failed to (parse|process|read)|could not (parse|process|read)/i.test(
    msg,
  ) && /\bfile\b|input_file|file_data|document|pdf|docx|pptx|xlsx/i.test(msg);

export type ExtractResult = {
  /** 'native' = 没本地解析，原样喂给了模型（D71，migration 008 放行）。 */
  status: 'ready' | 'failed' | 'skipped' | 'native';
  text: string;
  truncated: boolean;
  error?: string;
};

/** 一条速记的全部附件，按去向分好类（D71）。 */
export type PreparedAttachments = {
  /** 原生给模型看的图。 */
  images: NativeImage[];
  /** 原生给模型看的文档（input_file）。 */
  files: NativeFile[];
  /** 纯文本附件 + 降级抽取出来的文字，照旧拼进 prompt。 */
  text: string;
  /** 原生直通了几个（日志 / stage 用）。 */
  native: number;
  /** 这一轮原生附上的文档扩展名 —— 探测失败时 loop.ts 要标记的就是它们。 */
  nativeExts: string[];
};

const human = (bytes: number) =>
  bytes > 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * 截断上限的理由（§1.4b）：一本 80 页的产品手册整个塞进去，
 * 一是贵，二是**会把销售那句话淹掉**。超长取前面部分，并在 staging 里标明截断了。
 * ⚠️ 只用于降级路径 —— 原生直通的文件没法按页截，超了门槛是**整件降级**（D71）。
 */
const clip = (text: string): { text: string; truncated: boolean } => {
  const max = env.attachmentMaxChars;
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n\n…（超长已截断，原文 ${text.length} 字）`, truncated: true };
};

const parseInWorker = (path: string, timeoutMs = 45_000): Promise<string> =>
  new Promise((resolve, reject) => {
    const w = new Worker(new URL('./attachment-worker.ts', import.meta.url), {
      workerData: { path },
    });
    const timer = setTimeout(() => {
      void w.terminate();
      reject(new Error('解析超时'));
    }, timeoutMs);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      void w.terminate();
      fn();
    };
    w.on('message', (m: { ok: boolean; text?: string; error?: string }) =>
      done(() => (m.ok ? resolve(m.text ?? '') : reject(new Error(m.error ?? '解析失败')))),
    );
    w.on('error', (e) => done(() => reject(e)));
    w.on('exit', (code) => {
      if (code !== 0) done(() => reject(new Error(`worker 退出码 ${code}`)));
    });
  });

/**
 * 降级路径：附件 → 纯文字。原来的主线，现在只在原生直通走不了时用
 * （超门槛 / 探测不支持 / odt 系 / 坏文件）。
 */
export const extractAttachmentText = async (att: {
  path: string;
  filename: string;
  mime?: string | null;
  kind: string;
}): Promise<ExtractResult> => {
  const abs = join(env.audioDir, att.path);
  const ext = extname(att.filename).toLowerCase();
  let bytes = 0;
  try {
    bytes = (await stat(abs)).size;
  } catch {
    return { status: 'failed', text: '', truncated: false, error: '文件不存在' };
  }

  const fallback = (why: string): ExtractResult => ({
    status: 'skipped',
    text: `【附件：${att.filename}，${human(bytes)}】${why}`,
    truncated: false,
  });

  if (bytes === 0) return fallback('空文件。');

  try {
    /**
     * 图片到这里说明**原生直通走不了**（一般是超了字节门槛）。
     * 原来这条路走一次视觉模型换一段 200 字转述（describeImage），D71 起删了：
     * 正常路径模型直接看原图，比转述强得多；超大的图为一段转述再烧一次调用不值 ——
     * 只记文件名，人在核对卡上看得到有这么个附件。
     */
    if (IMAGE.has(ext) || att.mime?.startsWith('image/')) {
      return fallback(`图片超过了原生直通的大小门槛（${human(env.attachmentInlineMaxBytes)}），只记文件名。`);
    }

    // 纯文本类：直接读，不值得开线程
    if (PLAIN.has(ext)) {
      const raw = await readFile(abs, 'utf8');
      if (!raw.trim()) return fallback('内容为空。');
      return { status: 'ready', ...clip(`【文件：${att.filename}】\n${raw}`) };
    }

    // Office / PDF：worker_thread
    if (OFFICE.has(ext)) {
      const raw = await parseInWorker(abs);
      if (!raw.trim()) return fallback('解析出来是空的（可能是扫描件或加密文档）。');
      return { status: 'ready', ...clip(`【文件：${att.filename}】\n${raw}`) };
    }

    return fallback('这个格式没有解析器，只记下文件名和大小。');
  } catch (e) {
    // 「尽力而为」的落点：认不出就只记文件名和大小，**不假装读懂了**
    return {
      status: 'failed',
      text: `【附件：${att.filename}，${human(bytes)}】解析失败，只记下文件名。`,
      truncated: false,
      error: (e as Error).message.slice(0, 300),
    };
  }
};

/** 降级抽取的结果落 attachment_text（幂等，重跑不重来）。 */
const cacheExtract = async (attachmentId: string, r: ExtractResult): Promise<void> => {
  await sql`
    insert into attachment_text (attachment_id, status, text, truncated, chars, error)
    values (${attachmentId}, ${r.status}, ${r.text}, ${r.truncated}, ${r.text.length}, ${r.error ?? null})
    on conflict (attachment_id) do update set
      status = excluded.status, text = excluded.text, truncated = excluded.truncated,
      chars = excluded.chars, error = excluded.error`;
};

/**
 * 把一条速记的所有附件分好类：原生的进 images/files，其余走降级抽取。
 *
 * `attachment_text` 里对原生直通的附件记一行 `status='native'` ——
 * ① 界面上「parsed」那一格有东西可显示；② read_attachment 能答出
 * 「这份已经原样喂给你了」；③ 探测失败重跑时，'native' 行**不当缓存用**
 * （那时扩展名已被标不支持，会真的走降级抽取并覆盖这一行）。
 */
export const prepareAttachments = async (inboxId: string): Promise<PreparedAttachments> => {
  const atts = await sql<
    Array<{ id: string; path: string; filename: string; mime: string | null; kind: string }>
  >`select id, path, filename, mime, kind from attachment where inbox_id = ${inboxId} order by created_at`;

  const out: PreparedAttachments = { images: [], files: [], text: '', native: 0, nativeExts: [] };
  if (!atts.length) return out;

  const parts: string[] = [];
  for (const a of atts) {
    const ext = extname(a.filename).toLowerCase();
    const abs = join(env.audioDir, a.path);

    let bytes = -1;
    try {
      bytes = (await stat(abs)).size;
    } catch {
      /* 文件不在了 → 走降级路径，它会记 failed */
    }
    const inlineOk = bytes > 0 && bytes <= env.attachmentInlineMaxBytes;

    // ── 原生直通：图片 ──────────────────────────────────────────────
    if (inlineOk && (IMAGE.has(ext) || a.mime?.startsWith('image/'))) {
      const buf = await readFile(abs);
      out.images.push({
        data: buf.toString('base64'),
        mimeType: a.mime || IMAGE_MIME[ext] || 'image/jpeg',
      });
      out.native++;
      await cacheExtract(a.id, {
        status: 'native',
        text: `【图片：${a.filename}】已原样喂给模型。`,
        truncated: false,
      });
      continue;
    }

    // ── 原生直通：pdf / docx / pptx / xlsx ─────────────────────────
    if (inlineOk && NATIVE_DOC[ext] && !isExtUnsupported(ext)) {
      const buf = await readFile(abs);
      out.files.push({
        filename: a.filename,
        mime: a.mime || NATIVE_DOC[ext],
        data: buf.toString('base64'),
      });
      out.native++;
      out.nativeExts.push(ext);
      await cacheExtract(a.id, {
        status: 'native',
        text: `【文件：${a.filename}】已原样喂给模型。`,
        truncated: false,
      });
      continue;
    }

    // ── 降级路径 ────────────────────────────────────────────────────
    // 已经抽过就不重来（重跑整条速记时省钱）。⚠️ 'native' 行不算缓存 ——
    // 走到这里说明这次不打算原生直通（比如刚被探测标了不支持），要真的抽一次。
    const [done] = await sql<Array<{ status: string; text: string | null }>>`
      select status, text from attachment_text where attachment_id = ${a.id}`;
    if (done && done.status !== 'pending' && done.status !== 'native') {
      if (done.text) parts.push(done.text);
      continue;
    }

    const r = await extractAttachmentText(a);
    await cacheExtract(a.id, r);
    if (r.text) parts.push(r.text);
  }

  out.text = parts.join('\n\n');
  return out;
};
