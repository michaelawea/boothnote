import { env } from '../env.ts';

/**
 * 回执渲染（docs/dingtalk-channel.md §2 的模板）—— **纯函数，一份实现喂两条腿**：
 * 同步响应的 `ding` 和出站 webhook 发的是同一族格式（text/markdown）。
 *
 * 规格（可测）：永远 @ 发送人。agent 跑完之后的汇报在 report.ts（D145：状态先行、拟写入详尽）；
 * **「已入库」只在 confirmed 之后出现** —— 倒计时里只能说「待入库」。
 */

export type DingMessage = {
  msgtype: 'markdown' | 'text';
  markdown?: { title: string; text: string };
  text?: { content: string };
  at?: { atUserIds: string[]; isAtAll: boolean };
};

const TITLE = 'Boothnote'; // 出现在通知横幅上，别拿它传业务内容

/**
 * 一条钉钉消息正文的字节上限。钉钉机器人消息约 20000 字节封顶，留 2000 余量。
 *
 * 🔴 **截断放在 `md()` 这一个咽喉上**，不放各个 render 函数里 ——
 * `renderReceipt` 自己有「≤8 行」的硬规格，而实验室 agent 的回答是模型自由发挥的，
 * 实测两轮长文分别是 16920 / 17784 字节，两次都贴着上限（§2.52）。
 * 超限的后果和被关键词拦掉一样：钉钉丢掉消息，而**我们这边照样以为发成功了**。
 */
const MAX_TEXT_BYTES = 18000;
const CLAMP_NOTE = '\n\n…（回答太长，后面截掉了。换个更具体的问法能拿到完整回答。）';

/** 按 UTF-8 字节截断，不切碎多字节字符（切口上的半个字会被解成 U+FFFD，去掉）。 */
export const clampText = (text: string, max = MAX_TEXT_BYTES): string => {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return text;
  const head = buf
    .subarray(0, max - Buffer.byteLength(CLAMP_NOTE, 'utf8'))
    .toString('utf8')
    .replace(/�+$/, '');
  return head + CLAMP_NOTE;
};

/**
 * 🔴 **markdown 消息的 `at` 列表单独放着是不生效的 —— 正文里必须出现 `@<userid>` 那个串**
 * （2026-08-17 真群实测：只有 `at.atUserIds` 的那条没 @ 到人，
 * 正文补上 `@<id>` 的和纯 text 类型的都 @ 到了，§2.52⑥）。
 *
 * 这件事在异步补发那条腿上是承重的，不是装饰：回答可能是一分钟后才回到群里，
 * **问的人早就划走了** —— 没有 @ 就等于没有通知，那条回答会安静地沉在聊天记录里。
 *
 * 拼在**末尾**：`renderReceipt` 的正文是 `#### …` 开头的，@ 串放前面会把标题行吃掉。
 */
const mentionOf = (sender?: string): string => (sender ? `\n\n@${sender}` : '');

export const md = (text: string, sender?: string): DingMessage => {
  const mention = mentionOf(sender);
  return {
    msgtype: 'markdown',
    // 🔴 先按「上限 - @ 那一行」截断再拼 —— 反过来的话超长消息会把 @ 串截掉，
    //    而越长的回答越是当事人已经不在看的那种。
    markdown: {
      title: TITLE,
      text: clampText(text, MAX_TEXT_BYTES - Buffer.byteLength(mention, 'utf8')) + mention,
    },
    ...(sender ? { at: { atUserIds: [sender], isAtAll: false } } : {}),
  };
};

/**
 * 这个投递口是「连接平台的流程 webhook」还是「群自定义机器人」。
 *
 * 两者的报文形状不一样，而**一个群配哪一种是 per-row 的事**
 * （`channel_conversation.webhook_url`）—— 所以判据只能长在 URL 上，
 * 不能是一个全局开关。
 */
export const isFlowWebhook = (url: string): boolean =>
  /^https:\/\/connector\.dingtalk\.com\/webhook\/flow\//i.test(String(url ?? '').trim());

/**
 * 出站报文（两条腿共用）。
 *
 * · 自定义机器人：原样发这条消息，它就是钉钉机器人 API 的报文。
 * · 流程 webhook：包一层 `{keyword, ding}` ——
 *   `keyword` 让触发器的关键词过滤放行（它扫整个 body），
 *   而**关键词不会出现在群里那条消息上**；
 *   `ding` 这个键名是和流程里那段代码节点的契约（`body.get("ding")`，
 *   `docs/dingtalk-api.md` §1.2 一直是这个形状，入站响应也是它）。
 */
export const outboundBody = (ding: DingMessage, webhookUrl: string): unknown =>
  isFlowWebhook(webhookUrl) ? { keyword: env.channelFlowKeyword, ding } : ding;


/**
 * 同步 ack。`degraded` = 这个群还没配出站 webhook —— 不许假装稍后有回执。
 * D127 之后 ack 要说清「转给了谁」（维护者：用户不需要知道背后是哪个 Agent 在工作，
 * 但要立即知道消息被接走了、去了哪条线）。
 */
export const renderAck = (sender: string, degraded: boolean): DingMessage =>
  md(
    degraded
      ? // 🔴 没有出站 webhook = 汇报发不出来 = **不会自动入库**（D143：发送成功才开始倒计时）
        `**已接收** · 转给速记（新记录）\n这个群还没配回执机器人：汇报发不回来，也不会自动入库。结果去 PWA 看` +
          (env.captureUrl ? `：${env.captureUrl}` : '。')
      : '**已接收** · 转给速记（新记录）\n整理完会汇报：内容够完整就倒计时后自动入库，期间可撤回。',
    sender,
  );

export const renderHelp = (sender: string): DingMessage =>
  md(
    '#### RV 助手 · 用法\n' +
      (env.routerEnabled
        ? '@我 一句话，自动分给背后的助手：\n' +
          '- **说事实**（拜访了谁、客户想要什么、进展）→ 速记，整理成 CRM 记录\n' +
          '- **提问题**（参数、选型、价格、文档）→ 实验室助手，答案稍后发回群里\n' +
          '- **其他**（测试、翻译、顺手帮个忙）→ 日常助手直接回\n' +
          '分错了就在开头写「记：」或「问：」强制指定。\n'
        : '@我 一句话，整理成 CRM 记录（客户、产品、进展说全）。\n') +
      '**入库**：汇报说「待入库」的，倒计时后自动写入 CRM；倒计时内点汇报里的「撤回」可取消。\n' +
      '**修改**：@我 #编号 + 修改内容；或回答汇报里的问题（30 分钟内直接说）；或「更正 …」改你上一条（2 小时内）。\n' +
      '**命令**：「待办」看未入库的 ·「#编号」重看一条 ·「入库 #编号」按原样入库。\n' +
      '我**只能看到 @我 的这一条**，前面的聊天我看不见。',
    sender,
  );

/** 幂等命中：复述现状，不重录。 */
export const renderDuplicate = (sender: string, status: string): DingMessage =>
  md(
    status === 'confirmed'
      ? '这条我已经收过了，而且已经入库。'
      : '这条我已经收过了，正在处理，不再重复记录。',
    sender,
  );

/** 网关侧兜底错误 —— 永远 HTTP 200 + 一条给人看的消息，不把话语权交给流程的报错分支。 */
export const renderError = (detail: string): DingMessage =>
  md(`**未处理**：网关这边出了问题（${detail.slice(0, 80)}），这条先没记上。稍后再试或找 维护者。`);
