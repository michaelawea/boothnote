import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_RECORD_SECONDS, WARN_BEFORE_SECONDS, startRecording } from '../recorder';

/**
 * ══════════════════════════════════════════════════════════════════
 *  录音被掐断时的归宿（issue #28 · D97）
 *
 *  🔴 **上限从 90 秒放到 10 分钟之后，「录到一半被打断」从理论风险变成常发事件。**
 *
 *  iOS 网页没有后台录音（§2.9 / R10）：锁屏、来电、切到别的 App，
 *  都会让 `MediaRecorder` 自己停掉。在 `onInterrupt` 存在之前，
 *  那种情况下 `stop()` 的 Promise **永远不 resolve** —— 界面上计时器还在走，
 *  录音其实早就死了，最后一个字都留不下。
 *  90 秒的上限一直在替我们挡这件事；改成 10 分钟之后就挡不住了。
 *
 *  这个文件守的就是那条判据：
 *  **一个上限值本身是某个失败模式的对策时，改它之前先问那个失败模式怎么办。**
 * ══════════════════════════════════════════════════════════════════ */

/** 一个够用的 MediaRecorder 替身：能停、能报错、能被外力掐断。 */
class FakeRecorder {
  state: 'recording' | 'inactive' = 'recording';
  mimeType = 'audio/webm';
  ondataavailable: ((e: { data: { size: number } }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  static last: FakeRecorder | null = null;
  static isTypeSupported = (m: string) => m === 'audio/webm;codecs=opus';
  constructor() {
    FakeRecorder.last = this;
  }
  start() {}
  /** 我们叫停它。 */
  stop() {
    if (this.state === 'inactive') throw new Error('InvalidStateError');
    this.state = 'inactive';
    this.onstop?.();
  }
  /** 系统把它掐了（锁屏 / 来电）—— 没人调用 `stop()`，它自己就停了。 */
  killedBySystem() {
    this.state = 'inactive';
    this.onstop?.();
  }
}

const track = () => {
  const listeners: Array<() => void> = [];
  return {
    stop: () => {},
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    end: () => listeners.forEach((f) => f()),
  };
};

let audioTrack: ReturnType<typeof track>;

const stub = () => {
  audioTrack = track();
  // ⚠️ 两处都要装：`probe()` 读的是 `window.MediaRecorder`，
  //    而 `new MediaRecorder(...)` 走的是**裸的全局**。只装一处会 ReferenceError。
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('window', {
    isSecureContext: true,
    MediaRecorder: FakeRecorder,
    AudioContext: class {
      createAnalyser() {
        return { fftSize: 0, frequencyBinCount: 8, getByteTimeDomainData: () => {} };
      }
      createMediaStreamSource() {
        return { connect: () => {} };
      }
      close() {
        return Promise.resolve();
      }
    },
  });
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('Blob', class {
    constructor(readonly parts: unknown[], readonly opts: { type: string }) {}
    get type() {
      return this.opts.type;
    }
  });
  vi.stubGlobal('navigator', {
    userAgent: 'test',
    mediaDevices: {
      getUserMedia: () =>
        Promise.resolve({ getTracks: () => [audioTrack], getAudioTracks: () => [audioTrack] }),
    },
  });
};

afterEach(() => vi.unstubAllGlobals());

describe('上限值本身', () => {
  it('10 分钟（issue #28 点名的数字）', () => {
    expect(MAX_RECORD_SECONDS).toBe(600);
  });
  it('🔴 提醒窗口要短于上限 —— 否则一按下录音就在催人', () => {
    expect(WARN_BEFORE_SECONDS).toBeGreaterThan(0);
    expect(WARN_BEFORE_SECONDS).toBeLessThan(MAX_RECORD_SECONDS / 2);
  });
});

describe('正常按停止', () => {
  it('stop() 拿到音频，onInterrupt 一次都不触发', async () => {
    stub();
    const h = await startRecording();
    let interrupted = 0;
    h.onInterrupt(() => interrupted++);
    const r = await h.stop();
    expect(r.mime).toBe('audio/webm');
    expect(interrupted).toBe(0);
  });
});

describe('🔴 被系统掐断（锁屏 / 来电 / 切 App）', () => {
  it('onInterrupt 拿到已经录到的那一段 —— 不是静默丢掉', async () => {
    stub();
    const h = await startRecording();
    const got: Array<{ seconds: number }> = [];
    h.onInterrupt((r) => got.push(r));
    FakeRecorder.last!.killedBySystem();
    expect(got.length).toBe(1);
    expect(got[0]!.seconds).toBeGreaterThanOrEqual(0);
  });

  it('🔴 掐断之后人再按停止 —— stop() 必须 resolve，不能永远吊着', async () => {
    stub();
    const h = await startRecording();
    h.onInterrupt(() => {});
    FakeRecorder.last!.killedBySystem();
    // 界面上那个停止键还在（人没看到掐断的那一瞬），按下去不能卡死
    const r = await h.stop();
    expect(r.mime).toBe('audio/webm');
  });

  it('麦克风被收走（track ended）也算掐断 —— onstop 不是唯一的出口', async () => {
    stub();
    const h = await startRecording();
    let n = 0;
    h.onInterrupt(() => n++);
    audioTrack.end();
    expect(n).toBe(1);
  });

  it('🔴 只结算一次：onstop 和 track ended 先后都触发时不会存成两条', async () => {
    stub();
    const h = await startRecording();
    let n = 0;
    h.onInterrupt(() => n++);
    FakeRecorder.last!.killedBySystem();
    audioTrack.end();
    expect(n).toBe(1);
  });

  it('rec.onerror 同样交出手上那一段', async () => {
    stub();
    const h = await startRecording();
    let n = 0;
    h.onInterrupt(() => n++);
    FakeRecorder.last!.onerror?.();
    expect(n).toBe(1);
  });
});

describe('人自己放弃这一条', () => {
  it('🔴 cancel() 之后 onInterrupt 不触发 —— 他要的就是丢掉它', async () => {
    stub();
    const h = await startRecording();
    let n = 0;
    h.onInterrupt(() => n++);
    h.cancel();
    expect(n).toBe(0);
  });
});
