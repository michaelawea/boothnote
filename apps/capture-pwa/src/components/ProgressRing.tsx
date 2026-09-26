import { T } from '../theme';
import { t } from '../i18n';

/**
 * 上传进度圈。
 *
 * 🔴 **它回答的是一个很具体的问题：「传上去了吗？」**
 *
 * 传一张 8 MB 的展台照片，在展馆的 4G 上要十几秒。这十几秒里如果界面上
 * 只有「待传」两个字，人不知道它是在传、卡住了、还是已经完了 ——
 * **不知道的时候他会再点一次**。2026-08-03 就是这么来的：连按 5 次，
 * 5 条速记、5 条对话、5 轮模型。
 *
 * `value`：0–1 是百分比；`-1` 或 `undefined` = 拿不到总大小，退化成转圈。
 * **宁可转圈也不显示一个编出来的百分比** —— 假进度比没有进度更坏，
 * 它会让人相信一个不存在的剩余时间。
 */
export const ProgressRing = ({
  value,
  size = 16,
  color = T.blue,
}: {
  value?: number;
  size?: number;
  color?: string;
}) => {
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const known = typeof value === 'number' && value >= 0;
  const pct = known ? Math.min(1, Math.max(0, value)) : 0;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{
        flexShrink: 0,
        // 拿不到总大小时就整体转起来，明确表示「在动，但不知道还剩多少」
        animation: known ? undefined : 'spin 1.1s linear infinite',
      }}
      aria-label={known ? t('已上传 {a}%', { a: Math.round(pct * 100) }) : t('上传中')}
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={T.line} strokeWidth={2} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        // 未知进度时画 1/4 圈，转起来就是一个标准的 spinner
        strokeDasharray={c}
        strokeDashoffset={known ? c * (1 - pct) : c * 0.75}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: known ? 'stroke-dashoffset .25s linear' : undefined }}
      />
    </svg>
  );
};
