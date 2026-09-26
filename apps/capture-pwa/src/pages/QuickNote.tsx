import { useEffect, useRef, useState } from 'react';

import { T, fmtAgo, fmtDuration } from '../theme';
import { db, myNotes, type LocalAttachment, type Note } from '../db';
import { ACCEPT, addFiles, attachmentCount } from '../attach';
import { readForUpload } from '../image';
import { AttachmentList } from '../components/Attachments';
import { flush, uploadProgress } from '../sync';
import { useSyncTick } from '../useSync';
import { ProgressRing } from '../components/ProgressRing';
import { useSession } from '../auth';
import { CURRENT_VISIT } from '../mock-data';
import {
  MAX_RECORD_SECONDS,
  RecorderError,
  WARN_BEFORE_SECONDS,
  startRecording,
  type RecordingHandle,
} from '../recorder';
import { syncLabel } from '../retry';
import {
  IconCamera,
  IconChevron,
  IconFile,
  IconImage,
  IconNoteMic,
  IconNoteNew,
  IconStop,
} from '../icons';
import { NoteDetail } from './NoteDetail';
import { t } from '../i18n';
import { setBusy } from '../update';

/**
 * 速记页 —— 这个应用的默认屏，也是它存在的理由。
 *
 * 三条约束把这一屏的形状定死了：
 *   ① **一屏之内录完。** 展馆里人边走边说，多一次跳转就少一条记录。
 *   ② **归属可以空着。**（D28 修订）门槛在「确认入库」那一步，不在这里。
 *   ③ **离线是常态不是异常。** 写进 IndexedDB 就算成功了，上传是后面的事。
 */
export const QuickNotePage = ({ onOpenChat }: { onOpenChat?: (threadId: string) => void }) => {
  const session = useSession();
  const me = session?.user;

  const [text, setText] = useState('');
  const [atts, setAtts] = useState<LocalAttachment[]>([]);
  const [attErr, setAttErr] = useState('');
  /** 正在读字节 / 压图（几百毫秒到两三秒）—— 这段时间不能让人以为点了没反应 */
  const [attBusy, setAttBusy] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);

  const [rec, setRec] = useState<RecordingHandle | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [micErr, setMicErr] = useState<{ msg: string; hint: string } | null>(null);

  /**
   * 打开详情页的是哪一条（D96 · issue #27）。
   *
   * 🔴 存 id 而不是整条 `Note`：列表每 1.5 秒刷一次，存对象的话
   * 详情页上看到的会是**打开那一刻的快照** —— 转录回来了、状态变了、
   * 修改同步完了，这一屏全都不知道。存 id 就永远是最新那一份。
   */
  const [detailId, setDetailId] = useState<string | null>(null);
  /** 录音是被打断的（不是人按停的）—— 说一句，别让人以为是自己按错了（issue #28）。 */
  const [interrupted, setInterrupted] = useState<number | null>(null);
  useSyncTick(); // 上传进度一变就重渲染 —— 1.5 秒轮询会让进度圈看起来卡住
  const fileInput = useRef<HTMLInputElement | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const pendingKind = useRef<'photo' | 'image' | 'file'>('file');

  /**
   * 手上有东西丢不起的时候，禁掉自动刷新（D83）。
   *
   * 🔴 录音句柄、还没保存的正文、刚挑好的附件**全都只在内存里** ——
   *    自动换版本那一步是 `location.reload()`，它们一个都活不下来。
   *    「停在旧版本」是小事，「录了 80 秒被一次静默刷新吃掉」不是。
   *    这几样都没有时才放行，那时刷新的代价只是重画一次。
   */
  const holding = rec !== null || text.trim().length > 0 || atts.length > 0;
  useEffect(() => {
    setBusy('capture', holding);
    return () => setBusy('capture', false);
  }, [holding]);

  // 只读**自己的**（T30：同一台手机换人登录，别把上一个人的速记显示出来）
  useEffect(() => {
    if (!me) return;
    const load = async () =>
      setNotes((await myNotes(me.userCode).reverse().sortBy('createdAt')).slice(0, 40));
    void load();
    const t = window.setInterval(() => void load(), 1500);
    return () => window.clearInterval(t);
  }, [me?.userCode]);

  const save = async (extra: Partial<Note> = {}) => {
    if (!me) return;
    const body = text.trim();
    if (!body && !extra.audioBlob && !atts.length) return;
    await db.notes.add({
      id: crypto.randomUUID(), // 幂等键（§4.2 第6条）—— 断网重传不会产生重复
      text: body,
      createdAt: Date.now(),
      recordedBy: me.userCode,
      visitLabel: CURRENT_VISIT,
      sync: 'queued',
      attempts: 0,
      attachments: atts.length ? atts : undefined,
      ...extra,
    });
    setText('');
    setAtts([]);
    setAttErr('');
    void flush(); // 有网就立刻传；没网就在队列里等，两种情况调用方都不用管
  };

  const stop = async () => {
    const h = rec;
    if (!h) return;
    setRec(null);
    const { blob, mime, seconds: sec } = await h.stop();
    await save({ audioBlob: blob, audioMime: mime, audioSeconds: sec });
  };

  // 到点自动停并保存，而不是让人以为还在录（issue #28 起是 10 分钟）
  useEffect(() => {
    if (!rec) return;
    const t = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [rec]);
  useEffect(() => {
    if (rec && seconds >= MAX_RECORD_SECONDS) void stop();
  }, [seconds, rec]);

  const start = async () => {
    setMicErr(null);
    setInterrupted(null);
    try {
      const h = await startRecording();
      h.onLevel(setLevel);
      /**
       * 🔴 **被掐断的那一段也要存下来**（issue #28）。
       *
       * 上限从 90 秒放到 10 分钟之后，「录到一半被打断」从理论风险变成常发事件：
       * 接个电话、看一眼别的 App、屏幕自动锁屏 —— iOS 网页没有后台录音，
       * 每一样都会让 `MediaRecorder` 自己停掉。
       * 在这个回调之前，那种情况下界面上的计时器还在走，而录音早就死了，
       * 最后**一个字都留不下**。90 秒的上限一直在替我们挡这件事。
       *
       * 存下来 + 说一句，两件都要做：只存不说的话，人会以为自己还在录，
       * 接着对着一个已经停了的界面继续说话。
       */
      h.onInterrupt((r) => {
        setRec(null);
        setInterrupted(r.seconds);
        void save({ audioBlob: r.blob, audioMime: r.mime, audioSeconds: r.seconds });
      });
      setSeconds(0);
      setRec(h);
    } catch (e) {
      if (e instanceof RecorderError) setMicErr({ msg: e.message, hint: e.hint });
      else setMicErr({ msg: t('拿不到麦克风'), hint: (e as Error).message });
    }
  };

  const pick = (kind: 'photo' | 'image' | 'file') => {
    pendingKind.current = kind;
    const el = fileInput.current;
    if (!el) return;
    el.accept = ACCEPT[kind];
    // 「拍照」和「从相册选」在系统层面就是 capture 这一个属性的区别
    if (kind === 'photo') el.setAttribute('capture', 'environment');
    else el.removeAttribute('capture');
    el.value = '';
    el.click();
  };

  /**
   * 选好文件之后：**先读成字节、图片顺手压小**，再进列表（D132 · issue #53）。
   * 🔴 `readForUpload` 必须在 change 事件里马上调 —— iOS 给的 `File` 句柄过一会儿就死了，
   *    存句柄进 IndexedDB 就是这次「HTTP 400」的来源。
   */
  const onFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    const kind = pendingKind.current;
    setAttBusy(true);
    try {
      const prepared = await Promise.all([...list].map((f) => readForUpload(f, kind)));
      setAtts((cur) => {
        const r = addFiles(cur, prepared, kind);
        setAttErr(r.ok ? '' : r.reason);
        return r.attachments;
      });
    } catch (e) {
      setAttErr(t('读取附件失败：{a}', { a: (e as Error).message }));
    } finally {
      setAttBusy(false);
    }
  };

  /**
   * 一条速记当前该显示哪段文字（issue #15/#16）。
   *
   * 三层，从新到旧：人改定的 → 人当时打的 → 机器听的。
   * ⚠️ 用 `||` 不用 `??` 是**故意的**：改成空串会退回原文，而不是留下一张白卡。
   * 「我要把这条清空」不是这个功能要解决的问题（真想丢就别发给 AI），
   * 而一张白卡在现场是彻底没法处理的东西。
   */
  const bodyOf = (n: Note) => n.editedText || n.text || n.transcript || '';

  const hasDraft = Boolean(text.trim() || atts.length);
  const detail = detailId ? notes.find((n) => n.id === detailId) : null;
  /**
   * 详情页那条**在这一轮刷新里消失了**（删掉了 / 换人登录了）。
   * 静默把这一屏留在那儿的话，人对着一份已经不存在的记录点保存 —— 关掉它。
   */
  useEffect(() => {
    if (detailId && !detail) setDetailId(null);
  }, [detailId, detail]);

  return (
    <div style={{ padding: '10px 14px 24px' }}>
      {/**
       * ── 两个并列的入口（issue #16，维护者 2026-08-05）────────────
       *
       * 「应该设计的像是苹果的备忘录那样，有一个按钮（方框中一支笔）创建速记，
       *   旁边并列一个按钮（方框中一个麦克风）进行麦克风速记」
       *
       * 🔴 改这个的理由不是好看：原来这一屏上只有一个 ↑ 键，
       * **人以为它是「发给 Agent」，而它其实只是保存**（维护者 原话）。
       * 一个键长得像另一件事，在展会现场就是每次都要停一下想一想 ——
       * 而这一屏的全部设计目标是「一屏之内录完，多一次犹豫就少一条记录」。
       *
       * 现在两个动词各有一个按钮，而且**都只做「创建一条速记」这一件事**：
       * 交不交给 AI 是速记建好之后、在那张卡片上按的（D31）。
       */}
      {rec ? (
        <div style={{ textAlign: 'center', padding: '18px 0 10px' }}>
          <button
            className="mic"
            data-recording
            onClick={() => void stop()}
            style={{ transform: `scale(${1 + level * 0.12})` }}
            aria-label={t('停止录音')}
          >
            <IconStop size={26} />
          </button>
          <div style={{ fontSize: 13, color: T.red, marginTop: 10, height: 18 }}>
            {fmtDuration(seconds)} · {t('再按一下停止')}
          </div>
          {seconds >= MAX_RECORD_SECONDS - WARN_BEFORE_SECONDS && (
            <div style={{ fontSize: 11.5, color: T.amber }}>
              {t('{a} 秒后自动保存', { a: MAX_RECORD_SECONDS - seconds })}
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 10, padding: '14px 0 12px' }}>
          <BigAction
            icon={<IconNoteNew size={22} />}
            label={t('写一条')}
            hint={t('打字')}
            onClick={() => textarea.current?.focus()}
          />
          <BigAction
            icon={<IconNoteMic size={22} />}
            label={t('说一条')}
            hint={t('录音 ≤10 分钟')}
            primary
            onClick={() => void start()}
          />
        </div>
      )}

      {/**
       * 录音被掐断了（issue #28）。**说出来，而且说清「已经存下来了」** ——
       * 这两句缺一不可：不说的话人以为还在录，只说「被打断了」的话
       * 人以为那几分钟白说了，而它其实好好地在列表第一条。
       */}
      {interrupted !== null && (
        <div
          style={{
            background: T.amberSoft,
            color: T.amber,
            borderRadius: 12,
            padding: '10px 12px',
            fontSize: 12.5,
            lineHeight: 1.7,
            marginBottom: 12,
          }}
        >
          {t('录音被打断了（锁屏、来电、或切到了别的 App）—— 已经录到的 {a} 存下来了。', {
            a: fmtDuration(interrupted),
          })}
        </div>
      )}

      {micErr && (
        <div
          style={{
            background: T.redSoft,
            color: T.red,
            borderRadius: 12,
            padding: '11px 13px',
            fontSize: 12.5,
            lineHeight: 1.7,
            marginBottom: 12,
          }}
        >
          <b>{micErr.msg}</b>
          <div style={{ marginTop: 3 }}>{micErr.hint}</div>
        </div>
      )}

      {/* ── 打字 + 附件 ──────────────────────────────────────── */}
      <div className="composer" style={{ marginBottom: 10 }}>
        <textarea
          ref={textarea}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('写点什么…（支持 markdown）')}
          rows={1}
          style={{ flex: 1, resize: 'none', maxHeight: 160, lineHeight: 1.5, padding: '9px 0' }}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
          }}
        />
        {/**
         * 🔴 这个键叫「存下来」，不叫「发送」（issue #16）。
         *
         * 它以前是一个 ↑ 图标，而 ↑ 在所有聊天界面里的意思都是「发出去」——
         * 于是人以为按下去就交给 AI 了。**它从来只是保存到本地**。
         * 交给 AI 是速记建好之后、在下面那张卡片上按的（D31：抽取是显式触发）。
         * 文字比图标准确，这一格值得多占几个像素。
         */}
        <button
          className="btn sm"
          style={{
            background: hasDraft ? T.text : T.s3,
            color: hasDraft ? '#fff' : T.textLight,
            boxShadow: 'none',
            flexShrink: 0,
          }}
          disabled={!hasDraft}
          onClick={() => void save()}
        >
          {t('存下来')}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 7, marginBottom: atts.length || attErr ? 10 : 18 }}>
        <AttachBtn icon={<IconCamera size={16} />} label={t('拍照')} onClick={() => pick('photo')} />
        <AttachBtn icon={<IconImage size={16} />} label={t('图片')} onClick={() => pick('image')} />
        <AttachBtn icon={<IconFile size={16} />} label={t('文件')} onClick={() => pick('file')} />
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => void onFiles(e.target.files)}
      />

      {attBusy && (
        <div style={{ color: T.textLight, fontSize: 12.5, marginBottom: 10 }}>{t('正在处理图片…')}</div>
      )}
      {atts.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <AttachmentList local={atts} onRemove={(i) => setAtts(atts.filter((_, j) => j !== i))} />
        </div>
      )}
      {attErr && <div style={{ color: T.amber, fontSize: 12.5, marginBottom: 12 }}>{attErr}</div>}

      {/* ── 我的速记 ─────────────────────────────────────────── */}
      <div style={{ fontSize: 12.5, color: T.textSoft, margin: '14px 0 8px' }}>
        {t('今天记了 {a} 条', { a: notes.filter((n) => Date.now() - n.createdAt < 864e5).length })}
      </div>

      {/**
       * ── 列表：**只负责浏览，一个动作都不带**（D96 · issue #27）────────
       *
       * 维护者 2026-08-07：「希望『速记』主界面更多承担快速浏览和记录的作用，
       * 而具体的查看、修改和操作集中到单条速记的详情界面中，
       * 避免主界面越来越复杂。」
       *
       * 🔴 搬走的东西是**真的搬走了**，不是「详情页也有一份」：
       * 改 / 发给 AI / 重试转写 / 展开全文 / 看原始转录，这一屏上一个都没有了。
       * 留一份在这儿的话主界面一格没省，还多了一处要同步维护的实现 ——
       * 而这个仓库最贵的 bug 全是「同一件事两处实现，其中一处后来错了」。
       *
       * **唯一的例外**是没传上去时那个「点一下重试」：它说的是同步层
       * （这条**传上去**了没有），而且「失败了但点不动」是最让人放弃这个工具的状态。
       */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {notes.map((n) => (
          <div key={n.id} className="card" data-state={n.sync} style={{ padding: 0 }}>
            <div style={{ display: 'flex', alignItems: 'stretch' }}>
            <button
              onClick={() => setDetailId(n.id)}
              style={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                textAlign: 'left',
                background: 'transparent',
                padding: '12px 4px 12px 13px',
              }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                {/**
                 * 自动标题（issue #15）。服务端在转写之后生成，没生成出来就不显示 ——
                 * **不在这里编一个**，那会变成「截前 20 个字」，
                 * 也就是它本来要解决的那个问题。
                 */}
                {n.title && (
                  <span
                    style={{
                      display: 'block',
                      fontSize: 14.5,
                      fontWeight: 600,
                      lineHeight: 1.45,
                      marginBottom: 3,
                    }}
                  >
                    {n.title}
                  </span>
                )}
                {/**
                 * 摘要压到两行。**这一屏是「扫一眼」，全文在详情页** ——
                 * 一条 10 分钟的语音转录能有好几屏，摊在列表里就没法浏览了。
                 */}
                <span
                  style={{
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    fontSize: 13,
                    lineHeight: 1.6,
                    color: n.title ? T.textSoft : T.text,
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {bodyOf(n) ||
                    (n.audioSeconds
                      ? n.sync === 'synced'
                        ? t('🎙 {a} 语音 · 正在转写…', { a: fmtDuration(n.audioSeconds) })
                        : t('🎙 {a} 语音', { a: fmtDuration(n.audioSeconds) })
                      : t('（附件）'))}
                </span>

                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 7,
                    marginTop: 6,
                    fontSize: 11.5,
                    color: T.textLight,
                  }}
                >
                  <span>{fmtAgo(n.createdAt)}</span>
                  {n.companyName && <span>· {n.companyName}</span>}
                  {attachmentCount(n) > 0 && <span>· 📎{attachmentCount(n)}</span>}
                  {/**
                   * 🔴 处理失败要在列表上就看得见（D87 · issue #21②）。
                   * 藏进详情页的话，一条转写失败的语音和一条正常的长得一模一样 ——
                   * 人不会为了检查而逐条点进去，于是它永远不会被发现。
                   */}
                  {n.stagingStatus === 'failed' && (
                    <span style={{ color: T.red, fontWeight: 600 }}>· {t('处理失败')}</span>
                  )}
                  {n.editedText && n.editedText !== n.text && <span>· {t('已修改')}</span>}
                  {n.sentToAgentAt && <span>· {t('已发给 AI')}</span>}
                </span>
              </span>

              <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0, color: T.textLight }}>
                <IconChevron size={15} />
              </span>
            </button>

            {/**
             * ── 列表上**一个动作都不放**（D107 修订 · 2026-08-11）────────────
             *
             * D105 曾经在这里挂过一个垃圾桶（issue #34「每一条速记都支持单独删除」）。
             * 维护者 当天实测后否掉了：「删除键不要放在预览界面下，
             * 要点开之后，才有删除键和修改键。」
             *
             * 🔴 **他撞到的不是「多了一个键」，是「只多了一个键」**：
             * 原话是「为什么现在速记不能修改了？」—— 修改一直在详情页里，
             * 但列表行上突然出现一个垃圾桶之后，这一行看起来就像「动作都在这儿」，
             * 而那里只有删除。**一个只露出破坏性动作的入口，比没有入口更糟。**
             *
             * 所以回到 D96 的原则：列表只负责浏览，**改和删成对出现在详情页**。
             * 唯一的例外仍然是下面那个「没传上去 → 点一下重试」（同步层的事）。
             */}
            </div>

            {/* 还没传上去：点一下就强制重试。**这一格不进详情页** ——
                「失败了但点不动」是最让人放弃这个工具的状态（见上面那段注释）。 */}
            {n.sync !== 'synced' && (
              <button
                onClick={() => void flush({ manual: true })}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: 5,
                  padding: '0 13px 10px',
                  color: n.sync === 'failed' ? T.red : n.sync === 'syncing' ? T.blue : T.amber,
                  fontSize: 11.5,
                }}
              >
                {n.sync === 'syncing' && <ProgressRing value={uploadProgress(n.id)} />}
                {n.sync === 'syncing' && typeof uploadProgress(n.id) === 'number' && uploadProgress(n.id)! >= 0
                  ? t('上传中 {a}%', { a: Math.round(uploadProgress(n.id)! * 100) })
                  : syncLabel(n)}
              </button>
            )}
          </div>
        ))}
        {!notes.length && (
          <div style={{ textAlign: 'center', color: T.textLight, fontSize: 13.5, padding: '30px 0' }}>
            {t('还没有记录。按一下上面那个圆键就能开始。')}
          </div>
        )}
      </div>

      {/**
       * ── 单条详情（D96 · issue #27）─────────────────────────────────
       *
       * 🔴 **一层盖上去的 sheet，不是路由跳转。** issue 的原话是
       * 「关闭详情界面后，应当自然回到原来的『速记』主界面」——
       * 这一屏整个还挂着，所以滚动位置、正在打的草稿、**正在录的音**
       * 一个都不受影响。跳路由的话这三样全没了。
       */}
      {detail && (
        <NoteDetail
          key={detail.id}
          note={detail}
          onClose={() => setDetailId(null)}
          onOpenChat={(id) => {
            setDetailId(null); // 先收起详情，免得回来时它还盖在对话上面
            onOpenChat?.(id);
          }}
          /**
           * 删完立刻从列表里拿掉，不等下一次 1.5 秒轮询 ——
           * 详情页收起来之后那一行还在的话，人会以为没删掉，然后再点一次。
           */
          onDeleted={() => {
            setNotes((cur) => cur.filter((x) => x.id !== detail.id));
            setDetailId(null);
          }}
        />
      )}

    </div>
  );
};

const AttachBtn = ({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) => (
  <button className="chip" onClick={onClick} style={{ flex: 1, justifyContent: 'center' }}>
    {icon}
    {label}
  </button>
);

/**
 * 备忘录式的大按钮（issue #16）。两个并列，各占一半宽。
 *
 * 手指目标 64px 高 —— 展馆里人是**边走边按**的，而 iOS 的建议下限是 44。
 * 「说一条」是主键（深色）：现场绝大多数记录是口述的，打字是备选。
 */
const BigAction = ({
  icon,
  label,
  hint,
  primary,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  primary?: boolean;
  onClick: () => void;
}) => (
  <button
    onClick={onClick}
    style={{
      flex: 1,
      height: 64,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      borderRadius: 14,
      border: primary ? 'none' : `1px solid ${T.line}`,
      background: primary ? T.text : T.s2,
      color: primary ? '#fff' : T.text,
      font: 'inherit',
      cursor: 'pointer',
    }}
  >
    {icon}
    <span style={{ textAlign: 'left' }}>
      <span style={{ display: 'block', fontSize: 15, fontWeight: 500 }}>{label}</span>
      <span
        style={{ display: 'block', fontSize: 11.5, color: primary ? 'rgba(255,255,255,.72)' : T.textLight }}
      >
        {hint}
      </span>
    </span>
  </button>
);
