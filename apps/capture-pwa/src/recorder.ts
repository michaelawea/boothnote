import { t } from './i18n';
/**
 * 录音封装 —— 这一层专门用来对付 iOS Safari。
 *
 * 已查证的事实（§2.9 / R10）：
 *  · Safari 18.4（2025-03）之前只能录 `audio/mp4`；之后才支持 webm/ogg/fMP4。
 *    → 容器必须**协商**，不能写死；服务端也不能只收 webm。
 *  · MediaRecorder 需要 secure context。`localhost` 算，**局域网 IP 不算** ——
 *    用手机连 Mac 的 192.168.x.x 测会直接拿不到 mediaDevices（用 cloudflared 给个 https 域名）。
 *  · iOS 网页**没有后台录音**：锁屏或切 App 会掐断录音。
 *    ⚠️ 这条事实没变，变的是我们怎么对付它 —— 见下面 `MAX_RECORD_SECONDS` 和 `onInterrupt`。
 */

/**
 * 单次录音上限（issue #28，维护者 2026-08-08：
 * 「90 秒可能不够……希望将单次录音的最长时长扩展到 10 分钟」）。
 *
 * 🔴 **90 → 600 之后，「iOS 会掐断录音」从理论风险变成了常发事件。**
 *
 * 原来 90 秒的上限本身就是那条限制的**对策**：一口气说完不到两分钟，
 * 中途切 App 的概率很低。放到 10 分钟之后，接个电话、看一眼别的 App、
 * 屏幕自动锁屏 —— 每一样都会掐断录音，而且**在这一层是静默的**：
 * `MediaRecorder` 自己停掉，`stop()` 那个 Promise 永远不 resolve，
 * 于是「录了七分钟，一个字都没留下」，人还在盯着一个不动的计时器。
 *
 * 所以这个数字不能单独改。它必须和 `onInterrupt` 一起上 ——
 * **被掐断时把已经录到的那一段交出来**，让调用方存下来。
 * 判据：**一个上限值本身就是某个失败模式的对策时，改它之前先问那个失败模式怎么办。**
 */
export const MAX_RECORD_SECONDS = 600;

/** 快到点时开始提醒还剩多久。10 分钟的录音不需要从第 75 秒就开始催。 */
export const WARN_BEFORE_SECONDS = 30;

/** 按优先级协商容器。第一个被浏览器认可的就用它。 */
const CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
];

export type RecorderDiagnostics = {
  secureContext: boolean;
  hasMediaDevices: boolean;
  hasMediaRecorder: boolean;
  supported: string[];
  chosen: string | null;
  userAgent: string;
};

/** 不申请权限也能跑，用来在界面上显示「这台设备到底行不行」。 */
export const probe = (): RecorderDiagnostics => {
  const hasMR = typeof window.MediaRecorder !== 'undefined';
  const supported = hasMR
    ? CANDIDATES.filter((m) => window.MediaRecorder.isTypeSupported?.(m))
    : [];
  return {
    secureContext: window.isSecureContext,
    hasMediaDevices: Boolean(navigator.mediaDevices?.getUserMedia),
    hasMediaRecorder: hasMR,
    supported,
    chosen: supported[0] ?? null,
    userAgent: navigator.userAgent,
  };
};

export type Recorded = { blob: Blob; mime: string; seconds: number };

export type RecordingHandle = {
  stop: () => Promise<Recorded>;
  cancel: () => void;
  /** 0–1，用来画音量条：让人看得见「它真的在听」 */
  onLevel: (cb: (level: number) => void) => void;
  /**
   * 录音**不是我们叫停的**（issue #28）。
   *
   * 🔴 iOS 上锁屏 / 切 App / 别的 App 抢走麦克风，都会让 `MediaRecorder`
   * 自己停掉。在这个回调之前，那种情况下 `stop()` 的 Promise **永远不 resolve** ——
   * 界面上计时器还在走，而录音其实早就死了，最后什么都没存下来。
   * 90 秒的上限一直在替我们挡这件事；改成 10 分钟之后就挡不住了。
   *
   * 回调拿到的是**已经录到的那一段**（`ondataavailable` 每 250ms 落一块，
   * 最多丢最后那 250 毫秒）。调用方该做的事只有一件：**当成正常录完存下来**，
   * 然后如实告诉人「录音被打断了，已经存下前 N 秒」。
   */
  onInterrupt: (cb: (r: Recorded) => void) => void;
};

export class RecorderError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

export const startRecording = async (): Promise<RecordingHandle> => {
  const d = probe();
  if (!d.secureContext)
    throw new RecorderError(
      t('当前不是 secure context'),
      t('需要 https 或 localhost。用手机连局域网 IP 不行 —— 跑 `npm run tunnel` 拿一个 https 地址。'),
    );
  if (!d.hasMediaDevices)
    throw new RecorderError(
      t('navigator.mediaDevices 不可用'),
      t('要么不是 secure context，要么被上层 iframe 的 permissions policy 挡住了。'),
    );
  if (!d.hasMediaRecorder)
    throw new RecorderError(t('浏览器没有 MediaRecorder'), t('需要 iOS 14.3+ / 现代 Chrome。'));

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  const mime = d.chosen ?? undefined;
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
  rec.start(250);
  const startedAt = Date.now();

  // 音量分析
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  let raf = 0;
  let levelCb: ((n: number) => void) | null = null;
  const tick = () => {
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    levelCb?.(Math.min(1, peak / 60));
    raf = requestAnimationFrame(tick);
  };
  tick();

  const teardown = () => {
    cancelAnimationFrame(raf);
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => undefined);
  };

  /** 把手上已有的块封成一段录音。**随时可调** —— 被打断时用的也是它。 */
  const collect = (): Recorded => {
    const actual = rec.mimeType || mime || 'audio/webm';
    return {
      blob: new Blob(chunks, { type: actual }),
      mime: actual,
      seconds: Math.round((Date.now() - startedAt) / 1000),
    };
  };

  /**
   * 这一段录音的归宿只可能是三者之一，而且**只能发生一次**。
   *
   * `settled` 不是防御性代码：`rec.onstop` 和 track 的 `ended` 在
   * 「切到后台」这一种情况下会**先后都触发**，不挡的话同一段录音会被存两遍。
   */
  let outcome: 'recording' | 'stopping' | 'cancelled' = 'recording';
  let settled = false;
  /** 结算出来的那一段。留着，好让「打断之后又按了一下停止」也能拿到东西。 */
  let final: Recorded | null = null;
  let interruptCb: ((r: Recorded) => void) | null = null;
  let resolveStop: ((r: Recorded) => void) | null = null;

  /** 录音结束了 —— 分清是我们叫停的，还是被掐断的。 */
  const settle = () => {
    if (settled) return;
    settled = true;
    teardown();
    if (outcome === 'cancelled') return; // 人自己不要这一条，什么都不用交出去
    final = collect();
    if (resolveStop) resolveStop(final);
    else interruptCb?.(final); // 🔴 没人在等 stop() → 是被打断的
  };

  rec.onstop = settle;
  /**
   * 🔴 `onstop` 不是唯一的出口。
   *
   * 麦克风被系统收走时（iOS 锁屏、来电、别的 App 抢占），先断的是 **track**；
   * `MediaRecorder` 在有些实现里会跟着停、有些不会 —— 只听 `onstop` 的话，
   * 后一种就是「计时器还在走，麦克风已经不在了」，录出来的是一段静音。
   * 两个入口都接上，靠 `settled` 保证只结算一次。
   */
  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      if (outcome === 'recording' && rec.state !== 'inactive') {
        try {
          rec.stop(); // 走上面那条 onstop
        } catch {
          settle(); // 停不动就直接结算，别把已经录到的丢了
        }
      } else settle();
    });
  }
  rec.onerror = () => settle();

  return {
    onLevel: (cb) => {
      levelCb = cb;
    },
    onInterrupt: (cb) => {
      interruptCb = cb;
    },
    cancel: () => {
      outcome = 'cancelled';
      try {
        rec.stop();
      } catch {
        /* 已经停了 */
      }
      teardown();
    },
    stop: () =>
      new Promise<Recorded>((resolve) => {
        /**
         * 🔴 **它可能已经自己停了**（被掐断，走了 `onInterrupt` 那条路）。
         *
         * 那种情况下 `settle()` 早就跑完、`settled` 是 true，
         * 再走一遍下面的流程等于**这个 Promise 永远不 resolve** ——
         * 界面永久卡在「录音中」，而录音其实还在手上。
         * 所以先把已经结算过的那份交出去。
         */
        if (settled) return resolve(final ?? collect());
        outcome = 'stopping';
        resolveStop = resolve;
        // `rec.stop()` 对一个已经 inactive 的 recorder 会抛 InvalidStateError
        if (rec.state === 'inactive') settle();
        else
          try {
            rec.stop();
          } catch {
            settle();
          }
      }),
  };
};
