import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import { continueList, lineRange, mdToPlain, parseLine } from '../markdown';
import { draftKey, loadDraft, storeDraft, type DraftStore } from '../draft';
import {
  LINE_TOOLS,
  afterTool,
  applyEdit,
  beforeTool,
  keyIntent,
  widenToLines,
  type EditableField,
  type ExecCommand,
} from '../editor';

/**
 * 「写一条」的编辑器（D135）。
 *
 * 守的是三件「错了不会报错、只会悄悄变难用」的事：
 *   ① 工具栏插进去的东西，详情页和列表摘要**必须认得** —— 认不得就原样露出 `- [ ]`
 *   ② 回车续列表 —— 错了会把人刚打的字吞掉，或者在不该接的地方接一个 `- `
 *   ③ 草稿 —— 存不住是小事，**存错人**（换人登录看到上一个人的草稿）是大事
 */

/** 工具栏上的每一个键 → 它在组件里的类名 → 我们期望认成的那一种。 */
const CONTRACT: Record<string, { cls: string; kind: string }> = {
  'md-bold': { cls: 'MarkdownBoldButtonElement', kind: 'bold' },
  'md-unordered-list': { cls: 'MarkdownUnorderedListButtonElement', kind: 'li' },
  'md-ordered-list': { cls: 'MarkdownOrderedListButtonElement', kind: 'ol' },
  'md-task-list': { cls: 'MarkdownTaskListButtonElement', kind: 'task' },
  'md-quote': { cls: 'MarkdownQuoteButtonElement', kind: 'quote' },
  'md-header': { cls: 'MarkdownHeaderButtonElement', kind: 'h' },
};

const composerSrc = () => readFileSync(new URL('../pages/NoteComposer.tsx', import.meta.url), 'utf8');

/**
 * 一个假的 textarea：一段字符串 + 选区 + 记下发过哪些事件。
 * `setRangeText` 的行为照浏览器的 `'end'` 模式（光标落在插入内容末尾）。
 */
const field = (value: string, start = value.length, end = start) => {
  const f = {
    value,
    selectionStart: start,
    selectionEnd: end,
    events: [] as string[],
    setSelectionRange(a: number, b: number) {
      f.selectionStart = a;
      f.selectionEnd = b;
    },
    setRangeText(text: string, a: number, b: number) {
      f.value = f.value.slice(0, a) + text + f.value.slice(b);
      f.selectionStart = f.selectionEnd = a + text.length;
    },
    dispatchEvent(ev: Event) {
      f.events.push(`${ev.type}${ev.bubbles ? ':bubbles' : ''}`);
      return true;
    },
  };
  return f;
};
const asField = (f: ReturnType<typeof field>) => f as unknown as EditableField;

/** 一个像浏览器那样真的会改字的 execCommand（它自己发的 input 事件记成 `native`）。 */
const workingExec =
  (f: ReturnType<typeof field>, calls: string[] = []): ExecCommand =>
  (cmd, v) => {
    calls.push(cmd);
    if (cmd === 'insertText') f.setRangeText(v ?? '', f.selectionStart, f.selectionEnd);
    else if (cmd === 'delete') f.setRangeText('', f.selectionStart, f.selectionEnd);
    else return false;
    f.events.push('input:native');
    return true;
  };

/** 一个用 Map 做的假 localStorage。 */
const mem = (): DraftStore & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
  };
};

describe('一行是什么（markdown.ts —— 渲染 / 摘要 / 续列表共用这一份）', () => {
  it('标题 · 列表 · 编号 · 待办 · 引用 · 正文', () => {
    expect(parseLine('## 会谈纪要')).toEqual({ kind: 'h', level: 2, text: '会谈纪要' });
    expect(parseLine('- 锂电')).toEqual({ kind: 'li', text: '锂电' });
    expect(parseLine('· 锂电')).toEqual({ kind: 'li', text: '锂电' });
    expect(parseLine('3. 报价')).toEqual({ kind: 'ol', n: 3, text: '报价' });
    expect(parseLine('2) 报价')).toEqual({ kind: 'ol', n: 2, text: '报价' });
    expect(parseLine('> 客户原话')).toEqual({ kind: 'quote', text: '客户原话' });
    expect(parseLine('Alpin 要 200Ah')).toEqual({ kind: 'p', text: 'Alpin 要 200Ah' });
    expect(parseLine('   ')).toEqual({ kind: 'blank' });
  });

  it('🔴 待办排在普通列表前面 —— `- [ ] x` 也是一个合法的 `- x`', () => {
    expect(parseLine('- [ ] 发报价')).toEqual({ kind: 'task', done: false, text: '发报价' });
    expect(parseLine('- [x] 发报价')).toEqual({ kind: 'task', done: true, text: '发报价' });
    expect(parseLine('- [X] 发报价')).toEqual({ kind: 'task', done: true, text: '发报价' });
  });

  it('刚点完「待办」还没打字（`- [ ] ` 末尾空格被裁掉）仍然是待办，不是一个写着 [ ] 的列表项', () => {
    expect(parseLine('- [ ] ')).toEqual({ kind: 'task', done: false, text: '' });
  });

  it('行首的 **粗体** 不是列表（`*` 后面没有空格）', () => {
    expect(parseLine('**Alpin** 要锂电').kind).toBe('p');
  });
});

describe('速记列表的两行摘要：不画格式，也不许露出符号', () => {
  it('剥掉 ## 和 **，列表和待办留一个记号，空行去掉', () => {
    const md = ['## Alpin 会谈', '', '**结论**：要 200Ah', '- 锂电', '- [ ] 发报价', '- [x] 约下次', '> 原话'].join('\n');
    expect(mdToPlain(md)).toBe(['Alpin 会谈', '结论：要 200Ah', '· 锂电', '☐ 发报价', '☑ 约下次', '原话'].join('\n'));
  });

  it('没有格式的原文一个字不动（除了空行）', () => {
    expect(mdToPlain('明天去 Alpin\n\n带样品')).toBe('明天去 Alpin\n带样品');
  });

  it('只剩空白 → 空串（调用方靠这个退回「🎙 语音」那一行）', () => {
    expect(mdToPlain('\n  \n')).toBe('');
  });
});

describe('回车续列表', () => {
  const at = (s: string) => [s, s.length, s.length] as const;

  it('列表项后面回车 → 下一行接上同样的记号', () => {
    expect(continueList(...at('- 锂电'))).toEqual({ from: 4, to: 4, insert: '\n- ', caret: 7 });
  });

  it('编号自动 +1，括号式也认', () => {
    expect(continueList(...at('a\n3. 报价'))?.insert).toBe('\n4. ');
    expect(continueList(...at('9) 报价'))?.insert).toBe('\n10) ');
  });

  it('🔴 勾过的待办后面回车，新的一条是**没勾的**', () => {
    expect(continueList(...at('- [x] 约下次'))?.insert).toBe('\n- [ ] ');
  });

  it('缩进跟着走（子列表）', () => {
    expect(continueList(...at('- 甲\n  - 乙'))?.insert).toBe('\n  - ');
  });

  it('引用也接着引', () => {
    expect(continueList(...at('> 客户说'))?.insert).toBe('\n> ');
  });

  it('空项上回车 → 删掉记号、结束列表（连按两下回车退出）', () => {
    const s = '- 锂电\n- ';
    expect(continueList(s, s.length, s.length)).toEqual({ from: 5, to: 7, insert: '', caret: 5 });
    const task = '- [ ] ';
    expect(continueList(task, task.length, task.length)).toEqual({ from: 0, to: 6, insert: '', caret: 0 });
  });

  it('在一项的中间回车 → 把这一项拆成两项（后半截带着记号下去）', () => {
    // `- 锂电池` 光标停在「锂电」后面
    expect(continueList('- 锂电池', 4, 4)).toEqual({ from: 4, to: 4, insert: '\n- ', caret: 7 });
  });

  it('不接的三种：不是列表 / 选中了一段 / 光标在记号里面', () => {
    expect(continueList(...at('Alpin 要锂电'))).toBeNull();
    expect(continueList('- 锂电', 2, 4)).toBeNull();
    expect(continueList('- 锂电', 0, 0)).toBeNull(); // 想在列表上面插一行
    expect(continueList('- 锂电', 1, 1)).toBeNull();
  });

  it('只看光标所在那一行 —— 上一行是列表不算', () => {
    expect(continueList(...at('- 锂电\n正文'))).toBeNull();
  });
});

/**
 * 🔴 **契约：GitHub 那个组件插什么，我们就得认什么。**
 *
 * 工具栏是别人的代码（`@github/markdown-toolbar-element`），渲染是我们的（`markdown.ts`）。
 * 哪天升级它、它把待办的记号从 `- [ ] ` 改成 `* [ ] ` —— 界面上点得动、插得进去，
 * 只是详情页里原样露出符号，**没有任何东西会报错**。所以直接去读它的源码。
 */
describe('契约：工具栏上每个键插进去的前缀，渲染那一侧都认得', () => {
  const require = createRequire(import.meta.url);
  const lib = readFileSync(require.resolve('@github/markdown-toolbar-element'), 'utf8');
  const prefixOf = (cls: string) => {
    const m = lib.match(
      new RegExp(`class ${cls} extends MarkdownButtonElement \\{\\s*connectedCallback\\(\\) \\{\\s*styles\\.set\\(this, \\{ prefix: '([^']*)'`),
    );
    if (!m) throw new Error(`在组件源码里找不到 ${cls} 的前缀 —— 它的写法变了，这条契约要跟着改`);
    return m[1]!;
  };

  it('编辑器上挂的每一个格式键都在这张契约表里（加了键却没加契约 → 红）', () => {
    const src = composerSrc();
    const used = [...new Set([...src.matchAll(/<(md-[a-z-]+)/g)].map((m) => m[1]!))].sort();
    expect(used.length).toBeGreaterThan(0);
    expect(used).toEqual(Object.keys(CONTRACT).sort());
  });

  it('列表 / 编号 / 待办 / 引用：前缀 + 一个字，认成对应的那一种', () => {
    for (const [tag, c] of Object.entries(CONTRACT)) {
      if (c.kind === 'bold' || c.kind === 'h') continue;
      const line = `${prefixOf(c.cls)}报价`;
      expect(parseLine(line).kind, `${tag} 插的是「${line}」`).toBe(c.kind);
    }
  });

  it('粗体：前后包 ** → 摘要里剥得掉、渲染时认得', () => {
    const p = prefixOf('MarkdownBoldButtonElement');
    expect(mdToPlain(`${p}结论${p}：要 200Ah`)).toBe('结论：要 200Ah');
  });

  it('标题：`#` × level + 空格（我们挂的是 level=2）', () => {
    expect(lib).toContain("const prefix = `${'#'.repeat(level)} `;");
    expect(composerSrc()).toMatch(/<md-header level="2"/);
    expect(parseLine('## 报价').kind).toBe('h');
  });
});

describe('选区撑到整行（lineRange）', () => {
  const s = 'Alpin 会谈\n发报价\n约下次';
  it('光标在行中间 → 整行', () => {
    expect(lineRange(s, 12, 12)).toEqual([9, 12]); // 「发报价」
    expect(lineRange(s, 3, 3)).toEqual([0, 8]);
  });

  it('跨行选区 → 第一行行首到最后一行行尾', () => {
    expect(lineRange(s, 3, 11)).toEqual([0, 12]);
  });

  it('🔴 选区正好收在下一行行首（三击选中一行）→ 不把下一行拖进来', () => {
    expect(lineRange(s, 9, 13)).toEqual([9, 12]);
  });

  it('最后一行没有换行符 / 空行', () => {
    expect(lineRange(s, s.length, s.length)).toEqual([13, 16]);
    expect(lineRange('甲\n\n乙', 2, 2)).toEqual([2, 2]);
  });
});

describe('「标题 / 引用 / 待办」点下去之前撑到整行', () => {
  it('光标停在行尾 → 选中整行（否则 GitHub 那个组件把 ## 插在字后面）', () => {
    const f = field('Alpin 会谈纪要');
    widenToLines(asField(f));
    expect([f.selectionStart, f.selectionEnd]).toEqual([0, 10]);
  });

  it('空行不动 —— 光标本来就在行首，前缀插在那儿正好', () => {
    const f = field('甲\n\n乙', 2);
    widenToLines(asField(f));
    expect([f.selectionStart, f.selectionEnd]).toEqual([2, 2]);
  });

  it('LINE_TOOLS 正好是契约表里那几个整行格式（标题 / 引用 / 待办）', () => {
    const tags = LINE_TOOLS.split(',').map((x) => x.trim()).sort();
    const lineKinds = new Set(['h', 'quote', 'task']);
    expect(tags).toEqual(Object.keys(CONTRACT).filter((k) => lineKinds.has(CONTRACT[k]!.kind)).sort());
  });

  it('🔴 before 挂捕获阶段、after 挂冒泡阶段 —— 挪了任何一个，格式都会加错地方或者选区收不回来', () => {
    const src = composerSrc();
    expect(src).toMatch(/addEventListener\('click', before, true\)/);
    expect(src).toMatch(/addEventListener\('click', after\)/);
  });
});

/** 一个假的按钮：`closest` 只认它自己那个标签。 */
const btn = (tag: string) => ({ closest: (sel: string) => (sel.split(',').map((x) => x.trim()).includes(tag) ? {} : null) });

describe('🔴 点完格式键，光标回到字的末尾（不许留一段选中的字等着被覆盖）', () => {
  /**
   * 模拟 GitHub 组件给整行加前缀：前缀插在选区前面，**然后把原来那段字保持选中** ——
   * 这正是它在浏览器里实测的行为（`## Alpin 会谈纪要`，选区 [3,13]）。
   */
  const githubPrefix = (f: ReturnType<typeof field>, prefix: string) => {
    const [a, b] = [f.selectionStart, f.selectionEnd];
    f.value = f.value.slice(0, a) + prefix + f.value.slice(a);
    f.setSelectionRange(a + prefix.length, b + prefix.length);
  };

  it('先打一行、点「标题」→ 行首加 ##，光标停在行尾（接着按回车 / 打字不会吃掉这一行）', () => {
    const f = field('Alpin 会谈纪要');
    const caretOnly = beforeTool(asField(f), btn('md-header'));
    expect([f.selectionStart, f.selectionEnd]).toEqual([0, 10]); // 撑到整行，交给组件
    githubPrefix(f, '## ');
    afterTool(asField(f), caretOnly);
    expect(f.value).toBe('## Alpin 会谈纪要');
    expect([f.selectionStart, f.selectionEnd]).toEqual([13, 13]);
  });

  it('待办、引用同理（它们也是整行格式）', () => {
    for (const [tag, prefix] of [['md-task-list', '- [ ] '], ['md-quote', '> ']] as const) {
      const f = field('甲\n发报价');
      const caretOnly = beforeTool(asField(f), btn(tag));
      githubPrefix(f, prefix);
      afterTool(asField(f), caretOnly);
      expect(f.selectionStart).toBe(f.selectionEnd);
      expect(f.selectionEnd).toBe(f.value.length);
    }
  });

  it('不是整行格式的键（粗体 / 列表）：点之前不动选区', () => {
    const f = field('结论 要锂电', 2);
    expect(beforeTool(asField(f), btn('md-bold'))).toBe(true);
    expect([f.selectionStart, f.selectionEnd]).toEqual([2, 2]);
  });

  it('人原来就选中了一段 → 点完照组件的习惯留着选区（那是人要的）', () => {
    const f = field('Alpin 会谈纪要', 6, 10);
    const caretOnly = beforeTool(asField(f), btn('md-bold'));
    expect(caretOnly).toBe(false);
    f.setSelectionRange(8, 12); // 组件加完 ** 之后的选区
    afterTool(asField(f), caretOnly);
    expect([f.selectionStart, f.selectionEnd]).toEqual([8, 12]);
  });

  it('点到工具栏的空隙（没有任何键）：什么都不变', () => {
    const f = field('甲乙', 1);
    const caretOnly = beforeTool(asField(f), null);
    afterTool(asField(f), caretOnly);
    expect([f.selectionStart, f.selectionEnd, f.value]).toEqual([1, 1, '甲乙']);
  });
});

describe('键盘：哪些按键由编辑器接管', () => {
  it('普通回车 → 交给续列表', () => {
    expect(keyIntent({ key: 'Enter' })).toBe('newline');
  });

  it('🔴 输入法组字中的回车（选词）一律不接管 —— 两种写法都要认', () => {
    expect(keyIntent({ key: 'Enter', isComposing: true })).toBeNull();
    expect(keyIntent({ key: 'Enter', keyCode: 229 })).toBeNull(); // Safari 组字时不一定给 isComposing
    expect(keyIntent({ key: 'Enter', keyCode: 229, metaKey: true })).toBeNull(); // 组字时连保存都不抢
  });

  it('Esc → 收起；🔴 组字中的 Esc 是「取消这串拼音」，不收', () => {
    expect(keyIntent({ key: 'Escape' })).toBe('close');
    expect(keyIntent({ key: 'Escape', isComposing: true })).toBeNull();
    expect(keyIntent({ key: 'Escape', keyCode: 229 })).toBeNull();
  });

  it('Shift+回车是软换行，照常', () => {
    expect(keyIntent({ key: 'Enter', shiftKey: true })).toBeNull();
  });

  it('⌘↵ / Ctrl+↵ → 存下来', () => {
    expect(keyIntent({ key: 'Enter', metaKey: true })).toBe('save');
    expect(keyIntent({ key: 'Enter', ctrlKey: true })).toBe('save');
  });

  it('⌘B / Ctrl+B → 粗体；带 Shift / Alt 的不抢（那是别的快捷键）', () => {
    expect(keyIntent({ key: 'b', metaKey: true })).toBe('bold');
    expect(keyIntent({ key: 'B', ctrlKey: true })).toBe('bold');
    expect(keyIntent({ key: 'b', metaKey: true, shiftKey: true })).toBeNull();
    expect(keyIntent({ key: 'b', metaKey: true, altKey: true })).toBeNull();
    expect(keyIntent({ key: 'b' })).toBeNull();
  });
});

describe('把一次替换打进 textarea（applyEdit）', () => {
  it('浏览器支持 execCommand：走它（进撤销栈），不再自己补发 input 事件', () => {
    const f = field('- 锂电');
    applyEdit(asField(f), { from: 4, to: 4, insert: '\n- ', caret: 7 }, workingExec(f));
    expect(f.value).toBe('- 锂电\n- ');
    expect(f.selectionStart).toBe(7);
    expect(f.events).toEqual(['input:native']);
  });

  it('🔴 execCommand 不支持 → 退回 setRangeText，并且**补发一个冒泡的 input 事件**（React 靠它知道值变了）', () => {
    const f = field('- 锂电');
    applyEdit(asField(f), { from: 4, to: 4, insert: '\n- ', caret: 7 }, () => false);
    expect(f.value).toBe('- 锂电\n- ');
    expect(f.selectionStart).toBe(7);
    expect(f.events).toEqual(['input:bubbles']);
  });

  it('execCommand 直接抛 → 同样退回', () => {
    const f = field('- 锂电');
    applyEdit(asField(f), { from: 4, to: 4, insert: '\n- ', caret: 7 }, () => {
      throw new Error('not supported');
    });
    expect(f.value).toBe('- 锂电\n- ');
  });

  it('execCommand 说成功、字其实没变 → 退回，而且**只插一次**', () => {
    const f = field('- 锂电');
    applyEdit(asField(f), { from: 4, to: 4, insert: '\n- ', caret: 7 }, () => true);
    expect(f.value).toBe('- 锂电\n- ');
  });

  it('删除（结束列表）走 delete；**区间为空时绝不调 delete**（那会往回吃掉一个字）', () => {
    const f = field('- 锂电\n- ');
    const calls: string[] = [];
    applyEdit(asField(f), { from: 5, to: 7, insert: '', caret: 5 }, workingExec(f, calls));
    expect(f.value).toBe('- 锂电\n');
    expect(calls).toEqual(['delete']);

    const g = field('锂电', 1);
    const gCalls: string[] = [];
    applyEdit(asField(g), { from: 1, to: 1, insert: '', caret: 1 }, workingExec(g, gCalls));
    expect(gCalls).toEqual([]);
    expect(g.value).toBe('锂电');
  });
});

describe('草稿（App 被系统回收之后还在）', () => {
  it('按代号分开存 —— 换人登录看不到上一个人没写完的东西（T30）', () => {
    const s = mem();
    storeDraft(s, 'mc', 'Alpin 会谈纪要');
    expect(loadDraft(s, 'mc')).toBe('Alpin 会谈纪要');
    expect(loadDraft(s, 'lw')).toBe('');
    expect([...s.m.keys()]).toEqual([draftKey('mc')]);
  });

  it('存下来之后（正文变空）那一格删掉，不留空串', () => {
    const s = mem();
    storeDraft(s, 'mc', '草稿');
    storeDraft(s, 'mc', '   ');
    expect(s.m.size).toBe(0);
  });

  it('🔴 存储会抛（Safari 无痕）时静默跳过 —— 草稿存不住绝不能挡住打字', () => {
    const boom: DraftStore = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(() => storeDraft(boom, 'mc', '草稿')).not.toThrow();
    expect(() => storeDraft(boom, 'mc', '')).not.toThrow();
    expect(loadDraft(boom, 'mc')).toBe('');
    expect(loadDraft(undefined, 'mc')).toBe('');
  });
});
