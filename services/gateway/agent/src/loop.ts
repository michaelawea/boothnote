import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sql } from './host.ts';
import { env } from './host.ts';
import { listCompanies, listSuppliers, listThreadItems, hasProposalItems, persistAgentReply, reconcilePendingQuestionItems, loadLegacyDispositionSource } from './host.ts';
import {
  markExtsUnsupported,
  prepareAttachments,
  rejectsInputFile,
  type PreparedAttachments,
} from './attachments.ts';
import { systemPrompt } from './prompt.ts';
import { committedBase, hasRecordProposal } from './inherit.ts';
import { loadPlaybooks } from './skills.ts';
import {
  keepThinking,
  appendThreadHistory,
  loadThreadHistory,
  resetThreadSession,
  runAgent,
  type ModelBinding,
  type RunResult,
} from './runtime.ts';
import { buildSkills, newContext, type SkillContext } from './tools/index.ts';
import { ensureTitle } from './title.ts';
import { transcribe, selfTestState } from './transcribe.ts';

/**
 * 后台处理链：**预处理（转写 / 解析附件）→ agent → staging**。
 *
 * 取代了原来的 `pipeline.ts` + `ai.ts`。两个性质一个字没变：
 *
 *   1. **任何一步炸了，inbox 那条原文都还在。** staging 标 failed + error，可重跑。
 *      这是「三段解耦」的服务端一半 —— 展会现场 OpenAI 挂了、余额没了、网断了，
 *      采集照常，只是抽取延后。
 *   2. 量级是一天几十条，不值得上 BullMQ —— 进程内串行 + 失败重跑就够。
 *
 * 新增的性质是 D46b 那条分界：**转写和附件解析跑在 agent 之外**，
 * 到 `runAgent` 手里的时候，输入已经是一个字符串。
 */
/**
 * 队列里的一件活。
 *
 * `agentRun: false` = **只转写，不跑 agent**（issue #15）。
 *
 * 2026-08-05 之前不存在这种活，后果是：**速记页录的音一个字都没被转写过**。
 * `transcribe()` 只在 `process_()` 里被调用，而 `process_` 只有 `enqueue()`
 * 才触发，`enqueue()` 的唯一入口是 `POST /inbox` 里的 `if (toAgent)` ——
 * 而速记页按 D31 就是不带 `toAgent` 的。
 * 于是那条卡片上永远是「🎙 12秒 语音」：不是转录还没回来，是**从来没开始过**。
 *
 * D31（抽取是显式触发）说的是**别自动烧抽取那一轮**，不是「别转写」。
 * 转写是把不可再生的资产变成可读的文字，它本来就该无条件发生。
 */
type Job = { id: string; agentRun: boolean };
const queue: Job[] = [];
let draining = false;
/**
 * **这个进程建过几轮 `agent_run`。** 只有一个用途：`reapStaleRuns()` 的前提判据 ——
 * 收尸的正确性完全建立在「此刻库里 `running` 的行没有一行是我建的」之上，
 * 而那件事只有这个计数器答得准（比「按时间戳掐一刀」准，也不怕两个容器的钟差）。
 */
let runsCreated = 0;
let lastError: string | null = null;
let lastFinishedAt: string | null = null;
let processed = 0;

/** 测试注入用：把模型换成 faux，不发网络请求。 */
let bindingOverride: ModelBinding | undefined;
export const __setBinding = (b: ModelBinding | undefined) => {
  bindingOverride = b;
};

/**
 * 测试注入用：假装这个进程已经建过 n 轮 —— 验 `reapStaleRuns()` 的位置守卫。
 * 那个守卫是这次修复里唯一「错了也不报错」的一格：它挡的是**代码被挪动**，
 * 而挪动这件事在运行时长得和正常一模一样，只能靠这里假造出来测。
 */
export const __setRunsCreated = (n: number) => {
  runsCreated = n;
};

/**
 * ── 能被叫停的那些活（D89 · issue #22）─────────────────────────────
 *
 * key = inboxId。**登记时机是 `enqueue()` 那一刻，不是开跑那一刻** ——
 * 队列是串行的，前面积压两条时后面这条要等好一会儿才开跑，
 * 而人在那段时间里点的停止**必须算数**。只在开跑时登记的话，
 * 那几秒里的停止会静默失效，然后它照样跑完 —— 「点了没反应」比没有按钮更糟。
 *
 * 生命周期：`push()` 建（已 abort 的换新的）→ `drain()` 跑完删 →
 * 临时故障重排时 `push()` 再建一个新的。
 */
const cancellable = new Map<string, AbortController>();

/** 入队的唯一入口 —— 顺手保证「跑 agent 的活都有一个能叫停的把手」。 */
const push = (job: Job) => {
  if (job.agentRun) {
    const cur = cancellable.get(job.id);
    // 已经 abort 过的那个不能复用：复用等于这一轮一开跑就被自己停掉
    if (!cur || cur.signal.aborted) cancellable.set(job.id, new AbortController());
  }
  queue.push(job);
};

/**
 * 叫停一条正在跑（或还在排队）的 agent 活。
 *
 * 返回 true = 真的递进去了一个停止信号；false = 这条已经不在我们手里
 * （跑完了、或者从来没排过）。**调用方要如实把这个布尔值说出去** ——
 * 「点了停止但其实什么都没停」是这个仓库最贵的那类 bug 的形状。
 */
export const abortInbox = (inboxId: string): boolean => {
  const c = cancellable.get(inboxId);
  if (!c || c.signal.aborted) return false;
  c.abort();
  console.log(`  ⏹ 收到叫停：${inboxId}`);
  return true;
};

/**
 * 消息史的落点。**只有这里知道它在哪** —— 网关那边改口重发时要归档它（D90），
 * 但不该跟着记住 `audioDir/agent-sessions` 这个布局。
 */
const sessionsDirOf = () => join(env.audioDir, 'agent-sessions');

/**
 * 人改口重发时，把这条对话的消息史归档（D90 · issue #23）。
 * 归档之后下一轮从零开始 —— 被撤回的那句话不会再被灌回模型。
 */
export const forgetThreadHistory = (threadId: string) =>
  resetThreadSession(sessionsDirOf(), threadId);

/** 跑完整一轮：转写 → 读附件 → agent → staging。人**显式**要过才走这条（D31）。 */
export const enqueue = (inboxId: string) => {
  push({ id: inboxId, agentRun: true });
  void drain();
};

/**
 * 只转写（issue #15）。速记页每条带音频的都走这条。
 *
 * 不跑 agent、不解析附件、不建 `agent_run`、不动 `status` ——
 * 它只做一件事：把音频变成 `staging.transcript`。
 * 人事后点「发给 AI」时，`process_` 看到 transcript 已经有了就跳过转写，
 * **不会重复烧钱**。
 */
export const enqueueTranscribe = (inboxId: string) => {
  push({ id: inboxId, agentRun: false });
  void drain();
};

export const agentHealth = () => ({
  enabled: env.agentEnabled,
  queued: queue.length,
  draining,
  processed,
  lastFinishedAt,
  lastError,
  model: env.extractModel,
  /**
   * 🔴 **思考档位要露在 health 里**（D125）。它是那种「配错了完全不报错、
   * 只是答得差」的配置 —— 2026-08-17 之前它一直是 `none`（思考关着）而
   * 没有任何一个地方看得出来。现在冒烟和横幅都看得到。
   */
  reasoning: keepThinking(env.agentReasoning) ?? 'none',
  transcribeModel: env.transcribeModel,
  /**
   * 转写链路的**事前**信号（issue #19 建议⑤/⑥）。
   *
   * 🔴 它和上面那个 `lastError` 问的不是同一个问题：
   *   · `lastError` —— 「**已经**有人踩雷了吗」，要等第一段录音丢掉之后才有值；
   *   · 这一项    —— 「**现在**踩下去会不会响」，网关一起来就有答案。
   * `smoke.sh` 拿它当**硬门槛**（bad，不是 warn）。
   */
  transcribeSelfTest: selfTestState(),
  maxSteps: env.agentMaxSteps,
  timeoutMs: env.agentTimeoutMs,
});

/** 一条记录最多被自动重跑几次。超了就得人来看一眼。 */
const MAX_ATTEMPTS = 3;

/**
 * 这个错值不值得再试一次。
 *
 * ⚠️ **宁可漏判也别错判**：把「模型说这条输入有问题」当成临时故障去重试，
 * 就是每次重启烧一遍钱（那正是 attempts 预算要挡的事）。
 * 所以这里只列**明确是对面/网络的**那几种。
 */
export const transient = (msg: string) =>
  /overload|rate.?limit|too many requests|\b(429|500|502|503|504)\b|timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up/i.test(
    msg,
  );

const drain = async () => {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const { id, agentRun } = queue.shift()!;
      try {
        if (agentRun) await process_(id, cancellable.get(id)?.signal);
        else await transcribeOnly(id);
      } catch (e) {
        const msg = (e as Error).message.slice(0, 500);
        lastError = msg;
        console.error(`  ✗ 处理 ${id} 失败：${msg}`);
        // attempts +1：`resumePending` 只捡还有预算的那些，
        // 于是「上游抖一下」能自愈，「这条永远会失败」不会每次重启都再烧一次模型
        const [row] = await sql<Array<{ attempts: number }>>`
          update staging set status = 'failed', error = ${msg},
            attempts = attempts + 1 where inbox_id = ${id} returning attempts`;

        /**
         * 🔴 **上游抖一下不该让这条记录停到下次重启。**
         *
         * 2026-08-04 实测撞到：`Our servers are currently overloaded. Please try again later.`
         * —— 模型端的临时故障，agent 直接标 failed 就不管了。
         * 而现场那句话是不可再生的资产，它只是等一会儿就能成功。
         *
         * 所以临时故障**当场排回队尾**（还有预算的话），永久故障不排 ——
         * 靠 `transient()` 分开，不靠「反正都重试一遍」。
         */
        const willRetry = transient(msg) && (row?.attempts ?? MAX_ATTEMPTS) < MAX_ATTEMPTS;
        if (willRetry) {
          const wait = 2000 * 2 ** ((row?.attempts ?? 1) - 1); // 2s → 4s → 8s
          console.log(`     ↻ 看着像临时故障，${wait / 1000}s 后再试一次（第 ${row?.attempts} 次）`);
          setTimeout(() => {
            // 排回去的还是**同一种活** —— 只转写的失败了不该升级成跑一整轮 agent
            push({ id, agentRun });
            void drain();
          }, wait).unref?.();
        }
        // ⚠️ 别把 running 那一行留在库里 —— 前端会永远转圈，而实际上早就死了
        await sql`update agent_run set status = 'failed', stage = ${'出错了'}, error = ${msg}
                  where inbox_id = ${id} and status = 'running'`.catch(() => {});

        /**
         * 🔴 **失败必须走到人眼前**（issue #19 第③条）。
         *
         * 之前这里只写库：`staging.status='failed'` + `error` 全文都在，
         * **而 `thread_message` 里一条都没有** —— 于是手机上那个「正在处理中」
         * 的乐观气泡在等一条**永远不会来的消息**，界面停在转圈，永远不动。
         * 维护者 2026-08-07 撞上的就是这个：数据一条没丢，
         * 但**没有任何一条路径能把「它失败了」送到用户眼前**。
         *
         * 判据（这个仓库反复踩的那一条的镜像）：
         * **界面绿色而东西没进去很糟；界面转圈而事情早就结束了，一样糟** ——
         * 后者更阴，因为人会一直等下去，而现场那句话正在变凉。
         *
         * ⚠️ 只对**有对话**的那些插消息（AI 那一屏发的）。速记页录的没有 thread，
         * 它那一半靠 `GET /inbox` 带出 `status`/`error`（#21②）。
         *
         * ⚠️ **还要重试的不插。** 上游抖一下 2 秒后就好了，
         * 那条「没处理成功」会永久留在对话里 —— 说了一句当时是真、之后就是假的话。
         */
        const [t] = willRetry
          ? []
          : await sql<Array<{ thread_id: string | null }>>`
              select thread_id from inbox where id = ${id}`;
        if (t?.thread_id) {
          const say = /转写失败/.test(msg)
            ? '这段录音没转出来。🔴 **音频已经存好了，不会丢** —— 可以在速记页重试转写，或者直接把要点打出来。'
            : '这一条没处理成功。原文和附件都还在，可以重试；定个客户照样能入库。';
          await sql`
            insert into thread_message (thread_id, role, text, inbox_id, meta)
            values (${t.thread_id}, 'agent', ${say}, ${id}, ${sql.json({ failed: true, error: msg } as never)})`.catch(
            (e: Error) => console.error(`  · 失败消息也没写进去：${e.message}`),
          );
          await sql`update thread set last_message_at = now() where id = ${t.thread_id}`.catch(() => {});
        }
      } finally {
        // 这一轮结束，把手收回。临时故障重排时 `push()` 会重新发一个新的（D89）
        if (agentRun) cancellable.delete(id);
        lastFinishedAt = new Date().toISOString();
        processed++;
      }
    }
  } finally {
    draining = false;
  }
};

/**
 * 当前进行到哪一步，写进 `agent_run`，前端轮询时带回去。
 *
 * 为什么值得每一步都写一次库：展会现场按下去之后转圈十几秒，
 * 人不知道它是在干活还是已经死了 —— **不知道的那几秒里他会再按一次**。
 * 一轮最多二十来次小 UPDATE，一天几十条速记，代价可以忽略。
 */
const setStage = async (runId: string, stage: string, steps?: number, done?: unknown[]) => {
  await sql`
    update agent_run set stage = ${stage}
      ${steps == null ? sql`` : sql`, steps = ${steps}`}
      ${done == null ? sql`` : sql`, trace = ${sql.json(done as never)}`}
    where id = ${runId}`.catch(() => {});
};

/**
 * 预处理：音频 → 文字（D46b 对音频仍成立），附件 → **分类**（D71）：
 * 原生直通的进 images/files，其余降级抽成文字。
 */
const preprocess = async (
  row: { text: string | null; audio_path: string | null; audio_mime: string | null },
  inboxId: string,
  brands: string[],
  runId: string,
): Promise<{ transcript: string | null; prepared: PreparedAttachments }> => {
  let transcript: string | null = null;

  if (row.audio_path) {
    /**
     * 🔴 **已经转过就直接用**（issue #15）。
     *
     * 速记页录完就已经排过一次只转写的活（`enqueueTranscribe`），
     * 人事后点「发给 AI」时不该再烧一次转写 —— 那是同一段音频的第二次付费，
     * 而且两次结果不一定一样（人看到的和 agent 读到的会对不上）。
     */
    const [cur] = await sql<Array<{ transcript: string | null }>>`
      select transcript from staging where inbox_id = ${inboxId}`;
    if (cur?.transcript) {
      transcript = cur.transcript;
      await setStage(runId, '录音已经转写过了');
    } else {
      await sql`update staging set status = 'transcribing' where inbox_id = ${inboxId}`;
      await setStage(runId, '正在转写录音');
      const buf = await readFile(join(env.audioDir, row.audio_path));
      // 把真实词表喂给转写 —— 实测这一步决定 Rosenfeld 会不会被听成 Rozenfelt
      transcript = await transcribe(buf, row.audio_mime ?? 'audio/webm', row.audio_path, brands);
      // ⚠️ 写 staging，**不回写 inbox** —— 原文不可变（§4.2 第2条）
      await sql`update staging set transcript = ${transcript} where inbox_id = ${inboxId}`;
    }
    // 🔴 **两个分支都要补标题。** 放在 if 里面的话，「转写已经有了」这条路
    // （AI 那一屏 + 补送「发给 AI」）就永远没有标题 —— 而那正是录音最多的路。
    if (transcript) await ensureTitle(inboxId, transcript);
  }

  const [att] = await sql<Array<{ n: number }>>`
    select count(*)::int as n from attachment where inbox_id = ${inboxId}`;
  if (att?.n) await setStage(runId, `正在准备 ${att.n} 个附件`);

  // 附件处理失败不影响这条速记 —— 单个附件在 attachments.ts 里各自降级，
  // 这里兜的是整批炸掉（比如数据库抖了）：退回「什么附件都没有」，速记照跑
  const prepared = await prepareAttachments(inboxId).catch((e: Error): PreparedAttachments => {
    console.error(`  · 附件准备出问题（已降级为无附件）：${e.message}`);
    return { images: [], files: [], text: '', native: 0, nativeExts: [] };
  });
  if (prepared.native) await setStage(runId, `${prepared.native} 个附件将原样喂给模型`);

  return { transcript, prepared };
};

/**
 * **只转写**（issue #15）。速记页录的每一条音频都走这条。
 *
 * 🔴 它和 `process_` 的分工是这个 issue 的全部：
 *   · 转写 = 把不可再生的资产变成可读的文字 → **无条件发生**
 *   · 抽取 = 烧一次模型、开一条对话、产生一条待确认 → **人显式要过才发生**（D31）
 *
 * 之前两件事绑在同一次调用里，于是「不想让 AI 整理」就等于「连转录都没有」。
 * 维护者 2026-08-05 的原话：「现在录音了之后，没有转录的显示」。
 *
 * 这里**不建 `agent_run`、不解析附件、不动 `status`**：
 * 它只往 `staging.transcript` 里写一段文字。看板不会因此多出一条待确认
 * （看板只看 `status='ready'`），而人事后点「发给 AI」时转写已经是现成的。
 */
const transcribeOnly = async (inboxId: string) => {
  const [row] = await sql<
    Array<{
      audio_path: string | null;
      audio_mime: string | null;
      transcript: string | null;
      status: string;
    }>
  >`select i.audio_path, i.audio_mime, s.transcript, s.status
    from inbox i join staging s on s.inbox_id = i.id where i.id = ${inboxId}`;
  if (!row?.audio_path) return;
  /**
   * 已经转过就别再烧一次 —— 两条路会走到这里：
   *   ① 「发给 AI」补送时重新入队；
   *   ② AI 那一屏已经在 `POST /transcribe` 里转过、发送时把结果带上来了（issue #15）。
   *
   * ⚠️ **但标题还是要补。** ② 那条路进来时 transcript 是现成的、title 是空的，
   * 直接 return 的话那条速记永远没有标题 —— 而它恰恰是录音最多的那条路。
   */
  if (row.transcript) {
    await ensureTitle(inboxId, row.transcript);
    return;
  }
  // 已经在跑 agent（或跑完了）的，转写归 process_ 管，别两边同时写同一行
  if (['transcribing', 'extracting', 'ready', 'confirming', 'committing', 'confirmed'].includes(row.status)) {
    return;
  }

  const [companies, suppliers] = await Promise.all([listCompanies(), listSuppliers()]);
  const brands = [...companies.map((c) => c.name), ...suppliers.map((s) => s.name)];

  const buf = await readFile(join(env.audioDir, row.audio_path));
  const text = await transcribe(buf, row.audio_mime ?? 'audio/webm', row.audio_path, brands);
  // ⚠️ 写 staging，**不回写 inbox** —— 原文不可变（§4.2 第2条）
  await sql`update staging set transcript = ${text} where inbox_id = ${inboxId}`;
  console.log(`  🎙 转写完成（${text.length} 字）：${inboxId}`);

  /**
   * 起个标题（issue #15）。**转写已经落库了才做这一步** ——
   * 顺序不能反：标题挂了不该连累转写，而转写是资产、标题是装饰。
   * `ensureTitle` 自己不抛异常，这里也不 await 出错的可能。
   */
  await ensureTitle(inboxId, text);
};

/**
 * `signal` = 这一轮的停止把手（D89 · issue #22）。
 *
 * 🔴 **它只递给 `runAgent`，前面的预处理照跑。**
 * 转写是「把不可再生的资产变成可读的文字」，无条件发生（issue #15 定的分工）——
 * 人叫停的是 AI 那一轮整理，不是「别把我刚才说的话记下来」。
 * 而 `runAgent` 拿到一个已经 abort 的 signal 时一次模型请求都不发，
 * 直接以 `aborted` 收工，后面的落库、兜底、插消息一步不少地照走 ——
 * 这就是「停下来之后不能什么都不留」那条要求的实现方式：**不加新路径，走同一条路。**
 */
const process_ = async (inboxId: string, signal?: AbortSignal) => {
  const [row] = await sql<
    Array<{
      text: string | null;
      audio_path: string | null;
      audio_mime: string | null;
      thread_id: string | null;
      user_id: string;
      edited_text: string | null;
      source: string | null;
    }>
  >`select i.text, i.audio_path, i.audio_mime, i.user_id, i.source,
           -- 人事后在手机上改定的正文（issue #15/#16）。inbox.text 一个字没动。
           s.edited_text,
           -- 「一键发给 AI」是事后补送的：那时 inbox 已经落库、而它只增不改
           -- （§4.2 第2条），所以对话关联只能记在 staging 上。这里两处都认。
           coalesce(i.thread_id, s.thread_id) as thread_id
    from inbox i left join staging s on s.inbox_id = i.id
    where i.id = ${inboxId}`;
  if (!row) return;

  const [st] = await sql<Array<{ id: string; status: string }>>`
    select id, status from staging where inbox_id = ${inboxId}`;
  if (!st) return;

  /**
   * 🔴 **已经有结果的就别再跑一遍。**
   *
   * `resumePending()` 启动时会把 pending / failed 的活捡回来，而队列在内存里。
   * 于是有两条真实路径会导致重复烧模型：
   *   ① 网关重启前队列里排着的活，重启后又被捡一次；
   *   ② 有人在队列排队期间手工把 staging 改成了 ready（或点了确认）。
   * 每重跑一次就是一次真实的 OpenAI 调用 —— 本地实测一次积压了 55 条。
   *
   * 想强制重跑：把 staging 的 status 改回 pending。
   */
  if (['ready', 'confirming', 'confirmed'].includes(st.status)) {
    console.log(`  ⏭  ${inboxId} 已经是 ${st.status}，跳过（要重跑请把 status 改回 pending）`);
    return;
  }

  const [user] = await sql<Array<{ user_code: string; display_name: string }>>`
    select user_code, display_name from app_user where id = ${row.user_id}`;

  // ⚠️ agent_run 在**预处理之前**就建好。转写和读附件也要能被看见 ——
  // 它们恰恰是最慢的两步，藏起来的话界面上就是十几秒没有任何解释的空白。
  const [runRow] = await sql<Array<{ id: string }>>`
    insert into agent_run (inbox_id, thread_id, status, stage, max_steps)
    values (${inboxId}, ${row.thread_id}, 'running', ${'准备中'},
            ${env.agentMaxSteps + 6})
    returning id`;
  const runId = runRow!.id;
  runsCreated++; // reapStaleRuns 的前提判据 —— 从这一刻起，库里的 running 不全是尸体了
  /** 半路退出时别把 running 这一行留在库里 —— 否则前端会永远转圈。 */
  const finish = (status: string, extra = '') =>
    sql`update agent_run set status = ${status}, stage = ${extra || null} where id = ${runId}`;

  const [companies, suppliers] = await Promise.all([listCompanies(), listSuppliers()]);
  const brands = [...companies.map((c) => c.name), ...suppliers.map((s) => s.name)];

  let { transcript, prepared } = await preprocess(row, inboxId, brands, runId);

  /**
   * 🔴 **人改过的话，agent 读人改的那一版**（issue #15/#16，2026-08-05）。
   *
   * 三层文字各答一个问题（migration 007 里那段）：
   *   `inbox.text` 人当时打的 · `staging.transcript` 机器听的 · `edited_text` 人改定的。
   *
   * 改的动机几乎总是「转录把品牌名听错了」——「Rozenfelt」改成「Rosenfeld」。
   * 这时候还把原始转录喂给 agent，等于**他刚纠正完的错误又被原样送进去**，
   * 而且他在核对卡上会第二次看到同一个错名字，完全不知道自己那次修改去哪了。
   * 所以有 `edited_text` 就只用它 —— 前两层原样留在库里，不覆盖、不合并。
   */
  const edited = (row.edited_text ?? '').trim();
  const source = edited || [row.text, transcript].filter(Boolean).join('\n').trim();
  if (!source && !prepared.text && !prepared.native) {
    await sql`update staging set status = 'ready' where inbox_id = ${inboxId}`;
    await finish('ok', '没有可处理的内容');
    return;
  }

  // 关掉 agent，采集照常 —— 只是不抽字段。集成测试断言这条。
  if (!env.agentEnabled) {
    await sql`update staging set status = 'ready', error = 'agent 已关闭（AGENT_ENABLED=0）'
              where inbox_id = ${inboxId}`;
    await finish('ok', 'agent 已关闭');
    return;
  }

  await sql`update staging set status = 'extracting', thread_id = ${row.thread_id} where inbox_id = ${inboxId}`;

  /**
   * ── 同一条对话：**在上一轮的基础上叠加，而不是从零再来一遍**（issue #14）──
   *
   * 维护者 2026-08-05 实测：同一条对话让它改了三轮，看板上出现三条待确认。
   * 他给的修法是「在这个 Inbox 的基础上去改，而不是生成一个新的 Inbox」。
   * 方向对，落点差一层：
   *
   *   🔴 `inbox` 只增不改（§4.2 第 2 条，库里有触发器）。三句话就是三行，
   *      一个字都不动 —— 展会说过的话是全项目唯一不可再生的资产。
   *   ✅ 该「在已有基础上改」的是**派生层**：把上一轮的 `extracted` 抄过来当起点，
   *      这一轮的 `propose_fields` 是合并语义（`||`），于是「把优先级改成紧急」
   *      真的只改那一格，而不是把前两轮读出来的东西全丢掉重来。
   *
   * ⚠️ **只继承还没进 CRM 的那些**（ready / failed）。
   *    已经 confirming/confirmed 的内容在 Twenty 里了，再抄一遍等于把整包重写一次；
   *    那种情况下的「增删」由 CRM 侧的幂等承担（projectCode / itemCode 撞了就更新）。
   */
  let inheritedFrom: string | null = null;
  let inheritedRecordType: string | null = null;
  const threadItems = env.agentMultiItems && row.thread_id ? await listThreadItems(row.thread_id,row.user_id) : [];
  const [answerMarker]=await sql<Array<{answer: {itemId?:string;revisionId?:string;stagingId?:string}|null}>>`
    select extracted->'answerToQuestion' as answer from staging where id=${st.id}`;
  // 只有耐久答案能解除旧提案处置边界；模型自报 action/purpose 不构成授权。
  const dispositionAnswer = await loadLegacyDispositionSource({ stagingId: st.id, userId: row.user_id, threadId: row.thread_id });
  const authorizedDisposition = dispositionAnswer?.action ?? null;
  const dispositionSource = dispositionAnswer?.text ?? '';
  if (row.thread_id && !threadItems.length && !answerMarker?.answer?.stagingId) {
    /**
     * D147：钉钉来源接管的是一版**已入库**的（`replaces`）时，起点只能是
     * 「比那一版更新的未入库版」或者「那一版入库时的值」—— 绝不能是**比它更旧**的、
     * 还活着的某一版（撤回过 / 交了白卷没被取代的）：从那儿起步，redo 的整包 PATCH
     * 会把已入库的更正打回旧值。评审抓出来的。PWA 那条路一个字不变。
     */
    const [own] = await sql<Array<{ owner_id: string | null; owner_at: Date | null }>>`
      select s.replaces->>'stagingId' as owner_id, o.created_at as owner_at
      from staging s left join staging o on o.id = (s.replaces->>'stagingId')::uuid
      where s.id = ${st.id}`;
    const takeover = row.source === 'dingtalk' && own?.owner_id && own.owner_at ? own : null;
    const [prev] = await sql<Array<{ id: string; extracted: any }>>`
      select id, extracted from staging
      where thread_id = ${row.thread_id} and id <> ${st.id}
        and status in ('ready','failed') and superseded_by is null
        ${takeover ? sql`and created_at > ${takeover.owner_at}` : sql``}
      order by created_at desc limit 1`;
    if (prev && hasRecordProposal(prev.extracted)) {
      await sql`update staging set extracted = ${sql.json(prev.extracted as never)} where id = ${st.id}`;
      inheritedFrom = prev.id;
      inheritedRecordType = typeof prev.extracted?.recordType === 'string' ? prev.extracted.recordType : null;
      console.log(`  ↳ 继承同一条对话上一轮的提案（${prev.id}）`);
    } else if (takeover) {
      /**
       * ── D147：这一轮接管的是一版**已入库**的（`staging.replaces`，D108）────
       *
       * 钉钉来源自动入库之后（D143），「#128 型号是 2000 的」改的就是 CRM 里那几条记录：
       * 网关在接上这句话时已经把交接意向写进了 `replaces`，入库时走 redo 原地更新。
       * 而 redo 的 PATCH 对没提到的格子写的是 `?? null` —— 这一轮不从那一版起步的话，
       * 只交了「型号」一格，其余的会被**清空**。
       *
       * 起点 = 那一版入库时真正写进去的值：`extracted` 叠上人改过的 `confirm_payload.fields`
       * （和 `commitToTwenty` 里 `f` 的算法同一条，否则人在核对卡上改过的值会被打回 agent 原值）。
       * ⚠️ 不标 `inheritedFrom` —— 已入库的那一版不能被 loop 标成 superseded，
       *    所有权在**入库成功那一刻**才转移（D108 / §2.47②）。
       */
      const [owner] = await sql<Array<{ extracted: any; confirm_payload: any }>>`
        select extracted, confirm_payload from staging
        where id = ${takeover.owner_id} and status = 'confirmed'`;
      const base = committedBase(owner ?? null);
      if (base) {
        await sql`update staging set extracted = ${sql.json(base as never)} where id = ${st.id}`;
        inheritedRecordType = typeof base.recordType === 'string' ? base.recordType : null;
        console.log(`  ↳ 接管已入库的那一版（${takeover.owner_id}），从它入库时的值起步`);
      }
    }
  }

  const attachmentInboxId = authorizedDisposition ? dispositionAnswer!.inboxId : inboxId;
  if (attachmentInboxId !== inboxId) prepared = await prepareAttachments(attachmentInboxId);
  const attList = await sql<Array<{ id: string; filename: string }>>`
    select id, filename from attachment where inbox_id = ${attachmentInboxId} order by created_at`;

  /**
   * 有附件就多给几步。
   *
   * 8 步是按「一句语音速记」定的。带一份技术报告时，光是
   * get_thread + list_enums + 查三次客户就用掉一半 —— 实测撞到过
   * **到顶时 propose_fields 一次都没调到，结果一个字段都没存下来**。
   * 附件多的那一条本来就值得多花几步。
   */
  const maxSteps = env.agentMaxSteps + (attList.length ? 6 : 0);
  /** 超时跟预算走（T51）：步数加了，时间也得加 —— 光加步不加秒等于没加。 */
  const timeoutMs = env.agentTimeoutMs + (attList.length ? 60_000 : 0);

  /**
   * 一次完整的 agent 跑动。抽成函数是因为 D71 的探测降级要**整轮重来**：
   * `input_file` 被模型拒了（新格式探测失败）时，不是修修补补，
   * 而是把那批扩展名标成不支持、附件重新走本地解析、ctx 和 prompt 全部重建再跑。
   */
  // 手册库（D72）。幂等，失败不抛 —— 没有手册 agent 也能跑，只是回到老水平
  await loadPlaybooks();

  /**
   * ── 同一条对话的消息史（D73①）─────────────────────────────────────
   *
   * extracted 浅拷贝（上面）给的是**数据层**的起点；这里再把上一轮的
   * **推理过程**（完整消息史）恢复进来 —— 两层互补：
   * 没有前者，模型不 propose 的格子会丢；没有后者，「把优先级改成紧急」
   * 之外的微调经常改错格（模型不记得上一轮为什么那么填）。
   * 落点在 audioDir 下 —— 唯一挂了 volume 的持久化目录，备份顺带（T35）。
   */
  const sessionsDir = sessionsDirOf();
  const history = row.thread_id ? await loadThreadHistory(sessionsDir, row.thread_id) : [];

  /**
   * 「推」的半边（D72）：这一轮**开跑前就知道**该看哪本时，直接把全文
   * 塞进系统提示词，省一步 read_skill 往返（步数是稀缺资源）。
   *   · 带附件 → attachment（转录粒度那本）
   *   · 续写继承的类型 → 对应那本（上一轮判成 project，这一轮多半还是项目的事）
   * 其余场景靠索引 + read_skill 拉。
   */
  const pushPlaybooks: string[] = [];
  if (attList.length) pushPlaybooks.push('attachment');
  if (inheritedRecordType === 'project' || inheritedRecordType === 'followup') {
    pushPlaybooks.push('project');
  } else if (inheritedRecordType === 'support') {
    pushPlaybooks.push('support');
  }

  const runOnce = async (): Promise<{ ctx: SkillContext; result: RunResult }> => {
    const ctx = newContext({
      attachments: attList,
      ...(attachmentInboxId !== inboxId ? { relatedInboxIds: [attachmentInboxId], dispositionSourceInboxId: attachmentInboxId } : {}),
      maxSteps,
      inboxId,
      stagingId: st.id,
      threadId: row.thread_id,
      userId: row.user_id,
      userCode: user?.user_code ?? 'unknown',
      displayName: user?.display_name ?? '未知',
      companies,
      suppliers,
      pushPlaybooks,
      resumed: history.length > 0,
      source: row.source ?? null,
      ...(env.agentMultiItems && row.source !== 'dingtalk' && inheritedFrom ? { inheritedLegacyStagingId: inheritedFrom } : {}),
      ...(authorizedDisposition === 'continue' ? { continuedLegacyStagingId: dispositionAnswer!.legacyStagingId } : {}),
    });

    const prompt = [
      (dispositionSource || source) && `销售说的：\n${dispositionSource || source}`,
      prepared.text && `随手上传的附件（已经解析成文字）：\n${prepared.text}`,
      prepared.native > 0 &&
        `另有 ${prepared.native} 个附件（图片/文档）已随本条消息**原样附上** —— 直接看内容，不用调 read_attachment。`,
      threadItems.length>0 && `本对话已有独立事项（不是整份最近提案）：\n${JSON.stringify(threadItems)}\n新增问题用propose_records创建新item；明确更正才传该itemId+expectedRevision；不猜最新/第一项。`,
      answerMarker?.answer?.itemId && `这是回答问题后对明确事项的补充：itemId=${answerMarker.answer.itemId}；只修订该事项，兄弟项保持。`,
      answerMarker?.answer?.stagingId && !answerMarker.answer.itemId && !authorizedDisposition && `这是回答问题后对明确来源提案的补充：stagingId=${answerMarker.answer.stagingId}；已复制该问题的来源字段，不继承对话中其他提案。`,
      ctx.inheritedLegacyStagingId && `本轮带有旧单条提案 ${ctx.inheritedLegacyStagingId}，它与这段新原话的关系尚未由人选择。不能猜对应关系创建多事项；检索该旧草稿后，ask_user 提供准确 continue 候选与 create 出口。`,
      authorizedDisposition && `用户已明确选择${authorizedDisposition === 'create' ? '独立新事项；旧提案保留，不借旧客户/字段' : '继续准确旧草稿；本轮必须用 propose_fields 补丁合并，禁止 propose_records；旧草稿已在答案事务中消费，其他旧草稿保留'}。只整理这道问题对应的新原话：\n${dispositionSource}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const result = await runAgent({
      systemPrompt: systemPrompt(ctx),
      prompt,
      skills: buildSkills(ctx),
      binding: bindingOverride,
      maxSteps,
      timeoutMs,
      /**
       * 思考档位（D125，维护者 2026-08-17 定：录入 agent 也开 high）。
       *
       * 🔴 在这之前从没传过这个字段，而实测（`onPayload` 截请求体）发出去的是
       * **`{"effort":"none"}` —— 思考整个关着**，不是「服务端默认档」。
       * 也就是说 2026-08-05 那次「5 轮吃满 60s」的观察是**无思考状态**下的，
       * 开了 high 之后每轮更慢 —— `AGENT_TIMEOUT_MS` 的默认值跟着提到 180s。
       */
      reasoning: keepThinking(env.agentReasoning),
      /**
       * 🔴 prompt 缓存键（D71）：同一条对话共用一个 —— Phase 4 的 session
       * 续跑会让同 thread 的轮次共享长前缀，按 thread 分键缓存才接得上。
       */
      sessionId: row.thread_id ?? inboxId,
      images: prepared.images,
      files: prepared.files,
      history,
      /**
       * 出口契约（D73③）：跑完还欠着产出时点名追问一轮，而不是直接伪造兜底。
       * 两条欠账都是这个仓库真实翻过的车：
       *   ① 一个字段都没交（2026-08-03 空白记录）；
       *   ② 判成 project 却没有项目提案（issue #17 —— CRM 里长不出项目）。
       */
      exitCheck: async () => {
        if (!ctx.proposed) {
          return (
            '你还没调 propose_fields。现在就把 summary、details 和已读出的字段交上去 —— ' +
            '读不出的留空，客户对不上号就留空 companyCode。什么都不交是最坏的结果。'
          );
        }
        if (threadItems.length && !await hasProposalItems(st.id)) return '已有独立事项，请用propose_records提交新增或明确itemId+expectedRevision的修订，不使用单记录覆盖整条对话。';
        const [cur] = await sql<Array<{ extracted: any }>>`
          select extracted from staging where id = ${st.id}`;
        const ex = cur?.extracted ?? {};
        if ((ex.recordType === 'project' || ex.recordType === 'followup') && !ex.project) {
          return (
            `你判成了 ${ex.recordType}，但还没调 propose_project —— 现在补上：` +
            '先 get_projects 查这是新项目还是已有项目；原话没给编号就留空，不要自己编。'
          );
        }
        return null;
      },
      // Pi 的事件流（agent.subscribe）经 runtime.ts 翻译成人话之后落到这里
      onProgress: (p) => void setStage(runId, p.stage, p.steps, p.done),
      // 人按的停止（D89）。降级重跑那一轮也带着它 —— 不带的话「停止」在降级后失效
      signal,
    });
    return { ctx, result };
  };

  let ctx: SkillContext;
  let result: RunResult;
  try {
    ({ ctx, result } = await runOnce());

    /**
     * ── D71 护栏②的另一半：格式探测失败 → 整轮降级重跑（最多一次）────
     *
     * 判据和 `transcribe.ts` 的 `rejectsExtendedParams` 同款：报文看着像
     * 「不收这种文件」（而不是网络抖动）才降级。降级是**进程级记忆** ——
     * 下一条同格式的速记直接走本地解析，不再撞一次。
     */
    if (
      result.stopReason === 'error' &&
      result.error &&
      prepared.files.length &&
      rejectsInputFile(result.error)
    ) {
      console.warn(
        `  ↻ 模型不收这批文件（${prepared.nativeExts.join(' ')}），降级为本地解析重跑一轮：` +
          result.error.slice(0, 160),
      );
      markExtsUnsupported(prepared.nativeExts);
      await setStage(runId, '模型不收这种附件格式，退回本地解析重来');
      prepared = await prepareAttachments(attachmentInboxId);
      ({ ctx, result } = await runOnce());
    }
  } catch (e) {
    await sql`update agent_run set status = 'failed', stage = ${'出错了'},
              error = ${(e as Error).message.slice(0, 500)} where id = ${runId}`;
    throw e;
  }

  /**
   * D73②：问了问题、正常收工 = **等人回答**，不是「完成」。
   * 之前它被记成 done —— `agent_run` 的统计里「等着人」和「干完了」分不开，
   * 排查 `agentHealth()` 时也被误导（issue #17-E）。status 仍是 ok
   * （这一轮本身没毛病），stop_reason 如实写 waiting_user。
   */
  reconcilePendingQuestionItems(ctx);
  const waitingUser = result.stopReason === 'done' && ctx.questions.length > 0;

  /**
   * 人按了停止（D89 · issue #22）。
   *
   * 🔴 `stop_reason` **如实写 `aborted`** —— issue 里点名要这一条。
   * 理由不是好看：`agent_run` 是排查现场问题时第一个要看的表，
   * 而「人不想要了」和「它跑挂了」混在一起的话，那张表就再也回答不了
   * 「今天到底有几条是真的出问题了」。status 记 `partial`
   * （这一轮确实只跑了一半），不是 `failed` —— 什么都没坏。
   */
  const aborted = result.stopReason === 'aborted';

  const waitingLegacyDisposition = !!ctx.inheritedLegacyStagingId && !ctx.proposed;
  await sql`
    update agent_run set
      status = ${result.stopReason === 'done' ? 'ok' : result.stopReason === 'error' ? 'failed' : 'partial'},
      steps = ${result.steps}, duration_ms = ${result.durationMs},
      stop_reason = ${waitingUser ? 'waiting_user' : result.stopReason},
      trace = ${sql.json(result.trace as never)},
      error = ${result.error ?? null},
      -- 跑完之后 stage 留最后一句，不清空 —— 出问题时它就是「卡在哪」的答案
      stage = ${
        waitingUser
          ? '等销售回答'
          : aborted
            ? '你叫停了'
            : result.stopReason === 'done'
              ? '完成'
              : `停在：${result.stopReason}`
      }
    where id = ${runId}`;

  /**
   * 消息史落盘（D73①）—— 只追加这一轮新增的部分。
   * 失败只 warn：消息史是增益，staging 才是结论的真相源。
   */
  if (row.thread_id && result.messages.length > history.length) {
    await appendThreadHistory(sessionsDir, row.thread_id, history.length, result.messages);
  }

  // 超上限 / 超时 / 人叫停都不是失败 —— **已经拿到的照样写进去，只是标 partial**。
  // 宁可少抽两个字段，也不能让一条卡住整个队列（展会一天几十条）。
  //
  // 🔴 `aborted` 走进这一档，是 issue #22 那条硬要求（「停下来之后不能什么都不留」）
  //    的**全部实现**：propose_fields 是边跑边写 staging 的（partial-first），
  //    所以停止那一刻已经交上来的字段本来就在库里；这里要做的只是别把它当失败擦掉。
  const partial = aborted || result.stopReason === 'max_steps' || result.stopReason === 'timeout';
  const failed = result.stopReason === 'error' && !ctx.proposed;

  /**
   * 🔴🔴 **一轮跑完，`extracted` 绝不能是空的。**
   *
   * 2026-08-03 实测，连着三条都栽在这里：客户名单里查不到那家公司，
   * 模型就回一句「暂不能提交结构化记录，companyCode 必须先由界面确认后生成」，
   * 然后 `propose_fields` **一次都没调**。后果是一连串的：
   *   `extracted = {}` → 核对卡上一格字段都没有 → 确认入库产出一条**空白记录**
   *   → 人在 CRM 里什么都看不到（维护者 原话：「你录入在哪里了？我这里都完全没看到」）。
   *
   * prompt 里已经把「companyCode 可选，客户对不上照样交」写死了，但**光靠 prompt 不算修好** ——
   * 这个项目自己的判据就是「靠工具清单，不靠 prompt 写请不要」。所以这里加一层结构性兜底：
   * 模型没提交，就用它自己那段话 + 原文 + 附件名凑一个最小可用的记录。
   *
   * 兜底出来的东西**明确标成兜底**（`agentSkipped`），核对卡上要说清楚
   * 「这条 AI 没整理出字段，下面是原文」—— 绝不假装它抽出来了。
   */
  let fallback: Record<string, unknown> | null = null;
  if (!ctx.proposed && !failed) {
    const [cur] = await sql<Array<{ extracted: any; transcript: string | null }>>`
      select extracted, transcript from staging where id = ${st.id}`;
    if (!hasRecordProposal(cur?.extracted)) {
      const original = (dispositionSource || row.text || cur?.transcript || '').trim();
      const attNames = attList.map((a) => a.filename).join(' · ');
      fallback = {
        ...(cur?.extracted ?? {}),
        agentSkipped: true,
        // 小结优先用模型自己那段话（它通常已经把事情说清楚了，只是没走工具）
        summary: (result.text || original || '（只有附件）').slice(0, 120).replace(/\s+/g, ' '),
        details: [
          result.text && `AI 说：\n${result.text}`,
          original && `原话：\n${original}`,
          attNames && `附件：${attNames}`,
        ]
          .filter(Boolean)
          .join('\n\n'),
      };
      console.warn(
        `  ⚠️ agent 没调 propose_fields（stop=${result.stopReason}），已用原文兜底：${st.id}`,
      );
    }
  }

  /**
   * 🔴 **结构层的一致性检查**（issue #17 根因 B 的第二半，2026-08-05）。
   *
   * prompt 里已经写死了「recordType 是 project/followup 就必须调 propose_project」，
   * 但**光靠 prompt 不算修好** —— 这个项目自己的判据就是
   * 「靠工具清单，不靠 prompt 写请不要」。prompt 会被长文本冲掉、会被模型换代改变行为。
   *
   * 所以这里检查一次：判成项目却没有项目提案时，**把它说出来**。
   * 不是拦下来（原话还在，字段也在，照样能入库），而是让人在核对卡上看见
   * 「它漏了一半」。**宁可让人看到漏了，也不要让人以为它做了** ——
   * 后者正是 维护者 说「我根本不敢入库」的那种体验的来源。
   */
  const [after] = await sql<Array<{ extracted: any }>>`
    select extracted from staging where id = ${st.id}`;
  const ex = after?.extracted ?? {};
  const wantsProject = ex.recordType === 'project' || ex.recordType === 'followup';
  const missedProject = wantsProject && !ex.project && !fallback;
  if (missedProject) {
    console.warn(`  ⚠️ 判成 ${ex.recordType} 却没有项目提案：${st.id}`);
  }

  /**
   * 兜底标记（`agentSkipped`）只描述「上一轮 AI 没整理出来」—— 这一轮真交了字段，它就不再成立。
   * 不清的话它会被之后每一版继承（propose_fields 是合并语义），钉钉那边的确信度门槛
   * 永远按「AI 没整理出结构化字段」挡住这一条，理由还是假的。
   */
  if (ctx.proposed) {
    await sql`update staging set extracted = extracted - 'agentSkipped'
              where id = ${st.id} and extracted ? 'agentSkipped'`;
  }

  await sql`
    update staging set
      status = ${waitingLegacyDisposition ? 'extracting' : failed ? 'failed' : 'ready'},
      partial = ${partial},
      agent_steps = ${result.steps},
      agent_trace = ${sql.json(result.trace as never)},
      ${waitingLegacyDisposition ? sql`extracted = coalesce(extracted,'{}'::jsonb) || '{"legacyDispositionRequired":true}'::jsonb,`
        : fallback ? sql`extracted = ${sql.json(fallback as never)},` : sql``}
      error = ${
        failed
          ? (result.error ?? 'agent 失败')
          : waitingLegacyDisposition
            ? '旧单条提案与新原话的关系尚未确认，请选择继续旧事项或独立新事项；原提案保留。'
          : aborted
            ? '你叫停了这一轮 —— 已经整理出来的都在下面，原话一个字没丢'
            : partial
            ? `已达上限（${result.stopReason}），结果可能不全`
            : fallback
              ? 'AI 没整理出结构化字段 —— 下面是原文，定个客户照样能入库'
              : missedProject
                ? 'AI 判成项目却没提交项目提案 —— 确认之前先看一眼，CRM 里可能不会长出项目'
                : null
      }
    where id = ${st.id}`;

  /**
   * ── 取代上一轮（issue #14）─────────────────────────────────────────
   *
   * 🔴 **只有这一轮真的产出了提案才取代。**
   * 否则一次模型抖动（超载、超时）就会把上一轮好好的那张卡也一起干掉 ——
   * 人手上会什么都不剩，而他刚刚明明看到过一张能确认的卡。
   *
   * 取代 ≠ 删除：`superseded` 只是「不再是活的那一条」，内容一个字没动，
   * `superseded_by` 指向新的那条。**「看不见」和「不存在」必须分得开** ——
   * 下次有人怀疑数据丢了，这一列就是答案。
   */
  /**
   * ⚠️ **人叫停、而且这一轮什么都没交出来时，不许取代上一轮**（D89）。
   * 那正是上面那段注释说的情形的一个新变种：兜底出来的那份只是原文，
   * 拿它取代上一轮好好的一张卡，等于人按了一下停止就把前一轮的成果按没了。
   * 真交过字段（`ctx.proposed`）的那种照常取代 —— 那是货真价实的新一版。
   */
  if (!waitingLegacyDisposition && inheritedFrom && !await hasProposalItems(st.id) && (ctx.proposed || (fallback && !aborted))) {
    await sql`
      update staging set status = 'superseded', superseded_by = ${st.id}
      where id = ${inheritedFrom} and status in ('ready','failed')`;
  }

  // agent 想说的话进对话，人在 AI 那一屏看得到
  if (row.thread_id) {
    /**
     * ⚠️ **就算它一个字都没说，也要插这条消息。**
     *
     * 核对卡是挂在 agent 那条消息底下的 —— 没有消息就没有卡，
     * 于是「模型没话说」会变成「这条速记永远确认不了」。
     * 宁可显示一句干巴巴的兜底，也不能让人对着自己那句话干瞪眼。
     */
    const replyBody = result.text || (failed
      ? '这一条没处理成功。原文还在，定个客户照样能入库。'
      : aborted ? '你叫停了这一轮。已经整理出来的在下面，原话一个字没丢 —— 改一改再发一次就行。'
      : '已整理，核对一下。');
    const questionWarning = !ctx.questions.length && ctx.questionWarnings?.length
      ? '\n\n提案已保存；尚未绑定明确事项的问题没有发送，请重新整理并核对目标。' : '';
    const say =
      [result.text, ...ctx.questions.map((q) => q.question)].filter(Boolean).join('\n') ||
      (failed
        ? '这一条没处理成功。原文还在，定个客户照样能入库。'
        : aborted
          ? // D89：叫停之后**必须有这条消息**，否则前端的 waiting 永远不落地（它等的就是
            // 「最后一条是 agent 且没有 running」），人会盯着一个停不下来的转圈。
            '你叫停了这一轮。已经整理出来的在下面，原话一个字没丢 —— 改一改再发一次就行。'
          : '已整理，核对一下。');
    {
      /**
       * 🔴 `inbox_id` **必须写上**。
       *
       * 少了它，`GET /threads/:id` 里那个
       * `left join staging s on s.inbox_id = m.inbox_id` 就永远落空，
       * 前端拿到的 `staging_id` 是 null —— 于是**核对卡永远不出现**：
       * agent 回了一段话，底下什么都没有，人无从确认、无从入库。
       *
       * 2026-08-03 实测踩到。当时 stagingId 其实已经写在 meta 里了，
       * 数据是在的，只是**不在前端找的那个位置** —— 这类 bug 不报错，
       * 只是少了一块 UI，最难发现。
       */
      await sql.begin(async(tx)=>{
        await persistAgentReply(ctx, { text: say + questionWarning, fallbackText: replyBody, partial }, tx);
      });
      await sql`update thread set last_message_at = now() where id = ${row.thread_id}`;
    }
  }
};

/**
 * ── 网关被硬杀之后，把留在 `running` 的那些轮次收掉（T99）─────────────
 *
 * `agent_run` 有三条正常收尾的路（跑完 / 内部出错 / 人叫停），**但没有第四条**：
 * 进程被 `kill`、容器被 `--force-recreate` 掉的时候，没有任何代码来得及写那一行。
 * 于是它永远停在 `status='running'`。
 *
 * 🔴 **这一行不是脏数据，它会在界面上撒谎。** `/threads/:id` 就是靠
 * 「这条对话有没有 `status='running'` 的 agent_run」回答「它在跑吗」，
 * 而 D130 之后**这个答案直接决定思考动画显不显示** —— 一行尸体 = 那条对话
 * 从此永远「正在思考…」，而且**换个标签页打开也一样**（此前只有发起的那个页面一直转）。
 * 人会一直等下去，而现场那句话正在变凉（同 issue #19③ 的形状）。
 *
 * 🔴 **判据是「这个进程建过几轮」，不是时间戳。**
 * 进程刚起来、一轮都没建过的时候，库里每一条 `running` 都必然是上一个进程留下的 ——
 * 这是个精确判据，不用猜「多久算超时」，也不怕网关和 Postgres 两个容器的钟差。
 * 代价：**调用位置必须在 `resumePending()` 和 `app.listen()` 之前**。
 * 而「必须在前面」这种约束一被人挪动就静默失效 —— 所以这里不靠注释，
 * 靠 `runsCreated` 自己挡住：挪到后面会拒跑并喊一声，不会把活的那一轮当尸体收掉。
 *
 * ⚠️ **不往对话里插「这条失败了」。** 紧接着的 `resumePending()` 多半会把它重新排上队
 * （`staging` 还停在 `extracting`），那句话就成了「说的时候是真、两秒之后变假」的话 ——
 * 上面 `drain()` 里 `willRetry` 那段注释已经为同一件事写过一次。
 * 捡不回来的那些（超 24 小时 / 用完 attempts），`resumePending()` 自己会喊。
 *
 * ⚠️ **一个库上只能有一个网关**（§2.37 附注）。真开两个的话，后起来的会把前一个
 * 正在跑的轮次收掉 —— 那个配置本来就是禁止的，这里不为它让路。
 */
export const reapStaleRuns = async (): Promise<number> => {
  if (runsCreated > 0) {
    console.warn(
      `  ⚠ reapStaleRuns() 被放到了太后面 —— 这个进程已经建过 ${runsCreated} 轮 agent_run，` +
        `跳过收尸（继续跑会把活着的那一轮当尸体收掉）。把它挪回 resumePending() 之前。`,
    );
    return 0;
  }

  const dead = await sql<Array<{ id: string }>>`
    update agent_run set
      status      = 'failed',
      stop_reason = 'interrupted',
      stage       = ${'网关重启了'},
      -- 已经写过错就保留 —— 那一条比这句通用的更接近真相
      error       = coalesce(error, ${'网关在这一轮跑到一半时停了，没有机会收尾'})
    where status = 'running'
    returning id`;

  if (dead.length)
    console.warn(
      `  ⚰️ 收掉 ${dead.length} 轮上次没跑完的 agent（进程被杀，没机会收尾）。\n` +
        `     不收的话那几条对话会永远显示「正在思考…」。能重跑的下一步就会被捡回来。`,
    );
  return dead.length;
};

/**
 * 启动时把上次没跑完的捡回来 —— 进程重启不丢活。
 *
 * ⚠️ **三条边界，每一条都是花钱买来的：**
 *   · 只捡最近 24 小时的。
 *   · 一次最多 50 条。本地实测一次捡回 55 条，队列当场开始连续调 OpenAI。
 *   · 🔴 **只捡还有尝试预算的**（`attempts < 3`）。
 *
 * 第三条是 2026-08-04 补的。之前的写法把 `failed` 也无条件捡回来，于是
 * 一条**永远会失败**的记录（实测有一条报 `unsupported Unicode escape sequence`）
 * 在 24 小时里每次重启都被重跑一遍，每次烧一次模型调用。
 *
 * 后果不是浪费钱那么简单：实测 50 条积压把模型占满，
 * **新来的那一条 agent 直接 60 秒超时走兜底** —— 人看到的是「agent 不行」，
 * 而真正的原因在一堆和他无关的旧记录上。
 *
 * 为什么不干脆不捡 `failed`：上游过载（`Our servers are currently overloaded`）
 * 是临时故障，重试一次就好了；而现场那句话是不可再生的资产，
 * 不该因为模型抖了一下就永远停在半路。**要的是次数预算，不是开关。**
 *
 * 超了预算的要重跑：`update staging set attempts = 0, status = 'pending'`，
 * 或者用 `POST /inbox/:id/agent` 手动踢一次。
 */
export const resumePending = async () => {
  /**
   * 🔴 **`thread_id is not null` 这一条是 D31 的执行机制**（issue #15，2026-08-05）。
   *
   * 少了它，这个查询会把**人故意没发给 AI 的纯速记**也捡回来：
   * 它们的 `staging.status` 默认就是 `'pending'`（001_init.sql），永远停在那儿，
   * 于是**网关每重启一次，24 小时内最多 50 条速记被跑一整轮 agent** ——
   * 烧模型、落 extracted、状态变 `ready`，然后出现在看板的待确认里。
   *
   * D31 的原话是「抽取是显式触发」，而这里是它唯一一条没被守住的缝：
   * 显式触发的两条路（AI 那一屏发的、点了「发给 AI」的）**都会写 thread_id**，
   * 纯速记则永远是 null。所以这一条判据就是「人要过没有」。
   */
  const rows = await sql<Array<{ inbox_id: string }>>`
    select inbox_id from staging
    where status in ('pending','transcribing','extracting','failed')
      and thread_id is not null
      and created_at > now() - interval '24 hours'
      and attempts < ${MAX_ATTEMPTS}
      and coalesce(extracted->>'legacyDispositionRequired','false') <> 'true'
    order by created_at limit 50`;
  for (const r of rows) push({ id: r.inbox_id, agentRun: true });
  if (rows.length) {
    console.log(`  ↻ 捡回 ${rows.length} 条未完成的 agent 任务`);
    void drain();
  }

  /**
   * 转写是另一条队列：**没转完的音频要补上，但不跑 agent**（issue #15）。
   * 判据同上 —— 这些是 `thread_id is null` 的纯速记，人还没要过抽取。
   */
  const pendingAudio = await sql<Array<{ inbox_id: string }>>`
    select s.inbox_id from staging s join inbox i on i.id = s.inbox_id
    where i.audio_path is not null and s.transcript is null and s.thread_id is null
      and s.created_at > now() - interval '24 hours'
      and s.attempts < ${MAX_ATTEMPTS}
    order by s.created_at limit 50`;
  for (const r of pendingAudio) push({ id: r.inbox_id, agentRun: false });
  if (pendingAudio.length) {
    console.log(`  🎙 捡回 ${pendingAudio.length} 条还没转写的录音（只转写，不跑 agent）`);
    void drain();
  }

  // 用完预算的**要说出来** —— 它们不会再被自动重跑，静默留在库里等于丢了
  const [stuck] = await sql<Array<{ count: string }>>`
    select count(*)::text from staging
    where status = 'failed' and attempts >= ${MAX_ATTEMPTS}
      and created_at > now() - interval '24 hours'`;
  if (stuck && stuck.count !== '0') {
    console.warn(
      `  🟠 有 ${stuck.count} 条试了 ${MAX_ATTEMPTS} 次仍失败，已不再自动重跑。\n` +
        `     看一眼原因：select error, count(*) from staging where attempts >= ${MAX_ATTEMPTS} group by 1;\n` +
        `     修好之后重置：update staging set attempts = 0, status = 'pending' where …`,
    );
  }
};
