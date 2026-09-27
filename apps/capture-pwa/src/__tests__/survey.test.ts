/**
 * 2C 问卷的答案形状（D136 · T104）。
 *
 * 守的是「错了收上来的数据就没法统计」的那几件：
 *   · id 不重复 —— 两个选项同 id，答案会互相覆盖，而界面上看起来一切正常
 *   · 「都没有」和别的选项互斥
 *   · 第 2 题三态一圈能回到「没点」
 */
import { describe, expect, it } from 'vitest';

import { EMPTY_CONTACT, VDL_2026, answeredCount, cycleHaveWant, submitState, toggleMulti } from '../survey';

describe('题目清单', () => {
  it('六道题，题目 id（含追问）全局不重复', () => {
    expect(VDL_2026).toHaveLength(6);
    const ids = VDL_2026.flatMap((q) => [q.id, ...(q.kind === 'single' && q.followUp ? [q.followUp.id] : [])]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每道题里选项 id 不重复', () => {
    for (const q of VDL_2026) {
      const groups = q.kind === 'text' ? [] : [q.options, ...(q.kind === 'single' && q.followUp ? [q.followUp.options] : [])];
      for (const opts of groups) {
        const ids = opts.map((o) => o.id);
        expect(new Set(ids).size, q.id).toBe(ids.length);
      }
    }
  });
});

describe('cycleHaveWant', () => {
  it('没点 → 在用 → 想加 → 没点', () => {
    expect(cycleHaveWant(undefined)).toBe('have');
    expect(cycleHaveWant('have')).toBe('want');
    expect(cycleHaveWant('want')).toBeUndefined();
  });
});

describe('toggleMulti', () => {
  it('点一下加上，再点一下拿掉', () => {
    expect(toggleMulti([], 'solar')).toEqual(['solar']);
    expect(toggleMulti(['solar', 'lithium'], 'solar')).toEqual(['lithium']);
  });

  it('点「都没有」清掉其它；点其它清掉「都没有」', () => {
    expect(toggleMulti(['solar', 'lithium'], 'none')).toEqual(['none']);
    expect(toggleMulti(['none'], 'solar')).toEqual(['solar']);
  });
});

describe('answeredCount', () => {
  it('空串、空数组、空对象都不算答了；追问不单独算', () => {
    expect(
      answeredCount(VDL_2026, {
        equipment: [],
        appliances: {},
        wish: '   ',
        brand_chooser: 'me',
      }),
    ).toBe(0);
    expect(
      answeredCount(VDL_2026, {
        equipment: ['solar'],
        appliances: { fridge: 'have' },
        install: 'pro',
        camping_pain: 'Pas assez de prises',
      }),
    ).toBe(4);
  });
});

describe('submitState（和网关 normalizeSurvey 同一条规则）', () => {
  const c = (x: Partial<typeof EMPTY_CONTACT>) => ({ ...EMPTY_CONTACT, ...x });

  it('什么都没有 → 不能交', () => {
    expect(submitState(VDL_2026, {}, EMPTY_CONTACT, false)).toBe('empty');
    expect(submitState(VDL_2026, {}, c({ name: '   ' }), false)).toBe('empty');
  });

  it('🔴 留了姓名 / 电话 / 邮箱就必须勾同意', () => {
    for (const k of ['name', 'phone', 'email'] as const) {
      expect(submitState(VDL_2026, { wish: 'x' }, c({ [k]: 'v' }), false)).toBe('consent');
      expect(submitState(VDL_2026, { wish: 'x' }, c({ [k]: 'v' }), true)).toBe('ok');
    }
  });

  it('只留邮编不要求同意；只答了题也能交', () => {
    expect(submitState(VDL_2026, {}, c({ postcode: '75001' }), false)).toBe('ok');
    expect(submitState(VDL_2026, { equipment: ['solar'] }, EMPTY_CONTACT, false)).toBe('ok');
  });
});
