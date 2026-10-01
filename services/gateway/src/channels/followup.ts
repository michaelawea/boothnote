/**
 * ══════════════════════════════════════════════════════════════════
 *  二轮对话：这句 @ 接在哪一条上（D146 · docs/dingtalk-confirm-pool.md §5）
 *
 *  钉钉流程每次 @ 是一个独立请求，只有 6 个字段 —— **没有会话 ID、消息 ID、引用**，
 *  bot 也只看得见 @ 它的那一句。所以「持续对话」只能由网关自己记：
 *  钉钉只负责一句一句递话，「这句是在回答哪个问题 / 在改哪一条」全在这里判。
 *
 *  规则从上往下、命中即停（`decideFollow`，纯函数，表驱动测试钉住）：
 *    0  整句命令：帮助 · 待办 · #128（重发汇报）· 入库 #128 · 确认/撤回（提示）
 *    1  正文带 #N（必须有 #）                    → 那一条
 *    2  记： / 问： 开头                           → 不接，交给路由器按前缀
 *    3  有待回答问题（每人每群一个，30 分钟）
 *       且不像提问、没点名别家客户、没带图        → 那个问题对应的条
 *    4  更正词开头，本人 2 小时内在这个群有一条  → 那一条
 *    5  其余                                      → 不接，交给路由器
 *
 *  🔴 判据：**分错方向的代价不对称**（routing.ts 文件头）。错开新条 = 多一条汇报；
 *     错并线 = 一句不相干的话改写了一条记录 —— 而现在那条记录 60 秒后就进 CRM（D143）。
 *     所以只认明确信号，其余一律交给路由器新开。
 * ══════════════════════════════════════════════════════════════════ */
import { isCorrection } from './routing.ts';

export type FollowContext = {
  /** 这个人在这个群里没过期的待回答问题（一条 thread 一个）。**恰好一个时**才直接当回答。 */
  openQuestions: Array<{ threadId: string; refNo: number | null }>;
  /** 本人 2 小时内在这个群最近的一条。 */
  recent: { threadId: string; refNo: number | null } | null;
  /** 这句话点名了一家客户，而且**不是**待回答问题那一条的客户（见 `namesOtherCompany`）。 */
  mentionsOtherCompany: boolean;
  hasAttachments: boolean;
};

export type Command =
  | { cmd: 'help' }
  | { cmd: 'todo' }
  | { cmd: 'resend'; refNo: number }
  | { cmd: 'force'; refNo: number }
  | { cmd: 'hint' };

export type FollowDecision =
  | { kind: 'command'; command: Command }
  | { kind: 'item'; via: 'ref'; refNo: number }
  | { kind: 'item'; via: 'answer' | 'correction'; threadId: string; refNo: number | null }
  /** 像回答，但同时有不止一个问题在等 —— 不猜，原话存下、请带 #编号。 */
  | { kind: 'ambiguous'; refNos: Array<number | null> }
  | { kind: 'none' };

const REF_RE = /#(\d{2,9})(?!\d)/;

/** 整句命令。**整句才算** —— 「确认 Alpin 那条…」是一句内容，不能被命令层吞掉。 */
export const commandOf = (text: string): Command | null => {
  const t = String(text ?? '').trim().replace(/[。！!\s]+$/, '');
  if (/^(帮助|help|用法)$/i.test(t)) return { cmd: 'help' };
  if (/^(待办|todo)$/i.test(t)) return { cmd: 'todo' };
  let m = /^#(\d{2,9})$/.exec(t);
  if (m) return { cmd: 'resend', refNo: Number(m[1]) };
  m = /^入库\s*#(\d{2,9})$/.exec(t);
  if (m) return { cmd: 'force', refNo: Number(m[1]) };
  if (/^(确认|撤销|撤回)(\s*#\d{2,9})?$/.test(t)) return { cmd: 'hint' };
  return null;
};

/** 这句话像不像一个提问 —— 像的话不当成对 bot 追问的回答（真问题交给路由器去实验室）。 */
export const looksLikeQuestion = (text: string): boolean => {
  const t = String(text ?? '').trim();
  return (
    /[?？]\s*$/.test(t) ||
    /吗\s*$/.test(t) ||
    // 中文开头不能用 \b —— 汉字两边都是 \W，`请问X` 中间没有词边界
    /^(请问|问一下|怎么|如何|为什么|为啥|多少|哪里|哪个|哪些|是否|能不能|可不可以|有没有)/.test(t) ||
    /^(what|how|why|which|can|could|is|are|does|do)\b/i.test(t)
  );
};

export const decideFollow = (text: string, ctx: FollowContext): FollowDecision => {
  const t = String(text ?? '').trim();
  const cmd = commandOf(t);
  if (cmd) return { kind: 'command', command: cmd };

  const ref = REF_RE.exec(t);
  if (ref) return { kind: 'item', via: 'ref', refNo: Number(ref[1]) };

  if (/^(记|问)[：:]/.test(t)) return { kind: 'none' };

  const qs = ctx.openQuestions;
  /**
   * 「更正 …」说的是**刚说的那一条** —— 待回答的问题挂在另一条上时，更正优先。
   * （同一条上既有问题又在更正，下面那条「回答」照样接到它上面，结果一样。）
   */
  if (ctx.recent && isCorrection(t) && !(qs.length === 1 && qs[0]!.threadId === ctx.recent.threadId)) {
    return { kind: 'item', via: 'correction', threadId: ctx.recent.threadId, refNo: ctx.recent.refNo };
  }

  const answerLike = qs.length > 0 && !ctx.hasAttachments && !ctx.mentionsOtherCompany && !looksLikeQuestion(t);
  if (answerLike && qs.length === 1) {
    return { kind: 'item', via: 'answer', threadId: qs[0]!.threadId, refNo: qs[0]!.refNo };
  }
  if (answerLike) return { kind: 'ambiguous', refNos: qs.map((q) => q.refNo) };
  return { kind: 'none' };
};

type Co = { code: string; name: string; group?: string };

/**
 * 这句话里点名的客户。全名（≥3 字）或第一个词（**≥4 字**，免得「Orba」「Sun」这类短词误中），
 * 大小写不敏感。纯函数。
 */
export const companiesMentioned = (text: string, companies: Co[]): string[] => {
  const t = String(text ?? '').toLowerCase();
  const out: string[] = [];
  for (const c of companies) {
    const full = c.name.trim().toLowerCase();
    const first = (c.name.split(/\s+/)[0] ?? '').trim().toLowerCase();
    if ((full.length >= 3 && t.includes(full)) || (first.length >= 4 && t.includes(first))) out.push(c.code);
  }
  return out;
};

/** 同一家，或同一个集团（父子 / 兄弟）。Alpin 和 Alpin Tannhof 集团不算「别家」。 */
const sameFamily = (a: Co | undefined, b: Co | undefined): boolean => {
  if (!a || !b) return false;
  if (a.code === b.code) return true;
  const ga = (a.group ?? '').trim();
  const gb = (b.group ?? '').trim();
  return Boolean((ga && ga === gb) || (ga && ga === b.name) || (gb && gb === a.name));
};

/**
 * 「回答」点名了**别家**客户吗（那就是一条新情报，不是在答这道题）。
 *
 * 🔴 那一条**还没有客户**时，点名客户恰恰就是在回答（「客户没对上」的硬挡，补的就是这一句）——
 *    第一版把它判成「别家」，硬挡的那一条按汇报给的方式永远补不上。评审抓出来的。
 */
export const namesOtherCompany = (text: string, itemCode: string | null, companies: Co[]): boolean => {
  if (!itemCode) return false;
  const item = companies.find((c) => c.code === itemCode);
  const named = companiesMentioned(text, companies);
  return named.some((code) => code !== itemCode && !sameFamily(companies.find((c) => c.code === code), item));
};
