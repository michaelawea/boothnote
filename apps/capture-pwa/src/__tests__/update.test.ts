import { describe, expect, it } from 'vitest';

import { mayAutoApply } from '../update';

/**
 * 自动换版本的三条闸门（D83）。
 *
 * 这个函数错一次的代价是不对称的：
 *   判宽了 → 展台上正录着的 80 秒被一次静默 `location.reload()` 吃掉
 *   判严了 → 人多点一下「有新版本」那条横幅
 * 所以每一条都必须是「不满足就不刷」，测的也正是这个方向。
 */
describe('mayAutoApply —— 什么时候可以替人刷新', () => {
  const base = { now: 1_000_000, autoUntil: 1_030_000, busy: false, lastReloadAt: 0 };

  it('刚打开 / 刚切回前台 + 手上没东西 + 不在冷却期 → 刷', () => {
    expect(mayAutoApply(base)).toBe(true);
  });

  it('🔴 手上有东西（录音 / 草稿 / 上传 / 对话）→ 一律不刷', () => {
    expect(mayAutoApply({ ...base, busy: true })).toBe(false);
  });

  it('🔴 不是 start/resume 那次检查的结果 → 只挂横幅，不刷', () => {
    // 定时检查压根不设 autoUntil，于是 now 永远在窗口之外
    expect(mayAutoApply({ ...base, autoUntil: 0 })).toBe(false);
    // 窗口过期一毫秒也算过期 —— 边界上宁可不刷
    expect(mayAutoApply({ ...base, autoUntil: base.now - 1 })).toBe(false);
    expect(mayAutoApply({ ...base, autoUntil: base.now })).toBe(true);
  });

  it('🔴 冷却期内不刷 —— 这一条是「刷完又判成有新版本」成环时唯一的刹车', () => {
    expect(mayAutoApply({ ...base, lastReloadAt: base.now - 60_000 })).toBe(false);
    expect(mayAutoApply({ ...base, lastReloadAt: base.now - 10 * 60_000 })).toBe(true);
  });

  it('冷却期可以调，但默认必须够长 —— 十分钟以内的重复自动刷新都要挡下', () => {
    expect(mayAutoApply({ ...base, lastReloadAt: base.now - 1_000, cooldownMs: 500 })).toBe(true);
  });

  it('多条同时不满足时也是 false —— 没有任何一条能被另一条抵消', () => {
    expect(mayAutoApply({ ...base, busy: true, autoUntil: 0, lastReloadAt: base.now })).toBe(false);
  });
});
