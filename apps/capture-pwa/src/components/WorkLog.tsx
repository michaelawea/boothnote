import { useState } from 'react';

import { T } from '../theme';
import { t } from '../i18n';
import { IconChevron, IconStop } from '../icons';

/**
 * AI 的工作日志 —— **收缩式，跑完也一直在**（D74，维护者 2026-08-06）。
 *
 * 之前有两个问题：
 *   ① 运行中只有一串步骤铺开显示（AgentProgress），没有收纳；
 *   ② 🔴 对话一完成，整块直接消失 —— 轨迹明明每一步都落了库
 *     （`agent_run.trace` 就是为「盲盒」问题建的），只是前端跑完就不渲染了。
 *     维护者 原话：「之前的思考流程记录就不在了」。
 *
 * 现在：**收起态一行标题**（运行中 = 当前阶段 + 步数；完成 = 结果 + 步数 + 耗时），
 * 点开是逐步日志。**默认收起** —— 核对卡才是主角，日志是排查与信任的辅助。
 */
/**
 * ── D88（issue #24，维护者 2026-08-07）：照 OpenAI 那个形态重做外观 ────
 *
 * 三条都不对，一条一条对：
 *   ① **位置**：原来挂在整条 agent 消息**之后**。改到**第一个子元素** ——
 *      挂在 `Chat.tsx` 里，见那边的注释。
 *   ② **文案**：原来是「AI 工作日志 · 6 次调用 · 12.3s」。
 *      「N 次调用」是实现细节，人关心的是**它想了多久** ——
 *      收起态只留 `思考了 12.3s`，跑动时 `正在思考…`。
 *   ③ **样式**：原来 `background` + `borderRadius:14` + `minWidth:230`，
 *      长得像**又一条聊天消息**。现在是回复顶上一行不起眼的可点文字 + chevron：
 *      没有底色、没有气泡、不占一整块。
 *
 * 展开态一个字没动 —— issue 里点名「那部分是对的，别动」。
 */

export type TraceStep = { tool: string; ms: number; ok: boolean; summary: string };

/**
 * 工具名 → 人话。轨迹里存的是工具名，界面上不该出现 snake_case。
 *
 * ⚠️ **15 个工具，这里就得有 15 行**（外加 follow_up 这类运行时记号）。
 * 少一行不会报错 —— 只是日志里冒出一个 `propose_work_items`，
 * 人在展会现场看到它只会觉得这东西没做完。D59 那五个漏了整整两天没人发现，
 * `read_skill`（D72）也漏过一次。加工具时顺手加这一行，
 * `agent/src/tools/index.ts` 的 `TOOL_NAMES` 是那份清单。
 *
 * 🔴 **存中文，渲染时才翻**（D80 的三条判据之一）。
 * 这张表是模块级常量 —— 值里直接放翻译函数的调用，它会在**模块加载那一刻**求值，
 * 用的是那时候的语言。刚被改过语言的人第一次打开会看到旧语言，刷新第二次才对。
 * （`scripts/check-i18n-safety.mjs` 机械守着这条，它连注释一起扫。）
 */
export const TOOL_LABEL: Record<string, string> = {
  read_skill: '翻手册',
  search_companies: '查客户',
  get_thread: '看之前说过什么',
  get_company_gaps: '看这家还缺什么',
  get_company_records: '看这家已有什么记录',
  get_projects: '查项目',
  read_attachment: '读附件',
  list_enums: '看可选值',
  propose_fields: '整理成字段',
  ask_user: '想问一句',
  flag_new_company: '提议新客户',
  propose_intel_field: '造一个新字段',
  propose_project: '建/更新项目',
  propose_work_items: '拆成任务线程',
  propose_document: '生成文档',
  // 运行时记号（不是工具）：出口契约的那一次追问（D73③）
  follow_up: '差一步，追问补交',
};

/** 停止原因 → 人话。跑完的日志标题右边那一小截。同样存中文，渲染时才翻。 */
const STOP_LABEL: Record<string, string> = {
  done: '完成',
  waiting_user: '等你回答',
  max_steps: '到步数上限',
  timeout: '到时间上限',
  // D89（issue #22）：人自己按的停止。它不是故障，标题上要和「出错了」分得开。
  aborted: '你叫停了',
  error: '出错了',
  // T99：上个进程被杀时留在 running、启动时被 reapStaleRuns() 收掉的那一轮。
  // 和 error 分开：它没跑出错，是**没跑完就被掐了**，而且多半已经被重新排上队。
  interrupted: '网关重启了',
};

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

/**
 * 收起态那一行写什么。**抽成纯函数是为了能测** ——
 * 「思考了 25s」这句话是 issue #24 的全部验收点，而它藏在 JSX 里就只能靠眼睛看。
 */
export const workLogTitle = (a: {
  live?: boolean;
  durationMs?: number | null;
  stopReason?: string | null;
}): string => {
  if (a.live) return t('正在思考…');
  const head = a.durationMs ? t('思考了 {a}', { a: fmtMs(a.durationMs) }) : t('思考过程');
  // 正常收工不用说 —— 只有「等你回答 / 你叫停了 / 出错了」这类才值得占那几个字
  if (!a.stopReason || a.stopReason === 'done') return head;
  return `${head} · ${t(STOP_LABEL[a.stopReason] ?? a.stopReason)}`;
};

/**
 * ── 这一屏要不要显示「它在跑」（issue #50，维护者 2026-09-01 展会现场报）────
 *
 * 现象：**第一轮没有思考动画，第二轮才有。**
 *
 * 🔴 **根因是判据问错了对象。** 原来是 `{waiting && <WorkLog live … />}`，
 * 而 `waiting` 是 `Chat.tsx` 里的一格本地 state，**唯一写 true 的地方是 `send()`** ——
 * 于是它回答的其实是「这一轮是不是我在这个对话框里按下发送的」，
 * 而不是人真正在问的那句「它现在在跑吗」。三条常走的路全都落空，而且恰好都是第一轮：
 *   · **速记 → 发给 AI（D95）→ 对话页打开** —— 那一轮不是 `send()` 发起的（现场最常用的入口）
 *   · 从看板 / 历史点进一条正在跑的对话 —— `pickThread()` 显式 `setWaiting(false)`
 *   · 关掉再打开 / PWA 被系统回收后切回来 —— 组件重挂，`waiting` 回到初始值
 * 接着人打的第二句走 `send()`，动画就出来了 —— 「第二轮才有」就是这么来的。
 *
 * 🔴 **判据：「它在跑吗」是服务端的事实，不是这个标签页的记忆。**
 * 和 D95「『发过没有』必须由服务端回答」同一个形状 —— 那次是换台手机就不弹 double check。
 * 服务端每 1.2 秒就在给答案（`/threads/:id` 的 `running`），此前只拿它填 trace/stage，
 * **没人拿它决定显不显示**。
 *
 * ⚠️ **是并集不是替换。** `send()` 之后到服务端把 `agent_run` 建出来之前有 1~2 秒空窗
 * （弱网更长），那一段只有 `waiting` 答得上来 —— 换成纯服务端判据的话，
 * 现场按下发送最先看到的仍然是一片什么都没有。
 *
 * ⚠️ **代价**：网关被硬杀时 `agent_run` 会留下一行永远 `running`（没有回收），
 * 于是那条对话会一直显示「正在思考…」。这不是这次引入的
 * （发起的那个标签页本来就一直转），但现在**换个标签页打开也看得见**。
 *
 * 抽成纯函数是为了能测 —— 判据躺在 JSX 里就只能靠眼睛看（同 `workLogTitle`）。
 */
export const agentIsRunning = ({
  waiting,
  running,
}: {
  /** 本地乐观态：这一轮是我刚按下发送的。 */
  waiting: boolean;
  /** 服务端说的那一轮（`/threads/:id` 的 `running`）。`null` = 没有在跑。 */
  running: unknown;
}): boolean => waiting || running != null;

export const WorkLog = ({
  trace,
  live,
  stage,
  steps,
  maxSteps,
  stopReason,
  durationMs,
  onStop,
  stopping,
}: {
  trace: TraceStep[];
  /** true = 这一轮还在跑（标题显示当前阶段 + 跳动的点）。 */
  live?: boolean;
  /** 运行中的当前阶段（人话，来自 agent_run.stage）。 */
  stage?: string | null;
  steps?: number | null;
  maxSteps?: number | null;
  /** 跑完后的停止原因（done / waiting_user / …）。 */
  stopReason?: string | null;
  durationMs?: number | null;
  /**
   * 按下「停止」（D89 · issue #22）。只在 `live` 时给 —— 没跑的东西没得停。
   * 不传就不渲染那个键：这个组件不猜「现在能不能停」。
   */
  onStop?: () => void;
  /** 停止请求已经发出去、还没落地。按钮转成不可点，免得连按。 */
  stopping?: boolean;
}) => {
  /**
   * 🔴 默认收起 —— 维护者 点名的形态：「平时只显示一个标题，
   * 点开后可以看到状态和详细的日志记录」。
   * 展开状态放本地 state：轮询 1.2 秒重渲染一次，放外面会被刷回去。
   */
  const [open, setOpen] = useState(false);

  const failed = trace.some((x) => !x.ok);
  const title = workLogTitle({ live, durationMs, stopReason });

  return (
    <div
      style={{
        alignSelf: 'flex-start',
        // 🔴 D88③：**没有 background / borderRadius / minWidth**。
        //    有它们就是一个气泡，而气泡在这一屏的语义是「一条消息」。
        maxWidth: '100%',
        fontSize: 12.5,
      }}
    >
      {/* ── 收起态：一行小字 + chevron（跑动时右边还有停止键）─────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '2px 0',
            font: 'inherit',
            color: failed ? T.amber : T.textLight,
            textAlign: 'left',
            cursor: 'pointer',
            background: 'transparent',
            border: 'none',
          }}
          aria-expanded={open}
        >
          {live ? (
            <span className="dots" style={{ width: 12, flexShrink: 0 }}>
              <span />
            </span>
          ) : failed ? (
            // 失败仍然是琥珀色的那个记号（issue #24 第 5 条：这条保留）
            <span style={{ flexShrink: 0 }}>⚠</span>
          ) : null}
          <span>{title}</span>
          {live && steps ? (
            <span style={{ flexShrink: 0 }}>
              {Math.min(steps, maxSteps ?? 8)} / {maxSteps ?? 8}
            </span>
          ) : null}
          {/* chevron —— 展开转 90°。有它人才知道这行是可以点的 */}
          <span
            style={{
              display: 'inline-flex',
              flexShrink: 0,
              transform: open ? 'rotate(90deg)' : 'none',
              transition: 'transform .15s',
            }}
          >
            <IconChevron size={12} />
          </span>
        </button>

        {/**
         * 🔴 **停止键**（D89 · issue #22，维护者：「跑起来的 agent 必须能手动叫停」）。
         *
         * 现场是「说一句 → 看一眼 → 改一句」的节奏。发现说错了却只能盯着转圈等两分钟
         * （8 步 / 120 秒，带附件还要再加），那不是体验问题 —— 是这东西现场根本不会被用。
         *
         * 放在这一行而不是输入框那边：**人的眼睛此刻就在这一行上**（它是唯一在动的东西）。
         */}
        {live && onStop && (
          <button
            onClick={onStop}
            disabled={stopping}
            aria-label={t('停止')}
            title={t('停止')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 22,
              height: 22,
              borderRadius: 11,
              border: `1px solid ${T.lineLight}`,
              background: 'transparent',
              color: stopping ? T.textLight : T.textSoft,
              cursor: stopping ? 'default' : 'pointer',
              opacity: stopping ? 0.5 : 1,
              flexShrink: 0,
            }}
          >
            <IconStop size={11} />
          </button>
        )}
      </div>

      {/* ── 展开态：逐步日志（issue #24：「那部分是对的，别动」）───── */}
      {open && (
        <div
          style={{
            marginTop: 4,
            paddingLeft: 10,
            borderLeft: `2px solid ${T.lineLight}`,
          }}
        >
          {trace.length === 0 && (
            <div style={{ color: T.textLight, padding: '6px 0', lineHeight: 1.7 }}>
              {live ? t('还没有工具调用 —— 它在读原文、想第一步干什么。') : t('还没有工具调用。')}
            </div>
          )}
          {trace.map((d, i) => (
            <div key={i} style={{ padding: '6px 0', lineHeight: 1.6 }}>
              <div style={{ display: 'flex', gap: 7, alignItems: 'baseline' }}>
                <span style={{ color: d.ok ? T.green : T.red, flexShrink: 0 }}>
                  {d.ok ? '✓' : '✕'}
                </span>
                <span style={{ flex: 1, color: T.text }}>{t(TOOL_LABEL[d.tool] ?? d.tool)}</span>
                <span style={{ fontSize: 11, color: T.textLight, flexShrink: 0 }}>{fmtMs(d.ms)}</span>
              </div>
              {/* 结果摘要 —— 这就是 维护者 要的「详细的日志记录」：
                  不只是「查了客户」，还有「查到了什么」。失败的那步尤其重要。 */}
              {d.summary && (
                <div
                  style={{
                    fontSize: 11.5,
                    color: d.ok ? T.textLight : T.red,
                    marginLeft: 19,
                    marginTop: 2,
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                    // 摘要最长 200 字（runtime.ts 截过），三行内放得下，不再截
                    lineHeight: 1.55,
                  }}
                >
                  {d.summary}
                </div>
              )}
            </div>
          ))}
          {live && (
            <div style={{ display: 'flex', gap: 7, alignItems: 'center', paddingTop: 6, color: T.text }}>
              <span className="dots" style={{ width: 14 }}>
                <span />
              </span>
              <span>{stage ?? t('正在处理')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
