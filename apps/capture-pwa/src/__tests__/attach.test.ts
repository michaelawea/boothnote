import { describe, expect, it } from 'vitest';

import { MAX_BYTES, MAX_COUNT, addFiles, attachmentBlob, attachmentCount, humanSize, kindLabel } from '../attach';
import type { LocalAttachment } from '../db';

/**
 * 附件的准入规则。
 *
 * 这一组守的是一件很具体的事：**附件不能把 IndexedDB 的配额吃光。**
 * 配额吃光的后果不是「传不了附件」，是**连速记都写不进去** ——
 * 而离线时还能录，是这套系统唯一不能出的事。
 */

const file = (name: string, size: number, type = 'image/jpeg') => ({
  name,
  type,
  size,
  bytes: new ArrayBuffer(1),
});

describe('addFiles', () => {
  it('正常加进去，类型跟着按钮走', () => {
    const r = addFiles([], [file('a.jpg', 1000)], 'photo');
    expect(r.ok).toBe(true);
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0]!.kind).toBe('photo');
  });

  it('超过单个上限就拒绝', () => {
    const r = addFiles([], [file('big.pdf', MAX_BYTES + 1, 'application/pdf')], 'file');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('big.pdf');
  });

  it('空文件拒绝 —— 传上去解析器也只会得到一句「空文件」', () => {
    const r = addFiles([], [file('empty.pdf', 0)], 'file');
    expect(r.ok).toBe(false);
  });

  it(`最多 ${MAX_COUNT} 个`, () => {
    const many = Array.from({ length: MAX_COUNT + 2 }, (_, i) => file(`f${i}.jpg`, 100));
    const r = addFiles([], many, 'image');
    expect(r.ok).toBe(false);
    expect(r.attachments).toHaveLength(MAX_COUNT);
  });

  it('🔴 拒绝时不能把已经加好的弄没了', () => {
    const existing: LocalAttachment[] = [
      { kind: 'photo', name: 'ok.jpg', mime: 'image/jpeg', size: 10, bytes: new ArrayBuffer(10) },
    ];
    const r = addFiles(existing, [file('huge.bin', MAX_BYTES + 1)], 'file');
    expect(r.ok).toBe(false);
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0]!.name).toBe('ok.jpg');
  });

  it('没有文件名时也不会生成空名字', () => {
    const r = addFiles([], [file('', 100)], 'photo');
    expect(r.attachments[0]!.name).toMatch(/^photo-/);
  });

  it('没有 mime 时回落到 octet-stream，而不是空串', () => {
    const r = addFiles([], [file('x.weird', 100, '')], 'file');
    expect(r.attachments[0]!.mime).toBe('application/octet-stream');
  });
});

describe('humanSize', () => {
  it('小文件用 KB，大文件用 MB', () => {
    expect(humanSize(2048)).toBe('2 KB');
    expect(humanSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('几百字节也显示 1 KB，不显示 0 KB —— 「0 KB」看起来像出错了', () => {
    expect(humanSize(300)).toBe('1 KB');
  });
});

// ══════════════════════════════════════════════════════════════════
//  D132 · issue #53：附件是字节，不是句柄
// ══════════════════════════════════════════════════════════════════
describe('附件的字节（D132 · issue #53）', () => {
  it('🔴 进库的是 ArrayBuffer，不是 File —— iOS 上 File 存进 IndexedDB 读回来是死的', () => {
    const r = addFiles([], [file('a.jpg', 3)], 'photo');
    expect(r.ok).toBe(true);
    expect(r.attachments[0]!.bytes).toBeInstanceOf(ArrayBuffer);
    expect(r.attachments[0]!.blob).toBeUndefined();
  });

  it('attachmentBlob：字节 → 带 mime 的 Blob，大小一个不差', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const b = attachmentBlob({ bytes, mime: 'image/jpeg' })!;
    expect(b.size).toBe(4);
    expect(b.type).toBe('image/jpeg');
    expect(new Uint8Array(await b.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('attachmentBlob：2026-09-02 之前存的 File 照样交出去（能不能读是浏览器的事）', () => {
    const legacy = new Blob(['old']);
    expect(attachmentBlob({ blob: legacy, mime: 'image/png' })).toBe(legacy);
    expect(attachmentBlob({ mime: 'image/png' })).toBeNull();
  });

  it('attachmentCount：本地原件优先，没有就数服务端清单', () => {
    const local: LocalAttachment = { kind: 'photo', name: 'a', mime: 'image/jpeg', size: 1, bytes: new ArrayBuffer(1) };
    const remote = { id: 'r1', kind: 'photo' as const, name: 'a', mime: 'image/jpeg', size: 1 };
    expect(attachmentCount({})).toBe(0);
    expect(attachmentCount({ attachments: [local] })).toBe(1);
    expect(attachmentCount({ remoteAttachments: [remote, remote] })).toBe(2);
    // 上传成功那一刻：attachments 清空、remoteAttachments 填上 —— 📎 不能闪没
    expect(attachmentCount({ attachments: undefined, remoteAttachments: [remote] })).toBe(1);
  });

  it('kindLabel 是函数：每次调用才翻译（模块级常量会在 import 时定死语言）', () => {
    expect(typeof kindLabel).toBe('function');
    expect(kindLabel('photo')).toBe('拍照');
    expect(kindLabel('file')).toBe('文件');
  });
});
