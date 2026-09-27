/**
 * ══════════════════════════════════════════════════════════════════
 *  这个应用认的那一小撮 markdown —— **规则只写在这一处**（D135）
 *
 *  三个地方要回答「这一行是什么」：
 *    · `MarkdownLite`      把它画出来（详情页 / 编辑器的预览）
 *    · `mdToPlain()`       速记列表那两行摘要 —— 不画格式，但也不许露出 `##` `**`
 *    · `continueList()`    编辑器里按回车，这一行是列表的话下一行自动接上
 *  三处各写一份正则的话，迟早有一处认 `1)` 另一处不认 ——
 *  而这个仓库最贵的 bug 全是「同一件事两处实现，其中一处后来错了」。
 *
 *  认这几种，其余原样当正文：
 *    `## 标题` · `**粗体**` · `- 列表` · `1. 编号` · `- [ ] 待办` · `> 引用`
 *  编辑器工具栏上**只放这几个**：工具栏能插进去、渲染时却原样露出符号的格式
 *  （斜体、链接、代码块）等于教人写一种这里读不懂的东西。
 *
 *  ⚠️ **不认 HTML，也不认链接** —— 理由见 `MarkdownLite.tsx` 头注释（不可信来源）。
 * ══════════════════════════════════════════════════════════════════ */

export type MdLine =
  | { kind: 'blank' }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'task'; done: boolean; text: string }
  | { kind: 'li'; text: string }
  | { kind: 'ol'; n: number; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'p'; text: string };

// 顺序有讲究：待办必须排在普通列表前面（`- [ ] x` 也是一个合法的 `- x`）
const H = /^(#{1,6})\s+(.*)$/;
const TASK = /^\s*[-*]\s+\[([ xX])\](?:\s+(.*))?$/;
const LI = /^\s*[-*·•]\s+(.*)$/;
const OL = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

export const parseLine = (raw: string): MdLine => {
  const line = String(raw ?? '').trimEnd();
  if (!line.trim()) return { kind: 'blank' };
  let m: RegExpMatchArray | null;
  if ((m = line.match(H))) return { kind: 'h', level: m[1]!.length, text: m[2] ?? '' };
  if ((m = line.match(TASK))) return { kind: 'task', done: m[1] !== ' ', text: m[2] ?? '' };
  if ((m = line.match(LI))) return { kind: 'li', text: m[1] ?? '' };
  if ((m = line.match(OL))) return { kind: 'ol', n: Number(m[1]), text: m[2] ?? '' };
  if ((m = line.match(QUOTE))) return { kind: 'quote', text: m[1] ?? '' };
  return { kind: 'p', text: line };
};

/** 行内只认 `**粗体**`。拆成「偶数段是正文、奇数段是粗体」。 */
export const splitBold = (s: string): string[] => String(s ?? '').split(/\*\*(.+?)\*\*/g);

/**
 * 去掉格式符号，留下人要读的字 —— 给速记列表那两行摘要用。
 *
 * 🔴 空行也去掉：摘要只有两行，一行被空行吃掉就只剩一行能看。
 * 列表和待办**保留一个记号**（`·` / `☐` / `☑`）—— 全剥掉的话，
 * 三条待办在摘要里会粘成一句看不出边界的话。
 */
export const mdToPlain = (text: string): string =>
  String(text ?? '')
    .split('\n')
    .map(parseLine)
    .flatMap((l): string[] => {
      switch (l.kind) {
        case 'blank':
          return [];
        case 'task':
          return [`${l.done ? '☑' : '☐'} ${l.text}`];
        case 'li':
          return [`· ${l.text}`];
        case 'ol':
          return [`${l.n}. ${l.text}`];
        default:
          return [l.text];
      }
    })
    .map((s) => splitBold(s).join(''))
    .join('\n');

/**
 * 选区所在的**整行**（多行选区：第一行行首 → 最后一行行尾）。
 *
 * 给「标题 / 引用 / 待办」三个键用：GitHub 那个组件把它们当成「在光标处插前缀」，
 * 于是先打一行字再点「标题」，得到的是 `Alpin 会谈纪要## ` —— 它的用法是先点再打。
 * 现场是先打再排版，所以点之前先把选区撑到整行，交给它的「整段加前缀 / 再点一次去掉」。
 */
export const lineRange = (value: string, start: number, end: number): [number, number] => {
  const from = value.lastIndexOf('\n', start - 1) + 1;
  // 选区正好收在下一行行首（三击选中一整行时常见）：不把下一行算进来
  const e = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const nl = value.indexOf('\n', e);
  return [from, nl === -1 ? value.length : nl];
};

/** 一次文本替换：把 `[from, to)` 换成 `insert`，光标落在 `caret`。 */
export type TextEdit = { from: number; to: number; insert: string; caret: number };

// 列表记号本身（带缩进）。`>` 引用也算：多段引用一路回车下去是常见写法
const PREFIX = /^(\s*)(?:([-*])\s+\[[ xX]\]\s+|([-*·•])\s+|(\d{1,3})([.)])\s+|>\s?)/;

/**
 * 编辑器里按回车：**当前行是列表，就在下一行接上同样的记号**。
 *
 * · `- 甲` ⏎        → `- 甲\n- `
 * · `3. 丙` ⏎       → `3. 丙\n4. `
 * · `- [x] 做完` ⏎  → `- [x] 做完\n- [ ] `（新的一条永远是没勾的）
 * · `- ` ⏎（空项）   → 记号删掉，列表到此结束 —— 和所有编辑器一样，连按两下回车退出列表
 * · 选中了一段 / 光标在记号里面 / 不是列表 → `null`，交给浏览器照常换行
 *
 * 纯函数，返回一次替换而不是整段新文本 —— 调用方拿它去走 `execCommand('insertText')`，
 * 这样**系统的撤销（⌘Z / 摇一摇）还认得这一步**。
 */
export const continueList = (value: string, start: number, end: number): TextEdit | null => {
  if (start !== end) return null;
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const nl = value.indexOf('\n', start);
  const lineEnd = nl === -1 ? value.length : nl;
  const line = value.slice(lineStart, lineEnd);
  const m = line.match(PREFIX);
  if (!m) return null;
  const prefix = m[0];
  // 光标还在记号里（比如停在行首）：那是想在列表上面插一行，不是接着写
  if (start - lineStart < prefix.length) return null;

  // 空项：把记号删掉，结束列表
  if (!line.slice(prefix.length).trim() && start === lineEnd) {
    return { from: lineStart, to: lineEnd, insert: '', caret: lineStart };
  }

  const indent = m[1] ?? '';
  let next: string;
  if (m[2]) next = `${m[2]} [ ] `;
  else if (m[3]) next = `${m[3]} `;
  else if (m[4]) next = `${Number(m[4]) + 1}${m[5]} `;
  else next = '> ';
  const insert = `\n${indent}${next}`;
  return { from: start, to: start, insert, caret: start + insert.length };
};
