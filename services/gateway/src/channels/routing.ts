/**
 * 会话路由（docs/dingtalk-channel.md §4）—— 同群多人时，这条 @ 接到哪条对话上。
 *
 * 状态按 (会话, 发送人) 各记各的；**默认新开**。
 *
 * 🔴 判据：**分错方向的代价不对称。** 错开新条 = 多一张待确认卡，人不确认就是了；
 *    错并线 = 把一句不相干的话灌进上一条提案，续跑当场改写它 —— 数据踩数据。
 *    （反例就在窗口里：A 录完 Alpin 两分钟后又录一条 Heron，按「时间近就续写」会并错。）
 *    所以续写只认明确信号，其余一律新开。纯函数，SQL 查上下文的部分在 route.ts。
 */

export const ANSWER_WINDOW_MS = 30 * 60_000; // 回答 bot 追问
export const CORRECTION_WINDOW_MS = 2 * 60 * 60_000; // 「更正 …」改上一条

const CORRECTION_RE = /^(更正|不对|改一下|改成|上一条|纠正|说错了|写错了)/;

export const isCorrection = (text: string): boolean => CORRECTION_RE.test(String(text ?? '').trim());

export type RouteContext = {
  /** 该 (会话, 发送人) 最近一条对话；null = 没有历史。 */
  lastThreadId: string | null;
  /** 那条对话最近一次活动（消息时刻）。 */
  lastActivityAt: Date | null;
  /** 那条对话里 agent 最近一次**追问**的时刻（stop_reason=waiting_user）；null = 没在等回答。 */
  lastAskedAt: Date | null;
};

export type RouteDecision = { threadId: string | null; via: 'answer' | 'correction' | 'new' };

export const decideRoute = (text: string, ctx: RouteContext, now: Date): RouteDecision => {
  if (!ctx.lastThreadId) return { threadId: null, via: 'new' };
  const t = now.getTime();
  if (ctx.lastAskedAt && t - ctx.lastAskedAt.getTime() < ANSWER_WINDOW_MS)
    return { threadId: ctx.lastThreadId, via: 'answer' };
  if (
    isCorrection(text) &&
    ctx.lastActivityAt &&
    t - ctx.lastActivityAt.getTime() < CORRECTION_WINDOW_MS
  )
    return { threadId: ctx.lastThreadId, via: 'correction' };
  return { threadId: null, via: 'new' };
};
