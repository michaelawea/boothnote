import { applyUser, authFetch, type User } from './auth';
import { db, type Company, type EnumSet, type RecordRow, type Thread } from './db';
import { t, type Locale } from './i18n';

/**
 * 网关的读取侧客户端。
 *
 * 设计前提：**每一个读接口都要能离线降级。** 展馆会断网，而这个 App 的
 * 全部价值就是「网断了照常用」。所以统一的形状是：
 *   有网 → 拉服务端 → 写进 Dexie → 返回
 *   没网 → 直接返回 Dexie 里上次拉到的
 * 调用方不需要关心当前有没有网。
 *
 * 写接口（新建客户、确认入库）**没有**这个待遇 —— 它们必须联网，
 * 因为要拿只有服务端才有的东西（查重结果、Twenty 的 UUID）。
 * 离线时界面上说清楚「等有网再点」，而不是假装成功。
 */

/** 客户名单。**必须缓存** —— 断网时下拉是空的，等于采集端废了。 */
export const syncCompanies = async (): Promise<Company[]> => {
  try {
    const res = await authFetch('/companies');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { items } = (await res.json()) as { items: Company[] };
    if (items?.length) {
      // 整表替换而不是 put —— 服务端删掉的客户本地也该消失
      await db.transaction('rw', db.companies, async () => {
        await db.companies.clear();
        await db.companies.bulkAdd(items);
      });
    }
    return items ?? [];
  } catch {
    return db.companies.toArray(); // 离线：用上次的
  }
};

export const cachedCompanies = () => db.companies.toArray();

/**
 * 枚举 + 中文标签。**和客户名单同一个待遇：必须能离线读。**
 *
 * 核对卡上点一格弹出来的选项就是它（手册 P8）。断网时弹层是空的话，
 * 「改一格」在展馆里就等于不存在 —— 而那正是最需要它的场合。
 */
export const syncEnums = async (): Promise<EnumSet | null> => {
  try {
    const res = await authFetch('/enums');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const sets = (await res.json()) as Omit<EnumSet, 'id'>;
    if (!sets?.stage?.length) throw new Error(t('空的枚举'));
    const row: EnumSet = { ...sets, id: 'v1' };
    await db.enums.put(row);
    return row;
  } catch {
    return (await db.enums.get('v1')) ?? null; // 离线：用上次的
  }
};

export const cachedEnums = () => db.enums.get('v1');

/**
 * 改界面语言（D83）。**必须联网** —— 语言存在账号上（D80），不是本机开关。
 *
 * 两件事必须一起做，少一件界面就会半中半英：
 *   ① `PATCH /me` 写库，回来的整份 user 换进登录态 → 所有 `t()` 立刻走新语言
 *   ② 重新拉一次 `/enums` → 核对卡上那些**标签是服务端按用户语言给的**，
 *      缓存里那份是上一种语言的，不重拉就会一直是旧语言（离线时更明显：它是唯一那份）
 */
export const setLocale = async (locale: Locale): Promise<void> => {
  const res = await authFetch('/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locale }),
  });
  if (!res.ok) throw new Error(t('改语言失败（HTTP {a}）', { a: res.status }));
  const { user } = (await res.json()) as { user: User };
  applyUser(user);
  await syncEnums();
};

/**
 * 服务端说「这一屏对你关着」（D76①：`user` 角色在看板里什么都看不到）。
 *
 * 🔴 **它必须和「网络不通」分开**。两者都是「拿不到数据」，但一个要显示
 * 「完整看板需要更高权限」、另一个要显示上次缓存的表格 —— 混成一种，
 * 断网时会告诉人他没权限（他会去找 维护者 要），或者权限没了却还看着旧数据。
 */
export class ForbiddenError extends Error {}

/**
 * 我的全部记录 —— 看板表格的数据源（D76）。
 *
 * 和 `syncStaging()` 的差别是**一个查询参数**，而它决定了整屏的性质：
 * 那个只拉 `status=ready`（回答「还有什么没确认」），这个不按状态过滤
 * （回答「我到底记了些什么、哪些进去了哪些没进去」）。
 *
 * 作用域**不由这里决定** —— `/records` 端点根本不接受 `scope` 参数，
 * 服务端写死只查当前用户（§4.2 第 4 条的最强形式：没有参数就没有传错的可能）。
 */
export const fetchRecords = async (): Promise<RecordRow[]> => {
  let res: Response;
  try {
    res = await authFetch('/records');
  } catch {
    return db.records.orderBy('captured_at').reverse().toArray(); // 离线：用上次的
  }

  if (res.status === 403) {
    // 🔴 权限没了就把缓存**清掉**。留着的话，一个刚被降权的人下次打开
    // 还能看到上一次拉下来的整张表 —— 那等于权限没收回去。
    await db.records.clear();
    throw new ForbiddenError('board_forbidden');
  }
  if (!res.ok) return db.records.orderBy('captured_at').reverse().toArray();

  const { items } = (await res.json()) as { items: RecordRow[] };
  await db.transaction('rw', db.records, async () => {
    // 整表替换而不是 put —— 服务端不再返回的行本地也该消失
    await db.records.clear();
    await db.records.bulkAdd(items ?? []);
  });
  return items ?? [];
};

// ── 对话 ────────────────────────────────────────────────────────
export const syncThreads = async (): Promise<Thread[]> => {
  try {
    const res = await authFetch('/threads');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { items } = (await res.json()) as { items: Thread[] };
    await db.transaction('rw', db.threads, async () => {
      await db.threads.clear();
      await db.threads.bulkAdd(items ?? []);
    });
    return items ?? [];
  } catch {
    return db.threads.orderBy('last_message_at').reverse().toArray();
  }
};

/**
 * 先把对话建出来，再发第一条。
 *
 * 🔴 **不这么做会开出一堆对话。** `threadId` 原本要等第一条上传的回执才拿得到，
 * 而人在等不到反应时会连按几下 —— 那几下每一下都带着 `null` 发出去，
 * 服务端就每次新开一条。2026-08-03 实测：一句话开了 5 条对话、跑了 5 轮模型。
 */
export const createThread = async (title?: string): Promise<string | null> => {
  try {
    const res = await authFetch('/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title?.slice(0, 40) }),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { id: string }).id;
  } catch {
    return null; // 离线：退回旧路径，由服务端建
  }
};

/** 「一键发给 AI」—— 速记落库之后补送（D31：抽取是显式触发）。 */
/**
 * 把一条速记补送给 AI（D31：抽取是显式触发）。
 *
 * 🔴 `force` 是 issue #16 的服务端护栏：**已经整理过的（`ready`）必须显式
 * 带 force 才重跑**。不带就直接回 `alreadyDone`，不烧模型、不覆盖 extracted。
 * 前端那个确认框绕得过去（PWA 重试队列、第二台设备、手滑双击），这一层绕不过去。
 */
export const sendToAgent = async (
  inboxId: string,
  opts: { force?: boolean; newThread?: boolean } = {},
): Promise<AgentSendResult> => {
  const res = await authFetch(`/inbox/${inboxId}/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: opts.force === true, newThread: opts.newThread === true }),
  });
  if (!res.ok) throw new Error(t('发给 AI 失败（HTTP {a}）', { a: res.status }));
  return (await res.json()) as AgentSendResult;
};

export type AgentSendResult = {
  threadId: string | null;
  alreadyDone?: boolean;
  /** 服务端说「它正在跑」—— 界面必须如实说，别假装排上了新的一轮（D95）。 */
  alreadyRunning?: boolean;
  status?: string;
  queued?: boolean;
  newThread?: boolean;
};

/** 一条速记关联着的一条对话（D95 · issue #26）。 */
export type NoteThread = {
  id: string;
  title: string | null;
  created_at: string;
  last_message_at: string;
  messages: number;
  /** 这条对话是不是「活的那一条」—— 提案落在它名下。 */
  active: boolean;
  /** agent 还在这条对话里跑。跳进去之前就该知道。 */
  running: boolean;
};

/**
 * 「这条速记已经发给过哪几条对话」（D95 · issue #26）。
 *
 * 🔴 **必须问服务端，不能只看本地的 `sentToAgentAt`。** 那一格存在这台设备的
 * IndexedDB 里 —— 换台手机、清个缓存、或者同事在另一台上发过，本地全都是空的，
 * 于是 double check 根本不会弹出来，又开一条对话、又烧一轮模型。
 * 这正是 issue #26 第一句话要防的事。
 *
 * ⚠️ 离线时返回 `null`（不是空数组）：**「问不到」和「一条都没有」必须分得开** ——
 * 前者要退回一个保守的确认框，后者才可以直接发。
 */
export const fetchNoteThreads = async (inboxId: string): Promise<NoteThread[] | null> => {
  try {
    const res = await authFetch(`/inbox/${inboxId}/threads`);
    if (!res.ok) return null;
    return ((await res.json()) as { items: NoteThread[] }).items;
  } catch {
    return null;
  }
};

/**
 * ── 手动删除（D93 · issue #25 / #29）──────────────────────────────
 *
 * 两个面，两个动作，可以任意组合（migration 012 为此加了两列）：
 *   · `deleteNote`   速记页删掉这条速记。**CRM 一个字不动。**
 *   · `deleteRecord` 看板删掉这条记录，并同步软删 CRM 里那几条。
 *
 * 都是软删，都能撤销 —— Twenty 那边打的是 `delete{Object}`（本来就是软删），
 * `destroy` 一处都不调（维护者 2026-08-07 的裁定）。
 */
export type DeletionPreview = {
  status: string;
  noteDeletedAt: string | null;
  recordDeletedAt: string | null;
  committed: boolean;
  records: Array<{ object: string; label: string; name: string | null }>;
  /** 「拜访 · 商机 · 2 条工作项」。直接放进确认框里。 */
  summary: string;
  /** 🔴 删不掉的那些 —— **必须显示出来**，静默留孤儿就是把「看不见」当成「不存在」。 */
  skipped: Array<{ what: string; why: string }>;
  source: 'created_records' | 'legacy_refs' | 'none';
};

/**
 * 「按下去到底会删掉什么」。**在人点确认之前**问它。
 *
 * 🔴 一个写着「确定删除吗？」的框，成本是零，换来的是人条件反射地点掉。
 *    写「会同时删掉 CRM 里的 3 条：拜访 · 商机 · 项目文档」才是一次真正的复核。
 */
export const fetchDeletionPreview = async (stagingId: string): Promise<DeletionPreview | null> => {
  try {
    const res = await authFetch(`/staging/${stagingId}/deletion`);
    if (!res.ok) return null;
    return (await res.json()) as DeletionPreview;
  } catch {
    return null;
  }
};

export type DeleteRecordResult = {
  deleted?: boolean;
  alreadyDeleted?: boolean;
  /** 真删掉了几条 CRM 记录。0 = 这条压根没进过 CRM（issue #29 的主场景）。 */
  removed?: number;
  summary?: string;
  failed?: Array<{ label: string; reason: string }>;
  skipped?: Array<{ what: string; why: string }>;
};

/** 从速记页删掉一条速记。**不碰 CRM，一个请求都不发。** */
export const deleteNote = async (stagingId: string): Promise<void> => {
  const res = await authFetch(`/staging/${stagingId}/note`, { method: 'DELETE' });
  if (!res.ok) throw new Error(t('删除失败（HTTP {a}）', { a: res.status }));
};

export const restoreNote = async (stagingId: string): Promise<void> => {
  const res = await authFetch(`/staging/${stagingId}/note/restore`, { method: 'POST' });
  if (!res.ok) throw new Error(t('撤销失败（HTTP {a}）', { a: res.status }));
};

/** 从看板删掉一条记录 + 同步软删 CRM 里那几条。 */
export const deleteRecord = async (stagingId: string): Promise<DeleteRecordResult> => {
  const res = await authFetch(`/staging/${stagingId}/record`, { method: 'DELETE' });
  if (res.status === 409) {
    // 正在写 CRM 的那 5 秒 —— 服务端如实拒绝，这里把原话带给人
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? t('这条正在写进 CRM，等它写完再删。'));
  }
  if (!res.ok) throw new Error(t('删除失败（HTTP {a}）', { a: res.status }));
  return (await res.json()) as DeleteRecordResult;
};

/**
 * 撤销看板删除：把软删掉的 CRM 记录恢复回来。
 *
 * 🔴 `gone` = 那几条**永远回不来了**（Twenty 说它根本不存在，多半是历史上被硬删过）。
 *    看板那一行照常回来，但这件事必须让人看见 —— 不说的话他会以为一切都还原了，
 *    直到某天去 CRM 里找才发现是空的。
 */
export const restoreRecord = async (
  stagingId: string,
): Promise<{ recovered: number; gone?: Array<{ label: string; reason: string }> }> => {
  const res = await authFetch(`/staging/${stagingId}/record/restore`, { method: 'POST' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? t('撤销失败（HTTP {a}）', { a: res.status }));
  }
  return (await res.json()) as { recovered: number; gone?: Array<{ label: string; reason: string }> };
};

/**
 * 重试**只转写**那一步（D87 · issue #21②）。
 *
 * 和上面那个 `sendToAgent` 分开是刻意的：转写该随手能再来一次，
 * 而跑一轮 agent 是烧模型 + 开对话 + 产出待确认，得人显式要（D31）。
 */
export const retryTranscribe = async (
  inboxId: string,
): Promise<{ queued: boolean; busy?: boolean; alreadyDone?: boolean }> => {
  const res = await authFetch(`/inbox/${inboxId}/transcribe`, { method: 'POST' });
  if (!res.ok) throw new Error(t('重试转写失败（HTTP {a}）', { a: res.status }));
  return (await res.json()) as { queued: boolean; busy?: boolean; alreadyDone?: boolean };
};

/**
 * 把改定的正文推上去（issue #15/#16）。
 *
 * 落点是 `staging.edited_text` —— **服务端不会碰 `inbox`**（只增不改，§4.2 第2条）。
 *
 * 三种返回，调用方要分开处理：
 *   · `ok`              存下了
 *   · `alreadyCommitted` 已经进 CRM 了，改这里没用（服务端 409）——
 *     **必须告诉人**，不能静默当成成功：他不会再改第二次
 *   · 抛异常             网络问题，本地那份还在，下次 flush 再推
 */
export const saveNoteText = async (
  inboxId: string,
  text: string,
): Promise<{ ok: boolean; alreadyCommitted?: boolean }> => {
  const res = await authFetch(`/inbox/${inboxId}/text`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (res.status === 409) return { ok: false, alreadyCommitted: true };
  if (!res.ok) throw new Error(t('保存失败（HTTP {a}）', { a: res.status }));
  return { ok: true };
};

/**
 * 只转写，不建记录（issue #15）。
 *
 * AI 那一屏按下停止之后调它，把文字放进输入框让人改。
 * 音频**仍然留在手机上**，发送时才随速记一起上去 —— 所以放弃这条录音
 * 不会在服务端留下任何东西。
 *
 * 🔴 失败要**抛出来**，让调用方停下来把选择权交回给人（D86 · issue #20）。
 * 返回空字符串的话，人会以为自己录了一段静音。
 *
 * ⚠️ 这里原来写的是「让调用方退回『直接把音频发出去，转写在服务端补』」——
 *    **那条退路已经删掉了，因为它的前提是假的**：服务端跑的是同一个
 *    `transcribe()`，客户端刚失败过它必然也失败。见 Chat.tsx 的 `failedAudio`。
 */
export const transcribeAudio = async (blob: Blob, mime?: string): Promise<string> => {
  const form = new FormData();
  const ext = mime?.includes('mp4') ? 'm4a' : mime?.includes('ogg') ? 'ogg' : 'webm';
  form.append('audio', blob, `clip.${ext}`);
  const res = await authFetch('/transcribe', { method: 'POST', body: form });
  if (!res.ok) throw new Error(t('转写失败（HTTP {a}）', { a: res.status }));
  return ((await res.json()) as { text?: string }).text ?? '';
};

export type ThreadMessage = {
  id: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  inbox_id: string | null;
  meta: { questions?: Array<{ question: string; options?: string[] }>; partial?: boolean };
  created_at: string;
  /**
   * D90（issue #23）：这条已经被改口取代了 —— 值是取代它的那条消息 id。
   * 🔴 **取代 ≠ 删除**：原话一个字没动，界面照样显示，只是淡一档 + 一句「已改」。
   * `supersede_reason`：`edited` 人改了这句 · `resent` 原话重跑 ·
   * `stale_reply` 它是对被撤回那句话的回应。
   */
  superseded_by: string | null;
  supersede_reason: string | null;
  staging_id: string | null;
  status: string | null;
  extracted: Record<string, unknown> | null;
  confidence: Record<string, string> | null;
  partial: boolean | null;
  suggested_company: string | null;
  /** 服务端算好的提交时刻。倒计时从它推 —— 卡片被重建也不影响。 */
  confirm_after: string | null;
  twenty_refs: Record<string, string> | null;
  /** 工作日志（D74）：agent 那一轮的完整轨迹，跑完之后也一直在。 */
  agent_trace: Array<{ tool: string; ms: number; ok: boolean; summary: string }> | null;
  agent_steps: number | null;
  run_stop_reason: string | null;
  run_duration_ms: number | null;
  /** D75：staging 上的错误（重录失败原因等）。null = 没有。 */
  staging_error: string | null;
  /** D75：人上次确认时改过的那几格 —— 重录界面要显示入库的值，不是抽取的旧值。 */
  confirmed_fields: Record<string, unknown> | null;
  /** 这条消息带的附件。不带回来的话，人在对话里看不到自己传了什么。 */
  attachments: Array<{
    id: string;
    name: string;
    kind: string;
    bytes: number;
    parsed: string | null;
    chars: number;
  }>;
};

/**
 * 正在跑的那一轮。**没有它，等待就是一个转圈** ——
 * 而转圈十几秒之后，人不知道它是在干活还是已经死了，
 * 不知道的那几秒里他会再按一次。
 */
export type Running = {
  /** 人话：「正在转写录音」「查客户」「在想」…… */
  stage: string | null;
  steps: number;
  max_steps: number | null;
  trace: Array<{ tool: string; ms: number; ok: boolean; summary: string }> | null;
};

export const fetchThread = async (
  id: string,
): Promise<{ messages: ThreadMessage[]; running: Running | null; deletedAt: string | null }> => {
  const res = await authFetch(`/threads/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as {
    messages: ThreadMessage[];
    running: Running | null;
    thread?: { deleted_at?: string | null };
  };
  return {
    messages: j.messages ?? [],
    running: j.running ?? null,
    /**
     * 🔴 删掉的对话**照样返回全文**，只多这一格（D102 · issue #33）。
     * 服务端回 404 的话，从看板点「去对话里看」会落到一屏静默的空白 ——
     * 界面拿它打一条「这条对话已删除 · 撤销」的横幅。
     */
    deletedAt: j.thread?.deleted_at ?? null,
  };
};

/**
 * ── 删掉一条对话历史（D102 · issue #33）──────────────────────────────
 *
 * 🔴 **只删对话这一层。** 速记页那条原话照常在（要删去速记页删），
 * CRM 里已入库的行也照常在（要删去看板删）—— 三个面各有各的时间戳。
 * 这句话必须原样出现在确认框上：人以为删对话会连 CRM 一起带走的话，
 * 他要么不敢删，要么以为删干净了而其实没有。两种误解都比没这个功能更糟。
 *
 * ⚠️ 正在跑的那一轮服务端会 409 拒绝 —— 把它那句原话带给人（先按停止）。
 */
export const deleteThread = async (threadId: string): Promise<void> => {
  const res = await authFetch(`/threads/${threadId}`, { method: 'DELETE' });
  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? t('AI 正在这条对话里跑 —— 先按停止再删。'));
  }
  if (!res.ok) throw new Error(t('删除失败（HTTP {a}）', { a: res.status }));
};

/**
 * ── 「改这一句会改写 CRM 里的哪几条」（D108 · issue #37）─────────────
 *
 * 人**按发送之前**问一次。改口本来只让还没入库的提案退场，已入库的那些
 * 一个都不碰 —— 于是那一轮照常新建一份，CRM 里两版并存
 * （生产实测：Movara 的逆变器 3000W 和 2000W 两条都在）。
 *
 * 现在改成「继承所有权、原地改写」，而**这件事必须在人按下去之前说出来** ——
 * 「会改写下面这几条」和「会新增一条」是两个完全不同的动作。
 *
 * ⚠️ 问不到（离线 / 老服务端）时返回 `null`：**不假装「没有已入库的」** ——
 * 调用方据此退回一个保守的提示，而不是直接发。
 */
export type SupersedePreview = {
  messages: number;
  /** 这几条已经在 CRM 里，发出去会被改写。空数组 = 上一轮还没入库，照常发。 */
  rewriting: Array<{ object: string; label: string; name: string | null }>;
  source: 'created_records' | 'legacy_refs' | 'none';
  /** 🔴 除了要改写的那一版，还有几版也已入库 —— 它们一个字不会被动。 */
  otherCommitted: number;
};

export const fetchSupersedePreview = async (
  threadId: string,
  messageId: string,
): Promise<SupersedePreview | null> => {
  try {
    const res = await authFetch(
      `/threads/${threadId}/supersede-preview?messageId=${encodeURIComponent(messageId)}`,
    );
    if (!res.ok) return null;
    return (await res.json()) as SupersedePreview;
  } catch {
    return null;
  }
};

/** 撤销删除。纯改一格时间戳，消息一个字都没动过 —— 恢复是无损的。 */
export const restoreThread = async (threadId: string): Promise<void> => {
  const res = await authFetch(`/threads/${threadId}/restore`, { method: 'POST' });
  if (!res.ok) throw new Error(t('撤销失败（HTTP {a}）', { a: res.status }));
};

/**
 * 叫停这条对话上正在跑的那一轮（D89 · issue #22）。
 *
 * 🔴 **必须联网** —— 中止信号在网关的进程里，前端把按钮变灰不叫「停了」。
 * 离线时如实抛出去，界面上说一句「连不上服务器，它还在那边跑」，
 * 而不是假装停下来（那会让人以为可以重发了，结果两轮撞在一起）。
 *
 * 返回**真的停掉了几条**。0 = 它已经跑完了或本来就没在跑 ——
 * 这个数字要传到界面上，「点了停止但什么都没停」不许静默。
 */
export const abortThread = async (threadId: string): Promise<number> => {
  const res = await authFetch(`/threads/${threadId}/abort`, { method: 'POST' });
  if (!res.ok) throw new Error(t('停止失败（HTTP {a}）', { a: res.status }));
  return ((await res.json()) as { stopped?: number }).stopped ?? 0;
};

/**
 * 取回附件原件。
 *
 * ⚠️ **不能用 `<a href>` 直接指过去** —— 那样带不上 Bearer token，会 401。
 * 所以走 authFetch 拿 blob，再用 object URL 触发下载。
 *
 * 为什么需要它：Twenty 这个版本没有开放文件上传接口，原件只在网关磁盘上，
 * 这是唯一能把那份 Word / PDF 拿回来的路径。
 */
export const downloadAttachment = async (id: string, name: string): Promise<void> => {
  const res = await authFetch(`/attachments/${id}/file`);
  if (!res.ok) throw new Error(res.status === 410 ? '原件已经不在服务器上了' : t('取不到（HTTP {a}）', { a: res.status }));
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // 立刻回收 —— 不回收的话每点一次都留一份在内存里
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// ── 新建客户 ────────────────────────────────────────────────────
export class DuplicateError extends Error {
  constructor(readonly candidates: Array<Company & { score: number }>) {
    super(t('可能是重复客户'));
  }
}

/**
 * 新建客户。名字、国家、类型三样**必填**（维护者 2026-07-30）。
 *
 * 🔴 服务端会先查重。命中就抛 `DuplicateError`，界面必须把候选摆出来给人看，
 * 人确认「都不是」之后才带 `confirmedUnique` 再发一次。
 * **这一步不能省** —— 销售那份 Excel 就是因为同一家有三种写法而散架的。
 */
export const createCompany = async (input: {
  name: string;
  country: string;
  accountType: string;
  parentCode?: string;
  confirmedUnique?: boolean;
}): Promise<Company> => {
  const res = await authFetch('/companies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (res.status === 409) {
    const { candidates } = (await res.json()) as { candidates: Array<Company & { score: number }> };
    throw new DuplicateError(candidates ?? []);
  }
  if (res.status === 422) throw new Error(t('名字、国家、类型都得填'));
  if (!res.ok) throw new Error(t('新建失败（HTTP {a}）', { a: res.status }));
  const c = (await res.json()) as { id: string; code: string; name: string };
  const company: Company = {
    id: c.id,
    code: c.code,
    name: c.name,
    group: '',
    type: input.accountType,
  };
  await db.companies.put(company);
  return company;
};

export const searchCompanies = async (q: string): Promise<Array<Company & { score: number }>> => {
  if (!q.trim()) return [];
  try {
    const res = await authFetch(`/companies/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) return [];
    return ((await res.json()) as { items: Array<Company & { score: number }> }).items ?? [];
  } catch {
    return []; // 离线：查不了重就不让新建，界面上说明原因
  }
};

// ── 渠道链（D54）────────────────────────────────────────────────
export type ChainLevel = {
  name: string;
  role: string;
  matched: { id: string; code: string; name: string } | null;
  candidates: Array<{ id: string; code: string; name: string; score: number }>;
};

/** 把 agent 给的名字对到已有客户上。**对不上的不会自动建** —— 那一步是人按的。 */
export const resolveChain = async (
  chain: Array<{ name: string; role: string }>,
): Promise<ChainLevel[]> => {
  const res = await authFetch('/chain/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chain }),
  });
  if (!res.ok) return [];
  return ((await res.json()) as { levels: ChainLevel[] }).levels ?? [];
};

/** 建立链路。顺序反了服务端会拒绝（分销商必须在终端客户前面）。 */
export const linkChain = async (companyIds: string[]): Promise<number> => {
  const res = await authFetch('/chain/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ levels: companyIds.map((id) => ({ companyId: id })) }),
  });
  if (res.status === 422) {
    const j = (await res.json()) as { hint?: string };
    throw new Error(j.hint ?? t('这条链的顺序不对'));
  }
  if (!res.ok) throw new Error(t('建立链路失败（HTTP {a}）', { a: res.status }));
  return ((await res.json()) as { linked: number }).linked;
};

// ── 确认入库（5 秒延迟提交，D48）────────────────────────────────
export class ConfirmError extends Error {}

/**
 * 确认入库 → 网关排队，5 秒后写 Twenty。
 *
 * 🔴 `companyId` 是 **Twenty 的记录 UUID**，不是 code。
 *    §4.2 第 3 条：关系字段只能是已存在的 UUID，绝不能传名字串。
 *    这也是 D28 修订的闸门 —— 录入时可以不定客户，**入库时必须定**。
 *
 * 返回 `undoMs`：界面拿它显示倒计时。这段时间内 `undoConfirm` 能把它撤掉，
 * 而且是**真的撤掉** —— 请求还没发到 Twenty，不存在「删记录」这条路径。
 */
/** 这条记录会接到 CRM 里的什么上面（D57）。核对卡在入库前拿它显示落点。 */
export type ConfirmTargets = {
  openCases: Array<{
    id: string;
    name: string;
    caseStatus: string;
    statusLabel: string;
    severity: string;
    reportedAt: string | null;
  }>;
  opportunity: { id: string; name: string; stage: string; stageLabel: string } | null;
  /** 在位品牌对不上受控名单 —— 那一格不会进 CRM。界面必须说出来（D23a）。 */
  supplierUnmatched?: string | null;
  /**
   * 项目提案没有编号时，服务端给的建议编号（issue #17 根因 D）。
   * 🔴 **必须在人按确认之前摆出来** —— 他得知道 CRM 里那条会叫什么，
   * 否则下次去找这个项目会找不到。
   */
  suggestedProjectCode?: string | null;
};

export const fetchTargets = async (
  stagingId: string,
  companyId: string,
  category?: string | null,
  supplierName?: string | null,
): Promise<ConfirmTargets> => {
  const q = new URLSearchParams({
    companyId,
    ...(category ? { category } : {}),
    ...(supplierName ? { supplierName } : {}),
  });
  try {
    const res = await authFetch(`/staging/${stagingId}/targets?${q}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as ConfirmTargets;
  } catch {
    // 落点查不到不该挡住入库 —— 没有它就是「新开一条」，那也是默认行为
    return { openCases: [], opportunity: null };
  }
};

export const confirmStaging = async (
  stagingId: string,
  companyId: string,
  fields?: Record<string, unknown>,
  /** 人选的「接在这条售后上」。不传 = 新开一条（手册 P23 / D57）。 */
  supportCaseId?: string | null,
): Promise<{ undoMs: number }> => {
  const res = await authFetch(`/staging/${stagingId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ companyId, fields, supportCaseId: supportCaseId ?? undefined }),
  });
  if (res.status === 422) {
    // 422 有两种：没定客户，和改出来的值非法。分开说 —— 「入库前必须先定客户」
    // 出现在人明明已经选了客户的时候，只会让他更迷惑
    const j = (await res.json().catch(() => ({}))) as { error?: string; rejected?: string[] };
    if (j.error === 'bad_field_value') {
      throw new ConfirmError(t('这几格的值服务端不认：{a}', { a: (j.rejected ?? []).join(t('、')) }));
    }
    throw new ConfirmError(t('入库前必须先定客户'));
  }
  if (!res.ok) throw new ConfirmError(t('入库失败（HTTP {a}）', { a: res.status }));
  const json = (await res.json()) as { undoMs?: number };
  return { undoMs: json.undoMs ?? 5000 };
};

/**
 * D75：重录 —— 已入库之后改字段重新提交，按 ref 更新替代之前的记录。
 * 服务端的拒绝都带着人话（类型锁 / 客户锁 / 编号冲突），原样抛给界面显示。
 */
export const reconfirmStaging = async (
  stagingId: string,
  fields: Record<string, unknown>,
): Promise<{ undoMs: number }> => {
  const res = await authFetch(`/staging/${stagingId}/reconfirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as {
      message?: string;
      error?: string;
      rejected?: string[];
    };
    if (j.error === 'bad_field_value') {
      throw new ConfirmError(t('这几格的值服务端不认：{a}', { a: (j.rejected ?? []).join(t('、')) }));
    }
    throw new ConfirmError(j.message ?? t('重录失败（HTTP {a}）', { a: res.status }));
  }
  const json = (await res.json()) as { undoMs?: number };
  return { undoMs: json.undoMs ?? 5000 };
};

/** 撤销。过了窗口期会回 409 —— 那时候诚实地说「来不及了」。 */
export const undoConfirm = async (stagingId: string): Promise<boolean> => {
  try {
    const res = await authFetch(`/staging/${stagingId}/confirm`, { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
};

/**
 * 延迟窗口过去之后，把它从本地待办里拿掉。
 *
 * ⚠️ **D76 之后这张表已经没人往里写了**（看板换成 `GET /records`，
 * 原来的 `syncStaging()` 随之删掉），所以这一句现在是个空操作。
 * 留着它、也留着 `db.staging` 那张表，是刻意的：删一张 Dexie 表意味着
 * 一次会在**每台手机上执行**的 schema 升级，而万一它打不开库，
 * 连 `notes` 里还没传上去的录音一起打不开 —— 那是全项目唯一不可再生的资产。
 * 一个空操作的代价远小于这个风险。
 */
export const dropStagingLocally = (stagingId: string) => db.staging.delete(stagingId);

/**
 * 把「人在核对卡上选的客户」写回本地那条速记。
 *
 * 🔴 不写回的话，客户详情页上的「我记过 N」**永远是 0**。
 * 因为归属是在**确认入库**那一步才定的（D28 修订），而本地 note 的
 * `companyCode` 停在录入那一刻 —— 那时它是空的。
 * 实测（2026-08-03）：刚给 Havel 记完一条并确认，进 Havel 详情页显示「我记过 0」。
 *
 * 顺带让速记列表也显示出客户名 —— 人回头翻的时候才认得出哪条是哪家。
 */
export const tagNoteWithCompany = async (stagingId: string, company: Company): Promise<void> => {
  const note = await db.notes.where('stagingId').equals(stagingId).first();
  if (!note || note.companyCode === company.code) return;
  await db.notes.update(note.id, { companyCode: company.code, companyName: company.name });
};

/**
 * ⚠️ **批量入库的前端入口在 D76 里删掉了**（维护者 2026-08-07：「确认这边只走对话」）。
 *
 * 服务端 `POST /staging/confirm-batch` 保留着 —— 它有自己的护栏
 * （逐条走 `loadOwned` + 挡 `superseded` + D28 的客户闸门），
 * 而且运维时「把积压的几条按脚本推进去」还用得上。
 * 但**没有界面能触发它**了：确认要看 AI 整轮的工作日志，那是对话页的事。
 */

// ── 情报缺口 ────────────────────────────────────────────────────
export type Gaps = {
  code: string;
  /** 情报清单一共配了几项。**0 = 清单还没配**，不是「都问过了」。 */
  totalItems?: number;
  completeness: number | null;
  missing: Array<{ key: string; question: string; wave: number | null }>;
  /**
   * 已经知道的那些（手册 P19：「传闻那条带着标」）。
   * 传闻排在最前面 —— **需要去核实的才是行动项**，已确认的只是背景。
   */
  known?: Array<{
    key: string;
    question: string;
    value: string;
    confidence: string | null;
    confidenceLabel: string | null;
    isRumor: boolean;
    sourceName: string | null;
    by: string | null;
  }>;
};

export const fetchGaps = async (code: string): Promise<Gaps | null> => {
  try {
    const res = await authFetch(`/gaps/${encodeURIComponent(code)}`);
    if (!res.ok) return null;
    return (await res.json()) as Gaps;
  } catch {
    return null;
  }
};
