import { env, sql } from './host.ts';

/**
 * 一句话标题 —— 让速记列表能扫（issue #15）。
 *
 * 维护者 2026-08-05：「当录音完成之后，自动开始转录，**自动生成标题**，
 * 点开 tab 之后，可以查看转录全文」。
 *
 * ── 这个文件唯一需要想清楚的性质 ────────────────────────────────────
 *
 * 🔴 **标题是装饰，转写是资产。** 所以这里每一条路径都通向「有个标题」，
 * 没有任何一条通向「抛异常」：模型没配、超时、返回了看不懂的东西、
 * 网关和 OpenAI 之间断了 —— 全部退回启发式，转写照常落库。
 *
 * 判据和 D61③ 一样：为一个标题把不可再生的录音挡在门外，那才是真事故。
 * 也是 `industryTerms()` 那次教训的反面 —— 它的 catch 分支**静默**退回空数组，
 * 于是「词表没进镜像」整整一天没人发现（7e9e5df）。所以这里退回时要说出来。
 */

/** 模型不可用时的兜底。**纯函数，有测试** —— 它是最后一道，不能也出错。 */
export const heuristicTitle = (text: string, max = 18): string => {
  const flat = String(text ?? '')
    // markdown 的记号不该进标题：`## 车辆与合同` 应该是「车辆与合同」
    .replace(/[#*_>`~]|\[|\]|\(|\)/g, ' ')
    .replace(/\s+/g, ' ')
    // 记号换成空格之后会留下「紧急 ：电池不充电」这种缝 —— 标点前面的空格收掉
    .replace(/\s+([，。！？：；、,.!?:;）】」』])/g, '$1')
    .trim();
  if (!flat) return '';
  // 第一个句末标点之前的那一段。中英文标点都算，换行也算。
  const first = flat.split(/(?<=[。！？!?；;])|(?<=\. )/)[0]?.trim() || flat;
  const body = first.length <= max ? first : `${first.slice(0, max)}…`;
  // 句末标点留在标题里很难看 —— 「他们想换供应商。」→「他们想换供应商」
  return (
    body
      .replace(/[。！？!?，,；;、\s]+$/, '')
      // ⚠️ 英文句号单独处理，而且**数字后面的不动** ——
      //    「They want to switch.」要去掉，「规格书 v1.0」不能变成「规格书 v1」。
      .replace(/(?<!\d)\.+$/, '')
  );
};

/** 一次 Responses API 调用，带超时。任何异常都由调用方兜底。 */
const askModel = async (text: string, signal: AbortSignal): Promise<string> => {
  const res = await fetch(`${env.openaiBaseUrl}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.openaiKey}`,
      'Content-Type': 'application/json',
    },
    signal,
    body: JSON.stringify({
      model: env.titleModel,
      /**
       * 🔴 走 **Responses API**，和 agent 那条链一样（runtime.ts 里那段注释）：
       * 这个模型在 `/chat/completions` 上有已知的限制，而两条路都用同一个
       * 端点意味着「模型换了」只需要验一次。
       */
      input: [
        {
          role: 'system',
          content:
            '你给房车行业的现场销售速记起标题。要求：' +
            '① 不超过 16 个汉字；② 只概括原文已经说了的事，绝不补充、不推测；' +
            '③ 不要引号、不要句号、不要「关于」这类开头；' +
            '④ **绝对不要出现任何自然人姓名**（合规要求），公司名和产品名照写；' +
            '⑤ 只输出标题本身，不要任何解释。',
        },
        { role: 'user', content: text.slice(0, 4000) },
      ],
      // 推理模型会先花掉一部分额度想事情，给太小会返回空 —— 给够，反正输出很短
      max_output_tokens: 512,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json: any = await res.json();

  /**
   * ⚠️ 防御性地解析。Responses API 的返回里正文可能在两个地方，
   * 而**拿不到就该退回启发式，不该抛出去** —— 上面那层会 catch，
   * 但在这里把两种形状都试一遍，能少一次没必要的退化。
   */
  const direct = typeof json?.output_text === 'string' ? json.output_text : '';
  const walked = (json?.output ?? [])
    .flatMap((o: any) => o?.content ?? [])
    .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
    .join('');
  return String(direct || walked).trim();
};

/** 模型给的标题也要收一道 —— 它有时候会带引号、带句号、带「标题：」。 */
const tidy = (raw: string, max = 18): string =>
  heuristicTitle(
    raw
      .replace(/^\s*(标题|title)\s*[:：]\s*/i, '')
      .replace(/^["'「『“”]+|["'」』“”]+$/g, '')
      .split('\n')[0] ?? '',
    max,
  );

/**
 * 生成标题。**永不抛异常** —— 拿不到就给启发式的那个。
 *
 * @param text 转录或原文。空字符串直接返回空（没内容就没标题，不去编一个）。
 */
export const makeTitle = async (text: string, timeoutMs = 12_000): Promise<string> => {
  const fallback = heuristicTitle(text);
  if (!fallback) return '';
  // 本来就短的不用花这一次调用 —— 一句话速记它自己就是标题
  if (fallback.length <= 12 && !/[。！？!?\n]/.test(text.trim().slice(0, 40))) return fallback;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const t = tidy(await askModel(text, ctl.signal));
    return t || fallback;
  } catch (e) {
    // 🔴 **说出来。** 静默退化正是 7e9e5df 那个 bug 的形状：
    //    功能看起来在（有标题），而它想解决的问题原封不动地还在（标题是截断的）。
    console.warn(`  · 标题生成失败，退回首句：${(e as Error).message.slice(0, 160)}`);
    return fallback;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 把标题写进 `staging.title`。**已经有标题的不覆盖** ——
 * 人如果改过正文、我们又重新生成，会把他看惯的那一条悄悄换掉。
 */
export const ensureTitle = async (inboxId: string, text: string): Promise<void> => {
  const [cur] = await sql<Array<{ title: string | null }>>`
    select title from staging where inbox_id = ${inboxId}`;
  if (cur?.title) return;
  const title = await makeTitle(text);
  if (!title) return;
  await sql`update staging set title = ${title} where inbox_id = ${inboxId}`;
};
