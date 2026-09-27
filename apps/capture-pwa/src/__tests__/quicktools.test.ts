/**
 * 快捷工具的日期窗口（D136）。
 *
 * 守的是两件「错了现场看不出来」的事：
 *   · 开展第一天 / 撤展最后一天，工具在不在（两端都含）
 *   · 按手机本地日期，不按 UTC —— 巴黎凌晨那两个小时 UTC 还是前一天
 */
// 🔴 必须在任何 Date 被构造之前设：UTC+2 才分得开「本地日期」和「UTC 日期」。
//    CI 跑在 UTC 上，不钉死的话「用了 toISOString」那种写法在 CI 里照样绿。
process.env.TZ = 'Europe/Paris';

import { describe, expect, it } from 'vitest';

import { activeTools, isActive, localDay } from '../quicktools';

/** 巴黎当地时间（月份按人话 1–12）。 */
const paris = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min);

describe('localDay', () => {
  it('补零成定长 YYYY-MM-DD —— 否则字符串比较就不是日期比较', () => {
    expect(localDay(paris(2026, 9, 5))).toBe('2026-09-05');
  });

  it('巴黎 00:30 是当天，不是 UTC 的前一天', () => {
    expect(paris(2026, 9, 26, 0, 30).toISOString().slice(0, 10)).toBe('2026-09-25'); // 尺子先验一下
    expect(localDay(paris(2026, 9, 26, 0, 30))).toBe('2026-09-26');
  });
});

describe('isActive', () => {
  const w = { from: '2026-09-26', until: '2026-10-04' };

  it('没有窗口 = 一直有', () => {
    expect(isActive({}, paris(2030, 1, 1))).toBe(true);
  });

  it('第一天一大早就在（含 from）', () => {
    expect(isActive(w, paris(2026, 9, 26, 0, 30))).toBe(true);
  });

  it('前一天深夜还没有', () => {
    expect(isActive(w, paris(2026, 9, 25, 23, 59))).toBe(false);
  });

  it('最后一天深夜还在（含 until）', () => {
    expect(isActive(w, paris(2026, 10, 4, 23, 59))).toBe(true);
  });

  it('第二天零点就没了', () => {
    expect(isActive(w, paris(2026, 10, 5, 0, 0))).toBe(false);
  });

  it('只给一端也成立', () => {
    expect(isActive({ from: '2026-09-26' }, paris(2027, 1, 1))).toBe(true);
    expect(isActive({ from: '2026-09-26' }, paris(2026, 9, 25))).toBe(false);
    expect(isActive({ until: '2026-10-04' }, paris(2020, 1, 1))).toBe(true);
    expect(isActive({ until: '2026-10-04' }, paris(2026, 10, 5))).toBe(false);
  });
});

describe('activeTools', () => {
  it('只留在窗口里的，并保持清单原来的顺序', () => {
    const list = [
      { id: 'a' },
      { id: 'old', until: '2026-08-31' },
      { id: 'b', from: '2026-09-01' },
      { id: 'later', from: '2026-12-01' },
      { id: 'c' },
    ];
    expect(activeTools(list, paris(2026, 9, 27)).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
});
