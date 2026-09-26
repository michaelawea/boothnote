import { describe, expect, it } from 'vitest';

import { MAX_ATTEMPTS, PENDING_STATES, isStuckUploading, shouldUpload, syncLabel } from '../retry';

/**
 * 上传队列的判据。
 *
 * 🐛 这一组全部来自一次真实事故（2026-08-03）：一条带附件的速记
 * 「点了上传就没下文了」，服务器上从来没收到，而界面上也看不出它还在。
 * 复盘出三条**各自都会让速记永久卡住、而且很安静**的路径，
 * 下面每一条都对应一个用例。
 */

const note = (over: Partial<{ sync: any; attempts: number; lastError: string }> = {}) => ({
  sync: 'queued' as const,
  attempts: 0,
  ...over,
});

describe('① syncing 是个死状态', () => {
  it('「待传」要把 syncing 算进去 —— 不显示的话人根本不知道它存在', () => {
    expect(PENDING_STATES).toContain('syncing');
    expect(PENDING_STATES).toContain('queued');
    expect(PENDING_STATES).toContain('failed');
    expect(PENDING_STATES).not.toContain('synced');
  });

  it('启动时认得出卡住的那条', () => {
    expect(isStuckUploading({ sync: 'syncing' })).toBe(true);
    expect(isStuckUploading({ sync: 'queued' })).toBe(false);
    expect(isStuckUploading({ sync: 'synced' })).toBe(false);
  });

  it('卡在 syncing 的照样要传 —— 不然它永远出不去', () => {
    expect(shouldUpload(note({ sync: 'syncing' }))).toBe(true);
  });
});

describe('② 攒够次数之后不能一声不吭', () => {
  it('自动重试到上限就停 —— 免得白白烧掉一个又一个请求', () => {
    expect(shouldUpload(note({ sync: 'failed', attempts: MAX_ATTEMPTS - 1 }))).toBe(true);
    expect(shouldUpload(note({ sync: 'failed', attempts: MAX_ATTEMPTS }))).toBe(false);
  });

  it('🔴 但人手动点了就一定要试一次', () => {
    expect(shouldUpload(note({ sync: 'failed', attempts: 99 }), { manual: true })).toBe(true);
  });

  it('已经传上去的，手动点也不重传', () => {
    expect(shouldUpload(note({ sync: 'synced' }), { manual: true })).toBe(false);
  });
});

describe('③ 状态文案要说人话', () => {
  it('到上限时告诉人「点这里再试」，而不是只说失败', () => {
    const s = syncLabel(note({ sync: 'failed', attempts: MAX_ATTEMPTS }));
    expect(s).toMatch(/再试/);
  });

  it('正在传和待传是两回事，不能都写「待传」', () => {
    expect(syncLabel(note({ sync: 'syncing' }))).toBe('正在传…');
    expect(syncLabel(note({ sync: 'queued' }))).toBe('待传');
  });

  it('失败几次要写出来 —— 「失败」两个字等于什么都没说', () => {
    expect(syncLabel(note({ sync: 'failed', attempts: 3 }))).toMatch(/3/);
  });

  it('传完了不占位置', () => {
    expect(syncLabel(note({ sync: 'synced' }))).toBe('');
  });
});

// ══════════════════════════════════════════════════════════════════
//  issue #53 B1：超时要跟着体积走
// ══════════════════════════════════════════════════════════════════
import { UPLOAD_TIMEOUT_MAX_MS, UPLOAD_TIMEOUT_MS, uploadTimeoutFor } from '../retry';

describe('④ 超时按体积放大（issue #53 B1）', () => {
  it('一句话还是 90 秒', () => {
    expect(uploadTimeoutFor(0)).toBe(UPLOAD_TIMEOUT_MS);
    expect(uploadTimeoutFor(-5)).toBe(UPLOAD_TIMEOUT_MS);
  });
  it('一张 4 MB 原图在 20 KB/s 上也给得够', () => {
    const ms = uploadTimeoutFor(4 * 1024 * 1024);
    expect(ms).toBeGreaterThanOrEqual(UPLOAD_TIMEOUT_MS + (4 * 1024 * 1024) / 20_000 * 1000);
  });
  it('封顶 10 分钟 —— 再长就不是慢，是挂了', () => {
    expect(uploadTimeoutFor(500 << 20)).toBe(UPLOAD_TIMEOUT_MAX_MS);
  });
});
