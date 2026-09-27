import { lineRange, type TextEdit } from './markdown';

/**
 * 「写一条」编辑器里和 DOM 打交道的那几段（D135）。
 *
 * 从 `NoteComposer.tsx` 里拆出来只有一个理由：**那个组件文件测不了**
 * （它 import 的 GitHub 组件一加载就去 `window.customElements` 注册），
 * 而这几段恰好都是「错了不报错、只是悄悄变难用」的那一类 ——
 * 输入法选词的回车被吃成换行、格式加在了光标处而不是行首、改了字 React 却不知道。
 * 判据同 `retry.ts` 开头：**失败得很安静的东西，判据要写成能单独断言的函数。**
 */

/** 键盘事件里用得到的那几格（React 的合成事件和原生事件都能喂进来）。 */
export type KeyLike = {
  key: string;
  keyCode?: number;
  isComposing?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
};

/** 这一下按键编辑器要接管成什么；`null` = 交给浏览器照常处理。 */
export type KeyIntent = 'save' | 'bold' | 'newline' | 'close' | null;

/**
 * 🔴 **输入法还在组字时一律不接管。** 拼音没上屏时按回车是「确认候选词」，
 * 被当成换行接走的话，人打的那个词就没了 —— 而中文是这个应用的主要输入。
 * `keyCode === 229` 是 Safari 的老写法（它在组字期间不一定给 `isComposing`）。
 * Esc 同理：组字时按 Esc 是「取消这串拼音」，不是「收起编辑器」。
 */
export const keyIntent = (k: KeyLike): KeyIntent => {
  if (k.isComposing || k.keyCode === 229) return null;
  if (k.key === 'Escape') return 'close';
  const mod = Boolean(k.metaKey || k.ctrlKey);
  if (k.key === 'Enter' && mod) return 'save';
  if (mod && !k.shiftKey && !k.altKey && k.key.toLowerCase() === 'b') return 'bold';
  if (k.key === 'Enter' && !k.shiftKey && !k.altKey && !mod) return 'newline';
  return null;
};

/** textarea 上我们要用的那几样 —— 测试里拿一个假的就行。 */
export type EditableField = Pick<
  HTMLTextAreaElement,
  'value' | 'selectionStart' | 'selectionEnd' | 'setSelectionRange' | 'setRangeText' | 'dispatchEvent'
>;

/** `document.execCommand` 的形状；测试里注入一个假的。 */
export type ExecCommand = (command: string, value?: string) => boolean;

const browserExec: ExecCommand = (command, value) => document.execCommand(command, false, value);

/**
 * 把一次替换打进 textarea。**先走 `execCommand`，不直接改 value** ——
 * 前者进浏览器的撤销栈（⌘Z / iPhone 摇一摇撤销还认得这一步），后者不进。
 *
 * 退路：`execCommand` 不支持 / 抛了 / 说成功但字其实没变 →
 * `setRangeText` + **手动发一个 input 事件**。那个事件不能省：React 靠它才知道值变了，
 * 省掉的话下一次重渲染（速记页每 1.5 秒一次）会把刚插的字悄悄抹掉。
 */
export const applyEdit = (el: EditableField, e: TextEdit, exec: ExecCommand = browserExec): void => {
  const prev = el.value;
  el.setSelectionRange(e.from, e.to);
  let ok = false;
  try {
    ok = e.insert ? exec('insertText', e.insert) : e.from < e.to && exec('delete');
  } catch {
    ok = false;
  }
  if (!ok || el.value === prev) {
    el.setRangeText(e.insert, e.from, e.to, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  el.setSelectionRange(e.caret, e.caret);
};

/**
 * 工具栏上这几个键是**整行**的格式（见 `lineRange` 的注释）：
 * GitHub 那个组件把它们当成「在光标处插前缀」，点之前要先把选区撑到整行。
 * 加一个整行的格式键就要加进这里 —— 契约测试会核对。
 */
export const LINE_TOOLS = 'md-header, md-quote, md-task-list';

/** 把选区撑到所在的整行。空行上等于不动（光标本来就在行首，前缀插在那儿正好）。 */
export const widenToLines = (el: EditableField): void => {
  const [from, to] = lineRange(el.value, el.selectionStart, el.selectionEnd);
  el.setSelectionRange(from, to);
};

/**
 * 点格式键**之前**（挂在工具栏的捕获阶段，赶在组件自己的 click 前面）：
 * 记下原来是不是只有一个光标；整行格式先撑到整行。
 * 返回值交给 `afterTool` —— 「点完要不要收回成光标」。
 */
export const beforeTool = (el: EditableField, target: { closest?: (sel: string) => unknown } | null): boolean => {
  const caretOnly = el.selectionStart === el.selectionEnd;
  if (target?.closest?.(LINE_TOOLS)) widenToLines(el);
  return caretOnly;
};

/**
 * 点格式键**之后**（冒泡阶段，组件已经改完字）：原来只是一个光标的，收回成光标、停在那段字末尾。
 *
 * 🔴 不收的话：GitHub 那个组件加完格式会把那段字**保持选中**（它的用法是「先选中再点」），
 * 而我们为了整行格式把选区撑大过 —— 于是先打一行、点「标题」、再按回车或接着打字，
 * **那一整行字被一下覆盖掉**（2026-09-27 浏览器实测撞到：`Alpin 会谈纪要` → `## `）。
 * 人原来就选中了一段的，照组件的习惯留着选区。
 */
export const afterTool = (el: EditableField, caretOnly: boolean): void => {
  if (caretOnly) el.setSelectionRange(el.selectionEnd, el.selectionEnd);
};
