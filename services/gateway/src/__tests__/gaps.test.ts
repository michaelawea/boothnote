import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeGaps } from '../gaps.ts';
import type { IntelItem } from '../twenty.ts';

/**
 * 情报缺口的计算（D17③ / issue #6）。**零依赖，不发任何请求。**
 *
 * 这一层最要紧的是一条不变式：**`missing` + `known` = 清单总数**。
 * 它一破，界面上那个百分比就没法信 —— 人看到「23%」却看不见它是怎么来的。
 *
 * 生产实测（2026-08-04）就是这么破的：`known` 只从 `intelValue` 取，
 * 而落在 Company 列上的答案**进了完整度的分子、却一条都不显示**。
 * 完整度 23%、还缺 14 项，「已经知道的」整块是空的。
 */

const item = (over: Partial<IntelItem> & { itemKey: string }): IntelItem => ({
  id: `id-${over.itemKey}`,
  question: `问 ${over.itemKey}？`,
  questionEn: `Ask ${over.itemKey}?`,
  valueType: 'text',
  appliesTo: 'company',
  wave: 1,
  weight: 1,
  isEnabled: true,
  createdByAgent: false,
  ...over,
});

/** 两类项各一个：一个答案落 Company 列，一个答案落 intelValue */
const ITEMS = [
  item({ itemKey: 'annualProduction', weight: 10 }),
  item({ itemKey: 'battery_chemistry', weight: 8, wave: 2 }),
  item({ itemKey: 'purchase_cycle', weight: 5, wave: 3 }),
];

describe('情报缺口', () => {
  it('🔴 不变式：还缺的 + 已知的 = 清单总数', () => {
    const g = computeGaps(
      ITEMS,
      [{ intelItem: { id: 'id-battery_chemistry', itemKey: 'battery_chemistry' }, valueText: '锂' }],
      { annualProduction: '8,000-10,000' },
    );
    assert.equal(
      g.missing.length + g.known.length,
      g.totalItems,
      '🔴 这条一破，界面上那个百分比就没法信 —— 有项既不在缺的里、也不在已知的里',
    );
  });

  it('答案落在 Company 列上的，也要出现在「已经知道的」里', () => {
    const g = computeGaps(ITEMS, [], { annualProduction: '8,000-10,000' });
    const k = g.known.find((x) => x.key === 'annualProduction');
    assert.ok(k, '🔴 只认 intelValue 的话，档案列上答着的一条都看不见（issue #6）');
    assert.equal(k?.value, '8,000-10,000');
    assert.equal(k?.confidence, null, '档案列上的值没有可信度这一说，界面上不该给它标');
    assert.equal(k?.isRumor, false);
  });

  it('MULTI_SELECT 那种数组值要拼成人看得懂的串', () => {
    const g = computeGaps([item({ itemKey: 'vehicleTypes' })], [], {
      vehicleTypes: ['A_CLASS', 'B_CLASS'],
    });
    assert.equal(g.known[0]?.value, 'A_CLASS、B_CLASS');
  });

  it('完整度只按有权重的项算 —— agent 造的 weight=0 不进分母（D47 护栏③）', () => {
    const withAgentMade = [...ITEMS, item({ itemKey: 'agent_made', weight: 0 })];
    const a = computeGaps(ITEMS, [], { annualProduction: 'x' });
    const b = computeGaps(withAgentMade, [], { annualProduction: 'x' });
    assert.equal(
      a.completeness,
      b.completeness,
      '🔴 agent 每造一个字段所有客户的完整度都往下掉，那个指标当场作废',
    );
  });

  it('清单是空的时候完整度是 null，不是 0% —— 两件事', () => {
    const g = computeGaps([], [], {});
    assert.equal(g.completeness, null, '0% 意味着「问过但都没答」，null 才是「清单还没配」');
    assert.equal(g.totalItems, 0);
  });

  it('传闻排在已知的最前面 —— 需要人去核实的才是行动项', () => {
    const g = computeGaps(
      ITEMS,
      [
        { intelItem: { id: 'id-battery_chemistry', itemKey: 'battery_chemistry' }, valueText: '锂', confidence: 'CONFIRMED' },
        { intelItem: { id: 'id-purchase_cycle', itemKey: 'purchase_cycle' }, valueText: '提前一年', confidence: 'RUMOR' },
      ],
      {},
    );
    assert.equal(g.known[0]?.isRumor, true, '传闻没排前面');
  });

  it('停用的清单项既不算缺、也不算已知', () => {
    const g = computeGaps([...ITEMS, item({ itemKey: 'off', isEnabled: false })], [], {});
    assert.ok(!g.missing.some((m) => m.key === 'off'));
    assert.ok(!g.known.some((k) => k.key === 'off'));
    assert.equal(g.totalItems, ITEMS.length);
  });

  /**
   * ── 界面语言（D80 / 2026-08-11）────────────────────────────────
   *
   * 🔴 `questionEn` 这一列 2026-08-07 就随 schema 建好、seed 一直在写，
   *    但**在这之前没有任何代码读过它** —— 英文账号的「还没问过的」
   *    整块都是中文。加这几条就是为了让那个洞以后红出来。
   */
  describe('跟用户语言走', () => {
    const VALUES = [
      { intelItem: { id: 'id-battery_chemistry', itemKey: 'battery_chemistry' }, valueText: '锂', confidence: 'RUMOR' },
    ];

    it('英文账号拿到英文问法 —— 「还没问过的」和「已经知道的」两处都要', () => {
      const g = computeGaps(ITEMS, VALUES, { annualProduction: '8,000' }, 'en');
      assert.equal(g.missing[0]?.question, 'Ask purchase_cycle?', '🔴 「还没问过的」还是中文');
      assert.ok(
        g.known.every((k) => k.question.startsWith('Ask ')),
        '🔴 「已经知道的」里的问法还是中文（两个来源要一起翻，漏一个就是半英半中）',
      );
    });

    it('可信度标签也跟语言走 —— 它和问法是同一块界面', () => {
      assert.equal(computeGaps(ITEMS, VALUES, {}, 'en').known[0]?.confidenceLabel, 'Low · hearsay');
      assert.equal(computeGaps(ITEMS, VALUES, {}).known[0]?.confidenceLabel, '低 · 听说的');
    });

    it('没写英文问法就退回中文 —— 一个中文问题比一个空格子有用', () => {
      const g = computeGaps([item({ itemKey: 'noEn', questionEn: '' })], [], {}, 'en');
      assert.equal(g.missing[0]?.question, '问 noEn？');
    });

    it('不传语言时一个字不变 —— agent 和完整度重算不该因为谁在用而变', () => {
      const g = computeGaps(ITEMS, VALUES, { annualProduction: '8,000' });
      assert.equal(g.missing[0]?.question, '问 purchase_cycle？');
    });

    /**
     * 🔴 **只有问法和标签跟语言走。**
     * `key` 是机器判据、`value` 是现场记下的原话 —— 它们随语言变，
     * 就是 D80 那条「数据路径存规范形式，只有渲染那一层才翻译」被推翻。
     */
    it('key 和 value 绝不随语言变', () => {
      const zh = computeGaps(ITEMS, VALUES, { annualProduction: '8,000' });
      const en = computeGaps(ITEMS, VALUES, { annualProduction: '8,000' }, 'en');
      assert.deepEqual(en.missing.map((m) => m.key), zh.missing.map((m) => m.key));
      assert.deepEqual(en.known.map((k) => k.value), zh.known.map((k) => k.value));
      assert.equal(en.completeness, zh.completeness, '🔴 完整度随语言变的话，两个账号看同一家会看到两个数');
    });
  });
});
