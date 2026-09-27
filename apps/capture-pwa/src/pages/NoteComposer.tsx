import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
/**
 * GitHub 自己每个评论框上那一排格式键（MIT · ~5 KB gzip · github/markdown-toolbar-element）。
 * import 这一行就把 `<markdown-toolbar>` / `<md-bold>` 这些自定义元素注册好了。
 */
import '@github/markdown-toolbar-element';

import { T } from '../theme';
import type { LocalAttachment } from '../db';
import { AttachmentList } from '../components/Attachments';
import { MarkdownLite } from '../components/MarkdownLite';
import { Sheet } from '../components/Sheet';
import { continueList } from '../markdown';
import { afterTool, applyEdit, beforeTool, keyIntent } from '../editor';
import {
  IconBold,
  IconCamera,
  IconChevron,
  IconFile,
  IconHeading,
  IconImage,
  IconListBullet,
  IconListNumber,
  IconListTask,
  IconQuote,
} from '../icons';
import { t } from '../i18n';

/**
 * ══════════════════════════════════════════════════════════════════
 *  「写一条」的编辑器（D135 · 维护者 2026-09-27）
 *
 *  「速记里面的『写一条』，加一个更专业的输入界面……原本的对话框保留，
 *    只是作为一个更加快速的速记方法。如果有开源工具可以直接用，那么更好。」
 *
 *  ── 三个决定 ────────────────────────────────────────────────────
 *
 *  ① **和快速输入框是同一份草稿，不是第二个输入框。**
 *     `text` / `atts` / `save()` 全在 `QuickNote` 里，这一屏只是把它们摊大。
 *     于是「收起」不会丢任何东西（写了一半收起来，字就在快速框里），
 *     「存下来」走的是同一个 `save()` —— 幂等键、离线队列、D83 的刷新闸门
 *     一个都不用重写。**同一件事两处实现**是这个仓库最贵的那类 bug。
 *
 *  ② **格式键用 GitHub 的开源组件，底下仍是一个原生 `<textarea>`。**
 *     没选 Tiptap / Lexical / OverType 这类「所见即所得」：
 *     · 它们靠 contenteditable 或透明层叠字，**中文输入法在 iOS 上是它们的老大难**
 *       —— 拼音上屏前那几个字母、候选框的位置，全靠编辑器自己模拟；
 *       原生 textarea 这些全由系统管，展馆里没人有空跟输入法较劲。
 *     · 存下来的仍是纯文本 markdown —— inbox 里的原文、agent 读的、详情页渲染的
 *       是同一份东西，**数据形状一个字不变**。
 *     · 体积：+5 KB（Tiptap 一套下来 100 KB 上下，整个应用才一百多 KB）。
 *
 *  ③ **工具栏贴着键盘上沿**（iOS 备忘录 / Bear 的形态），靠 `visualViewport` 摆位。
 *     放在顶上的话，键盘一弹起来 iOS 会把整页往上推，工具栏和「存下来」一起被推出屏幕。
 * ══════════════════════════════════════════════════════════════════ */

export type PickKind = 'photo' | 'image' | 'file';

/** 可见区域（键盘弹起来之后它会变矮、还可能被 iOS 往下挪）。 */
const useVisualViewport = () => {
  const [vv, setVv] = useState<{ h: number; top: number } | null>(null);
  useEffect(() => {
    const v = window.visualViewport;
    if (!v) return;
    const on = () => setVv({ h: v.height, top: v.offsetTop });
    on();
    v.addEventListener('resize', on);
    v.addEventListener('scroll', on);
    return () => {
      v.removeEventListener('resize', on);
      v.removeEventListener('scroll', on);
    };
  }, []);
  return vv;
};

/** React 键盘事件 → `keyIntent` 要的那几格（`isComposing` 只在原生事件上）。 */
const keyOf = (e: React.KeyboardEvent) => ({
  key: e.key,
  keyCode: e.keyCode,
  isComposing: e.nativeEvent.isComposing,
  metaKey: e.metaKey,
  ctrlKey: e.ctrlKey,
  shiftKey: e.shiftKey,
  altKey: e.altKey,
});

export const NoteComposer = ({
  text,
  onText,
  atts,
  onRemoveAtt,
  attBusy,
  attErr,
  onPick,
  onSave,
  onClose,
}: {
  text: string;
  onText: (v: string) => void;
  atts: LocalAttachment[];
  onRemoveAtt: (index: number) => void;
  attBusy: boolean;
  attErr: string;
  onPick: (kind: PickKind) => void;
  /** 存下来 —— 就是快速输入框那一份 `save()`。存完这一屏自己收起。 */
  onSave: () => Promise<void>;
  onClose: () => void;
}) => {
  const id = useId();
  const ta = useRef<HTMLTextAreaElement | null>(null);
  const bar = useRef<HTMLElement | null>(null);
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  const [closing, setClosing] = useState(false);
  const [saving, setSaving] = useState(false);
  const vv = useVisualViewport();
  /** 键盘开着：底部就不用再让出 Home 条那一截（键盘已经盖住了它）。 */
  const keyboard = vv ? window.innerHeight - vv.h > 120 : false;

  const hasDraft = Boolean(text.trim() || atts.length);
  const count = [...text.replace(/\s/g, '')].length;

  // 一打开就能写，光标放在末尾 —— 草稿是从快速框带过来的话，人要接着往下写，不是从头插
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  /**
   * GitHub 那个组件在没有 execCommand 的浏览器上会直接 `textarea.value = …`
   * 再发一个自定义 input 事件 —— 那条路 React 的 onChange 看不见（它认的是值追踪器，
   * 而直接赋值把追踪器也一起改了）。这里原生监听一次兜住：不兜的话，
   * 下一次 1.5 秒轮询重渲染会把刚加上的 `**` 悄悄抹掉。
   */
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    const sync = () => onText(el.value);
    el.addEventListener('input', sync);
    return () => el.removeEventListener('input', sync);
  }, [onText]);

  /**
   * 包住 GitHub 组件的每一次点击：之前撑整行、之后收回光标（见 `editor.ts` 的 beforeTool / afterTool）。
   * 🔴 两个阶段都不能挪：`before` 在捕获阶段 —— 冒泡的话组件已经按旧选区加完格式了；
   * `after` 在冒泡阶段 —— 捕获的话组件还没动手，收了也白收。
   */
  useEffect(() => {
    const tb = bar.current;
    const el = ta.current;
    if (!tb || !el) return;
    let caretOnly = false;
    const before = (e: Event) => {
      caretOnly = beforeTool(el, e.target as Element | null);
    };
    const after = () => {
      afterTool(el, caretOnly);
      caretOnly = false;
    };
    tb.addEventListener('click', before, true);
    tb.addEventListener('click', after);
    return () => {
      tb.removeEventListener('click', before, true);
      tb.removeEventListener('click', after);
    };
  }, []);

  const close = () => {
    setClosing(true);
    window.setTimeout(onClose, 190);
  };

  /**
   * 🔴 图片还在读 / 压（`attBusy`）时不许存：`save()` 拿的是**此刻**的附件清单，
   * 那张图处理完会落进一份已经清空的草稿 —— 于是它挂到了**下一条**速记上。
   * （闸门放在按钮这一层、不放进 `save()`：录音被打断时也走 `save()`，那条路绝不能被图片挡住。）
   */
  const canSave = hasDraft && !saving && !attBusy;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSave();
      close();
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 🔴 输入法组字时的回车是「确认候选」—— keyIntent 对那种一律回 null，不接管
    const intent = keyIntent(keyOf(e));
    if (intent === 'save') {
      e.preventDefault();
      void save();
    } else if (intent === 'bold') {
      e.preventDefault();
      bar.current?.querySelector<HTMLElement>('md-bold')?.click();
    } else if (intent === 'newline') {
      const el = e.currentTarget;
      const edit = continueList(el.value, el.selectionStart, el.selectionEnd);
      if (!edit) return;
      e.preventDefault();
      applyEdit(el, edit);
    }
  };

  /** 每个格式键共用的那几格。标签在渲染时才翻（模块级 `t()` 会拿到旧语言，D80）。 */
  // role 要自己给：那个组件的每个子类都覆写了 connectedCallback 而没调 super，于是它本来要设的 role="button" 从没设上
  const tool = (label: string) => ({ className: 'editor-tool', role: 'button', 'aria-label': label, title: label });

  return (
    <Sheet closing={closing}>
      {/**
       * 跟着可见区域走：键盘弹起来时整块缩进键盘上面那一截。
       * 桌面上 visualViewport 就是整个窗口，这一层等于什么都没做。
       */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: vv?.top ?? 0,
          height: vv ? vv.h : '100%',
          display: 'flex',
          flexDirection: 'column',
          background: T.bg,
        }}
        onKeyDown={(e) => {
          // 收起不丢东西（草稿还在快速框里），所以 Esc 可以放心给 —— 但组字时的 Esc 是取消拼音，不算
          if (keyIntent(keyOf(e)) === 'close') close();
        }}
      >
        {/* ── 顶栏：收起 · 编辑/预览 · 存下来 ─────────────────────────── */}
        <div
          style={{
            flexShrink: 0,
            paddingTop: keyboard ? 0 : 'env(safe-area-inset-top)',
            borderBottom: `1px solid ${T.lineLight}`,
          }}
        >
          <div className="editor-col" style={{ height: 52, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px 0 4px' }}>
            {/* 「收起」不叫「取消」：取消听起来像「这段不要了」，而它其实原样留在快速框里 */}
            <button
              onClick={close}
              style={{ display: 'flex', alignItems: 'center', gap: 2, color: T.textSoft, padding: 10, flexShrink: 0 }}
              aria-label={t('收起')}
            >
              <span style={{ display: 'inline-flex', transform: 'rotate(90deg)' }}>
                <IconChevron size={18} />
              </span>
              <span style={{ fontSize: 14 }}>{t('收起')}</span>
            </button>
            <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
              <div className="seg" role="tablist">
                <button role="tab" aria-selected={mode === 'write'} data-on={mode === 'write'} onClick={() => setMode('write')}>
                  {t('编辑')}
                </button>
                <button
                  role="tab"
                  aria-selected={mode === 'preview'}
                  data-on={mode === 'preview'}
                  onClick={() => setMode('preview')}
                >
                  {t('预览')}
                </button>
              </div>
            </div>
            <button
              className="btn sm"
              style={{
                background: canSave ? T.text : T.s3,
                color: canSave ? '#fff' : T.textLight,
                boxShadow: 'none',
                flexShrink: 0,
              }}
              disabled={!canSave}
              onClick={() => void save()}
            >
              {t('存下来')}
            </button>
          </div>
        </div>

        {/* ── 正文 ───────────────────────────────────────────────────
            预览时 textarea 只是藏起来、不卸载 —— 卸载的话撤销栈跟着一起没了。 */}
        <div
          className="editor-col"
          style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}
        >
          <textarea
            id={id}
            ref={ta}
            value={text}
            onChange={(e) => onText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('从这里开始写…\n\n下面那一排可以加标题、列表、待办。收起不会丢 —— 字会留在快速输入框里。')}
            style={{
              display: mode === 'write' ? 'block' : 'none',
              flex: 1,
              minHeight: 0,
              width: '100%',
              resize: 'none',
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: T.text,
              font: 'inherit',
              // 🔴 16px 不是审美：iOS 上输入框字号 < 16px 时一聚焦就把整页放大，而这一屏禁了缩放缩不回来
              fontSize: 16,
              lineHeight: 1.7,
              // 底下多留一截给右下角那个字数，最后一行字不会压在它下面
              padding: '14px 16px 30px',
              overflowY: 'auto',
            }}
          />
          {/* 字数浮在正文右下角 —— 放进工具栏的话，375 宽的屏上会被挤出屏幕 */}
          {mode === 'write' && count > 0 && (
            <span
              style={{
                position: 'absolute',
                right: 14,
                bottom: 6,
                fontSize: 11.5,
                color: T.textLight,
                background: T.bg,
                padding: '0 4px',
                pointerEvents: 'none',
              }}
            >
              {t('{a} 字', { a: count })}
            </span>
          )}
          {mode === 'preview' && (
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 16px' }}>
              {text.trim() ? (
                <div style={{ fontSize: 15, lineHeight: 1.75 }}>
                  <MarkdownLite text={text} />
                </div>
              ) : (
                <div style={{ color: T.textLight, fontSize: 14 }}>{t('（还没写内容）')}</div>
              )}
              <div style={{ color: T.textLight, fontSize: 11.5, marginTop: 18 }}>
                {t('存下来之后，详情页里就是这个样子。')}
              </div>
            </div>
          )}
        </div>

        {/* ── 附件（和快速框同一份）───────────────────────────────── */}
        {(atts.length > 0 || attBusy || attErr) && (
          <div className="editor-col" style={{ flexShrink: 0, maxHeight: '34%', overflowY: 'auto', padding: '0 12px 8px' }}>
            {attBusy && <div style={{ color: T.textLight, fontSize: 12.5, marginBottom: 6 }}>{t('正在处理图片…')}</div>}
            <AttachmentList local={atts} onRemove={onRemoveAtt} />
            {attErr && <div style={{ color: T.amber, fontSize: 12.5, marginTop: 6 }}>{attErr}</div>}
          </div>
        )}

        {/* ── 贴着键盘的工具栏 ──────────────────────────────────────
            🔴 mousedown 一律 preventDefault：点格式键**不许把焦点从 textarea 抢走** ——
            抢走的话 iPhone 键盘会先收下去再弹上来，每点一次闪一下。 */}
        <div
          style={{
            flexShrink: 0,
            borderTop: `1px solid ${T.lineLight}`,
            background: T.surface,
            paddingBottom: keyboard ? 0 : 'env(safe-area-inset-bottom)',
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="editor-col editor-dock">
            <div className="editor-tools" data-off={mode === 'preview'}>
              <markdown-toolbar for={id} ref={bar} className="editor-tools-inner">
                <md-header level="2" {...tool(t('标题'))}>
                  <IconHeading size={19} />
                </md-header>
                <md-bold {...tool(t('粗体'))}>
                  <IconBold size={18} />
                </md-bold>
                <md-unordered-list {...tool(t('列表'))}>
                  <IconListBullet size={19} />
                </md-unordered-list>
                <md-ordered-list {...tool(t('编号列表'))}>
                  <IconListNumber size={19} />
                </md-ordered-list>
                <md-task-list {...tool(t('待办'))}>
                  <IconListTask size={19} />
                </md-task-list>
                <md-quote {...tool(t('引用'))}>
                  <IconQuote size={19} />
                </md-quote>
              </markdown-toolbar>
            </div>
            <span className="editor-sep" />
            <button className="editor-tool" onClick={() => onPick('photo')} aria-label={t('拍照')} title={t('拍照')}>
              <IconCamera size={19} />
            </button>
            <button className="editor-tool" onClick={() => onPick('image')} aria-label={t('图片')} title={t('图片')}>
              <IconImage size={19} />
            </button>
            <button className="editor-tool" onClick={() => onPick('file')} aria-label={t('文件')} title={t('文件')}>
              <IconFile size={19} />
            </button>
          </div>
        </div>
      </div>
    </Sheet>
  );
};
