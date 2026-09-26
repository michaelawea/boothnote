import { useEffect, useRef, useState } from 'react';

import { T, fmtAgo, fmtDuration } from '../theme';
import { db, type Note } from '../db';
import { attachmentCount } from '../attach';
import { AttachmentList } from '../components/Attachments';
import { flush } from '../sync';
import { fetchNoteThreads, retryTranscribe, sendToAgent, type NoteThread } from '../api';
import { syncLabel } from '../retry';
import { MarkdownLite } from '../components/MarkdownLite';
import { Backdrop } from '../components/Backdrop';
import { Sheet } from '../components/Sheet';
import { useNoteDelete } from '../components/DeleteNote';
import { IconChevron, IconPen, IconSpark, IconTrash } from '../icons';
import { t } from '../i18n';
import { setBusy } from '../update';

/**
 * ══════════════════════════════════════════════════════════════════
 *  单条速记的详情页（D96 · issue #27）
 *
 *  维护者 2026-08-07：「希望『速记』主界面更多承担快速浏览和记录的作用，
 *  而具体的查看、修改和操作集中到单条速记的详情界面中，避免主界面越来越复杂。」
 *
 *  🔴 **这一屏的存在理由是给主界面减负，所以搬过来的东西必须真的从那边拿走。**
 *  只是「详情页也有一份」的话，主界面一格没省，反而多了一处要同步维护的实现 ——
 *  而这个仓库最贵的 bug 全是「同一件事两处实现，其中一处后来错了」。
 *  现在主界面上一条速记只剩：标题 / 摘要 / 时间 / 客户 / 状态，一个动作都没有
 *  （唯一的例外是没传上去时那个「点一下重试」—— 它说的是同步层，
 *  而且「失败了但点不动」是最让人放弃这个工具的状态）。
 *
 *  ── 三个动作都在这儿，各带各的闸门 ────────────────────────────────
 *    · **改**      → `staging.edited_text`（issue #15/#16）。原话一个字不动。
 *    · **发给 AI** → issue #26 的 double check（见 `AgentSheet`）
 *    · **删除**    → issue #25 的速记页删除。**CRM 一个字不动。**
 *
 *  ⚠️ 关掉这一屏要**自然回到速记主界面**（issue #27 的原话）。所以它是一层
 *     盖在上面的 sheet，不是一次路由跳转 —— 主界面整个还挂着，
 *     滚动位置、正在打的草稿、录音句柄一个都不受影响。
 * ══════════════════════════════════════════════════════════════════ */

/** 三层文字里该显示哪一层：人改定的 > 人当时打的 > 机器听的。 */
const bodyOf = (n: Note) => n.editedText || n.text || n.transcript || '';

export const NoteDetail = ({
  note,
  onClose,
  onOpenChat,
  onDeleted,
}: {
  note: Note;
  onClose: () => void;
  onOpenChat?: (threadId: string) => void;
  /** 删掉之后由调用方决定怎么收场（关掉这一屏 + 刷新列表）。 */
  onDeleted: () => void;
}) => {
  const [closing, setClosing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setLocalBusy] = useState<'agent' | 'retry' | null>(null);
  const [agentSheet, setAgentSheet] = useState<AgentChoice | null>(null);
  /**
   * 删除走**全应用唯一的那份实现**（`components/DeleteNote.tsx`）——
   * 速记列表上那个垃圾桶（D105 · issue #34）用的是同一个 hook。
   * 两处各写一遍的话，「先服务端后本地」那个顺序迟早有一处会写反。
   */
  const del = useNoteDelete({ onDeleted });
  const textarea = useRef<HTMLTextAreaElement | null>(null);

  /**
   * 🔴 改到一半的时候**不许自动刷新**（D83）。
   *
   * `location.reload()` 一个字都留不下，而人可能已经在这儿敲了两分钟。
   * 和速记页那个 `holding` 是同一条判据，只是这一屏有自己的编辑框，
   * 所以要自己报一次 —— 主界面那个 `holding` 看不见这里的 state。
   */
  useEffect(() => {
    setBusy('note-detail', editing);
    return () => setBusy('note-detail', false);
  }, [editing]);

  const close = () => {
    setClosing(true);
    window.setTimeout(onClose, 190);
  };

  /**
   * 保存修改。**两条路，分界线是「服务端见过它没有」**（和速记页同一份逻辑，
   * 见 `QuickNote.tsx` 的 `saveEdit` —— 那边现在只剩这一处调用）。
   *   · 还没传上去 → 直接改本地 `text`。inbox 里还没有这条，改的就是原文本身。
   *   · 已经传上去 → 写 `editedText`，由 `flushEdits()` 推到 `staging.edited_text`。
   *     **绝不能改 `text` 然后重传** —— `inbox` 只增不改（§4.2 第2条），
   *     而且音频在上传成功那一刻就从本地删了。
   */
  const saveEdit = async () => {
    const v = editText.trim();
    if (v === bodyOf(note).trim()) return setEditing(false);
    if (note.sync !== 'synced' || !note.remoteId) await db.notes.update(note.id, { text: v });
    else await db.notes.update(note.id, { editedText: v, editedAt: Date.now() });
    setEditing(false);
    void flush();
  };

  const retryTx = async () => {
    if (!note.remoteId || busy) return;
    setLocalBusy('retry');
    setErr('');
    try {
      const r = await retryTranscribe(note.remoteId);
      if (r.queued) await db.notes.update(note.id, { stagingStatus: 'pending', stagingError: undefined });
      else if (r.busy) setErr(t('这条正在处理中，等它跑完再说。'));
    } catch (e) {
      setErr((e as Error).message); // 断网时如实说，别假装排上了
    } finally {
      setLocalBusy(null);
    }
  };

  /**
   * ── 发给 AI 之前先问服务端「发过没有」（D95 · issue #26）────────────
   *
   * 🔴 **不能只看本地那格 `sentToAgentAt`。** 它在这台设备的 IndexedDB 里 ——
   * 换台手机、清个缓存、同事在另一台上发过，本地全都是空的，
   * 于是那道 double check 根本不会弹，又开一条对话、又烧一轮模型。
   * 而这正是这个 issue 的第一句话要防的事。
   *
   * ⚠️ 问不到（离线）时**退回保守的确认框**，不当成「一条都没有」。
   */
  const openAgent = async () => {
    if (!note.remoteId || busy) return;
    setLocalBusy('agent');
    setErr('');
    try {
      const threads = await fetchNoteThreads(note.remoteId);
      setAgentSheet({ threads, offline: threads === null });
    } finally {
      setLocalBusy(null);
    }
  };

  const runAgent = async (opts: { force?: boolean; newThread?: boolean }) => {
    if (!note.remoteId) return;
    setAgentSheet(null);
    setLocalBusy('agent');
    setErr('');
    try {
      const r = await sendToAgent(note.remoteId, opts);
      await db.notes.update(note.id, { sentToAgentAt: Date.now() });
      /**
       * 🔴 服务端说「它正在跑」时**要如实说**，不能当成发成功了（D95）。
       * 假装排上了的代价很具体：人以为这一轮是他刚要的那一轮，
       * 等出来的结果不对，他会以为 AI 读错了 —— 而其实那是上一轮的结果。
       */
      if (r.alreadyRunning) {
        setErr(t('这条正在跑（{a}）—— 等它跑完再说。', { a: r.status ?? '' }));
        if (r.threadId) onOpenChat?.(r.threadId);
        return;
      }
      if (r.threadId) onOpenChat?.(r.threadId);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLocalBusy(null);
    }
  };

  /**
   * ── 删除这条速记（D93 · issue #25 的后半段）────────────────────────
   *
   * 维护者 2026-08-07：「『速记』页面中，速记也可以被手动删除，
   * 如果速记内容已经入库，其涉及到的入库内容却不会被删除。」
   *
   * 实现整个搬进了 `components/DeleteNote.tsx`（D105）——
   * 那个按钮**一个 CRM 请求都不发**，确认框上也把这件事说清楚了。
   */
  const body = bodyOf(note);
  const hasAudio = Boolean(note.audioSeconds);
  const failed = note.stagingStatus === 'failed';

  return (
    <Sheet closing={closing}>
      {/* ── 顶栏：左边一个返回，右边一个删除 ────────────────────── */}
      <div
        style={{
          flexShrink: 0,
          paddingTop: 'env(safe-area-inset-top)',
          borderBottom: `1px solid ${T.lineLight}`,
          background: T.bg,
        }}
      >
        <div style={{ height: 52, display: 'flex', alignItems: 'center', padding: '0 8px 0 4px' }}>
          {/* 🔴 出口在左上角、长得像「返回」而不是「关闭」——
              这一屏是从列表里点进来的，人期待的是退回去，不是把什么东西关掉 */}
          <button
            onClick={close}
            style={{ display: 'flex', alignItems: 'center', gap: 2, color: T.textSoft, padding: 10 }}
            aria-label={t('返回')}
          >
            <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>
              <IconChevron size={18} />
            </span>
            <span style={{ fontSize: 14 }}>{t('速记')}</span>
          </button>
          <div style={{ flex: 1 }} />
          {/**
           * 🔴 **删除挪到底部那一排去了**（D107 · 2026-08-11）。
           *
           * 维护者：「点开之后，才有删除键和修改键。」两个键**必须在同一处、
           * 都带文字** —— 之前是「修改」在底部、「删除」是右上角一个图标，
           * 于是在他眼里这一屏只有删除没有修改（原话：「为什么现在速记不能修改了？」）。
           * 一个动作藏在图标里、另一个写着字，人只会看见写着字的那个。
           */}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
        <div className="page-wrap" style={{ padding: '14px 16px 28px' }}>
          {note.title && !editing && (
            <div style={{ fontSize: 19, fontWeight: 600, lineHeight: 1.4, marginBottom: 8 }}>
              {note.title}
            </div>
          )}

          {/* ── 一行元信息 ─────────────────────────────────────── */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              fontSize: 12,
              color: T.textLight,
              marginBottom: 14,
            }}
          >
            <span>{fmtAgo(note.createdAt)}</span>
            {note.companyName && <span>· {note.companyName}</span>}
            {hasAudio && <span>· 🎙 {fmtDuration(note.audioSeconds!)}</span>}
            {note.visitLabel && <span>· {note.visitLabel}</span>}
          </div>

          {/* ── 正文 —— 这一屏的主角，**不截断** ──────────────────
              主界面上它被压成两行摘要（issue #27 要的「快速浏览」），
              完整那一份就得在这儿；两边都截断的话这个页面就没有理由存在。 */}
          {editing ? (
            <>
              <textarea
                ref={textarea}
                value={editText}
                autoFocus
                onChange={(e) => setEditText(e.target.value)}
                rows={10}
                style={{
                  width: '100%',
                  resize: 'vertical',
                  minHeight: 200,
                  padding: '11px 13px',
                  borderRadius: 12,
                  border: `1px solid ${T.line}`,
                  background: T.surface,
                  color: T.text,
                  font: 'inherit',
                  fontSize: 15,
                  lineHeight: 1.7,
                }}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
                <button
                  className="btn sm"
                  style={{ background: T.text, color: '#fff', boxShadow: 'none' }}
                  onClick={() => void saveEdit()}
                >
                  {t('保存')}
                </button>
                <button
                  className="btn sm"
                  style={{ background: T.s3, color: T.text, boxShadow: 'none' }}
                  onClick={() => setEditing(false)}
                >
                  {t('取消')}
                </button>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: T.textLight }}>
                  {t('原话和原始转录都会留着')}
                </span>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 15, lineHeight: 1.75 }}>
              <MarkdownLite
                text={
                  body ||
                  (hasAudio
                    ? note.sync === 'synced'
                      ? t('🎙 {a} 语音 · 正在转写…', { a: fmtDuration(note.audioSeconds!) })
                      : t('🎙 {a} 语音', { a: fmtDuration(note.audioSeconds!) })
                    : t('（附件）'))
                }
              />
            </div>
          )}

          {/* 改过的要说出来，原始转录要翻得到（issue #15/#16 的同一条） */}
          {!editing && note.editedText && note.transcript && note.transcript !== note.editedText && (
            <Block title={t('机器听到的（未修改）')}>
              <MarkdownLite text={note.transcript} />
            </Block>
          )}
          {/* 打字 + 录音都有时，转录单独一块 —— 两者是不同来源，不能揉成一段 */}
          {!editing && note.text && note.transcript && !note.editedText && (
            <Block title={t('录音转录')}>
              <MarkdownLite text={note.transcript} />
            </Block>
          )}

          {/* 本地原件（还没传）或服务端清单（传上去了 / 别的设备传的）—— 两种都要看得到图（issue #53） */}
          {attachmentCount(note) > 0 && (
            <Block title={t('附件')}>
              <AttachmentList local={note.attachments} remote={note.remoteAttachments} />
            </Block>
          )}

          {/* ── 状态（issue #27:「查看相关状态」）─────────────────────
              两层分开说，因为它们答的不是同一个问题（D87）：
                · `sync`          这条**传上去**了没有
                · `stagingStatus` 服务端**处理**得怎么样
              合成一句的话，「传完了但转写失败」会长得和「一切正常」一模一样。 */}
          <Block title={t('状态')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5 }}>
              <StatusLine
                label={t('上传')}
                value={note.sync === 'synced' ? t('已上传') : syncLabel(note)}
                tone={note.sync === 'synced' ? 'ok' : note.sync === 'failed' ? 'bad' : 'wait'}
              />
              {note.stagingStatus && (
                <StatusLine
                  label={t('服务端')}
                  value={t(SERVER_STATUS[note.stagingStatus] ?? note.stagingStatus)}
                  tone={failed ? 'bad' : note.stagingStatus === 'confirmed' ? 'ok' : 'wait'}
                />
              )}
              {note.sentToAgentAt && (
                <StatusLine label={t('发给 AI')} value={fmtAgo(note.sentToAgentAt)} tone="ok" />
              )}
            </div>

            {/* 转写失败：**必须看得见，而且能再试一次**（D87 · issue #21②）。
                第一句先说「音频还在」—— 展台上人最怕的是那句话没了，而它确实还在。 */}
            {failed && (
              <div
                style={{
                  marginTop: 9,
                  padding: '9px 11px',
                  background: T.s2,
                  borderRadius: 10,
                  borderLeft: `3px solid ${T.amber}`,
                }}
              >
                <div style={{ fontSize: 12.5, color: T.text }}>
                  {hasAudio
                    ? t('这段录音没转出来 —— 音频还在，没丢。')
                    : t('这条服务端没处理成功。原文还在。')}
                </div>
                {note.stagingError && (
                  <div style={{ fontSize: 11, color: T.textLight, marginTop: 3, lineHeight: 1.5 }}>
                    {note.stagingError.slice(0, 200)}
                  </div>
                )}
                {Boolean(hasAudio && note.remoteId) && (
                  <button
                    onClick={() => void retryTx()}
                    disabled={busy === 'retry'}
                    style={{
                      marginTop: 8,
                      fontSize: 12,
                      padding: '6px 12px',
                      borderRadius: 8,
                      background: T.blue,
                      color: '#fff',
                      fontWeight: 600,
                      opacity: busy === 'retry' ? 0.5 : 1,
                    }}
                  >
                    {busy === 'retry' ? t('正在排队…') : t('重试转写')}
                  </button>
                )}
              </div>
            )}
          </Block>

          {/* 🔴 删除失败的原话也必须落在这里 —— 静默失败 = 假装删掉了 */}
          {(err || del.error) && (
            <div
              style={{
                marginTop: 12,
                background: T.redSoft,
                color: T.red,
                borderRadius: 10,
                padding: '9px 11px',
                fontSize: 12.5,
                lineHeight: 1.7,
              }}
            >
              {err || del.error}
            </div>
          )}
        </div>
      </div>

      {/* ── 底部两个动作 ────────────────────────────────────────
          常驻在屏幕底部（不随内容滚走）：一条 10 分钟的语音速记转录出来
          能有好几屏，动作藏在最下面等于没有。 */}
      {!editing && (
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            gap: 9,
            padding: '10px 16px',
            paddingBottom: 'max(10px, env(safe-area-inset-bottom))',
            borderTop: `1px solid ${T.lineLight}`,
            background: T.surface,
          }}
        >
          <button
            className="btn"
            style={{ flex: 1, background: T.s3, color: T.text, boxShadow: 'none' }}
            onClick={() => {
              setEditText(bodyOf(note));
              setEditing(true);
            }}
          >
            <IconPen size={15} />
            {t('修改')}
          </button>
          <button
            className="btn"
            style={{
              flex: 1,
              background: note.sync === 'synced' ? T.text : T.s3,
              color: note.sync === 'synced' ? '#fff' : T.textLight,
              boxShadow: 'none',
              opacity: busy === 'agent' ? 0.5 : 1,
            }}
            // 🔴 还没传上去的发不了 —— 服务端手上根本没有这条。
            //    按钮变灰 + 下面那行小字说清楚，别让人对着一个没反应的键点五次。
            disabled={note.sync !== 'synced' || busy === 'agent'}
            onClick={() => void openAgent()}
          >
            <IconSpark size={15} />
            {busy === 'agent' ? t('发送中…') : note.sentToAgentAt ? t('再发一次') : t('发给 AI')}
          </button>
          {/**
           * 🔴 **删除和修改并排、都带文字**（D107 · issue #34 修订）。
           *
           * 维护者 2026-08-11 实测之后的原话：「点开之后，才有删除键和修改键。」
           * 这两个键**成对出现在同一处**才算数：之前修改在这一排、删除是右上角一个
           * 灰/红图标，结果是他在这一屏上只看见删除 —— 图标和文字放在一起时，
           * 人只会读那个写着字的。
           *
           * 窄一点（不 `flex: 1`）是刻意的：它是破坏性动作，不该和另外两个等宽 ——
           * 看得见、但不是这一屏的主角。误触仍由确认框挡着（D93：那个框先说清后果）。
           */}
          <button
            className="btn"
            onClick={() => void del.ask(note)}
            disabled={del.deleting}
            style={{
              flexShrink: 0,
              padding: '0 14px',
              background: T.redSoft,
              color: T.red,
              border: `1px solid ${T.red}40`,
              boxShadow: 'none',
              opacity: del.deleting ? 0.5 : 1,
            }}
            aria-label={t('删除这条速记')}
          >
            <IconTrash size={15} />
            {t('删除')}
          </button>
        </div>
      )}

      {agentSheet && (
        <AgentSheet
          choice={agentSheet}
          firstTime={!note.sentToAgentAt}
          onClose={() => setAgentSheet(null)}
          onOpenThread={(id) => {
            setAgentSheet(null);
            onOpenChat?.(id);
          }}
          onRun={runAgent}
        />
      )}

      {del.sheet}
    </Sheet>
  );
};

/** 服务端那一格状态 → 一句人话。**中文存在这里，`t()` 在渲染那一刻才调**（D80）。 */
const SERVER_STATUS: Record<string, string> = {
  pending: '排队中',
  transcribing: '转写中',
  extracting: 'AI 整理中',
  ready: '整理完，等确认',
  confirming: '入库中',
  committing: '写入中',
  confirmed: '已入库',
  failed: '处理失败',
  superseded: '已被后一版取代',
  waiting_user: '等你回答',
};

const Block = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div
    style={{
      marginTop: 16,
      padding: '10px 12px',
      background: T.s2,
      border: `1px solid ${T.lineLight}`,
      borderRadius: 12,
    }}
  >
    <div style={{ fontSize: 11, color: T.textLight, marginBottom: 5 }}>{title}</div>
    <div style={{ fontSize: 13, lineHeight: 1.7, color: T.textSoft }}>{children}</div>
  </div>
);

const TONE = { ok: T.green, bad: T.red, wait: T.amber } as const;

const StatusLine = ({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: keyof typeof TONE;
}) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
    <span style={{ width: 8, height: 8, borderRadius: 4, background: TONE[tone], flexShrink: 0 }} />
    <span style={{ color: T.textLight, minWidth: 54 }}>{label}</span>
    <span style={{ color: T.text }}>{value}</span>
  </div>
);

// ═══════════════════════════════════════════════════════════════════
//  发给 AI 的 double check（D95 · issue #26）
// ═══════════════════════════════════════════════════════════════════

type AgentChoice = { threads: NoteThread[] | null; offline: boolean };

/**
 * 维护者 2026-08-07：「为了避免同一个速记同时创立多个 Agent 进程，或者重复发送，
 * 要加一个 double check 机制，如果某一个速记已经发送给了一个 Agent 进程，
 * 需要提醒用户，可以跳转进入该聊天 Agent 进程，或者客户也可以选择，创建一个新的对话，
 * 当创建新对话之后，该速记链接的聊天进程，就会变成两个，用户就可以进行选择。」
 *
 * 🔴 **这个框替代掉了原来那个 `window.confirm`，而不是叠在它上面。**
 * 原来那一个只有「确定 / 取消」两个出口，而人在那一刻真正想做的第三件事 ——
 * 「先去看看上次那轮说了什么」—— 它根本表达不了。于是人只能点确定，
 * 再烧一轮模型，而上一轮的结果就是这么被覆盖掉的。
 *
 * 所以这里的三个出口对应三个真实意图：
 *   ① 点某一条对话  → 我想看看那边现在是什么样（**不烧模型**）
 *   ② 重新整理      → 在原对话里再跑一轮（上一轮的提案会被继承）
 *   ③ 新建一个对话  → 从零重读这条速记（新线程里没有上一轮，模型只看到原话）
 */
const AgentSheet = ({
  choice,
  firstTime,
  onClose,
  onOpenThread,
  onRun,
}: {
  choice: AgentChoice;
  firstTime: boolean;
  onClose: () => void;
  onOpenThread: (id: string) => void;
  onRun: (opts: { force?: boolean; newThread?: boolean }) => void;
}) => {
  const threads = choice.threads ?? [];
  /**
   * 🔴 **「发过没有」以服务端为准，不以本地那格为准。**
   * 服务端说有对话 = 发过，哪怕这台设备的 `sentToAgentAt` 是空的
   * （换了手机 / 清了缓存 / 同事在另一台上发的）。
   */
  const sent = threads.length > 0;
  const running = threads.some((x) => x.running);

  return (
    <Backdrop onClose={onClose}>
      <div style={{ fontSize: 15.5, fontWeight: 600, marginBottom: 6 }}>
        {sent ? t('这条已经发给 AI 了') : t('把这条交给 AI 整理？')}
      </div>
      <div style={{ fontSize: 12.5, color: T.textSoft, lineHeight: 1.75, marginBottom: 12 }}>
        {choice.offline
          ? t('现在离线，查不到它发给过哪几条对话 —— 有网时再发比较稳妥。')
          : sent
            ? t('它已经在下面这些对话里了。先进去看看，还是让 AI 重新读一遍？')
            : t('AI 会读一遍并抽出客户、类型、字段，整理完出现在「看板」的待确认里等你核对。（原话不会被改动）')}
      </div>

      {threads.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 14 }}>
          {threads.map((x) => (
            <button
              key={x.id}
              onClick={() => onOpenThread(x.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                textAlign: 'left',
                padding: '10px 12px',
                borderRadius: 12,
                border: `1px solid ${x.active ? T.blue : T.line}`,
                background: x.active ? T.blueSoft : T.surface,
              }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <span
                  style={{
                    display: 'block',
                    fontSize: 13.5,
                    fontWeight: 500,
                    color: T.text,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {x.title || t('未命名对话')}
                </span>
                <span style={{ display: 'block', fontSize: 11, color: T.textLight, marginTop: 2 }}>
                  {t('{a} 条消息', { a: x.messages })}
                  {' · '}
                  {fmtAgo(new Date(x.last_message_at).getTime())}
                  {/* 🔴 「当前这一条」要标出来：提案落在它名下，另一条里的核对卡是旧的 */}
                  {x.active && ` · ${t('当前')}`}
                  {x.running && ` · ${t('正在跑')}`}
                </span>
              </span>
              <IconChevron size={14} />
            </button>
          ))}
        </div>
      )}

      {/* 🔴 正在跑的时候两个「再跑一轮」都不给 —— 这个 issue 的第一句话就是
          「避免同一个速记同时创立多个 Agent 进程」。服务端也挡着（`alreadyRunning`），
          但让一个点下去必然被拒的按钮亮着，本身就是在骗人。 */}
      {running ? (
        <div style={{ fontSize: 12.5, color: T.amber, lineHeight: 1.7 }}>
          {t('AI 正在跑这一条 —— 等它跑完再决定要不要重来。点上面那条对话可以看进度。')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            className="btn"
            style={{ background: T.text, color: '#fff', boxShadow: 'none' }}
            onClick={() => onRun(firstTime && !sent ? {} : { force: true })}
          >
            {sent ? t('在原对话里重新整理') : t('发给 AI')}
          </button>
          {sent && (
            <>
              <button
                className="btn"
                style={{ background: T.s3, color: T.text, boxShadow: 'none' }}
                onClick={() => onRun({ newThread: true })}
              >
                {t('新建一个对话')}
              </button>
              {/* 两个按钮的**代价不一样**，必须说清楚 —— 一句「确定吗」两边都对不上 */}
              <div style={{ fontSize: 11, color: T.textLight, lineHeight: 1.7, marginTop: 2 }}>
                {t('两个都会再花一次模型调用，而且这一轮读出来的东西会覆盖上一轮的提案。')}
                <br />
                {t('区别是：原对话会带着上一轮的结果接着改；新对话从零重读这条速记。')}
              </div>
            </>
          )}
        </div>
      )}
    </Backdrop>
  );
};

// ═══════════════════════════════════════════════════════════════════
//  删除这条速记的二次确认（D93 · issue #25）
// ═══════════════════════════════════════════════════════════════════
//
//  📜 整块搬去了 `components/DeleteNote.tsx`（D105 · issue #34）——
//     速记列表上每一行也要能删，而「同一件事两处实现」是这个仓库最贵的
//     那类 bug 的形状。底部弹层的壳也一起搬进了 `components/Backdrop.tsx`
//     （`Board.tsx` 原来是从这个**页面**里 import 它的）。
