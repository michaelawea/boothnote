import type { AttachmentKind, LocalAttachment } from './db';
import { t } from './i18n';

/**
 * 附件的纯逻辑。**刻意不碰 DOM** —— 好测，也好在别处复用。
 *
 * 上限的理由是 iPhone 的 IndexedDB 配额：Safari 给单站点的额度不是无限的，
 * 而这个应用**离线时必须还能录**。附件把配额吃光的后果不是「传不了附件」，
 * 是**连速记都写不进去** —— 那是这套系统唯一不能出的事。
 * 所以宁可当场拒绝一个大文件，也不赌配额。
 */

/** 单个附件上限。20 MB 够一份产品 PDF 或一张 iPhone 原图，且离配额还有余量。 */
export const MAX_BYTES = 20 * 1024 * 1024;
/** 一条速记最多带几个。多了展馆 4G 上行会把队列堵住。 */
export const MAX_COUNT = 4;

export const ACCEPT: Record<AttachmentKind, string> = {
  photo: 'image/*',
  image: 'image/*',
  // 什么都收 —— 维护者 2026-08-03：「用户上传什么，你就去看什么」
  file: '*/*',
};

export const KIND_LABEL: Record<AttachmentKind, string> = {
  photo: t('拍照'),
  image: t('图片'),
  file: t('文件'),
};

export const humanSize = (bytes: number): string =>
  bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export type AddResult =
  | { ok: true; attachments: LocalAttachment[] }
  | { ok: false; reason: string; attachments: LocalAttachment[] };

/**
 * 往列表里加文件。**拒绝时也要把已有的原样返回** ——
 * 「加第 5 个被拒」不能顺手把前 4 个弄没了。
 */
export const addFiles = (
  current: LocalAttachment[],
  files: Array<{ name: string; type: string; size: number; blob: Blob }>,
  kind: AttachmentKind,
): AddResult => {
  const next = [...current];
  for (const f of files) {
    if (next.length >= MAX_COUNT)
      return { ok: false, reason: t('一条速记最多 {a} 个附件', { a: MAX_COUNT }), attachments: next };
    if (f.size > MAX_BYTES)
      return {
        ok: false,
        reason: t('「{a}」{b}，超过 {c} 上限', { a: f.name, b: humanSize(f.size), c: humanSize(MAX_BYTES) }),
        attachments: next,
      };
    if (f.size === 0)
      return { ok: false, reason: t('「{a}」是空文件', { a: f.name }), attachments: next };
    next.push({
      kind,
      name: f.name || `${kind}-${Date.now()}`,
      mime: f.type || 'application/octet-stream',
      size: f.size,
      blob: f.blob,
    });
  }
  return { ok: true, attachments: next };
};

export const totalBytes = (list: LocalAttachment[]) => list.reduce((s, a) => s + a.size, 0);
