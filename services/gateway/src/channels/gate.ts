import { env } from '../env.ts';

/**
 * L1 完整性门卫（docs/dingtalk-channel.md §2，维护者 2026-08-17 定的两层结构）。
 *
 * 专治一种钉钉特有的失败：人以为 bot 看得见前面的聊天，@ 一句「记录一下相关信息」——
 * 而 bot 只收得到 @ 它的这一条，其余什么都没有。这种消息要在进 inbox 之前拦下来，
 * 否则「我的记录」里会积一堆空心条目，模型也白烧。
 *
 * 三级：规则先挡（不花钱）→ 小模型快判（2 秒超时）→ 放行。
 *
 * 🔴 **超时 / 出错 / 拿不准，一律放行。** 门卫的职责是挡明显的垃圾，不是当单点 ——
 *    宁可 L2 多跑一次抽取，不许把真情报卡在门口（fail-open，有变异测试盯着）。
 */

export type GateRuleVerdict = 'reject' | 'pass' | 'unsure';

/** 一句话里全是「记录/整理」这类壳词、没有任何实体内容时命中。 */
const FILLER_RE =
  /^(请|帮我|麻烦|你|给我)?(记录|记|整理|录入|登记|保存|存)(一下|下|个)?(这个|这些|上面|刚才|刚刚|之前)?(的)?(相关|聊天|讨论)?(信息|内容|记录|情况|东西)?(吧|哈|谢谢|哦|呀|啊)?[\s。．.!！~～]*$/;

export const gateRules = (text: string): GateRuleVerdict => {
  const t = String(text ?? '').trim();
  if (!t) return 'reject';
  if (FILLER_RE.test(t)) return 'reject'; // 「记录一下相关信息」这一族，长短都算
  if (t.length < 5) return 'reject';
  if (t.length < 14) return 'unsure'; // 短但可能有货（「Alpin 换 3000W」12 个字符）
  return 'pass';
};

/** 固定教育话术 —— L1 拒收时同步回这一条（kind: final）。 */
export const GATE_REJECT_TEXT =
  '我只能看到 @ 我的这一条消息，前面的聊天我看不见。\n' +
  '请把要记的内容完整带在一句话里再 @ 我，比如：\n' +
  '「@Boothnote 刚跟 Alpin 聊完，他们想把逆变器换成 3000W，Q4 送样」';

type GateDeps = {
  /** 测试注入。生产走真 fetch。 */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
};

/**
 * 完整判定。返回 true = 放行进 inbox。
 *
 * 小模型那一级只在「规则拿不准 && agent 开着」时才花钱 ——
 * 一次性测试环境 `AGENT_ENABLED=0`，行为完全由规则决定（可复现）。
 */
export const gateCheck = async (
  text: string,
  hasAttachments: boolean,
  deps: GateDeps = {},
): Promise<{ pass: boolean; via: 'rules' | 'model' | 'attachments' }> => {
  if (hasAttachments) return { pass: true, via: 'attachments' }; // 图片本身就是内容
  const rule = gateRules(text);
  if (rule === 'reject') return { pass: false, via: 'rules' };
  if (rule === 'pass') return { pass: true, via: 'rules' };

  if (!env.agentEnabled) return { pass: true, via: 'rules' }; // 拿不准 + 没模型 → 放行
  const fetchFn = deps.fetchFn ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? 2000);
  try {
    const res = await fetchFn(`${env.openaiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.openaiKey}` },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: env.gateModel,
        messages: [
          {
            role: 'user',
            content:
              '下面是销售在群里 @ 记录机器人说的一句话。机器人看不到群里其他消息。\n' +
              '判断这句话本身是否包含足以录入客户情报的具体内容（客户名/产品/事实/进展任一即可）。\n' +
              '只回一个词：有货 或 空心。\n\n' +
              text.slice(0, 500),
          },
        ],
        /**
         * 🔴 原来这里是 `max_tokens: 4, temperature: 0` —— gpt-5.6 这一族在
         * chat/completions 上两样都不认，**每次调用都 400**，而 400 走的是
         * 「出错放行」那条 fail-open：**门卫的模型档上线以来一次都没真判过**，
         * 界面上毫无症状（unsure 的全放行了）。D127 的路由评测（同参数形状
         * 20/20 全 fallback）才把它带出水面。判据还是那条：配错了不报错的配置，
         * 只有让它在真调用里跑一次才知道真假。
         */
        max_completion_tokens: 4,
      }),
    });
    if (!res.ok) return { pass: true, via: 'model' }; // 出错放行
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const out = String(data.choices?.[0]?.message?.content ?? '');
    return { pass: !out.includes('空心'), via: 'model' };
  } catch {
    return { pass: true, via: 'model' }; // 超时/网络失败放行 —— fail-open
  } finally {
    clearTimeout(timer);
  }
};
