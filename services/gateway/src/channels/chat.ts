import { env } from '../env.ts';
import { sql } from '../db.ts';
import { deriveClientId, type ChannelEvent } from './payload.ts';
import { md, type DingMessage } from './render.ts';

/**
 * 日常助手（D128，维护者 2026-08-18：「再创建第三个 agent……应付这种奇奇怪怪的、
 * 跟项目或技术没关系的客户请求」）—— 路由器的第三个去向。
 *
 * 起因是生产实测：测试消息（「你看得到我这里的引用吗？……」）被二分法路由进速记，
 * 变成一条垃圾「选型情报·待确认」。这类消息既不是情报也不是产品问题，
 * 需要一个**不进任何管道**的出口。
 *
 * 形态刻意最小：单次 Luna 调用（**无思考、无工具、无会话、无新表**），同步直答
 * （kind: final）—— 闲聊杂项不值得 ack + webhook 两条腿，也不该依赖群配没配 webhook。
 * 幂等靠 channel_event（`chat:<clientId>` 唯一），和 lab 同一个形状 ——
 * 流程重试时不重烧模型、不在群里再答一遍。
 *
 * ⚠️ 这不是「第三个端点」：入口仍然只有 `/channels/dingtalk/events` 一个，
 * 这里只是路由器内部的第三条分发线，钉钉侧零配置。
 */

const SYSTEM =
  '你是钉钉群里的日常助手。你只能看到 @ 你的这一条消息 —— 群里的其他消息、' +
  '被引用的内容、上一轮对话你都看不到，别假装看得到。\n' +
  '分工：客户情报由速记助手记录进 CRM；产品技术问题由实验室助手回答；' +
  '你负责剩下的杂项 —— 测试、打招呼、翻译改写、算个数、闲聊。\n' +
  '简短回答（几句话以内），不编造。有人问你是谁：钉钉里的 RV 助手的日常分线。';

/** 模型不可用/没回上话时的兜底 —— 也是一次性测试环境（AGENT_ENABLED=0）的固定输出。 */
export const CHAT_FALLBACK =
  '我没接上话（日常助手这条线没开或没回应）。' +
  '要记录客户情报直接说事实；要产品答案直接提问；这两条线不受影响。';

type ChatDeps = {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** 测试注入。生产走 env.agentEnabled。 */
  enabled?: boolean;
};

/**
 * 单次直答。返回 null = 没答上来（关着/超时/报错/空回答），调用方给兜底话术。
 * 🔴 参数形状同 router/gate：`max_completion_tokens`，不带 `max_tokens` /
 * `temperature` / `reasoning`（§2.53 —— 这族模型对前两样直接 400，第三样不传即不思考）。
 */
export const chatOnce = async (text: string, deps: ChatDeps = {}): Promise<string | null> => {
  if (!(deps.enabled ?? env.agentEnabled)) return null;
  const fetchFn = deps.fetchFn ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? env.chatTimeoutMs);
  try {
    const res = await fetchFn(`${env.openaiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.openaiKey}` },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: env.chatModel,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: String(text ?? '').slice(0, 2000) },
        ],
        max_completion_tokens: 900,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return String(data.choices?.[0]?.message?.content ?? '').trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/** 路由器分发进来的那条 —— 幂等 + 直答，永远返回一条能发回群的消息。 */
export const runChatForEvent = async (
  ev: ChannelEvent,
  deps: ChatDeps = {},
): Promise<{ ding: DingMessage }> => {
  const dupKey = deriveClientId(ev);
  const [fresh] = await sql<Array<{ id: string }>>`
    insert into channel_event (channel, event_key, kind, conversation_key, sender)
    values ('dingtalk-chat', ${`chat:${dupKey}`}, 'message', ${ev.conversationKey}, ${ev.sender})
    on conflict (channel, event_key) do nothing
    returning id`;
  if (!fresh) return { ding: md('这句我刚回过了（重复投递），不再答一遍。', ev.sender) };

  const answer = await chatOnce(ev.text, deps);
  return { ding: md(answer ? `💬 ${answer}` : `💬 ${CHAT_FALLBACK}`, ev.sender) };
};
