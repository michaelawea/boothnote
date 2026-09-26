import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { env } from './host.ts';
import { ROOT_DIR } from '../../src/env.ts';

/**
 * 转写。**跑在 agent 之外**（D46b，维护者 2026-08-03）。
 *
 * 分界是：agent 的输入类型只有一个 —— 字符串。音频在到它手里之前就已经是文字了。
 * 这条分界买到三件事：
 *   ① agent 的单元测试只要喂字符串，不用准备音频 fixture；
 *   ② 转写失败是**预处理**阶段的错，不会把 agent 那一轮拖垮；
 *   ③ 换转写模型不碰 agent 一行代码 —— 就是这个文件。
 *
 * 🔴 **`prompt` 里必须喂真实品牌名，这不是可选项。** 实测（2026-07-31）：
 *   不带 prompt → "the **Rozenfelt** line"（Rosenfeld 被听错）
 *   带  prompt → "the **Rosenfeld** line" ✅，连 "Jeff"→"Just" 都纠回来了
 * 品牌名听错 = 归属认错，是这条链路上最贵的错误。
 */
// ── 行业词表（issue #15）───────────────────────────────────────────
/**
 * `data/stt-terms.json` —— 协议名、型号、行业术语。**改词表不发版。**
 *
 * 为什么需要它（维护者 2026-08-05）：之前喂给转写的是
 * `listCompanies() + listSuppliers()` 的名字**前 60 个** —— 全是公司名。
 * 而现场说得最多、也最容易被听错的是**协议名和型号**：
 * CI-Bus 会变成 "sea bus"，VLI1230RCH 基本必错 —— 这些一个都没进过 prompt。
 *
 * 为什么做成数据文件：现场发现「CI-Bus 又被听错」的时候，能改的人是 维护者，
 * 而他手上不该需要一次构建 + 一次部署。和 `data/intel-items.json` 同一个套路（D62）。
 */
let termsCache: string[] | null = null;
export const industryTerms = (): string[] => {
  if (termsCache) return termsCache;
  try {
    const raw = JSON.parse(readFileSync(join(ROOT_DIR, 'data', 'stt-terms.json'), 'utf8'));
    termsCache = Object.entries(raw)
      .filter(([k, v]) => !k.startsWith('_') && Array.isArray(v))
      .flatMap(([, v]) => v as string[])
      .map((s) => String(s).trim())
      .filter(Boolean);
  } catch (e) {
    /**
     * 词表读不到**不该让转写整个挂掉** —— 降级成「只喂品牌名」，那是原来的行为。
     *
     * 🔴 但它必须**吵**。2026-08-05 部署实测：`data/` 在 `.dockerignore` 里，
     * 于是 `data/stt-terms.json` 根本没进镜像，容器里读到 0 条 ——
     * 而降级是静默的，转写照常返回，**看起来一切正常**。
     * 这正是这个仓库反复踩的形状（D65 / D66 / issue #17 的根因 A）：
     * 一步静默地什么都没做，而上面一路绿到「完成」。
     *
     * 修法是 compose 里那行 `./data/stt-terms.json:/data/stt-terms.json:ro`，
     * 外加启动横幅打出词条数（见 index.ts）—— 0 就一眼看得出来。
     */
    console.warn(
      `  🟠 读不到转写词表（${join(ROOT_DIR, 'data', 'stt-terms.json')}）：` +
        `${(e as Error).message.slice(0, 120)}\n` +
        '     转写会退回「只喂品牌名」—— 协议名和型号（CI-Bus / VLB12150-CIBUS）会明显更容易听错。\n' +
        '     容器里跑的话：docker-compose.yml 的 gateway.volumes 要有 ./data/stt-terms.json 那一行。',
    );
    termsCache = [];
  }
  return termsCache;
};

/**
 * 喂给转写的词表：**行业词在前，品牌名在后，总数收在 40 个以内**。
 *
 * ⚠️ 规划文档 §2 那条实测：品牌名 prompt 偏置在 12/20/30/56 个品牌下**非单调** ——
 * 它是噪声不是阈值。所以这里不是「越多越好」，而是**按相关度取**。
 * 原来的 `brands.slice(0, 60)` 正好落在那条噪声曲线上，而且挤掉了行业词。
 */
export const buildTermList = (brands: string[], limit = 40): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...industryTerms(), ...brands]) {
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
};

/**
 * ── 可选参数：怎么编码，以及被拒时怎么退（issue #19 · D85 · 2026-08-07）──
 *
 * 🔴 **这一段是「生产上语音 100% 不可用」的根因，编码和探测两处都错了。**
 *
 * ① **编码错了。** `multipart/form-data` 里**没有数组这种类型** ——
 *    数组只能写成**重复字段**（`languages=en&languages=de`）。
 *    原来是 `form.append('languages', JSON.stringify([...]))`，
 *    那一串被当成**一个非法的单值**，接口回 400，**每一段录音都失败**。
 *
 *    坑在哪：官方用法是 Python SDK 的 `extra_body={"languages": [...]}`，
 *    那是 **JSON 语义**；这里是手写 multipart，两者对数组的编码规则不一样。
 *    **翻译丢在了这一步，而它不会在启动时报错，要等现场第一次录音才 400。**
 *
 * ② **探测判据也是猜的，而且猜错了。** 原来靠正则去认 400 报文里有没有
 *    `keywords|languages|unknown parameter|...`。2026-08-07 用生产上那段真音频
 *    逐个参数试出来，对面回的是：
 *      `{"error":{"message":"Invalid request.","code":"invalid_value","param":null}}`
 *    —— **一个关键词都不匹配，`param` 还是 null。** 于是设计好的降级
 *    **一次都没触发过**，每条录音直接抛错。
 *
 *    🔴 **判据：报文长什么样是对方说了算的，「去掉可选参数再试一次」是我们说了算的。**
 *    所以现在**不认报文，只看状态码**（状态码是契约，报文是散文）。
 *
 * 同一轮实测还有一件反直觉的事，它决定了下面这些名字怎么起：
 *   **乱编一个参数名（`definitely_not_a_real_param`）也回 200** ——
 *   未知参数被静默忽略。所以 **200 只证明「没被拒」，不证明「生效了」**。
 *   下面这个三态叫 `accepted` 而不是 `supported`，就是这个原因；
 *   `keywords` 到底有没有被解析，只能靠有/无对照的识别效果来验（见 `scripts/stt-eval.mjs`）。
 */
export type OptionalParam = 'keywords' | 'languages';

/**
 * **丢弃顺序**：越靠前越先被丢掉。
 *
 * 🔴 顺序不是随手排的 —— 原来的降级是**两个一起丢**，而实测 `keywords` 是好的，
 * 于是就算降级触发了也白丢一半红利（issue #19 建议③）。
 * `languages` 排在前面是因为它是已知会被拒的那个：真出事时第一次重试就能成，
 * `keywords` 一次都不会被牵连。
 */
export const OPTIONAL_PARAMS: OptionalParam[] = ['languages', 'keywords'];

/** null=还没试过 · true=对面收下了（**不等于生效**）· false=试过，被拒。 */
let accepted: Record<OptionalParam, boolean | null> = { keywords: null, languages: null };
export const optionalParamState = (): Record<OptionalParam, boolean | null> => ({ ...accepted });
/** 测试注入用。 */
export const __setOptionalParams = (v: Partial<Record<OptionalParam, boolean | null>>): void => {
  accepted = { keywords: null, languages: null, ...v };
};

/**
 * 这个状态码值不值得「丢个参数再试一次」。
 *
 * 4xx 里挖掉三个：**401/403 是凭据问题、429 是限流** —— 这三种含义明确，
 * 少发个参数一点忙都帮不上，而多打两次请求在限流时是**帮倒忙**。
 * 剩下的 4xx 一律当成「我们发的内容对面不认」，逐个退。
 * ⚠️ 这里判的是**状态码**（契约），不是报文（散文）—— 那正是 ② 踩的坑。
 */
export const narrowsOn = (status: number): boolean =>
  status >= 400 && status < 500 && ![401, 403, 429].includes(status);

const post = async (form: FormData): Promise<{ ok: boolean; status: number; text: string }> => {
  const res = await fetch(`${env.openaiBaseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.openaiKey}` },
    body: form,
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
};

/**
 * 现在该带哪些可选参数（被拒过的不再带）。
 * 每次调用都重新算 —— 探测结果是**进程级记忆**，重启网关 = 重新探测。
 */
export const enabledParams = (): Set<OptionalParam> =>
  new Set(OPTIONAL_PARAMS.filter((p) => accepted[p] !== false));

export const buildForm = (
  audio: Buffer,
  mime: string,
  filename: string,
  terms: string[],
  enabled: Set<OptionalParam>,
): FormData => {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), filename);
  form.append('model', env.transcribeModel);
  /**
   * 整体业务背景 + 预计出现的专有名词。
   * 背景那一段比单纯罗列名词有用：模型得先知道「这是一段房车行业的技术讨论」，
   * 才知道听到的 "sea bus" 应该是 "CI-Bus"。
   */
  form.append(
    'prompt',
    'This is a technical field note about European motorhomes, caravans, batteries, ' +
      'inverters, solar systems and RV communication protocols. ' +
      'Brand, product and protocol names must retain their official spelling. ' +
      `Expected terms: ${terms.join(', ')}.`,
  );
  // 🔴 数组 = 重复字段。**一个 append 一个值**，绝不 JSON.stringify（见本段开头 ①）
  if (enabled.has('keywords')) for (const t of terms) form.append('keywords', t);
  if (enabled.has('languages')) {
    /**
     * 展会现场是德/英/意混杂 —— 给一个**候选集合**。
     * 🔴 仍然不传单一的 `language`：指定一种会让另外两种明显变差，
     * 那比听错品牌名退步更大（缺口 #4 的结论没变，只是现在能给集合了）。
     */
    for (const l of ['en', 'de', 'it', 'fr', 'zh']) form.append('languages', l);
  }
  return form;
};

/**
 * 发一次；被拒就**逐个丢掉可选参数**再发，直到只剩最小参数集。
 *
 * 抽出来收 `send` 这个回调，是为了能在**没有网络**的单元测试里断言退法
 * —— 原来那套探测在仓库里躺了两天没被执行过，而它恰恰是唯一一条
 * 「猜错了要到展会现场才知道」的代码。
 *
 * 🔴 **全都试完还是失败，就不动状态。** 那多半是音频本身有问题
 * （或者 key 过期），而不是参数 —— 让一条坏音频把 `keywords` 永久关掉，
 * 是拿一次故障换一整场展会的识别质量。
 */
export const sendWithFallback = async (
  send: (enabled: Set<OptionalParam>) => Promise<{ ok: boolean; status: number; text: string }>,
  state: Record<OptionalParam, boolean | null> = accepted,
): Promise<{ ok: boolean; status: number; text: string; dropped: OptionalParam[] }> => {
  const enabled = new Set(OPTIONAL_PARAMS.filter((p) => state[p] !== false));
  const dropped: OptionalParam[] = [];

  let r = await send(enabled);
  while (!r.ok && narrowsOn(r.status) && enabled.size) {
    const drop = OPTIONAL_PARAMS.find((p) => enabled.has(p))!;
    enabled.delete(drop);
    dropped.push(drop);
    console.warn(
      `  · 转写被拒（${r.status}）—— 丢掉 ${drop} 再试一次` +
        `${enabled.size ? `（还带着 ${[...enabled].join('/')}）` : '（只剩最小参数集）'}`,
    );
    r = await send(enabled);
  }

  if (r.ok) {
    // 丢掉之后才成功 → 丢掉的那些确实不被接受，记下来，下一条录音一次就过
    for (const p of dropped) state[p] = false;
    // ⚠️ `true` 只表示**没被拒**。未知参数也回 200（见本段开头），所以别读成「生效了」
    for (const p of enabled) if (state[p] === null) state[p] = true;
  }
  return { ...r, dropped };
};

export const transcribe = async (
  audio: Buffer,
  mime: string,
  filename: string,
  brands: string[] = [],
): Promise<string> => {
  const terms = buildTermList(brands);
  const r = await sendWithFallback((enabled) => post(buildForm(audio, mime, filename, terms, enabled)));

  if (!r.ok) {
    // ⚠️ 状态码留在消息里 —— `loop.ts` 的 `transient()` 靠它分「上游抖一下」和「这条永远会失败」
    const tried = r.dropped.length ? `（已逐个丢掉 ${r.dropped.join('/')} 重试过）` : '';
    throw new Error(`转写失败 ${r.status}${tried}: ${r.text.slice(0, 300)}`);
  }
  return (JSON.parse(r.text).text ?? '').trim();
};

/**
 * ── 启动自检：**现在踩下去会不会响**（issue #19 建议⑤）───────────────
 *
 * 🔴 为什么非要有它：`smoke.sh` 读的 `agentHealth().lastError` 天然滞后 ——
 * 它要等**已经有人处理失败过**才有值。08-07 上午那次部署，这一项是空的
 * （当时还没人录音），一路绿灯；直到下午 维护者 录了那段语音才有 warn。
 * **也就是说那个检查只能在第一段录音已经丢了之后才开口，
 * 而在展会现场，第一段录音丢掉就是最贵的那一次。**
 *
 * 两个信号问的不是同一个问题：
 *   · `lastError`：「**已经**有人踩雷了吗」—— 事后
 *   · 这个自检：  「**现在**踩下去会不会响」—— 事前
 *
 * 实测（2026-08-07）：**它能抓到这次这个 bug** —— 同一段 844 字节静音，
 * 用坏编码发是 400，用重复字段发是 200。
 *
 * ⚠️ 它**故意走 `sendWithFallback`**（而不是发一次看结果就算）：
 * 真出事时自检这一次就把状态探明白了，现场第一条录音一次就过，
 * 不用自己再付一轮重试。用的是一段合成的静音，没有任何真实数据的风险。
 */
export type SelfTest = {
  status: 'ok' | 'degraded' | 'failed' | 'skipped';
  /** 被拒、已经关掉的可选参数。 */
  dropped: OptionalParam[];
  detail: string;
  at: string;
};

/**
 * 一段静音 WAV。**在代码里现算，不放文件** ——
 * `data/` 在 `.dockerignore` 里（见本文件上面词表那段的教训），
 * 一个「镜像里可能不存在」的自检文件，本身就是下一个静默降级。
 */
export const silentWav = (seconds = 0.25, rate = 8000): Buffer => {
  const bytes = Math.round(rate * seconds) * 2; // 单声道 16bit
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + bytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // 单声道
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(bytes, 40);
  return Buffer.concat([h, Buffer.alloc(bytes)]);
};

let lastSelfTest: SelfTest | null = null;
export const selfTestState = (): SelfTest | null => lastSelfTest;

export const selfTestTranscribe = async (): Promise<SelfTest> => {
  const at0 = new Date().toISOString();
  // 关掉时也**留下一个状态**，别让 health 里是 null —— 「关了」和「还没跑完」
  // 是两件事，冒烟要能分开（同 D84⑤：`offline` 和 `latest` 绝不合并）
  if (!env.transcribeSelfTest) {
    lastSelfTest = { status: 'skipped', dropped: [], detail: 'TRANSCRIBE_SELFTEST=0', at: at0 };
    return lastSelfTest;
  }
  const wav = silentWav();
  const terms = buildTermList([]);
  const at = new Date().toISOString();
  try {
    const r = await sendWithFallback((enabled) =>
      post(buildForm(wav, 'audio/wav', 'selftest.wav', terms, enabled)),
    );
    lastSelfTest = r.ok
      ? {
          status: r.dropped.length ? 'degraded' : 'ok',
          dropped: r.dropped,
          detail: r.dropped.length ? `接口不认 ${r.dropped.join('/')}，已关掉这些参数` : '转写链路通',
          at,
        }
      : { status: 'failed', dropped: r.dropped, detail: `HTTP ${r.status}: ${r.text.slice(0, 160)}`, at };
  } catch (e) {
    // 网络不通也算失败，但**绝不能把网关带崩** —— 自检是诊断，不是前置条件
    lastSelfTest = { status: 'failed', dropped: [], detail: (e as Error).message.slice(0, 160), at };
  }
  return lastSelfTest;
};

/**
 * `describeImage()` 在这里待过（图片 → 200 字中文转述，走 chat/completions）。
 * D71 删了：图片现在**原样**喂给模型（input_image，attachments.ts 分类、
 * runtime.ts 递交），比转述保真得多；它还是全库唯一残留的旧端点调用。
 * 超过大小门槛的图不再烧一次视觉调用换转述 —— 只记文件名（降级路径）。
 */
