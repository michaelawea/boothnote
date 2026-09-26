import type { Note, SyncState } from './db';
import { t } from './i18n';

/**
 * 「这条要不要现在传」的判据 —— **纯逻辑，好测**。
 *
 * 单独抽出来是因为它错过一次，而且错得很难发现：
 * 2026-08-03 有一条带附件的速记「点了上传就没下文了」，服务器上从来没收到。
 * 复盘出三条路径，每一条都会让一条速记**永久卡住而且界面上看不出来**：
 *
 *   ① `syncing` 是个死状态。上传中途关页面 / 热重载 / 切走，那条就永远停在
 *      `syncing` —— 而 `flush()` 只捞 `queued` 和 `failed`，界面上的「待传 N」
 *      也只数这两种。于是它**既不会被重传，也不会被显示**，凭空消失。
 *   ② 攒够 8 次失败之后 `continue` 掉，**一声不吭**。人点「待传 N」，
 *      flush 跑一圈什么都没做，看起来就是「点了没反应」。
 *   ③ `fetch` 没有超时。一次挂住的上传会让 `running` 永远是 true，
 *      **整个队列从此不动**。
 *
 * 三条的共同点：**失败得很安静**。所以判据要写成能单独断言的函数。
 */

/** 自动重试的上限。到顶之后不再自动传，但**人手动点仍然可以**（见下）。 */
export const MAX_ATTEMPTS = 8;

/**
 * 界面上的「待传」要数哪些状态。
 *
 * 🔴 **`syncing` 必须算进去。** 它不算「传完了」，而一条卡在 `syncing` 的速记
 * 如果不显示，人就完全不知道它存在 —— 那是最糟的一种：数据在，但没人知道要救它。
 */
export const PENDING_STATES: SyncState[] = ['queued', 'failed', 'syncing'];

/**
 * 应用启动时，把上一次没走完的 `syncing` 掰回 `queued`。
 *
 * 判据很简单：**应用刚起来的时候，不可能有正在飞的请求**。
 * 所以此刻还是 `syncing` 的，一定是上次被中断的。
 */
export const isStuckUploading = (n: Pick<Note, 'sync'>) => n.sync === 'syncing';

/**
 * 该不该传这一条。
 *
 * `manual` = 人自己点了「待传 N」。**人点了就一定要试一次** ——
 * 否则「点了没反应」这件事会让人以为整个应用坏了，
 * 而实际上数据好好地躺在本地。
 */
export const shouldUpload = (
  n: Pick<Note, 'sync' | 'attempts'>,
  { manual = false } = {},
): boolean => {
  if (n.sync === 'synced') return false;
  if (manual) return true;
  return n.attempts < MAX_ATTEMPTS;
};

/** 单次上传的超时。没有它，一次挂住的请求会把整个队列永远堵死。 */
export const UPLOAD_TIMEOUT_MS = 90_000;

/** 超时上限。再长就不是「慢」而是「挂了」，该让它失败、让人看到。 */
export const UPLOAD_TIMEOUT_MAX_MS = 600_000;

/**
 * 按体积放大的超时（issue #53 B1）。
 *
 * 90 秒对一句话够用，对一张 iPhone 原图不够：展馆里 4G 上行几十 KB/s 是常态，
 * 5 MB 在 60 KB/s 以下**必然**超时，然后从零重传、再超时，8 次之后停下 ——
 * 这 4 分钟里没有一个字节被服务端收下。按 20 KB/s 的下限给每个字节留时间，
 * 封顶 10 分钟。图片进来先压过（`image.ts`），所以正常情况下加的那一段很短。
 */
export const uploadTimeoutFor = (bytes: number): number =>
  Math.min(UPLOAD_TIMEOUT_MAX_MS, UPLOAD_TIMEOUT_MS + Math.ceil(Math.max(0, bytes) / 20_000) * 1000);

/** 给人看的一句话。**不要只显示「失败」** —— 那等于什么都没说。 */
export const syncLabel = (n: Pick<Note, 'sync' | 'attempts' | 'lastError'>): string => {
  if (n.sync === 'synced') return '';
  if (n.sync === 'syncing') return t('正在传…');
  if (n.sync === 'queued') return t('待传');
  if (n.attempts >= MAX_ATTEMPTS) return t('传了 {n} 次都没成功 · 点这里再试', { n: n.attempts });
  // `lastError` 存的是中文原文（数据里不放译文，见 sync.ts 那段），显示时才翻
  if (n.lastError) return t(n.lastError);
  return t('传失败（第 {n} 次）', { n: n.attempts });
};
