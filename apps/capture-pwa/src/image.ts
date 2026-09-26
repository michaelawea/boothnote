import type { AttachmentKind } from './db';
import { isImageMime } from './attach';

/**
 * 附件进本地库之前的两步（D132 · issue #53）：**先读成字节，再把图片压小。**
 *
 * ① 读成字节是修 bug：`<input type=file>` 给的 `File` 在 iOS 上是个临时文件的句柄，
 *    存进 IndexedDB 再读回来就是死的，WebKit 会把整个 multipart 正文发成 0 字节
 *    （2026-09-02 展会现场抓包坐实：`Content-Length: 0` → 网关 400）。
 *    所以 `readForUpload` 做的第一件事就是 `file.arrayBuffer()` —— 在句柄还活着的那一刻。
 *
 * ② 压小是修下一个 bug：iPhone 原图 3–8 MB，展馆 4G 上行几十 KB/s，90 秒必超时。
 *    而消费端根本不需要原图 —— agent 看图 10 MB 封顶、Twenty 这版没有文件上传接口、
 *    人事后回看在手机上也就一屏。长边 2048、JPEG 0.82，一张 300–600 KB。
 *    HEIC 顺带变成 JPEG（Safari 能解，别的浏览器解不了就原样留着）。
 *    `file` 入口不压 —— 那是给 PDF / 表格的。
 *
 * 判断规则（`planImage` / `fitWithin` / `jpegName`）是纯函数，有单测；碰 DOM 的只有 `downscale`。
 */

/** 长边上限。够看清展台上一块铭牌，也在 iOS canvas 的面积限制之内。 */
export const MAX_EDGE = 2048;
export const JPEG_QUALITY = 0.82;
/** 小于这个就不折腾了 —— 一张截屏重新编码只会变大。 */
export const SKIP_BELOW = 700 * 1024;
/** 浏览器都能显示、也不用转格式的几种。 */
const WEB_SAFE = /^image\/(jpeg|png|webp|gif)$/i;

export type Prepared = {
  name: string;
  type: string;
  size: number;
  bytes: ArrayBuffer;
  /** 真的压过了（给界面提一句，也给测试断言）。 */
  downscaled: boolean;
};

/** 要不要转成 JPEG。`keep` = 原样进库。 */
export const planImage = (mime: string, size: number): 'keep' | 'jpeg' => {
  if (!isImageMime(mime)) return 'keep';
  if (!WEB_SAFE.test(mime)) return 'jpeg'; // HEIC / HEIF / TIFF：能解就转，解不了原样
  return size > SKIP_BELOW ? 'jpeg' : 'keep';
};

/** 等比缩到长边不超过 maxEdge。已经够小就原尺寸。 */
export const fitWithin = (w: number, h: number, maxEdge = MAX_EDGE) => {
  const s = Math.min(1, maxEdge / Math.max(w, h, 1));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)), scaled: s < 1 };
};

/** `IMG_0001.HEIC` → `IMG_0001.jpg`。没有名字也要有个名字。 */
export const jpegName = (name: string): string => `${name.replace(/\.[^.]+$/, '') || 'image'}.jpg`;

/**
 * 一个刚选好的文件 → 可以进本地库的形状。
 * 🔴 **第一步必须是读字节**，其它任何事都排在它后面。
 */
export const readForUpload = async (file: File, kind: AttachmentKind): Promise<Prepared> => {
  const bytes = await file.arrayBuffer();
  const type = file.type || 'application/octet-stream';
  const base: Prepared = { name: file.name, type, size: bytes.byteLength, bytes, downscaled: false };
  if (kind === 'file' || planImage(type, bytes.byteLength) === 'keep') return base;
  try {
    const out = await downscale(new Blob([bytes], { type }));
    // 压完没变小（截屏、已经很小的 JPEG）就用原件；HEIC 例外 —— 它的目的是换格式
    if (!out || (out.byteLength >= bytes.byteLength && WEB_SAFE.test(type))) return base;
    return { name: jpegName(file.name), type: 'image/jpeg', size: out.byteLength, bytes: out, downscaled: true };
  } catch {
    return base; // 解不开的图（别的浏览器碰上 HEIC）原样上传，别因为压不了就丢掉
  }
};

/** 走 `<img>` 而不是 createImageBitmap：只有它在各家浏览器上都按 EXIF 把照片摆正。 */
const downscale = async (blob: Blob): Promise<ArrayBuffer | null> => {
  if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') return null;
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('decode'));
      img.src = url;
    });
    const { w, h } = fitWithin(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    const out = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
    return out ? await out.arrayBuffer() : null;
  } finally {
    URL.revokeObjectURL(url);
  }
};
