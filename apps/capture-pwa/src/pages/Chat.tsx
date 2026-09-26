import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { T, fmtAgo, fmtDuration } from '../theme';
import {
  abortThread,
  createThread,
  deleteThread,
  downloadAttachment,
  fetchSupersedePreview,
  fetchThread,
  restoreThread,
  syncThreads,
  transcribeAudio,
  type Running,
  type SupersedePreview,
  type ThreadMessage,
} from '../api';
import { db, type LocalAttachment, type Thread } from '../db';
import { ACCEPT, KIND_LABEL, addFiles, humanSize } from '../attach';
import { flush, uploadProgress } from '../sync';
import { useSyncTick } from '../useSync';
import { ProgressRing } from '../components/ProgressRing';
import { useSession } from '../auth';
import { CURRENT_VISIT } from '../mock-data';
import { startRecording, type RecordingHandle } from '../recorder';
import {
  IconCamera,
  IconClose,
  IconCopy,
  IconFile,
  IconHistory,
  IconImage,
  IconMic,
  IconPen,
  IconPlus,
  IconRedo,
  IconSend,
  IconStop,
  IconTrash,
} from '../icons';
import { ReviewCard } from '../components/ReviewCard';
import { WorkLog, agentIsRunning } from '../components/WorkLog';
import { Backdrop } from '../components/Backdrop';
import { Sheet } from '../components/Sheet';
import { useCompanies } from '../companies';
import { t as tr } from '../i18n';
import { spliceAt } from '../compose';

/**
 * AI 全屏对话。
 *
 * 形态照 ChatGPT，理由不是好看 —— 是**销售同事已经在用它**，
 * 界面长得一样，学习成本接近零，而展会现场没有第二次培训的机会。
 *
 * 与 ChatGPT 的唯一实质差别在这里：
 * agent 回的那条消息**底下会挂一张核对卡**。对话是形式，
 * 「把话变成一条能入库的记录」才是目的 —— 它不是聊天机器人。
 */
/**
 * 「它正在干什么 / 它刚才干了什么」现在是同一个组件：`WorkLog`（D74）。
 *
 * 运行中的实时进度和跑完后的回看用同一份轨迹数据 —— 之前是两回事
 * （AgentProgress 只在 waiting 时渲染，跑完整块消失），维护者 2026-08-06
 * 点名要「对话完成后思考流程还在，收缩式，点开看详细日志」。
 */

/**
 * 一个附件。原件在网关磁盘上 —— Twenty 这个版本没有开放文件上传接口，
 * 所以这里提供的下载链接是**唯一**能拿回原件的路径。
 */
const AttachmentChip = ({
  att,
}: {
  att: { id: string; name: string; kind: string; bytes: number; parsed: string | null };
}) => {
  const read = att.parsed === 'ready';
  const body = (
    <>
      <IconFile size={14} />
      <span
        style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {att.name}
      </span>
      <span style={{ fontSize: 11, color: T.textLight, flexShrink: 0 }}>{humanSize(att.bytes)}</span>
      {/* 「已读」不是装饰 —— 它是 agent 真的把文件读开了的凭据。
          没有它，人分不清「传上去了」和「它看过了」。 */}
      {att.parsed && (
        <span style={{ fontSize: 11, color: read ? T.green : T.amber, flexShrink: 0 }}>
          {read ? '已读' : tr('没读开')}
        </span>
      )}
    </>
  );
  const style: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    padding: '8px 12px',
    background: T.s2,
    borderRadius: 12,
    fontSize: 12.5,
    color: T.textSoft,
    textDecoration: 'none',
  };
  // 还没上传完的那份没有 id，点不了
  return att.id ? (
    <button
      onClick={() => void downloadAttachment(att.id, att.name).catch((e) => alert(e.message))}
      style={{ ...style, width: '100%', textAlign: 'left' }}
      title={tr('下载原件')}
    >
      {body}
    </button>
  ) : (
    <div style={style}>{body}</div>
  );
};

// 工具名 → 人话的对照表搬进了 WorkLog.tsx（D74）—— 日志组件自己用，别两处维护。

/**
 * 有没有精确指针（鼠标/触控板）。
 *
 * ⚠️ 判的是**指针精度**不是屏幕宽度 —— 平板横屏够宽但仍然是触屏，
 * 那上面 Enter 就该是换行。按宽度判会判错。
 */
const desktop =
  typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches === true;

/**
 * agent 输出里的 `**粗体**`。
 *
 * 实测（2026-08-04 生产 · issue #7）：星号原样显示成字面量。
 *
 * ⚠️ **不引入 markdown 库。** 这一版打包 111 KB gzip 是刻意压出来的，
 * 为一个星号加一个解析器不划算。只认这一种标记，其余原样输出 ——
 * 我们自己写的文案里用 `<b>`（ProjectCard.tsx 那条注释记过同一个坑），
 * 但 agent 的输出是模型生成的，控制不了，只能在渲染这一侧兜。
 */
const bold = (s: string) =>
  String(s ?? '')
    .split(/\*\*(.+?)\*\*/g)
    .map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part));

/**
 * ── 消息的三个动作（D90 · issue #23）─────────────────────────────────
 *
 * 维护者：「消息发出去之后仍然可以回去改，然后重新发指令。」
 * 在这之前 `Chat.tsx` 里 `编辑` / `重发` / `长按` / `onContextMenu` 一个都搜不到 ——
 * 发出去就是终态，唯一的补救是**再说一遍**，而 agent 会把它当成续写
 * （「在刚才那句的基础上补充」），不是「刚才那句我说错了」。两者结果完全不同。
 *
 * 电脑端悬停显示这一排；手机端长按弹 `PickSheet`（见下面的长按处理）。
 */
const MSG_ACTIONS = ['copy', 'edit', 'resend'] as const;
type MsgAction = (typeof MSG_ACTIONS)[number];

/** 动作 → 人话。**存中文，渲染时才 `t()`** —— 模块级常量不能在加载时求值（D80）。 */
const MSG_ACTION_LABEL: Record<MsgAction, string> = {
  copy: '复制',
  edit: '编辑',
  resend: '重新发送',
};

/** 动作 → 图标（D103 · issue #31）。托起来那一列上三行纯文字长得一样，看不快。 */
const MSG_ACTION_ICON: Record<MsgAction, (p: { size?: number }) => React.ReactElement> = {
  copy: IconCopy,
  edit: IconPen,
  resend: IconRedo,
};

/**
 * 「+」里的那几项（D104 · issue #32）。
 *
 * ⚠️ 三类附件是**系统层面**的三种入口，不是三个好看的图标（`attach.ts` 的
 * `ACCEPT` + `capture` 属性）：拍照直接调后置摄像头、图片走相册、文件走文件选择器。
 * 合成一个「添加附件」的话，展台上想拍一张铭牌得先进相册再点相机。
 * **中文存在这里，`t()` 在渲染那一刻才调**（D80）。
 */
const PLUS_ITEMS: Array<{
  kind: 'photo' | 'image' | 'file';
  label: string;
  Icon: (p: { size?: number }) => React.ReactElement;
}> = [
  { kind: 'photo', label: '拍照', Icon: IconCamera },
  { kind: 'image', label: '图片', Icon: IconImage },
  { kind: 'file', label: '文件', Icon: IconFile },
];

/**
 * 长按的阈值和容差。
 *
 * ⚠️ issue #23 第 4 条点名了这件事：**长按要和文本选择分得开**。
 * 480ms 是各家聊天 App 的公约数（iOS 自己的取词也是 500ms 上下）；
 * 手指移动超过 10px 就当成滚动，撤销这一次长按 ——
 * 没有这一条的话，人一边滚对话一边就弹出菜单，那比没有这个功能更烦。
 */
const LONG_PRESS_MS = 480;
const LONG_PRESS_SLOP = 10;

export const ChatSheet = ({
  onClose,
  initialThreadId,
}: {
  onClose: () => void;
  /** 从速记页「发给 AI」进来时，直接落在那条对话上。 */
  initialThreadId?: string | null;
}) => {
  const session = useSession();
  const me = session?.user;

  const [threadId, setThreadId] = useState<string | null>(initialThreadId ?? null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  /**
   * 🔴 乐观气泡**单独放**，不混进 messages。
   *
   * 混在一起的话，1.2 秒后的第一次轮询就用服务端那份整个替换掉 ——
   * 于是「自己刚发的那条 + 它的上传进度」在人眼前闪一下就没了
   * （维护者 2026-08-03 实测：上传没有任何进度显示）。
   * 服务端出现同一条（inbox_id 对上）之后再撤掉本地这份。
   */
  const [pending, setPending] = useState<Array<ThreadMessage & { noteId: string }>>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  /**
   * 客户名单，只为一件事：把 agent 认出来的那家**预先选上**。
   *
   * 看板那一屏一直是这么做的（`Board.tsx` 传 `initialCompany`），
   * 对话这一屏漏了 —— 于是核对卡上明明写着「客户：ROVENA」，
   * 底下的按钮还是灰的「先选客户」，人得再搜一次同一个名字。
   * **展会现场每多一步下拉就少录一条**（D28 的理由），这一步是白费的。
   *
   * 注意这不违反 D28：门槛仍然在「确认入库」那一下，
   * 预选只是把 agent 的判断填进去，人照样要看一眼再按。
   */
  const companies = useCompanies();
  const [showHistory, setShowHistory] = useState(false);
  // 抽屉要能**滑回去**，不能直接消失 —— 所以关闭要等动画跑完
  const [histClosing, setHistClosing] = useState(false);
  const [closing, setClosing] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [running, setRunning] = useState<Running | null>(null);
  /**
   * 停止请求已经发出去、结果还没回来（D89 · issue #22）。
   * 按钮据此变灰 —— 展馆弱网时这个请求可能要好几秒，没有这一格人会连按。
   */
  const [stopping, setStopping] = useState(false);
  /**
   * **它现在在跑吗**（issue #50）—— `waiting`（我刚按下发送）和服务端的 `running` 的**并集**。
   * 判据本身连同它的来龙去脉在 `WorkLog.tsx` 的 `agentIsRunning` 上面。
   */
  const live = agentIsRunning({ waiting, running });
  /**
   * ── 消息编辑与重发（D90 · issue #23）─────────────────────────────
   * `hover`   电脑端鼠标停在哪条上（那一排动作只在它上面出现）
   * `menu`    手机端长按弹出来的那条
   * `editing` 正在改哪条 —— 发出去时带上它，服务端把老的那条标 superseded
   */
  const [hover, setHover] = useState<string | null>(null);
  /**
   * 手机端长按弹出来的那条 —— **连同它当时在屏幕上的坐标一起存**（D107 修订）。
   * 浮层按这个 rect 把拷贝画在原地，人的视线不用重新找一次。
   */
  const [menu, setMenu] = useState<{ message: ThreadMessage; rect: LiftRect } | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  /**
   * ── 删对话历史（D102 · issue #33）───────────────────────────────
   * `askDelete` 正在问哪一条（确认框）· `undo` 删完那条撤销条上写的是谁
   * · `deletedAt` 当前打开的这条**已经被删了**（从看板链接进来才会遇到）
   */
  const [askDelete, setAskDelete] = useState<Thread | null>(null);
  const [undo, setUndo] = useState<{ id: string; title: string } | null>(null);
  const [deletedAt, setDeletedAt] = useState<string | null>(null);
  /** 输入栏那个「+」展开了没有（D104 · issue #32）。 */
  const [plusOpen, setPlusOpen] = useState(false);
  /**
   * 改口之前那道「会改写 CRM 里这几条」的确认（D108 · issue #37）。
   * `'asking'` = 正在问服务端；对象 = 问到了、等人点。
   */
  const [rewrite, setRewrite] = useState<'asking' | SupersedePreview | null>(null);
  useSyncTick(); // 上传进度一变就重渲染

  const [text, setText] = useState('');
  const [atts, setAtts] = useState<LocalAttachment[]>([]);
  const [attErr, setAttErr] = useState('');
  const [rec, setRec] = useState<RecordingHandle | null>(null);
  const [seconds, setSeconds] = useState(0);

  /**
   * ── 录音 → 转写 → 人改 → 发送，**三步各自独立**（issue #15）───────────
   *
   * 维护者 2026-08-05 的原话：
   *   「录音完成之后，按下终止键，转录到输入框中，用户可以手动修改，
   *     或者在选中的地方，继续补充转录，然后再发送，
   *     **不要把转录的工作整合进入 Agent**。」
   *
   * 之前是 `stopRec()` 里 `h.stop()` 完直接 `send()` —— 音频原样飞走，
   * 人从头到尾没有机会看一眼转成了什么，更没机会改。
   * 而转写恰恰是最容易错的一环（品牌名），错了之后 agent 拿着错名字一路用下去。
   *
   * 现在：停止 → 音频**留在这里** → 转写 → 文字插到光标处 → 人改 → 按发送。
   * 音频到发送那一刻才和改定的文字一起上去 —— 所以放弃这条录音，
   * 服务端不会留下任何东西（`POST /transcribe` 不建记录）。
   */
  const [pendingAudio, setPendingAudio] = useState<{
    blob: Blob;
    mime: string;
    seconds: number;
    /** 机器听出来的那一版。发送时一并带上，服务端就不用再转一遍。 */
    transcript: string;
  } | null>(null);
  /**
   * 正在转写的那一段有多长（秒）。`null` = 没在转。
   *
   * 存秒数而不是布尔：提示条上要说「正在转写 12 秒的录音」——
   * **人等的时候最想知道的是「还要多久」**，而这一段的长度是唯一能给出的线索。
   */
  const [tx, setTx] = useState<{ seconds: number } | null>(null);
  const transcribing = tx !== null;

  /**
   * ── 转写失败之后，那段音频停在这里等人拿主意（D86 · issue #20/#21③）─────
   *
   * 🔴 **它绝不能自己发出去。** 原来的兜底是
   *   `setAttErr('转写没成功，这条先直接发出去了 —— 转录会在服务端补上'); await send({audioBlob})`
   * —— 两处都是错的：
   *   ① **恰恰在最需要人看一眼的时候（转写失败了），它反而自作主张发出去。**
   *      #15/#16 立的那道「转录 → 人改 → 发送」的隔离，在失败路径上整个被绕过去。
   *   ② 那句安慰话**是假的**。服务端跑的**同一个** `transcribe()`，
   *      客户端刚失败过，服务端必然也失败（日志里就是一前一后两条同样的 400）。
   *      「客户端转写失败 → 服务端补上」这条路**在设计上就不成立**。
   *   后果是 2026-08-07 维护者 撞到的那个：人以为记下了，实际 `staging.failed`、
   *   线程 0 条消息、界面永远转圈。**一句话说完，人以为记下了，其实什么都没有。**
   *
   * 现在停下来，把选择权交回去：重试 / 存到速记 / 不转了直接发。
   * ⚠️ 音频在 blob 里，**AI 这一屏开着时 `setBusy('chat')` 已经挡住自动刷新**
   *    （App.tsx，D83），所以它不会被一次静默 reload 吃掉。
   */
  const [failedAudio, setFailedAudio] = useState<{
    blob: Blob;
    mime: string;
    seconds: number;
    error: string;
  } | null>(null);
  /** 「存到速记」之后说一声去哪了 —— 不说的话人会以为音频没了。 */
  const [savedNote, setSavedNote] = useState('');

  const fileInput = useRef<HTMLInputElement | null>(null);
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const pendingKind = useRef<'photo' | 'image' | 'file'>('file');
  const bottom = useRef<HTMLDivElement | null>(null);

  // 每次点开默认是**新对话**（维护者 2026-08-03）——
  // 历史要主动去翻。默认续写会让人不小心把两家客户的话记在一起。
  useEffect(() => {
    void syncThreads().then(setThreads);
  }, []);

  useEffect(() => {
    if (!threadId) {
      setMessages([]);
      setRunning(null);
      setDeletedAt(null);
      return;
    }
    /**
     * 🔴 **换一条对话，先把上一条的 `running` 扔掉**（issue #50）。
     * 下面那个 `load()` 要几百毫秒才回来，这中间 `running` 还是**上一条**的 ——
     * 而它现在决定着显不显示「正在思考…」（`agentIsRunning`），
     * 不清的话新打开的那条会先闪一下别人家的思考动画。
     * 清完到 `load()` 回来之间没有动画，那是对的：**不知道就别声称。**
     */
    setRunning(null);
    let alive = true;
    const load = async () => {
      try {
        const r = await fetchThread(threadId);
        if (!alive) return;
        setMessages(r.messages);
        setRunning(r.running);
        // 🔴 打开的这条**已经被删了**（D102）—— 从看板那一行点进来才会遇到。
        //    静默显示全文的话，人会以为它还在历史里，下次去翻却找不到。
        setDeletedAt(r.deletedAt);
        // 服务端已经有这一条了（按 client_id 对应的 inbox_id 匹配），撤掉本地那份
        setPending((ps) =>
          ps.filter((p) => !p.inbox_id || !r.messages.some((m) => m.inbox_id === p.inbox_id)),
        );
        // agent 回了、而且没有正在跑的一轮 —— 才算真的结束
        if (r.messages.at(-1)?.role === 'agent' && !r.running) {
          setWaiting(false);
          setStopping(false); // 叫停的那一轮也是从这里落地的（D89）
        }
      } catch {
        /* 离线：保持现有内容，不要清空 */
      }
    };
    void load();
    // 1.2 秒一次：进度是给人看的，2.5 秒一跳会让「在想 → 查客户」这类
    // 一两秒的步骤整个被跳过去，看起来还是卡着不动
    const t = window.setInterval(() => void load(), 1200);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [threadId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, live]);

  /**
   * ── 输入框跟着内容长高、也跟着缩回去（D110 · 2026-08-11）────────────
   *
   * 维护者：「这个对话框其实可以稍微自由地变换大小……但是列的高度需要设一个上限，
   * 不能让它直接覆盖全屏，这样更方便大家修改。」
   *
   * 🔴 **算高度这件事必须挂在 `text` 上，不能只挂在 `onInput` 上。**
   * 原来是 `onInput` 里现算 —— 那只覆盖「人在打字」这一条路，而这个输入框有**三条**：
   *   ① 人打字            → `onInput` 会触发
   *   ② 转录插进来（#15）  → `setText()`，**不触发 `onInput`**
   *   ③ 点「编辑」灌进整条历史消息（D90）→ 同上
   * 后两条恰恰是内容最长的时候，而它们进来时框还是一行高 —— 人得在一条缝里改一段话。
   *
   * 上限取**视口的 40%**（不低于两行、不高于 40%）：
   * 再高就把对话本身挤没了，而这一屏的主体是对话，不是输入框。
   */
  useEffect(() => {
    const el = composer.current;
    if (!el) return;
    const cap = Math.max(96, Math.round(window.innerHeight * 0.4));
    el.style.height = 'auto'; // 先塌回去，否则只会越长越高、缩不回来
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
    // 到顶之后内部滚动 —— 不给滚动条的话，超出的部分人根本够不着
    el.style.overflowY = el.scrollHeight > cap ? 'auto' : 'hidden';
  }, [text]);

  useEffect(() => {
    if (!rec) return;
    const t = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [rec]);

  const close = () => {
    setClosing(true);
    window.setTimeout(onClose, 190);
  };

  const closeHistory = () => {
    setHistClosing(true);
    window.setTimeout(() => {
      setShowHistory(false);
      setHistClosing(false);
    }, 180);
  };

  /** 选一条历史（`null` = 新对话）。选完把抽屉滑回去。 */
  const pickThread = (id: string | null) => {
    setThreadId(id);
    setWaiting(false);
    setStopping(false);
    closeHistory();
  };

  /**
   * ── 删掉一条对话历史（D102 · issue #33）────────────────────────────
   *
   * 🔴 **删掉的是「这段对话」，不是它整理出来的东西。** 速记页那条原话照常在，
   * CRM 里已入库的那几行也照常在 —— 确认框上把这两句原样写出来
   * （见下面的 `DeleteThreadSheet`），因为这正是人在按之前最想知道的事。
   *
   * ⚠️ 删的是**正在看的那条**时要退回新对话：留在原地的话，人对着一屏
   *    已经从历史里消失的消息继续打字，下一句会落回那条被删的对话里。
   */
  const removeThread = async (th: Thread) => {
    setAskDelete(null);
    try {
      await deleteThread(th.id);
    } catch (e) {
      setAttErr((e as Error).message); // 正在跑的那一轮服务端会 409 —— 原话带给人
      return;
    }
    setThreads((ts) => ts.filter((x) => x.id !== th.id));
    if (threadId === th.id) pickThread(null);
    setUndo({ id: th.id, title: th.title || tr('（语音）') });
  };

  /** 撤销删除。纯改一格时间戳，消息一个字都没动过 —— 恢复是无损的。 */
  const undoDelete = async () => {
    const u = undo;
    if (!u) return;
    setUndo(null);
    try {
      await restoreThread(u.id);
    } catch (e) {
      // 🔴 撤销失败**不能静默**：人以为对话回来了，而它其实还在删除状态
      setAttErr((e as Error).message);
      setUndo(u); // 把撤销条放回去，让他能再点一次
      return;
    }
    void syncThreads().then(setThreads);
  };

  /**
   * 按下停止（D89 · issue #22）。
   *
   * 🔴 **不在这里 `setWaiting(false)`。** 「我发了个停止请求」和「它真的停了」
   * 是两件事：真正的落地信号是轮询看到 agent 那条收尾消息 + 没有 running
   * （上面那个 effect）。在这里就把转圈关掉的话，网关那边还在跑，
   * 而人已经开始打下一句 —— 两轮撞在一起，正是这个仓库最贵的那类 bug。
   *
   * 服务端说一条都没停（`stopped === 0`）时**要说出来**：它多半已经跑完了，
   * 下一次轮询就会带回结果。静默的话人会以为按钮坏了。
   */
  const stop = async () => {
    if (!threadId || stopping) return;
    setStopping(true);
    try {
      const n = await abortThread(threadId);
      if (n === 0) setAttErr(tr('没赶上 —— 这一轮已经跑完了，结果马上就到。'));
    } catch (e) {
      setStopping(false);
      setAttErr((e as Error).message);
    }
  };

  /**
   * ── 长按（手机端）· 悬停（电脑端）—— D90 · issue #23 ─────────────────
   *
   * 长按的两个参数（阈值 480ms、容差 10px）见文件上方的常量注释。
   * `onTouchMove` 里那个撤销是必须的：没有它，人一边滚对话一边就弹出菜单。
   */
  const pressTimer = useRef<number | null>(null);
  const pressAt = useRef<{ x: number; y: number } | null>(null);
  const cancelPress = () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
    pressAt.current = null;
  };
  const pressHandlers = (m: ThreadMessage) => ({
    onTouchStart: (e: React.TouchEvent) => {
      const p = e.touches[0];
      if (!p) return;
      pressAt.current = { x: p.clientX, y: p.clientY };
      /**
       * 🔴 **量下这条气泡此刻在屏幕上的位置**（D107 修订 · 2026-08-11）。
       *
       * 维护者 实测之后否掉了「浮到屏幕中央」：「就放在原有的位置上就好了。」
       * 消息一动，人的眼睛就得重新找一次「我按的是哪条」——
       * 而长按的对象本来就在他手指底下，那是**这一屏上他最确定的一个坐标**。
       *
       * 所以浮层里那份拷贝按这个 rect 定位，看上去就是原地不动，
       * 只是背景虚化下去、动作贴着它出现。
       */
      const el = (e.currentTarget as HTMLElement).querySelector('.bubble');
      const r = (el ?? (e.currentTarget as HTMLElement)).getBoundingClientRect();
      pressTimer.current = window.setTimeout(() => {
        pressTimer.current = null;
        setMenu({ message: m, rect: { top: r.top, left: r.left, width: r.width, height: r.height } });
      }, LONG_PRESS_MS);
    },
    onTouchMove: (e: React.TouchEvent) => {
      const p = e.touches[0];
      const a = pressAt.current;
      if (!p || !a) return;
      if (Math.hypot(p.clientX - a.x, p.clientY - a.y) > LONG_PRESS_SLOP) cancelPress();
    },
    onTouchEnd: cancelPress,
    onTouchCancel: cancelPress,
  });

  /**
   * 三个动作的落点。
   *
   * ⚠️ `resend` 直接发，`edit` 只是把话放回输入框 —— 分开是刻意的：
   * 「原话就想重跑一遍」是一下的事，不该逼人再按一次发送；
   * 而「我要改」必须让他看着改完自己按，中间那一眼是这个功能的全部价值。
   */
  const runAction = (m: ThreadMessage, a: MsgAction) => {
    setMenu(null);
    if (a === 'copy') {
      // 🔴 不假装成功：`clipboard` 在非 https / 老 WebView 上会抛
      navigator.clipboard?.writeText(m.text).catch(() => setAttErr(tr('这个浏览器不让复制')));
      return;
    }
    if (a === 'edit') {
      setEditing({ id: m.id, text: m.text });
      setText(m.text);
      requestAnimationFrame(() => composer.current?.focus());
      return;
    }
    void send({}, m.text, m.id);
  };

  const send = async (
    /**
     * ⚠️ **这一屏发出去的东西里不再有音频**（D111 · 2026-08-11）。
     * 留着这个参数是为了别处的调用形状不变；音频只在速记那一侧保存。
     */
    extra: Partial<{ audioSeconds: number }> = {},
    /**
     * 直接给正文，绕过输入框。
     * 用于 agent 追问的可点选项（issue #17 根因 E）—— `setText()` 是异步的，
     * 点完立刻 `send()` 会读到**上一帧**的 text，于是发出去一条空消息。
     */
    overrideText?: string,
    /**
     * 改口重发（D90 · issue #23）：这一句要取代对话里的哪条消息。
     *
     * 🔴 **它只是一个「取代」的标记，绝不是「改写」。** 老的那行原封不动 ——
     * `thread_message` 和 `inbox` 都只增不改（§4.2 第 2 条，库里有触发器）。
     * 服务端拿到它之后在派生层记一句「那条不再是活的那一条」，
     * 并把上一轮的 `staging` 一起标掉（否则会有两张都能按的核对卡 = CRM 里两份记录）。
     *
     * 不传 = 普通的一句续写。**默认就是不传** —— 改口是显式动作。
     */
    supersedes?: string,
  ) => {
    if (!me) return;
    const body = (overrideText ?? text).trim();
    /**
     * 停止录音之后攒在这里的那段（issue #15）—— 现在只剩**转录**有用（D111）。
     *
     * 🔴 维护者 2026-08-11：「在 AI Agent 界面进行的转录录音，我们是不保存在
     * 数据库内的……真正需要保存的录音都只在『速记』里面。」
     * 所以这里既不上传 blob，也不在本地留它：**这一屏的录音是一次听写，不是资产。**
     * 想留住那一段的话，下面那条提示上有「存到速记」——
     * 走的是速记那条路（`keepAsQuickNote`），音频照常安全落地。
     */
    const said = pendingAudio?.transcript?.trim() || '';
    // 没有正文、没有附件就没什么可发的 —— 音频不再是「可发的东西」
    if (!body && !atts.length) return;

    /**
     * 🔴 **先把对话建出来，再发。**
     *
     * 之前是「发出去，等回执告诉我 threadId」—— 而人在等不到反应时会连按几下，
     * 那几下每一下都带着 null 发出去，服务端就每次新开一条。
     * 2026-08-03 实测：一句话开了 5 条对话、跑了 5 轮模型。
     *
     * 建对话是一次很小的请求；离线时它返回 null，退回旧路径（由服务端建），
     * 那种情况下人也看不到 agent 回复，不会连按。
     */
    let tid = threadId;
    if (!tid) {
      tid = await createThread(body || tr('语音'));
      if (tid) setThreadId(tid);
    }

    const noteId = crypto.randomUUID();
    await db.notes.add({
      id: noteId,
      text: body,
      createdAt: Date.now(),
      recordedBy: me.userCode,
      visitLabel: CURRENT_VISIT,
      sync: 'queued',
      attempts: 0,
      threadId: tid ?? undefined,
      // 从 AI 这一屏发出去的才走 agent（D31：速记页不自动跑）
      toAgent: true,
      // D90：改口重发时带上被取代的那条消息 id（没有就是普通续写）
      supersedesMessageId: supersedes,
      attachments: atts.length ? atts : undefined,
      /**
       * 🔴 **只带转录，不带音频**（D111）。
       *
       * `text` = 人改定的那一版（进 inbox，不可变）
       * `transcript` = 机器听的那一版（进 staging，派生）
       * 两层分开存，三个月后才分得清哪句是谁写的 —— 这一条没变。
       *
       * 变的是音频本身：AI 这一屏的录音**转完就丢**，一个字节都不上传。
       * 它是「说给输入框听」的一次听写，人紧接着就在框里改；
       * 真正要留的现场录音在速记那一侧（维护者 2026-08-11 定）。
       */
      ...(said ? { transcript: said } : {}),
      ...extra,
    });
    setPendingAudio(null);

    // 乐观显示：网关还没回执之前，人先看到自己说的那句话（含附件和上传进度）
    setPending((ps) => [
      ...ps,
      {
        noteId,
        id: `local-${noteId}`,
        role: 'user',
        text: body || tr('（附件）'),
        inbox_id: null,
        meta: {},
        created_at: new Date().toISOString(),
        superseded_by: null,
        supersede_reason: null,
        staging_id: null,
        status: null,
        extracted: null,
        confidence: null,
        partial: null,
        suggested_company: null,
        confirm_after: null,
        twenty_refs: null,
        agent_trace: null,
        agent_steps: null,
        run_stop_reason: null,
        run_duration_ms: null,
        staging_error: null,
        confirmed_fields: null,
        // 本地这份的附件用刚选中的那几个 —— 服务端那份回来之后会被替换
        attachments: atts.map((a) => ({
          id: '',
          name: a.name,
          kind: a.kind,
          bytes: a.size,
          parsed: null,
          chars: 0,
        })),
      },
    ]);
    setText('');
    setAtts([]);
    setAttErr('');
    setEditing(null); // 改口那一轮到此结束（D90）—— 下一句又是普通续写
    setWaiting(true);

    await flush();
    // 上传完之后把服务端的 inbox id 补进那条乐观气泡 —— 轮询靠它判断「可以撤掉了」
    const saved = await db.notes.get(noteId);
    if (saved?.remoteId) {
      setPending((ps) => ps.map((p) => (p.noteId === noteId ? { ...p, inbox_id: saved.remoteId! } : p)));
    }
    // 离线时 createThread 拿不到 id，退回旧路径：从回执回填的那条 note 上取
    if (!tid) {
      const mine = await db.notes.orderBy('createdAt').reverse().limit(3).toArray();
      const withThread = mine.find((n) => n.threadId);
      if (withThread?.threadId) setThreadId(withThread.threadId);
    }
    void syncThreads().then(setThreads);
  };

  /**
   * ── 按下发送（D108 · issue #37）────────────────────────────────────
   *
   * 普通一句话：直接发，和以前一模一样。
   *
   * **改口那一路先问一次服务端**：被改的那一轮如果已经入库，这一句发出去
   * 会**改写 CRM 里那几条记录**（继承所有权，不再新建第二份）。
   * 这件事必须在人按下去之前说出来 —— 「会改写下面这几条」和「会新增一条」
   * 是两个完全不同的动作，而在这之前**界面上一个字都没有**：
   * 生产上 Movara 那次，人以为改了口，实际 CRM 里 3000W 和 2000W 两条并存。
   *
   * ⚠️ 上一轮**还没入库**时（`rewriting` 是空的）不打扰人，直接发 ——
   *    那是最常见的情况（改口本来就该在确认之前）。
   * ⚠️ 问不到（离线 / 老服务端）时**照常发**，但不假装知道：
   *    这一句本身不该因为一次查询失败而发不出去（`inbox` 只增不改，话最要紧）。
   */
  const trySend = async () => {
    const editId = editing?.id;
    if (!editId || !threadId) return void send({}, undefined, editId);
    setRewrite('asking');
    const p = await fetchSupersedePreview(threadId, editId);
    if (!p || !p.rewriting.length) {
      setRewrite(null);
      return void send({}, undefined, editId);
    }
    setRewrite(p); // 等人点：卡片上逐条列出会被改写的记录
  };

  /**
   * 把一段文字插到光标处（issue #15：「或者在选中的地方，继续补充转录」）。
   *
   * 不是简单追加到末尾 —— 现场的真实用法是「先打了半句，中间补一段口述」。
   * 选中一段再录，就是替换掉选中的那段。
   */
  const insertAtCursor = (chunk: string) => {
    const el = composer.current;
    setText((cur) => {
      if (!el) return cur ? `${cur}\n${chunk}` : chunk;
      // 纯计算那一半抽在 `compose.ts` 里并单测（D87）——
      // 它属于「插错了不报错、只是把两句话粘成一个词」那一类，必须能单独断言
      const { next, caret } = spliceAt(cur, chunk, el.selectionStart ?? cur.length, el.selectionEnd ?? cur.length);
      // 光标落到插入内容的末尾，方便接着改 —— setState 之后 DOM 才更新，所以下一帧再设
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(caret, caret);
      });
      return next;
    });
  };

  /**
   * 转写一段音频并把结果插到光标处。成功/失败两条路都收在这里，
   * 于是「停止录音」和「失败后重试」走的是**同一段代码** ——
   * 两份实现迟早分叉（D81 那条判据）。
   */
  const transcribeInto = async (blob: Blob, mime: string, sec: number) => {
    setTx({ seconds: sec });
    setAttErr('');
    setSavedNote('');
    try {
      const said = (await transcribeAudio(blob, mime)).trim();
      setFailedAudio(null);
      setPendingAudio({ blob, mime, seconds: sec, transcript: said });
      // issue #21①：插在**光标处**，选中一段就替换那一段 —— 再录一次就是「接着补一句」
      if (said) insertAtCursor(said);
      else setAttErr(tr('这段录音没听出内容 —— 可以直接打字，或者删掉重录。'));
    } catch (e) {
      const msg = (e as Error).message;
      console.warn('[chat] 转写失败：', msg);
      // 🔴 **什么都不做，等人拿主意**。见 `failedAudio` 那段注释（D86 · issue #20）
      setPendingAudio(null);
      setFailedAudio({ blob, mime, seconds: sec, error: msg });
    } finally {
      setTx(null);
    }
  };

  /**
   * 停止录音。**不再直接发出去** —— 转写完放进输入框，等人改（issue #15）。
   *
   * 🔴 转写失败也**不再直接发出去**（D86 · issue #20）：那条老退路
   * 恰恰在最该让人看一眼的时刻绕过了所有隔离，而且它承诺的「服务端会补上」是假的。
   * 音频一个字节都不会丢 —— 它就在 `failedAudio` 里，等人选一个去处。
   */
  const stopRec = async () => {
    const h = rec;
    if (!h) return;
    setRec(null);
    const { blob, mime, seconds: sec } = await h.stop();
    await transcribeInto(blob, mime, sec);
  };

  /**
   * 转写失败的那段音频**落到速记**（issue #21③）。
   *
   * 🔴 判据（这个仓库已经写死的一条）：**音频本身才是资产，转写只是它的一个视图。**
   * 所以「转写失败」不能导致音频被降级处理，它要退到**最安全的那一层** ——
   * 速记那边本来就是「音频先安全落地，转录和抽取都是后面的事」，
   * 而对话线程要求的是「这句话已经可以喂给 agent 了」，转写失败的音频显然不满足。
   *
   * ⚠️ 不带 `threadId`、不带 `toAgent` —— 和速记页录的那一条**一模一样**，
   *    于是它自然走 `enqueueTranscribe`（只转写不跑 agent，D31），
   *    失败了也在速记页看得见、能重试（#21②）。
   */
  /**
   * 把一段音频**存到速记**（issue #21③ · D111 扩用）。
   *
   * 🔴 D111 之后这是 AI 这一屏**唯一**能把录音留下来的路：这边的录音转完就丢，
   * 而速记那一侧「音频先安全落地」的性质一个字没变。
   *
   * 两个入口共用它：转写失败之后那张卡、转写成功之后那条提示 ——
   * **同一件事只能有一份实现**（两处各写一遍的话，迟早有一处忘了带 `transcript`）。
   *
   * ⚠️ 不带 `threadId`、不带 `toAgent` —— 和速记页录的那一条一模一样，
   *    于是它自然走 `enqueueTranscribe`（只转写不跑 agent，D31）。
   */
  const keepAudioAsNote = async (a: { blob: Blob; mime: string; seconds: number; transcript?: string }) => {
    if (!me) return;
    await db.notes.add({
      id: crypto.randomUUID(), // 幂等键（§4.2 第6条）
      text: '',
      createdAt: Date.now(),
      recordedBy: me.userCode,
      visitLabel: CURRENT_VISIT,
      sync: 'queued',
      attempts: 0,
      audioBlob: a.blob,
      audioMime: a.mime,
      audioSeconds: a.seconds,
      // 已经转出来的那一版一并带上 —— 同一段音频没有理由再转一次（也不该多花一次钱）
      transcript: a.transcript?.trim() || undefined,
    });
    setFailedAudio(null);
    setPendingAudio(null);
    setSavedNote(
      a.transcript?.trim()
        ? tr('已存到速记 —— 音频和转录都在那边。')
        : tr('已存到速记 —— 音频在那边，可以再试转写。'),
    );
    void flush(); // 有网就立刻传；没网就在队列里等
  };

  /**
   * 能不能按发送。
   *
   * 🔴 **录音本身不再算数**（D111）：这一屏的音频转完就丢，发出去的是文字。
   * 一段没听出内容的录音因此没有「发」的意义 —— 界面照旧会说一句
   * 「这段录音没听出内容」，并给出「存到速记」那条出口（那边音频是资产）。
   * 转写没回来之前不让发：那会把还在半路的转录漏掉。
   */
  const canSend = !transcribing && Boolean(text.trim() || atts.length);

  const pick = (kind: 'photo' | 'image' | 'file') => {
    pendingKind.current = kind;
    const el = fileInput.current;
    if (!el) return;
    el.accept = ACCEPT[kind];
    if (kind === 'photo') el.setAttribute('capture', 'environment');
    else el.removeAttribute('capture');
    el.value = '';
    el.click();
  };

  return (
    <Sheet closing={closing}>
      {/* ── 顶栏 ─────────────────────────────────────────────── */}
      <div
        style={{
          flexShrink: 0,
          paddingTop: 'env(safe-area-inset-top)',
          borderBottom: `1px solid ${T.lineLight}`,
          background: T.bg,
        }}
      >
        <div style={{ height: 52, display: 'flex', alignItems: 'center', padding: '0 8px 0 12px' }}>
          <button
            onClick={() => setShowHistory((v) => !v)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, color: T.textSoft, padding: 8 }}
          >
            <IconHistory size={19} />
            <span style={{ fontSize: 13 }}>{tr('历史')}</span>
          </button>
          <div style={{ flex: 1, textAlign: 'center', fontSize: 15, fontWeight: 600 }}>
            {threadId ? (threads.find((t) => t.id === threadId)?.title ?? tr('对话')) : tr('新对话')}
          </div>
          {/* 右上角这个 ✕ 是回到底栏那几个键的唯一出口 —— 位置不能变 */}
          <button onClick={close} style={{ color: T.textSoft, padding: 10 }} aria-label={tr('关闭')}>
            <IconClose size={20} />
          </button>
        </div>
      </div>

      {/**
       * 打开的这条已经被删了（D102 · issue #33）。
       *
       * 🔴 服务端**照常返回全文**（不是 404），就是为了能打这条横幅。
       * 从看板那一行点「去对话里看」是这条路径的唯一入口 —— 什么都不说的话，
       * 人看到的是一屏正常的对话，而它在历史列表里已经找不到了。
       * **「看不见」和「不存在」必须分得开。**
       */}
      {deletedAt && (
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '9px 14px',
            background: T.amberSoft,
            color: T.amber,
            fontSize: 12.5,
          }}
        >
          <span style={{ flex: 1 }}>
            {tr('这条对话已从历史里删掉了 —— 内容还在，可以恢复。')}
          </span>
          <button
            onClick={() => {
              if (!threadId) return;
              void restoreThread(threadId)
                .then(() => {
                  setDeletedAt(null);
                  return syncThreads().then(setThreads);
                })
                .catch((e: Error) => setAttErr(e.message));
            }}
            style={{ color: T.amber, fontWeight: 600, fontSize: 12.5, flexShrink: 0 }}
          >
            {tr('恢复')}
          </button>
        </div>
      )}

      {/* ── 历史对话：从左边推出来的抽屉（照 ChatGPT）─────────────
          手机铺满整屏，电脑只占左边 300px。点空白处或选中一条就关。

          🔴 **挂到 body 上（portal），不留在 .sheet 里面。**
          .sheet 因为 animation-fill-mode: both 一直保留着一个 transform，
          而**带 transform 的元素会成为 position:fixed 后代的 containing block**。
          留在里面的话，sheet 一播关闭动画（scale + translateY），
          抽屉就会跟着一起缩 —— 现在恰好是单位矩阵看不出来，
          但那属于「碰巧没事」，不是「不会出事」。 */}
      {showHistory && createPortal(
        <>
          <div className="scrim" data-closing={histClosing} onClick={closeHistory} />
          <div className="drawer" data-closing={histClosing}>
            <div
              style={{
                flexShrink: 0,
                paddingTop: 'env(safe-area-inset-top)',
                borderBottom: `1px solid ${T.lineLight}`,
              }}
            >
              <div style={{ height: 52, display: 'flex', alignItems: 'center', padding: '0 8px 0 16px' }}>
                <span style={{ flex: 1, fontSize: 15, fontWeight: 600 }}>{tr('历史对话')}</span>
                <button onClick={closeHistory} style={{ color: T.textSoft, padding: 10 }} aria-label={tr('关闭')}>
                  <IconClose size={19} />
                </button>
              </div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
              <button
                className="btn ghost sm"
                onClick={() => pickThread(null)}
                style={{ width: '100%', marginBottom: 10, justifyContent: 'flex-start' }}
              >
                <IconPlus size={15} /> {tr('新对话')}
              </button>

              {/**
               * ── 每条历史右边一个垃圾桶（D102 · issue #33）───────────────
               *
               * 🔴 **常驻显示，不藏在长按或侧滑后面。** 这一屏是「翻旧账」的地方，
               * 误触的代价又被两道东西挡着（一个说清后果的确认框 + 一次撤销），
               * 而藏起来的代价是这个功能等于不存在 —— issue #33 的第一句话
               * 「仍然无法删除」说的正是这件事（删除路径其实早就有了，
               * 只是没有任何入口）。
               */}
              {threads.map((t) => (
                <div
                  key={t.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    borderRadius: 12,
                    background: t.id === threadId ? T.s3 : 'transparent',
                    marginBottom: 2,
                  }}
                >
                  <button
                    onClick={() => pickThread(t.id)}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      display: 'block',
                      textAlign: 'left',
                      padding: '11px 4px 11px 12px',
                      background: 'transparent',
                    }}
                  >
                    <div
                      style={{
                        fontSize: 14,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {t.title || tr('（语音）')}
                    </div>
                    <div style={{ fontSize: 11.5, color: T.textLight, marginTop: 2 }}>
                      {fmtAgo(new Date(t.last_message_at).getTime())} ·{' '}
                      {tr('{a} 条', { a: t.messages })}
                      {t.company_code ? ` · ${t.company_code}` : ''}
                    </div>
                  </button>
                  <button
                    onClick={() => setAskDelete(t)}
                    style={{
                      flexShrink: 0,
                      display: 'flex',
                      alignItems: 'center',
                      color: T.textLight,
                      padding: '10px 12px',
                    }}
                    aria-label={tr('删除这条对话')}
                    title={tr('删除这条对话')}
                  >
                    <IconTrash size={16} />
                  </button>
                </div>
              ))}

              {!threads.length && (
                <div style={{ fontSize: 12.5, color: T.textLight, padding: '10px 2px', lineHeight: 1.8 }}>
                  {tr('还没有历史对话。')}
                  <br />
                  {tr('在下面说一句，就会有第一条。')}
                </div>
              )}
            </div>
          </div>
        </>,
        document.body,
      )}

      {/**
       * ── 消息 ───────────────────────────────────────────────
       *
       * 🔴 **正文列要有宽度上限。**
       *
       * 这一屏是全屏浮层，不在 `App.tsx` 那个 `maxWidth: 780` 的容器里 ——
       * 于是在 1568px 的笔记本上，一行字横跨整个屏幕，核对卡也是边到边。
       * 实测（2026-08-03 Chrome）：一句话拉成 1500px 一行，读不下去。
       * 手册 P21 写着「办公室里也是这一屏」，那就得在电脑上也能看。
       *
       * 上限取 820 —— 比 ChatGPT 的 768 略宽一点，因为核对卡里有「标签 + 值」两列。
       */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 14px' }}>
        <div style={{ maxWidth: 820, margin: '0 auto' }}>
        {!messages.length && !live && (
          <div style={{ textAlign: 'center', padding: '46px 20px', color: T.textLight }}>
            <div style={{ fontSize: 17, color: T.text, fontWeight: 500, marginBottom: 8 }}>
              {tr('说一句刚才发生的事')}
            </div>
            <div style={{ fontSize: 13.5, lineHeight: 1.8 }}>
              {tr('「刚跟 Alpin 聊完，他们逆变器现在用 Voltaro，明年想换」')}
              <br />
              {tr('我来认客户、抽字段、找出这家还缺哪些情报。')}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {[...messages, ...pending].map((m) => {
            /**
             * 被改口取代的那些（D90 · issue #23）。
             *
             * 🔴 **照样显示。** 取代 ≠ 删除 —— 原话一个字没动，只是不再是活的那一条。
             * 淡一档 + 一句人话，因为**「看不见」和「不存在」必须分得开**：
             * 这个仓库最贵的 bug 全长那个样子（issue #14 的注释里写过同一句）。
             */
            const dead = Boolean(m.superseded_by);
            /**
             * 能不能对这条动手（改 / 重发）。三个条件缺一不可：
             *   · 自己说的那句（agent 的回复没有「重发」的语义）
             *   · 已经上传了（`local-` 开头的还在队列里，没有服务端 id 可取代 ——
             *     那种情况直接在输入框里改就行）
             *   · 不是已经被取代的历史
             * ⚠️ 正在跑的那一轮**不禁用**：#22 和 #23 的组合场景就是
             *    「停止 → 改一改 → 重发」，禁掉的话那条路就断在中间。
             */
            const editable = m.role === 'user' && !m.id.startsWith('local-') && !dead;
            return (
            <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/**
               * 🔴 工作日志是 agent 那条回复的**第一个子元素**（D88 · issue #24）。
               *
               * 原来它挂在整条消息**之后**（正文 → 选项 chips → 日志 → 核对卡）。
               * 维护者 要的是 OpenAI 那个形态：「思考了 25s ›」在**回复的最抬头**，
               * 想看再点开。放在末尾的话，人读完回复才看到「哦它刚才在想」——
               * 顺序反了，那一行就从「过程」变成了「附录」。
               *
               * 轨迹一直都落在库里（D74），这里只是换了位置和长相。
               */}
              {m.role === 'agent' && (m.agent_trace?.length ?? 0) > 0 && (
                <WorkLog
                  trace={m.agent_trace!}
                  stopReason={m.run_stop_reason}
                  durationMs={m.run_duration_ms}
                />
              )}
              {/**
               * 气泡 + 它的动作（D90）。外面这层只做三件事：
               *   ① 电脑端记录鼠标停在哪条上（那一排动作只对它显示）
               *   ② 手机端接长按（阈值/容差在 `pressHandlers` 里）
               *   ③ 被取代的那条淡一档
               */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  alignItems: m.role === 'user' ? 'flex-end' : 'flex-start',
                  opacity: dead ? 0.45 : 1,
                  /**
                   * 🔴 被托起来的那一刻，原位这条**藏起来**（D103 · issue #31）。
                   * 不藏的话虚化背景里还有一份同样的气泡，浮层上那份就成了副本 ——
                   * 而 issue 要的是「这条消息成为焦点」，不是「多出来一条」。
                   * 用 `visibility` 不是 `display`：位置留着，退出时不会有一下跳动。
                   */
                  visibility: menu?.message.id === m.id ? 'hidden' : undefined,
                }}
                onMouseEnter={desktop && editable ? () => setHover(m.id) : undefined}
                onMouseLeave={desktop && editable ? () => setHover(null) : undefined}
                /**
                 * 🔴 长按**不按 `desktop` 分叉**（2026-08-11 改）。
                 *
                 * 原来是 `!desktop && editable`，于是**触屏笔记本上长按整个没有** ——
                 * 只要接着鼠标，`pointer: fine` 就是真，而人手边还有一块触摸屏。
                 * 挂上去在纯鼠标设备上是零代价：touch 事件根本不会触发。
                 * 悬停那一排仍然只给 `desktop`（鼠标才谈得上悬停）。
                 */
                {...(editable ? pressHandlers(m) : {})}
              >
                <div
                  className="bubble"
                  data-role={m.role}
                  style={
                    /**
                     * 🔴 手机端把系统的取词/长按菜单关掉，否则长按会先被它接走
                     * （issue #23 第 4 条）。**只关自己那侧的气泡、只在触屏上关** ——
                     * 电脑上鼠标选中复制是天天在用的动作，关了纯属添乱。
                     * 触屏上「复制」由我们自己那一排提供，没有丢功能。
                     */
                    !desktop && editable
                      ? { userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }
                      : undefined
                  }
                >
                  {bold(m.text)}
                </div>

                {/* 电脑端：悬停那一排（issue #23：至少要有 复制 · 编辑 · 重新发送） */}
                {desktop && editable && hover === m.id && (
                  <div style={{ display: 'flex', gap: 10 }}>
                    {MSG_ACTIONS.map((a) => (
                      <button
                        key={a}
                        onClick={() => runAction(m, a)}
                        style={{
                          font: 'inherit',
                          fontSize: 11.5,
                          color: T.textLight,
                          background: 'transparent',
                          border: 'none',
                          padding: 0,
                          cursor: 'pointer',
                        }}
                      >
                        {tr(MSG_ACTION_LABEL[a])}
                      </button>
                    ))}
                  </div>
                )}

                {/* 被取代的那条要说一句 —— 否则人会以为那句话丢了 */}
                {dead && (
                  <div style={{ fontSize: 11.5, color: T.textLight }}>
                    {m.supersede_reason === 'stale_reply'
                      ? tr('这一轮针对的是上面那句已经改掉的话')
                      : tr('这句已经改过了 —— 下面是新的那一版（原话没动）')}
                  </div>
                )}
              </div>

              {/* 🔴 附件必须看得见。传上去了、解析了，而对话里一点痕迹都没有 ——
                  人只能凭记忆相信它上去了（维护者 2026-08-03 实测的第一条抱怨）。
                  同时标出「已读」——那是 agent 真的把文件读开了的凭据。 */}
              {(m.attachments ?? []).length > 0 && (
                <div
                  style={{
                    alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 5,
                    maxWidth: '84%',
                  }}
                >
                  {m.attachments.map((a, i) => (
                    <AttachmentChip key={a.id || i} att={a} />
                  ))}
                </div>
              )}
              {/* 自己那条还在传的时候给个圈 —— 传一张 8MB 展台照在展馆 4G 上要十几秒，
                  这十几秒里没有反馈的话，人会以为没发出去然后再按一次 */}
              {m.id.startsWith('local-') && (() => {
                const p = uploadProgress(m.id.slice(6));
                if (p === undefined) return null;
                return (
                  <div
                    style={{
                      alignSelf: 'flex-end',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 11.5,
                      color: T.textLight,
                      marginTop: -6,
                    }}
                  >
                    <ProgressRing value={p} size={13} />
                    {p >= 0 ? tr('上传中 {a}%', { a: Math.round(p * 100) }) : tr('上传中')}
                  </div>
                );
              })()}
              {/**
               * 🔴 **agent 想问的那一句，做成可点的选项。**
               *
               * issue #17 根因 E（2026-08-05）：`ask_user` 的 `options` 参数
               * 从实现出来到今天**一次都没有到达过屏幕**。
               * 网关把问题拼成一行纯文本接在回复后面（`loop.ts` 的 `say`），
               * `options` 存进了 `meta.questions`，而这一屏从头到尾没读过它 ——
               * 我在整个 PWA 里搜过，`questions` 只出现在 `api.ts` 的类型声明里。
               *
               * 人看到的只是一句夹在回复里的问句，只能自己打字回答。
               * 而展会现场每多打一个字就少录一条 —— 这正是 `options` 当初存在的理由。
               *
               * ⚠️ 点一下 = 把选项文本当成下一条消息发出去（复用 `send()`），
               * 于是它变成这条对话的续写，agent 下一轮 `get_thread` 就看得到。
               * **不做成「直接改字段」** —— 那会绕过核对卡，而人按那一下之前
               * 系统不该替他决定任何事。
               */}
              {m.role === 'agent' &&
                (m.meta?.questions ?? []).map((q, qi) =>
                  q.options?.length ? (
                    <div
                      key={`q${qi}`}
                      style={{
                        alignSelf: 'flex-start',
                        display: 'flex',
                        gap: 6,
                        flexWrap: 'wrap',
                        maxWidth: '84%',
                      }}
                    >
                      {q.options.map((opt) => (
                        <button
                          key={opt}
                          className="chip"
                          disabled={live}
                          onClick={() => void send({}, opt)}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  ) : null,
                )}

              {/* 工作日志（D74）挪到了这条消息的**最前面**（D88）—— 见上面那段注释。 */}

              {/* agent 那条消息底下挂核对卡 —— 这就是它和聊天机器人的分界 */}
              {/* 🔴 状态放宽到 confirming / confirmed ——
                  只认 'ready' 的话，点完确认那一刻卡片会被整个卸载，
                  「已入库 · N 秒内可撤销」和撤销按钮跟着一起消失（实测踩到）。 */}
              {/**
               * 被后一轮取代的那一版（issue #14）。卡片不再出现 ——
               * 同一条对话只留最新一版可确认，否则三轮对话就是三张卡、
               * 都点了就是 CRM 里三份拜访记录。
               *
               * 🔴 但**必须说一句**：`superseded` 只是「不再是活的那一条」，
               * 内容一个字没动。不说的话人会以为那一轮说的话丢了 ——
               * 「看不见」和「不存在」必须分得开。
               */}
              {m.role === 'agent' && m.status === 'superseded' && (
                <div style={{ fontSize: 11.5, color: T.textLight, alignSelf: 'flex-start' }}>
                  {tr('这一版已被后面那次修改取代（原话和抽取结果都还在）')}
                </div>
              )}
              {m.role === 'agent' &&
                m.staging_id &&
                ['ready', 'confirming', 'committing', 'confirmed'].includes(m.status ?? '') && (
                  <ReviewCard
                    key={m.staging_id}
                    stagingId={m.staging_id}
                    extracted={m.extracted ?? {}}
                    confidence={m.confidence ?? undefined}
                    suggestedCompany={m.suggested_company}
                    partial={m.partial ?? undefined}
                    status={m.status}
                    confirmAfter={m.confirm_after}
                    twentyRefs={m.twenty_refs}
                    confirmedFields={m.confirmed_fields}
                    stagingError={m.staging_error}
                    initialCompany={
                      companies.find(
                        (c) => c.code === (m.extracted as Record<string, unknown> | null)?.companyCode,
                      ) ?? null
                    }
                  />
                )}
            </div>
            );
          })}
          {live && (
            <WorkLog
              live
              trace={running?.trace ?? []}
              stage={running?.stage}
              steps={running?.steps}
              maxSteps={running?.max_steps}
              // 停止键（D89）。只有已经有 threadId 才给得出去 ——
              // 第一条消息还在上传、对话都还没建出来时，没有能停的东西
              onStop={threadId ? () => void stop() : undefined}
              stopping={stopping}
            />
          )}
          <div ref={bottom} />
        </div>
        </div>
      </div>

      {/**
       * 手机端长按之后把这条消息**托起来**（D103 · issue #31）。
       * 三个动作一个没变（D90）—— 变的只是它们出现在哪儿。见 `LiftedMessage`。
       */}
      {menu && (
        <LiftedMessage
          message={menu.message}
          rect={menu.rect}
          onPick={(a) => runAction(menu.message, a)}
          onClose={() => setMenu(null)}
        />
      )}

      {/**
       * 改口会改写 CRM 里那几条 —— **在人按下去之前逐条列出来**（D108 · issue #37）。
       * 形状和删除确认（D93）、发给 AI 那张卡（D95）一致：说清楚会发生什么，
       * 而不是问一句「确定吗」。
       */}
      {rewrite && (
        <RewriteSheet
          preview={rewrite === 'asking' ? null : rewrite}
          onCancel={() => setRewrite(null)}
          onConfirm={() => {
            const editId = editing?.id;
            setRewrite(null);
            void send({}, undefined, editId);
          }}
        />
      )}

      {/* 删对话的二次确认（D102 · issue #33）—— 说清楚「另外两个面不动」 */}
      {askDelete && (
        <DeleteThreadSheet
          thread={askDelete}
          onCancel={() => setAskDelete(null)}
          onConfirm={() => void removeThread(askDelete)}
        />
      )}

      {/**
       * 撤销条。**挂到 body 上**（portal）：删这件事发生在历史抽屉里（z-index 51），
       * 留在 `.sheet`（40）里的话它整个被抽屉盖住 —— 有撤销等于没撤销。
       */}
      {undo &&
        createPortal(
          <div className="undo-bar">
            <span
              style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {tr('已删除「{a}」', { a: undo.title })}
            </span>
            <button
              onClick={() => void undoDelete()}
              style={{ color: '#fff', fontWeight: 600, fontSize: 13, flexShrink: 0 }}
            >
              {tr('撤销')}
            </button>
            <button
              onClick={() => setUndo(null)}
              style={{ color: 'rgba(255,255,255,.6)', display: 'flex', flexShrink: 0 }}
              aria-label={tr('关闭')}
            >
              <IconClose size={15} />
            </button>
          </div>,
          document.body,
        )}

      {/* ── 输入 ─────────────────────────────────────────────── */}
      <div
        style={{
          flexShrink: 0,
          padding: '10px 12px',
          paddingBottom: 'calc(10px + env(safe-area-inset-bottom))',
          borderTop: `1px solid ${T.lineLight}`,
          background: T.bg,
        }}
      >
        {/* 输入区跟着正文一起收窄 —— 不然电脑上输入框比消息宽一大截 */}
        <div style={{ maxWidth: 820, margin: '0 auto' }}>
        {atts.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {atts.map((a, i) => (
              <button
                key={`${a.name}-${i}`}
                className="chip"
                onClick={() => setAtts(atts.filter((_, j) => j !== i))}
              >
                {KIND_LABEL[a.kind]} · {a.name.slice(0, 14)} · {humanSize(a.size)} ✕
              </button>
            ))}
          </div>
        )}
        {attErr && <div style={{ color: T.amber, fontSize: 12, marginBottom: 6 }}>{attErr}</div>}
        {savedNote && (
          <div style={{ color: T.green, fontSize: 12, marginBottom: 6 }}>✅ {savedNote}</div>
        )}

        {/**
         * 🔴 **正在改哪一句，必须看得见**（D90 · issue #23）。
         *
         * 输入框里的字被换掉了，而这件事本身没有任何提示的话，人会以为
         * 那是自己刚打了一半的内容 —— 然后一按发送，上一轮被取代掉，
         * 他完全不知道发生了什么。「看不见」和「不存在」必须分得开，
         * 这条判据在这个仓库里已经写第五遍了。
         */}
        {editing && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 8,
              padding: '7px 11px',
              background: T.s2,
              borderRadius: 10,
              fontSize: 12,
              color: T.textSoft,
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>
              {tr('正在改这一句 —— 发出去会取代它，并在同一条对话上重跑一轮')}
            </span>
            <button
              onClick={() => {
                setEditing(null);
                // 改到一半反悔：输入框还原成空的，而不是留着那句话 ——
                // 留着的话下一次按发送就变成「又说了一遍同样的话」
                setText('');
              }}
              style={{ color: T.textLight, fontSize: 11.5, flexShrink: 0 }}
            >
              {tr('不改了')}
            </button>
          </div>
        )}

        {/**
         * ── 转写失败：**停下来，把选择权交回去**（D86 · issue #20/#21③）────
         *
         * 🔴 这一屏取代的是一行 `await send({audioBlob})` —— 那行代码
         * 恰恰在最需要人看一眼的时候自作主张把语音发了出去，
         * 还附赠一句「转录会在服务端补上」的假承诺（服务端跑的是同一个
         * `transcribe()`，客户端刚失败过，它必然也失败）。
         *
         * 三个去处按**安全程度**排，「存到速记」是推荐的那个：
         * 速记那一层本来就是「音频先安全落地，转录和抽取都是后面的事」。
         * 第一句话先说清楚**音频没丢** —— 人在展台上最怕的就是这个。
         */}
        {failedAudio && !transcribing && (
          <div
            style={{
              marginBottom: 8,
              padding: '10px 12px',
              background: T.s2,
              borderRadius: 10,
              borderLeft: `3px solid ${T.amber}`,
            }}
          >
            <div style={{ fontSize: 12.5, color: T.text, marginBottom: 2 }}>
              {tr('这段 {a} 录音没转出来 —— 它还在手机里，但只在这一屏开着的时候。', {
                a: fmtDuration(failedAudio.seconds),
              })}
              <br />
              {tr('要留住它，点「存到速记」—— 那边音频才会真的存下来。')}
            </div>
            <div style={{ fontSize: 11, color: T.textLight, marginBottom: 8 }}>
              {failedAudio.error.slice(0, 120)}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                onClick={() => void keepAudioAsNote(failedAudio)}
                style={{
                  fontSize: 12,
                  padding: '6px 12px',
                  borderRadius: 8,
                  background: T.blue,
                  color: '#fff',
                  fontWeight: 600,
                }}
              >
                {tr('存到速记')}
              </button>
              <button
                onClick={() =>
                  void transcribeInto(failedAudio.blob, failedAudio.mime, failedAudio.seconds)
                }
                style={{
                  fontSize: 12,
                  padding: '6px 12px',
                  borderRadius: 8,
                  background: T.s3,
                  color: T.text,
                }}
              >
                {tr('重试转写')}
              </button>
              {/**
               * 🔴 原来这里第三个出口是「不转了，直接发」—— 它在 D111 之后**没有意义了**：
               * 这一屏不再上传音频，"直接发"发出去的会是一条空消息。
               * 换成「丢掉这段」，并且把它排在最后、不给底色 ——
               * 丢掉是真的丢掉，那一段没有任何地方还留着它。
               */}
              <button
                onClick={() => setFailedAudio(null)}
                style={{ fontSize: 12, padding: '6px 12px', color: T.textSoft }}
              >
                {tr('丢掉这段')}
              </button>
            </div>
          </div>
        )}

        {/**
         * 🔴 **说清楚这段录音不会被保存**（D111 · 2026-08-11）。
         *
         * 以前这条提示说的是「录音已附上，按发送时一起上去」。现在不是了：
         * 维护者 定的规矩是「AI Agent 界面的录音不保存在数据库内，
         * 真正需要保存的录音都只在速记里面」。
         *
         * 所以这条提示要回答的问题变了 —— 从「它发了没有」变成
         * 「**它会不会被留下**」。答案是不会，而且旁边就给出唯一能留住它的那条路
         * （存到速记）。**「看不见」和「不存在」要分得开**，同样适用于
         * 「以为存下来了、其实转完就丢」。
         */}
        {(pendingAudio || transcribing) && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 8,
              padding: '7px 11px',
              background: T.s2,
              borderRadius: 10,
              fontSize: 12,
              color: T.textSoft,
            }}
          >
            {tx ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {/* 三个点 —— 和工作日志「正在跑」用的是同一套语言（D74） */}
                <span className="dots" style={{ width: 14, flexShrink: 0 }}>
                  <span />
                  <span />
                  <span />
                </span>
                {tr('正在把这段 {a} 录音转成文字…（转完会插到光标处）', {
                  a: fmtDuration(tx.seconds),
                })}
              </span>
            ) : (
              <>
                <span style={{ flex: 1, minWidth: 0 }}>
                  🎙 {fmtDuration(pendingAudio!.seconds)}
                  {pendingAudio!.transcript
                    ? tr(' · 已转成文字（在输入框里，可以改）')
                    : tr(' · 没听出内容')}
                  <br />
                  <span style={{ color: T.textLight }}>
                    {tr('这段录音不会被保存 —— 要留住它就存到速记。')}
                  </span>
                </span>
                {/* 唯一能把这段音频真的留下来的出口（走的就是速记那条路） */}
                <button
                  onClick={() => void keepAudioAsNote(pendingAudio!)}
                  style={{ color: T.blue, fontSize: 11.5, fontWeight: 600, flexShrink: 0 }}
                >
                  {tr('存到速记')}
                </button>
                <button
                  onClick={() => setPendingAudio(null)}
                  style={{ color: T.textLight, fontSize: 11.5, flexShrink: 0 }}
                >
                  {tr('知道了')}
                </button>
              </>
            )}
          </div>
        )}

        {/**
         * ── 输入栏（D104 · issue #32）──────────────────────────────────
         *
         * 维护者 2026-08-11：「目前 AI Agent 输入栏里的文件等附加功能，
         * 希望统一收进左侧的『+』按钮中，避免输入栏本身堆太多入口。」
         *
         * 原来是输入框**下面**一排三个 chip（拍照 · 图片 · 文件），常驻占一行。
         * 现在收进「+」：平时四个键（+ · 输入框 · 麦克风 · 发送），要加东西才展开。
         *
         * 🔴 `position: relative` 在这层，不在 `.composer` 上 —— 菜单要贴着「+」
         *    往上弹，而 `.composer` 自己会被 textarea 撑高（最多 120px），
         *    定位基准跟着变的话菜单会随着打字上下跳。
         */}
        <div style={{ position: 'relative' }}>
          {plusOpen && (
            <>
              {/* 点别处就收起来。**不用 scrim**（那会盖住输入框）—— 一层透明的
                  捕获层就够了，而且它同时挡住「点菜单外面顺手点到发送」那一下 */}
              <div
                onClick={() => setPlusOpen(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 20 }}
              />
              <div className="plus-menu">
                {PLUS_ITEMS.map(({ kind, label, Icon }) => (
                  <button
                    key={kind}
                    onClick={() => {
                      setPlusOpen(false);
                      pick(kind);
                    }}
                  >
                    <span className="ico">
                      <Icon size={17} />
                    </span>
                    {tr(label)}
                  </button>
                ))}
              </div>
            </>
          )}
        <div className="composer" data-busy={transcribing} style={{ paddingLeft: 8 }}>
          <button
            onClick={() => setPlusOpen((v) => !v)}
            style={{
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 34,
              height: 34,
              borderRadius: 17,
              color: T.textSoft,
              background: plusOpen ? T.s3 : 'transparent',
              // 展开时转 45° 变成 ✕ —— 同一个键既是开也是关，不用第二个图标
              transform: plusOpen ? 'rotate(45deg)' : 'none',
              transition: 'transform .16s ease, background .16s ease',
            }}
            aria-label={tr('添加内容')}
            aria-expanded={plusOpen}
          >
            <IconPlus size={20} />
          </button>
          <textarea
            ref={composer}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              rec
                ? tr('录音中 {a}s…', { a: seconds })
                : tx
                  ? tr('正在把这段 {a} 转成文字…', { a: fmtDuration(tx.seconds) })
                  : desktop
                    ? tr('说点什么…（Enter 发送 · Shift+Enter 换行）')
                    : tr('说点什么…')
            }
            rows={1}
            disabled={Boolean(rec)}
            /**
             * 🔴 转写这几秒里**不许打字**（D112 · 维护者 2026-08-11）。
             * 不锁的话，转录会插到人刚打了一半的句子中间 —— 而插入点正是
             * `insertAtCursor` 按光标算的（issue #21①），两边同时动就一定错位。
             *
             * ⚠️ 用 `readOnly` 而不是 `disabled`：**`disabled` 会让这个框失焦，
             *    光标和选区跟着没了**，而转录恰恰要插在光标处 / 替换选中的那一段。
             *    `readOnly` 挡住输入、留住光标 —— 这正是这里要的那一半。
             */
            readOnly={transcribing}
            /**
             * 桌面端 Enter 发送、Shift+Enter 换行 —— 所有聊天界面的肌肉记忆（issue #7）。
             * ⚠️ **手机上保持原样**：软键盘那个键就是换行，改了反而按不出换行。
             */
            onKeyDown={(e) => {
              if (desktop && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                // 🔴 `editing?.id` 不能漏（D90）—— 漏了就只是「又说了一句」，
                //    老的那条不会被取代，对话里两版同时是活的
                if (canSend) void trySend();
              }
            }}
            style={{ flex: 1, resize: 'none', lineHeight: 1.5, padding: '9px 0' }}
          />
          <button
            onClick={() =>
              rec ? void stopRec() : void startRecording().then((h) => (setSeconds(0), setRec(h)))
            }
            // 转写还没回来时不让再录 —— 那一下会把攒着的这段顶掉
            disabled={transcribing}
            style={{ color: rec ? T.red : T.textSoft, padding: 8, opacity: transcribing ? 0.4 : 1 }}
            aria-label={rec ? '停止录音' : tr('录音')}
          >
            {rec ? <IconStop size={19} /> : <IconMic size={19} />}
          </button>
          <button
            className="ai-key"
            style={{
              background: canSend ? T.text : T.s3,
              color: canSend ? '#fff' : T.textLight,
              boxShadow: 'none',
              width: 38,
              height: 38,
            }}
            disabled={!canSend}
            onClick={() => void trySend()}
            aria-label={tr('发送')}
          >
            <IconSend size={17} />
          </button>
        </div>
        </div>

        {/* 三个 chip 收进上面那个「+」了（D104 · issue #32）—— 这里不再有第二排。 */}
        <input
          ref={fileInput}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            const list = e.target.files;
            if (!list?.length) return;
            const r = addFiles(
              atts,
              [...list].map((f) => ({ name: f.name, type: f.type, size: f.size, blob: f })),
              pendingKind.current,
            );
            setAtts(r.attachments);
            setAttErr(r.ok ? '' : r.reason);
          }}
        />
        </div>
      </div>
    </Sheet>
  );
};

// ═══════════════════════════════════════════════════════════════════
//  长按之后把这条消息托起来（D103 · issue #31 · D107 修订）
// ═══════════════════════════════════════════════════════════════════

/** 长按那一刻这条气泡在屏幕上的位置。浮层按它把拷贝画在**原地**。 */
type LiftRect = { top: number; left: number; width: number; height: number };

/** 动作卡的估高（3 行 × 47 + 边框）—— 只用来判断「下面放得下吗」。 */
const LIFT_MENU_H = 148;
/** 浮层离屏幕边缘至少留这么多 —— iOS 底部还有 home indicator。 */
const LIFT_EDGE = 16;

/**
 * 维护者 2026-08-11（issue #31）：「长按后不再从屏幕底部弹出操作菜单，
 * 页面其余背景虚化，三个操作项显示在该消息附近。」
 *
 * 🔴 **同日实测之后的修订：不要把它挪到屏幕中央。** 原话：
 * 「我之前不是让你长按修改对话的时候，把对话框放在中间，我刚刚测试了一下，
 *   别这么干，就放在原有的位置上就好了。」
 *
 * 判据（值得记住的那条）：**长按的对象就在手指底下 —— 那是这一屏上人最确定的
 * 一个坐标。** 把它挪走，等于在他已经指准的东西上再要求他找一次；
 * 而虚化背景 + 动作贴着它出现，本来就已经把「焦点是这一条」说清楚了。
 * 移动带来的那点仪式感，换掉的是这条交互唯一的确定性。
 *
 * 🔴 **三个动作一个字都没改**（还是 D90 的 `runAction`）—— 变的只是它们出现在哪儿。
 * 原来那个 `PickSheet` 从屏幕底部升起来，人的视线被从「他刚长按的那条」拽到屏幕最下沿，
 * 副标题里那句 `text.slice(0, 60)` 就是在补这个断层。现在被操作的那条**就在原处**。
 *
 * ⚠️ 原位那条同时被 `visibility: hidden` 藏起来 —— 浮层这份和它**严丝合缝地重叠**，
 *    不藏的话边缘会露出一圈没虚化的原件。
 * ⚠️ 挂到 `body` 上（portal）：`.sheet` 带 `transform`（开合动画），
 *    而**带 transform 的元素会成为 `position:fixed` 后代的包含块** ——
 *    留在里面的话这个浮层会跟着 sheet 一起缩放（§2.46 是它的孪生症状）。
 */
const LiftedMessage = ({
  message,
  rect,
  onPick,
  onClose,
}: {
  message: ThreadMessage;
  rect: LiftRect;
  onPick: (a: MsgAction) => void;
  onClose: () => void;
}) => {
  // Esc 退出（键盘用户和 iPad 外接键盘）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const vh = typeof window === 'undefined' ? 800 : window.innerHeight;
  const vw = typeof window === 'undefined' ? 400 : window.innerWidth;

  /**
   * 气泡画在原地；**只有一种情况会挪它**：它自己就比一屏还高
   * （10 分钟语音转出来的那种）。那时按住屏幕顶端、内部滚动 ——
   * 不这么做的话动作卡会被挤出屏幕，而那三个动作是这个浮层存在的全部理由。
   */
  const maxH = vh - LIFT_MENU_H - LIFT_EDGE * 3;
  const tooTall = rect.height > maxH;
  const top = tooTall ? LIFT_EDGE : rect.top;
  const height = tooTall ? maxH : rect.height;

  /** 动作卡：下面放得下就放下面，放不下就放上面（iOS 的做法）。 */
  const below = top + height + 8;
  const menuBelow = below + LIFT_MENU_H + LIFT_EDGE <= vh;
  const mine = message.role === 'user';

  return createPortal(
    <div className="lift-scrim" onClick={onClose} data-testid="lift-scrim">
      {/* 气泡的拷贝 —— 和原位严丝合缝地重叠 */}
      <div
        className="bubble lift-bubble"
        data-role={message.role}
        style={{
          top,
          left: rect.left,
          width: rect.width,
          maxHeight: height,
          // 点消息本身不关掉 —— 关掉的动作是「点旁边空白」
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {bold(message.text)}
      </div>

      {/* 动作卡：贴着气泡，和它同一侧对齐（自己发的靠右） */}
      <div
        className="lift-menu"
        style={{
          top: menuBelow ? below : undefined,
          bottom: menuBelow ? undefined : Math.max(LIFT_EDGE, vh - top + 8),
          ...(mine
            ? { right: Math.max(LIFT_EDGE, vw - (rect.left + rect.width)) }
            : { left: Math.max(LIFT_EDGE, rect.left) }),
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {MSG_ACTIONS.map((a) => {
          const Icon = MSG_ACTION_ICON[a];
          return (
            <button key={a} onClick={() => onPick(a)}>
              <Icon size={17} />
              {tr(MSG_ACTION_LABEL[a])}
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
};

// ═══════════════════════════════════════════════════════════════════
//  改口会改写 CRM 里哪几条（D108 · issue #37）
// ═══════════════════════════════════════════════════════════════════

/**
 * 🔴 **这张卡回答的是人在那一刻真正在问的问题：「我改这一句，CRM 里那条会怎么样？」**
 *
 * 在它之前，界面上一个字都没有 —— 生产实测（Movara）：人以为改了口，
 * 实际 CRM 里 `PowerFlex 3000W` 和 `2000W` 两条并存，而对话里那一版
 * 明明标着「已改」。同屏三个信号互相矛盾，谁也没说出真相。
 *
 * 现在改口会**继承上一版的记录所有权、原地改写**（D108）——
 * 于是这张卡能给出一句确定的话：**会被改写的就是下面这几条。**
 *
 * ⚠️ 只有「上一轮已经入库」时才弹。还没入库的改口是最常见的情况，
 *    那时它一句话都不该说 —— 每多一次打断，展会现场就少一条记录。
 */
const RewriteSheet = ({
  preview,
  onCancel,
  onConfirm,
}: {
  preview: SupersedePreview | null;
  onCancel: () => void;
  onConfirm: () => void;
}) => (
  <Backdrop onClose={onCancel}>
    <div style={{ fontSize: 15.5, fontWeight: 600, marginBottom: 8 }}>
      {tr('这一句上一轮已经入库了')}
    </div>
    {!preview ? (
      <div style={{ fontSize: 13, color: T.textLight }}>{tr('正在看它牵扯到什么…')}</div>
    ) : (
      <div style={{ fontSize: 12.5, color: T.textSoft, lineHeight: 1.8 }}>
        {/* ⚠️ 加粗用 `<b>`，不用 `**…**` —— 这一层没有 markdown 解析，星号会原样显示 */}
        {tr('发出去会')}
        <b>{tr('改写')}</b>
        {tr('下面这几条已入库的记录，不会新建第二份：')}
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {preview.rewriting.map((r, i) => (
            <div
              key={`${r.object}-${i}`}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'baseline',
                padding: '7px 10px',
                background: T.s2,
                borderRadius: 10,
              }}
            >
              <span style={{ fontSize: 11.5, color: T.textLight, flexShrink: 0 }}>{r.label}</span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12.5,
                  color: T.text,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {r.name || tr('（未命名）')}
              </span>
            </div>
          ))}
        </div>
        {/* 🔴 认成别家客户时那条路不一样 —— 说在前面，别让人事后才发现 */}
        <div style={{ marginTop: 8 }}>
          {tr('如果这一轮把客户认成了另一家，上面这几条会被')}
          <b>{tr('软删')}</b>
          {tr('、在新客户名下重建（随时可撤销）。')}
        </div>
        {/* 只继承最近的那一版：其余的一个字不动，**必须说出来** */}
        {preview.otherCommitted > 0 && (
          <div style={{ marginTop: 6, color: T.amber }}>
            {tr('⚠️ 这条对话里还有 {a} 版已入库的记录不会被改写 —— 要改它们，去「看板」上那一行改。', {
              a: preview.otherCommitted,
            })}
          </div>
        )}
        {preview.source === 'legacy_refs' && (
          <div style={{ marginTop: 6, color: T.textLight }}>
            {tr('（这一版是「删除/改写」功能上线之前入库的，清单是保守推断出来的。）')}
          </div>
        )}
      </div>
    )}
    <div style={{ display: 'flex', gap: 9, marginTop: 16 }}>
      <button
        className="btn"
        style={{ flex: 1, background: T.s3, color: T.text, boxShadow: 'none' }}
        onClick={onCancel}
      >
        {tr('先不改')}
      </button>
      <button
        className="btn"
        style={{ flex: 1, background: T.text, color: '#fff', boxShadow: 'none' }}
        onClick={onConfirm}
      >
        {tr('改写并重发')}
      </button>
    </div>
  </Backdrop>
);

// ═══════════════════════════════════════════════════════════════════
//  删对话历史的二次确认（D102 · issue #33）
// ═══════════════════════════════════════════════════════════════════

/**
 * 🔴 **这个框存在的理由是「说清楚哪些东西不会跟着没」**，不是再问一次「确定吗」。
 *
 * 一个写着「确定删除这条对话吗？」的框拦不住误触（人会条件反射地点确定），
 * 而且它答不了人在那一刻真正在想的问题：**「我整理进 CRM 的那几条会不会一起没？」**
 * 答案是不会 —— 三个面各有各的删除（对话 / 速记 / 看板），这里只删第一个。
 * 不说的话两种误解都会发生：不敢删，或者以为删干净了而其实没有。
 *
 * 形态复用 `components/Backdrop`（底部弹层）——
 * 和速记页、看板那两个删除确认长得一样，删除这件事在三个面上手感一致。
 */
const DeleteThreadSheet = ({
  thread,
  onCancel,
  onConfirm,
}: {
  thread: Thread;
  onCancel: () => void;
  onConfirm: () => void;
}) => (
  <Backdrop onClose={onCancel}>
    <div style={{ fontSize: 15.5, fontWeight: 600, marginBottom: 8 }}>{tr('删掉这条对话？')}</div>
    <div style={{ fontSize: 12.5, color: T.textSoft, lineHeight: 1.8 }}>
      <div
        style={{
          color: T.text,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          marginBottom: 4,
        }}
      >
        {tr('「{a}」', { a: thread.title || tr('（语音）') })} ·{' '}
        {tr('{a} 条消息', { a: thread.messages })}
      </div>
      {tr('它会从历史列表里消失，随时可以撤销。')}
      {/* 🔴 这两句是这个框的全部价值 —— 一个字都不能省。
          ⚠️ 加粗用 `<b>` 而不是 `**…**`：这一层没有 markdown 解析，
             星号会**原样显示成字面量**（issue #7 那个坑的同一个形状）。 */}
      <div style={{ marginTop: 6, color: T.text }}>
        {tr('速记页那条原话')}
        <b>{tr('不会')}</b>
        {tr('被删掉。')}
        <br />
        {tr('已经入库到 CRM 的那几条也')}
        <b>{tr('不会')}</b>
        {tr(' —— 要删它们，去「看板」上删那一行。')}
      </div>
    </div>
    <div style={{ display: 'flex', gap: 9, marginTop: 16 }}>
      <button
        className="btn"
        style={{ flex: 1, background: T.s3, color: T.text, boxShadow: 'none' }}
        onClick={onCancel}
      >
        {tr('不删')}
      </button>
      <button
        className="btn"
        style={{ flex: 1, background: T.red, color: '#fff', boxShadow: 'none' }}
        onClick={onConfirm}
      >
        {tr('删除')}
      </button>
    </div>
  </Backdrop>
);
