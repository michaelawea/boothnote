import { afterEach, describe, expect, it, vi } from 'vitest';

import { probe } from '../recorder';

/**
 * 录音能力探测。
 *
 * 这一层是 T8 真机实测的自助诊断依据（「我的」页那一屏），
 * 也是 §2.9c 那条实测事实的守卫：
 *   **Safari 18.4 之前只能录 mp4，之后才有 webm** → 容器必须协商，不能写死。
 */

const stub = (opts: {
  secure?: boolean;
  mediaDevices?: boolean;
  mediaRecorder?: false | string[];
}) => {
  vi.stubGlobal('window', {
    isSecureContext: opts.secure ?? true,
    MediaRecorder:
      opts.mediaRecorder === false
        ? undefined
        : { isTypeSupported: (m: string) => (opts.mediaRecorder as string[]).includes(m) },
  });
  vi.stubGlobal('navigator', {
    mediaDevices: opts.mediaDevices === false ? undefined : { getUserMedia: () => {} },
    userAgent: 'test-agent',
  });
};

afterEach(() => vi.unstubAllGlobals());

describe('probe —— 容器协商与三层诊断', () => {
  it('现代 Chrome：选 webm/opus', () => {
    stub({ mediaRecorder: ['audio/webm;codecs=opus', 'audio/webm'] });
    const d = probe();
    expect(d.chosen).toBe('audio/webm;codecs=opus');
    expect(d.supported).toContain('audio/webm');
  });

  it('🔴 旧版 iOS Safari（18.4 之前）：只有 mp4，也必须能录', () => {
    // 写死只收 webm 的话，这类机器直接废掉 —— 服务端也不能只收一种
    stub({ mediaRecorder: ['audio/mp4'] });
    expect(probe().chosen).toBe('audio/mp4');
  });

  it('新版 iOS Safari（18.4 起）：webm 优先于 mp4', () => {
    stub({ mediaRecorder: ['audio/webm', 'audio/mp4'] });
    expect(probe().chosen).toBe('audio/webm');
  });

  it('非 secure context → 明确报出来（局域网 IP 测手机时的典型症状）', () => {
    stub({ secure: false, mediaRecorder: ['audio/webm'] });
    expect(probe().secureContext).toBe(false);
  });

  it('mediaDevices 缺失 → 单独一项，便于区分「不是 https」还是「被 iframe 挡了」', () => {
    stub({ mediaDevices: false, mediaRecorder: ['audio/webm'] });
    const d = probe();
    expect(d.hasMediaDevices).toBe(false);
    expect(d.hasMediaRecorder).toBe(true);
  });

  it('完全没有 MediaRecorder → chosen 为 null，不抛异常', () => {
    stub({ mediaRecorder: false });
    const d = probe();
    expect(d.hasMediaRecorder).toBe(false);
    expect(d.chosen).toBeNull();
    expect(d.supported).toEqual([]);
  });
});
