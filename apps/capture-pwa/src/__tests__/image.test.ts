import { describe, expect, it } from 'vitest';

import { JPEG_QUALITY, MAX_EDGE, SKIP_BELOW, fitWithin, jpegName, planImage, readForUpload } from '../image';

/**
 * 附件进库前的两步（D132 · issue #53）：先读字节、图片压小。
 * 压图那一段要 DOM，这里守的是**判断规则**和「没有 DOM 时原样退回、绝不丢文件」。
 */

describe('planImage：什么样的图要转', () => {
  it('不是图片的一律原样（PDF / 表格）', () => {
    expect(planImage('application/pdf', 50 << 20)).toBe('keep');
    expect(planImage('application/octet-stream', 50 << 20)).toBe('keep');
  });
  it('小图不折腾 —— 截屏重新编码只会变大', () => {
    expect(planImage('image/png', SKIP_BELOW)).toBe('keep');
    expect(planImage('image/jpeg', 100 * 1024)).toBe('keep');
  });
  it('iPhone 原图（大 JPEG）要转', () => {
    expect(planImage('image/jpeg', SKIP_BELOW + 1)).toBe('jpeg');
    expect(planImage('image/jpeg', 3.7 * 1024 * 1024)).toBe('jpeg');
  });
  it('HEIC 不管多小都转 —— 目的是换成谁都能显示的格式', () => {
    expect(planImage('image/heic', 10)).toBe('jpeg');
    expect(planImage('image/heif', 10)).toBe('jpeg');
  });
});

describe('fitWithin：长边封顶、等比', () => {
  it('够小就原尺寸', () => {
    expect(fitWithin(800, 600)).toEqual({ w: 800, h: 600, scaled: false });
  });
  it('横图按宽缩', () => {
    expect(fitWithin(4032, 3024)).toEqual({ w: MAX_EDGE, h: 1536, scaled: true });
  });
  it('竖图按高缩', () => {
    expect(fitWithin(3024, 4032)).toEqual({ w: 1536, h: MAX_EDGE, scaled: true });
  });
  it('0 尺寸不除零', () => {
    expect(fitWithin(0, 0).w).toBeGreaterThan(0);
  });
  it('质量参数在「看得清铭牌」和「几百 KB」之间', () => {
    expect(JPEG_QUALITY).toBeGreaterThan(0.7);
    expect(JPEG_QUALITY).toBeLessThan(0.95);
  });
});

describe('jpegName', () => {
  it('换后缀、留主名', () => {
    expect(jpegName('IMG_0001.HEIC')).toBe('IMG_0001.jpg');
    expect(jpegName('展台照片 ①.png')).toBe('展台照片 ①.jpg');
  });
  it('没有名字也要有名字', () => {
    expect(jpegName('')).toBe('image.jpg');
    expect(jpegName('.heic')).toBe('image.jpg');
  });
});

describe('readForUpload：没有 DOM 时', () => {
  const big = new Uint8Array(SKIP_BELOW + 10);
  it('🔴 第一步是读字节 —— 出来的一定是 ArrayBuffer，大小和文件一样', async () => {
    const f = new File([big], 'stand.jpg', { type: 'image/jpeg' });
    const p = await readForUpload(f, 'photo');
    expect(p.bytes).toBeInstanceOf(ArrayBuffer);
    expect(p.bytes.byteLength).toBe(big.byteLength);
    expect(p.size).toBe(big.byteLength);
  });
  it('压不了（没有 canvas）就原样退回，名字和类型都不动 —— 绝不因为压不了而丢文件', async () => {
    const f = new File([big], 'stand.jpg', { type: 'image/jpeg' });
    const p = await readForUpload(f, 'photo');
    expect(p.downscaled).toBe(false);
    expect(p.name).toBe('stand.jpg');
    expect(p.type).toBe('image/jpeg');
  });
  it('file 入口不压，哪怕是张图', async () => {
    const f = new File([big], 'scan.jpg', { type: 'image/jpeg' });
    const p = await readForUpload(f, 'file');
    expect(p.downscaled).toBe(false);
    expect(p.bytes.byteLength).toBe(big.byteLength);
  });
  it('没有 mime 的文件补成 octet-stream', async () => {
    const f = new File([new Uint8Array(3)], 'x');
    expect((await readForUpload(f, 'file')).type).toBe('application/octet-stream');
  });
});
