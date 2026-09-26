/**
 * 往输入框里插一段转录 —— **纯计算那一半**（issue #21① · D87）。
 *
 * 为什么单独抽出来：这段逻辑原本整个长在 `Chat.tsx` 的 `insertAtCursor()` 里，
 * 混着 `setState` 和 `requestAnimationFrame`，**没有任何一条断言碰得到它**。
 * 而 issue #21 对它的判断是「代码已经写好了，只是转写 100% 失败（#19）
 * 所以这条路径根本没机会跑到」—— 也就是说：
 * **它在生产上从来没有被执行过，也从来没有被验证过。**
 *
 * 判据是这个仓库自己写下的那一条（`retry.ts` 开头）：
 * **失败得很安静的东西，判据要写成能单独断言的函数。**
 * 光标插入正是这一类 —— 插错了不报错，只是把两句话粘成一个词，
 * 而那个词会被 agent 当成品牌名一路用下去。
 */

export type Spliced = {
  /** 插完之后输入框里的全文。 */
  next: string;
  /** 光标该落在哪 —— 插入内容的末尾，方便接着改。 */
  caret: number;
};

/**
 * 把 `chunk` 插到 `[start, end)` 这段选区上。
 *
 * · 没选中（start === end）→ 就在光标处插入
 * · 选中了一段        → **替换掉那一段**（现场的真实用法：
 *                       「刚才那句说错了」，选中再录一遍）
 * · 前面有字且不以空白结尾 → 自动补一个空格，
 *                       **绝不把两句话粘成一个词**
 */
export const spliceAt = (cur: string, chunk: string, start: number, end: number): Spliced => {
  // 越界和反着给的选区都得兜住：`selectionStart` 在某些输入法下会给出意外值，
  // 而这里插错位置是**静默**的 —— 人只会看到一句话跑到了奇怪的地方
  const len = cur.length;
  const a = Math.max(0, Math.min(Number.isFinite(start) ? start : len, len));
  const b = Math.max(a, Math.min(Number.isFinite(end) ? end : a, len));

  const before = cur.slice(0, a);
  const after = cur.slice(b);
  const glue = before && !/\s$/.test(before) ? ' ' : '';
  return { next: `${before}${glue}${chunk}${after}`, caret: (before + glue + chunk).length };
};
