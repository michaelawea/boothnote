import { CONFIDENCE_LABELS, CONFIDENCE_LABELS_EN, labelsFor, type Locale } from '../agent/src/enums.ts';
import type { IntelItem } from './twenty.ts';

/**
 * 情报缺口的计算 —— **纯函数，一行网络请求都不发**（D17③）。
 *
 * 抽出来的理由不是好看：这段逻辑原来在**三个地方各写一遍**
 * （`/gaps` 端点、agent 的 `get_company_gaps`、以及本来就该有却一直没有的
 * 「写回 Company 的存储字段」）。三份实现迟早会算出三个不同的完整度，
 * 而分歧的表现是「界面上 40%、agent 说还缺 3 项、视图里排在最前面」——
 * 三个都不报错，谁也说不清哪个对。
 *
 * 🔴 **答案有两种落点，这里必须都认**（D17② / §4.4 的三段式）：
 *   · `itemKey` 就是 `Company` 上的列名  → 看 `company[itemKey]` 有没有值
 *   · `itemKey` 是自定义键（客户档案上没有这一列）→ 看 `intelValue` 里有没有这一行
 * 只认一种的话，另一种问过多少遍都还是「缺」。
 */

export type IntelValueRow = {
  intelItem?: { id?: string; itemKey?: string; question?: string; questionEn?: string } | null;
  valueText?: string | null;
  valueNumber?: number | null;
  confidence?: string | null;
  sourceName?: string | null;
  recordedAt?: string | null;
  recordedBy?: { name?: string } | null;
};

export type Gaps = {
  totalItems: number;
  /** 没有任何**有权重**的项时是 null —— **`null` 和 `0%` 不是一回事** */
  completeness: number | null;
  missing: Array<{ key: string; question: string; wave: number | null; weight: number | null }>;
  known: Array<{
    key: string;
    question: string;
    value: string;
    confidence: string | null;
    confidenceLabel: string | null;
    isRumor: boolean;
    sourceName: string | null;
    recordedAt: string | null;
    by: string | null;
  }>;
};

/**
 * 问法与可信度标签按语言取。**英文缺就退回中文**（和 `labelsFor` 同一条判据）。
 *
 * 🔴 **只有这两样跟语言走，`key` / `value` 一个字不动。**
 * `value` 是现场记下的原话，`key` 是机器判据 —— 它们随语言变就是 D80 那条
 * 「数据路径存规范形式，只有渲染那一层才翻译」被推翻。
 */
const questionIn = (L: Locale, zh: string | undefined, en: string | undefined) =>
  (L === 'en' ? en || zh : zh) ?? '';

export const computeGaps = (
  items: IntelItem[],
  values: IntelValueRow[],
  company: Record<string, any>,
  /**
   * 界面语言。**默认 `zh` 是刻意的** —— 四个调用点里只有 `/gaps/:code`
   * 是给人看的；agent 的 `get_company_gaps` 和 `confirm.ts` 的完整度重算
   * 都不该因为谁在用而变。
   */
  locale: Locale = 'zh',
): Gaps => {
  const conf = labelsFor(locale, CONFIDENCE_LABELS, CONFIDENCE_LABELS_EN);
  const active = items.filter((i) => i.isEnabled && i.appliesTo === 'company');
  const filled = new Set(values.map((v) => v.intelItem?.itemKey).filter(Boolean) as string[]);

  const isBlank = (v: unknown) =>
    v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

  const missing = active.filter((i) => !filled.has(i.itemKey) && isBlank(company[i.itemKey]));

  /**
   * 完整度只按**有权重**的项算。agent 造的那些 weight=0，不进分母 ——
   * 否则它造得越多，所有客户的完整度看起来越低，那个指标当场作废（D47 护栏③）。
   */
  const scored = active.filter((i) => (i.weight ?? 0) > 0);
  const missingSet = new Set(missing);
  const got = scored.filter((i) => !missingSet.has(i)).reduce((s, i) => s + (i.weight ?? 0), 0);
  const total = scored.reduce((s, i) => s + (i.weight ?? 0), 0);

  const byItem = new Map(active.map((i) => [i.id, i]));

  /**
   * 🔴 **答案有两种落点，`known` 也要都认**（issue #6）。
   *
   * 上面 `missing` 已经两种都认了（`filled` 看 intelValue，`isBlank` 看 Company 列），
   * 而 `known` 原来**只从 `intelValue` 取** —— 于是落在 Company 列上的那些
   * （年产量 / 车型 / 定位 / 总部 / 集团排名…）**进了完整度的分子，却一条都不显示**。
   *
   * 实测（2026-08-04 生产）：Havel 完整度 23%、还缺 14 项，
   * 而「已经知道的」整块是空的 —— 人看到一个 23% 但看不见它是怎么来的，
   * 分子分母对不上，这个数字就没法信。
   *
   * ⚠️ 档案列上的值没有「可信度」这一说（它不是某次现场记录，是客户档案），
   *    所以 `confidence` 留 null、`isRumor` 为 false —— 界面上不给它标。
   */
  const fromColumns = active
    .filter((i) => !filled.has(i.itemKey) && !isBlank(company[i.itemKey]))
    .map((i) => ({
      key: i.itemKey,
      question: questionIn(locale, i.question, i.questionEn),
      value: Array.isArray(company[i.itemKey])
        ? (company[i.itemKey] as unknown[]).join('、')
        : String(company[i.itemKey]),
      confidence: null,
      confidenceLabel: null,
      isRumor: false,
      sourceName: null,
      recordedAt: null,
      by: null,
    }));

  const fromValues = values
    .map((v) => ({
      key: byItem.get(v.intelItem?.id ?? '')?.itemKey ?? v.intelItem?.itemKey ?? '',
      question: questionIn(
        locale,
        byItem.get(v.intelItem?.id ?? '')?.question ?? v.intelItem?.question,
        byItem.get(v.intelItem?.id ?? '')?.questionEn ?? v.intelItem?.questionEn,
      ),
      value: v.valueText ?? (v.valueNumber != null ? String(v.valueNumber) : '') ?? '',
      confidence: v.confidence ?? null,
      confidenceLabel: conf[String(v.confidence ?? '')] ?? null,
      /** 传闻要能一眼认出来 —— 界面上给它一个标。 */
      isRumor: String(v.confidence ?? '').toUpperCase() === 'RUMOR',
      sourceName: v.sourceName || null,
      recordedAt: v.recordedAt ?? null,
      by: v.recordedBy?.name ?? null,
    }))
    .filter((k) => k.value);

  const known = [...fromValues, ...fromColumns]
    // 传闻排前面：**需要人去核实的那些才是行动项**，已确认的只是背景
    .sort((a, b) => Number(b.isRumor) - Number(a.isRumor));

  return {
    totalItems: active.length,
    completeness: total ? Math.round((got / total) * 100) : null,
    missing: sortMissing(missing).map((i) => ({
      key: i.itemKey,
      question: questionIn(locale, i.question, i.questionEn),
      wave: i.wave,
      weight: i.weight,
    })),
    known,
  };
};

/**
 * 「本次该问」的排序（D17④）：**wave 升序 → 阶段门优先 → 权重降序**。
 *
 * 界面每次只露前 3 个。销售永远看不到「还差 27 项」那种让人直接放弃的画面 ——
 * 这不是省地方，是这条需求唯一正确的落法。
 */
export const sortMissing = <T extends { wave: number | null; weight: number | null }>(rows: T[]) =>
  [...rows].sort(
    (a, b) =>
      (a.wave ?? 9) - (b.wave ?? 9) ||
      Number(Boolean((b as any).requiredForStage)) - Number(Boolean((a as any).requiredForStage)) ||
      (b.weight ?? 0) - (a.weight ?? 0),
  );
