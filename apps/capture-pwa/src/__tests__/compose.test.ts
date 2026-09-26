import { describe, expect, it } from 'vitest';

import { spliceAt } from '../compose';

/**
 * 光标插入（issue #21① · D87）。
 *
 * 🔴 **这条路径在生产上一次都没跑过。** issue #21 的判断是
 * 「代码已经实现了，只是转写 100% 失败（#19）所以根本走不到」——
 * 也就是说它从来没有被任何东西验证过，包括人眼。
 * #19 修好之后它会立刻变成每条录音的必经之路，所以先把判据钉住。
 */
describe('把转录插到光标处', () => {
  it('空输入框：原样放进去，不补空格', () => {
    expect(spliceAt('', '这家要锂电', 0, 0)).toEqual({ next: '这家要锂电', caret: 5 });
  });

  it('接在已有文字后面：补一个空格，**不把两句话粘成一个词**', () => {
    const r = spliceAt('Rosenfeld', '要锂电', 9, 9);
    expect(r.next).toBe('Rosenfeld 要锂电');
    // 🔴 没有这个空格就是 'Rosenfeld要锂电' —— agent 会把它当成一个品牌名
    expect(r.next).not.toBe('Rosenfeld要锂电');
  });

  it('前面已经以空白结尾：不再补第二个空格', () => {
    expect(spliceAt('明年 ', '换供应商', 3, 3).next).toBe('明年 换供应商');
    expect(spliceAt('第一句\n', '第二句', 4, 4).next).toBe('第一句\n第二句');
  });

  it('插在中间：前后都留着', () => {
    const r = spliceAt('AB', 'X', 1, 1);
    expect(r.next).toBe('A XB');
    expect(r.caret).toBe(3);
  });

  /** 现场真实用法：「刚才那句说错了」—— 选中再录一遍就是替换。 */
  it('选中一段再录：**替换掉选中的那段**', () => {
    const r = spliceAt('客户是 Rozenfelt 那家', 'Rosenfeld', 4, 13);
    expect(r.next).toBe('客户是 Rosenfeld 那家');
  });

  it('全选再录：整段换掉', () => {
    expect(spliceAt('全错了', '重说一遍', 0, 3).next).toBe('重说一遍');
  });

  it('光标落在插入内容的末尾 —— 接着改不用再点一次', () => {
    const r = spliceAt('前面 ', '新内容', 3, 3);
    expect(r.caret).toBe(r.next.length - 0);
    expect(r.next.slice(0, r.caret)).toBe('前面 新内容');
  });

  /**
   * 🔴 越界/反序的选区要兜住。插错位置是**静默**的：不报错，
   * 只是把一句话放到奇怪的地方，而人多半不会发现。
   */
  it('选区越界或反着给，都不能崩、也不能丢字', () => {
    expect(spliceAt('abc', 'X', 99, 99).next).toBe('abc X');
    expect(spliceAt('abc', 'X', -5, -5).next).toBe('Xabc');
    // 反序（end < start）：当成「就在 start 处插入」，不吃掉任何字符
    expect(spliceAt('abc', 'X', 2, 1).next).toBe('ab Xc');
    // @ts-expect-error 故意传脏东西：这一层不能自己抛
    expect(spliceAt('abc', 'X', undefined, undefined).next).toBe('abc X');
  });
});
