/**
 * 决策窗口：自由文本 → 日期。
 *
 * 现场听到的是「Q4 前定供应商」「2027 年年中」「MY2027 已锁」这种，
 * 而 `opportunity.nextDecisionWindow` 是 DATE —— 不转就永远是空的，
 * 「按决策窗口排的机会列表」（§7.3，大领导要的第 2 类分类）就排不出来。
 *
 * 🔴 **认不出就返回 null，绝不猜。**
 *
 * 一个猜错的日期比没有日期糟得多：没有日期，人知道要去问；
 * 有一个错的日期，看板会把这家排到错的时间段里，而**没有任何迹象表明它是猜的**。
 * 原文永远保留在 `extracted.decisionWindow` 与拜访小结里，转不出来也不丢。
 *
 * 取的是那段时间的**最后一天** —— 「Q4 前定」的截止是 Q4 结束，不是开始。
 */

/** 那个月的最后一天。用 UTC，避免跑在不同时区的机器上差一天。 */
const endOfMonth = (year: number, month1: number): string => {
  // Date.UTC 的 day=0 表示「上个月的最后一天」，所以传下个月
  const d = new Date(Date.UTC(year, month1, 0));
  return d.toISOString().slice(0, 10);
};

const inRange = (y: number) => y >= 2020 && y <= 2100;

export const parseDecisionWindow = (raw: string | null | undefined): string | null => {
  const s = String(raw ?? '').trim();
  if (!s) return null;

  // ── 完整日期：2026-12-31 / 2026/12/31 ──────────────────────────
  const ymd = s.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (ymd) {
    const [y, m, d] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
    if (inRange(y) && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // ── 季度：2026 Q4 / Q4 2026 / 2026年第四季度 ────────────────────
  // 「年在前」和「季在前」现场都会出现，所以不管顺序 —— 各找各的。
  // 一句话里同时出现两个年份的情况不存在（真出现了，取第一个也不比猜差）。
  const year = Number(s.match(/(20\d{2})/)?.[1]);
  const CN_Q: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4 };
  const quarter =
    Number(s.match(/Q\s*([1-4])/i)?.[1]) ||
    CN_Q[s.match(/第?\s*([一二三四])\s*季度/)?.[1] ?? ''] ||
    Number(s.match(/第?\s*([1-4])\s*季度/)?.[1]);
  if (inRange(year) && quarter >= 1 && quarter <= 4) return endOfMonth(year, quarter * 3);

  // ── 年月：2026-09 / 2026/9 / 2026年9月 / Sep 2026 ───────────────
  const ym = s.match(/(20\d{2})\s*[-/年.]\s*(\d{1,2})\s*月?/);
  if (ym) {
    const [y, m] = [Number(ym[1]), Number(ym[2])];
    if (inRange(y) && m >= 1 && m <= 12) return endOfMonth(y, m);
  }
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const en = s.toLowerCase().match(/\b([a-z]{3})[a-z]*\.?\s*,?\s*(20\d{2})\b/);
  if (en) {
    const m = MONTHS.indexOf(en[1]!) + 1;
    const y = Number(en[2]);
    if (m >= 1 && inRange(y)) return endOfMonth(y, m);
  }

  // ── 光一个年份：2027 / MY2027 ──────────────────────────────────
  // 车型年（MY2027）说的就是那一年，落到年底
  const only = s.match(/(?:^|[^\d])(?:MY)?\s*(20\d{2})(?:[^\d]|$)/i);
  if (only) {
    const y = Number(only[1]);
    if (inRange(y)) return `${y}-12-31`;
  }

  return null; // 认不出。原文留在 extracted 与小结里，不丢。
};
