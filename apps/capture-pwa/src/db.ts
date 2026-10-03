import Dexie, { type Table } from 'dexie';
import type { ProposalItemView } from './proposal-items';

/**
 * 本地库 = 采集端的真相源。
 *
 * §4.2 第2条：原文不可变。这里写下去的 text/audio 永远不被覆盖，
 * 上传只是把它复制到服务端，失败了本地这份还在。
 *
 * 「三段解耦」的第一段就靠它：速记 → 本地库，不依赖 Agent、不依赖 Twenty、不依赖网络。
 */
export type SyncState = 'queued' | 'syncing' | 'synced' | 'failed';

/** 三类附件（维护者 2026-08-03 把「上传文件 / 上传资料」合并掉之后就是这三个）。 */
export type AttachmentKind = 'photo' | 'image' | 'file';

export type LocalAttachment = {
  kind: AttachmentKind;
  name: string;
  mime: string;
  size: number;
  /**
   * 原件的字节。**上传成功之前绝不删** —— 和音频同一个道理。
   *
   * 🔴 **存 ArrayBuffer，不存 `File`**（D128 · issue #53）。
   * 2026-09-02 展会现场抓包：iPhone 上传带图速记时发出去的请求 **`Content-Length: 0`**，
   * 网关只能回 400。原因是之前把 `<input type=file>` 给的 `File` 对象原样存进 IndexedDB，
   * iOS 上读回来的是一个指向已经不存在的临时文件的引用；WebKit 遇到读不出的 Blob
   * 会把**整个** multipart 正文发成零字节 —— 连 JSON 那个字段一起没了。
   * 录音一直能传，因为 MediaRecorder 给的是内存里的 Blob。
   * 判据：**进本地库的附件必须是字节，不是句柄。** 句柄只在拿到它的那一刻有效。
   */
  bytes?: ArrayBuffer;
  /**
   * 2026-09-02 之前的形状（`File` 原样存）。只为让老记录还能被读到（`attachmentBlob`）——
   * 新代码**不再写这一格**。
   */
  blob?: Blob;
};

/**
 * 服务端已经收下的附件（`GET /inbox` / `POST /inbox` 回包里的清单）。
 *
 * 🔴 和 `attachments` 是两回事：那个是「还没传上去的原件」，这个是「服务端有的引用」。
 * 以前上传成功就把 `attachments` 清空、而服务端只回一个数量 —— 于是**传成功那一刻
 * 图片从界面上消失**（issue #53 A1）。原件走 `GET /attachments/:id/file` 取。
 */
export type RemoteAttachment = {
  id: string;
  kind: AttachmentKind;
  name: string;
  mime: string;
  size: number;
};

export type Note = {
  id: string;
  /**
   * 归属。⚠️ D28 修订（2026-07-31）：**录入时可空**，但**入库前必须定下来**。
   * 现场多一步下拉就少录一条；而挂错客户的数据比没录更糟 —— 所以把门槛从
   * 「录入时」挪到「确认入库时」，两头都保住。
   */
  companyCode?: string;
  companyName?: string;
  /** Agent 认为是新客户时填这里。§4.2 第3条：只能提议，不能自动建 */
  suggestedCompany?: string;
  /** 原文 —— **人打的字**。空 = 这是一条纯语音速记。 */
  text: string;
  /**
   * 语音转录（issue #15）。**和 `text` 分开存，不合并。**
   *
   * 🔴 `text` 是人打的，`transcript` 是机器听的。合成一格之后，
   * 「这句话是他打的还是听出来的」永久分不清 —— 而三个月后回头看一条记录时，
   * 这个区别决定了它有多可信。服务端也是这么分的（`inbox.text` vs
   * `staging.transcript`，§4.2 第2条：派生数据不回写原文）。
   *
   * 由 `pullInbox()` 从服务端回填。**人改的不写这里，写 `editedText`。**
   */
  transcript?: string;
  /**
   * 人事后改定的正文（issue #15「转录可以手动修改」/ #16「每条速记可以进去修改」）。
   *
   * 🔴 **第三层，不覆盖前两层。** `text` 是他当时打的、`transcript` 是机器听的、
   * 这一格是他看过之后改定的。三层各答一个问题，服务端也是这么分的
   * （`inbox.text` 不可变 · `staging.transcript` · `staging.edited_text`，migration 007）。
   *
   * 改的动机几乎总是「转录把品牌名听错了」—— 而那句错的原文必须留着，
   * 否则三个月后没有任何地方能回答「他当时到底说的是什么」。
   */
  editedText?: string;
  /** 改定的时刻（本地时钟）。空 = 没改过。 */
  editedAt?: number;
  /**
   * 这次修改**推上去了没有**。
   *
   * 🔴 单独一个字段而不是复用 `sync`：`sync` 说的是「这条速记本身传上去了没有」，
   * 而修改是它之后的第二次往返。混用的话，改一条已经 `synced` 的速记
   * 会把它打回 `queued`，于是**整条速记连同音频被重传一次**（音频本地已经删了，
   * 重传等于把一条完整记录变成没有音频的记录）。
   */
  editSyncedAt?: number;
  /** 服务端生成的一句话标题（issue #15）。列表页用它，没有就退回正文首句。 */
  title?: string;
  /** 音频原始数据。留在本地直到上传成功 —— 展会 10 天说过的话是唯一不可再生的资产 */
  audioBlob?: Blob;
  audioMime?: string;
  audioSeconds?: number;
  createdAt: number;
  recordedBy: string;
  /** 归属到哪次拜访/事件（D32）。原型里由「当前事件」设置项推导 */
  visitLabel: string;
  sync: SyncState;
  attempts: number;
  lastError?: string;
  /** 服务端回执 id，同步成功后回填 */
  remoteId?: string;

  /** 这条属于哪条对话。空 = 由服务端新开一条（一条速记 = 一条对话）。 */
  threadId?: string;
  /** Stable identity for a conversation captured before the first server response. */
  clientThreadId?: string;
  /** Structured answers retain their binding during offline replay. */
  questionAnswer?: { questionId: string; expectedRevision: string; optionId?: string; text?: string };
  /** A stale/invalid answer needs a new explicit choice, never automatic reinterpretation. */
  answerBlocked?: boolean;
  /** 拍照 / 相册 / 文件。上传成功后清空，原件不再占手机空间。 */
  attachments?: LocalAttachment[];
  /** 服务端收下的附件清单（issue #53）。上传成功时由回包填，换台手机由 `pullInbox()` 填。 */
  remoteAttachments?: RemoteAttachment[];
  /** 服务端 staging 行的 id，用来做核对与确认。 */
  stagingId?: string;
  /**
   * 服务端把这条处理到哪一步了（`staging.status`）。由 `pullInbox()` 回填。
   *
   * 🔴 **和 `sync` 是两件事，不能合并**（D87 · issue #21②）：
   * `sync` 说的是「这条**传上去**了没有」，这一格说的是「服务端**处理**得怎么样」。
   * 一条 `sync='synced'` + `stagingStatus='failed'` 的速记，
   * 在界面上必须长得和「传完了、一切正常」不一样 —— 而在这一格存在之前，
   * 它们长得一模一样：都是一条没有转录的语音卡片。
   */
  stagingStatus?: string;
  /**
   * 服务端的失败原因（`staging.error`）。⚠️ 存**服务端原文**，不过 `t()`（D80 判据②）。
   * 和 `lastError`（上传失败）分开：一个是「没传上去」，一个是「传上去了但没处理成」。
   */
  stagingError?: string;
  /**
   * 要不要交给 AI 整理。**默认不交**（D31）——
   * 速记页只管把话记下来；AI 那一屏发出来的才带这个标记。
   * 事后想让它整理，用「发给 AI」（`POST /inbox/:id/agent`）。
   */
  toAgent?: boolean;
  /**
   * 上一次交给 AI 整理的时刻（issue #16）。
   *
   * 🔴 它是防重复的**第一层**：60 秒内不让再发，之后再发要二次确认。
   * 真正的护栏在服务端（`ready` 必须带 `force`）—— 这里挡的是
   * 「按了没反应就再按一下」那种，而那恰恰是展会现场最常发生的一种。
   */
  sentToAgentAt?: number;
  /**
   * 这一句是**改口重发**，取代对话里的哪条消息（D90 · issue #23）。
   *
   * 🔴 服务端拿它做的事只有一件：在派生表里记一句「那条不再是活的那一条」。
   * **原来那行一个字都不会改** —— `thread_message` 和 `inbox` 都只增不改
   * （§4.2 第 2 条，库里有触发器）。改口之前说过的那句话永久留着。
   *
   * ⚠️ 存的是**服务端的消息 id**，所以只有联网发出去的那条才谈得上改口；
   * 还没上传的那条直接在输入框里改就行，根本不需要走这条路。
   * ⚠️ 不需要 Dexie 版本升级 —— 它不进索引（升级 schema 会在**每台手机上**跑一次，
   * 万一打不开库，连 notes 里还没传上去的录音一起打不开）。
   */
  supersedesMessageId?: string;
};

/** 客户名单。来自网关 `GET /companies`（它再从 Twenty 拉）。缓存下来供离线用。 */
export type Company = {
  /** 🔴 Twenty 的记录 UUID —— **确认入库时必须传这个**，不是 code（§4.2 第3条） */
  id: string;
  code: string;
  name: string;
  group: string;
  type: string;
};

/** 待确认队列。服务端 `staging` 表的投影，字段名保持 snake_case 与契约一致。 */
export type StagingItem = {
  id: string;
  inbox_id: string;
  status: string;
  proposal_items?: ProposalItemView[];
  item_summary?: Record<string, unknown> | null;
  /** 语音转写结果。**独立于原文**，重跑转写不动 inbox */
  transcript: string | null;
  /** 人改定的正文（issue #15/#16）。有它就以它为准 —— 前两层原样留着。 */
  edited_text?: string | null;
  /** 自动标题（issue #15）。装饰，没有就退回正文首句。 */
  title?: string | null;
  /** 服务端 LLM 抽出来的字段 —— 不是前端那个关键词 mock */
  extracted: Record<string, unknown>;
  confidence: Record<string, string>;
  suggested_company: string | null;
  company_code: string | null;
  text: string | null;
  audio_seconds: number | null;
  captured_at: string;
  display_name: string;
  error: string | null;
  /** 达到上限 / 超时 —— 结果是真的，但可能不全。界面上必须说出来。 */
  partial?: boolean;
  /** 这条属于哪次对话。同一条对话只有最新一版可确认（issue #14）。 */
  thread_id?: string | null;
  /**
   * 这一版取代了同一条对话里的几版（issue #14）。
   * 🔴 折叠掉的必须在界面上提一句 —— **「看不见」和「不存在」必须分得开**。
   */
  supersedes?: number;
};

/**
 * 我的一条记录 —— 看板表格的一行（D76）。
 *
 * 🔴 **和 `StagingItem` 的区别不是字段，是「哪些行会出现」。**
 * `StagingItem` 来自 `GET /staging?status=ready`，只有等确认的那些；
 * 这个来自 `GET /records`，**不按状态过滤** —— 已入库的、失败的、
 * 被取代的、还在跑的全都在。
 *
 * 为什么非要把失败的也列出来：一条录了却没进 CRM 的记录，如果表格上不显示，
 * 在人这边就是彻底不存在的。「界面绿色、东西没进去」是这个仓库最贵的那类 bug。
 */
export type RecordRow = {
  id: string;
  inbox_id: string;
  /** 去对话里确认时要用。补送给 AI 的那些记在 staging 上，服务端已经 coalesce 过。 */
  thread_id: string | null;
  status: string;
  proposal_items?: ProposalItemView[];
  item_summary?: Record<string, unknown> | null;
  title: string | null;
  /** 三层文字里最靠下那层（人改定的 > 机器听的 > 人打的），服务端算好。 */
  text: string | null;
  extracted: Record<string, unknown>;
  confidence: Record<string, string> | null;
  /** D75：人上次确认时改过的那几格。显示要以它为准，不是 extracted 的旧值。 */
  confirmed_fields: Record<string, unknown> | null;
  /** D75：入库回执。重录按里面的 id 更新替代，绝不新建第二份。 */
  twenty_refs: Record<string, string> | null;
  confirm_after: string | null;
  partial: boolean | null;
  suggested_company: string | null;
  error: string | null;
  /**
   * 确认入库那一刻定下的 Twenty company id。
   * 🔴 归属是**入库时**才定的（D28 修订），所以已入库的行要靠它认客户，
   * `company_code`（录入时那一刻的）对它们往往是空的。
   */
  resolved_company_id: string | null;
  company_code: string | null;
  audio_seconds: number | null;
  visit_label: string | null;
  captured_at: string;
  updated_at: string;
  supersedes: number;
  attachments: number;
};

/** 一条对话。列表页用。 */
export type Thread = {
  /** Cache scope on shared devices; legacy unscoped cache entries are not displayed. */
  recordedBy?: string;
  id: string;
  title: string | null;
  company_code: string | null;
  created_at: string;
  last_message_at: string;
  messages: number;
};

/** 一个枚举选项。值给服务端，标签给人看。 */
export type EnumOption = { value: string; label: string };

/**
 * 全部枚举。**必须缓存** —— 核对卡上的「改一格」（手册 P8）弹的就是它。
 *
 * 展馆断网时那个弹层不能是空的：改字段恰恰是在现场最需要的动作，
 * 而它是纯前端交互（改的只是「这次读出了什么」，不碰原文）。
 * 存成一行，`id` 固定是 `'v1'` —— 这张表永远只有一条记录。
 */
export type EnumSet = {
  id: string;
  recordType: EnumOption[];
  category: EnumOption[];
  stage: EnumOption[];
  caseStatus: EnumOption[];
  severity: EnumOption[];
  confidence: EnumOption[];
  accountType: EnumOption[];
};

/**
 * 一份 2C 问卷（D138）。**和速记分开放**：它不进 inbox、不走 agent，
 * 上传去的是 `POST /surveys`，网关直接写进 Twenty。
 *
 * `id` 就是幂等键（网关的 `client_id`），断网重传不会多出一位客户。
 * 答案存题目/选项 id（`survey.ts`），不存文字 —— 换语言、改措辞都不影响统计。
 */
export type LocalSurvey = {
  id: string;
  surveyKey: string;
  answers: Record<string, unknown>;
  /**
   * 姓名 / 电话 / 邮箱 / 邮编。**传上去之后本地就清掉**（R20）：
   * 服务端已经有了，手机丢了不该连带一串消费者的电话。答案留着，给「今天几份」数数。
   */
  contact?: { name?: string; email?: string; phone?: string; postcode?: string };
  consentAt?: string;
  createdAt: number;
  recordedBy: string;
  sync: SyncState;
  attempts: number;
  lastError?: string;
};

class CaptureDb extends Dexie {
  notes!: Table<Note, string>;
  companies!: Table<Company, string>;
  staging!: Table<StagingItem, string>;
  threads!: Table<Thread, string>;
  enums!: Table<EnumSet, string>;
  records!: Table<RecordRow, string>;
  surveys!: Table<LocalSurvey, string>;

  constructor() {
    super('boothnote-capture');
    this.version(1).stores({
      notes: 'id, sync, createdAt, companyCode',
    });
    // v2：补 recordedBy 索引 —— 个人看板要按录入人过滤（D34），
    // 没索引时 Dexie 会抛 "KeyPath recordedBy ... is not indexed"，页面静默变成全 0。
    this.version(2).stores({
      notes: 'id, sync, createdAt, companyCode, recordedBy',
    });
    // v3：归属改为可空（D28 修订）。Dexie 的索引会自动跳过 undefined，无需迁移数据。
    this.version(3).stores({
      notes: 'id, sync, createdAt, companyCode, recordedBy',
    });
    // v4：缓存服务端的客户名单与待确认队列。
    // **两者都必须能离线读** —— 展馆断网时下拉不能是空的，Agent 页也不该是白屏。
    this.version(4).stores({
      notes: 'id, sync, createdAt, companyCode, recordedBy',
      companies: 'id, code, name',
      staging: 'id, status, created_at',
    });
    // v5：对话线程 + 附件。附件是 Blob，直接挂在 note 上（不单开表）——
    // Dexie 能存 Blob，而分表意味着「note 删了附件还在」这种孤儿状态。
    this.version(5).stores({
      notes: 'id, sync, createdAt, companyCode, recordedBy, threadId',
      companies: 'id, code, name',
      staging: 'id, status, created_at',
      threads: 'id, last_message_at',
    });
    // v6：枚举与中文标签。核对卡的「改一格」离线也要能弹出选项 ——
    // 现场改字段的需求恰恰在没信号的展馆里最强。
    this.version(6).stores({
      notes: 'id, sync, createdAt, companyCode, recordedBy, threadId',
      companies: 'id, code, name',
      staging: 'id, status, created_at',
      threads: 'id, last_message_at',
      enums: 'id',
    });
    /**
     * v7：补 `stagingId` 索引。
     *
     * 🔴 **和 v2 补 `recordedBy` 是同一个错，我又犯了一遍。**
     * 确认入库之后要把选中的客户回写到本地那条速记（`tagNoteWithCompany`），
     * 查询是 `.where('stagingId')` —— 没索引时 Dexie **抛异常**，
     * 而调用点写的是 `void tagNoteWithCompany(...)`，异常被吞掉：
     * 界面完全正常，只是客户名永远不出现（2026-08-03 Chrome 实测抓到）。
     *
     * 判据：**Dexie 的 `.where(x)` 之前先确认 x 在索引里**，
     * 而且这类调用不许裸 `void` —— 要么 await，要么显式 catch 并说出来。
     */
    this.version(7).stores({
      notes: 'id, sync, createdAt, companyCode, recordedBy, threadId, stagingId',
      companies: 'id, code, name',
      staging: 'id, status, created_at',
      threads: 'id, last_message_at',
      enums: 'id',
    });
    /**
     * v8：`editedAt` 进索引（issue #15/#16 的「速记可以改」）。
     *
     * 🔴 **第三次了。** v2 补 `recordedBy`、v7 补 `stagingId`，都是同一个错：
     * 写了 `.where('editedAt')` 而它不在索引里 → Dexie **抛异常**，
     * 而调用点在 `flush()` 里被 try 吞掉 —— 界面完全正常，
     * 只是**修改永远推不上去**，换台设备就看不到自己改过的内容。
     *
     * 判据（第三次写下来）：**`.where(x)` 之前先确认 x 在这张表的索引里。**
     */
    this.version(8).stores({
      notes: 'id, sync, createdAt, companyCode, recordedBy, threadId, stagingId, editedAt',
      companies: 'id, code, name',
      staging: 'id, status, created_at',
      threads: 'id, last_message_at',
      enums: 'id',
    });
    /**
     * v9：看板表格的离线缓存（D76）。
     *
     * ⚠️ **`captured_at` 必须在索引里** —— 读它的地方写的是
     * `db.records.orderBy('captured_at')`，而这个仓库已经因为
     * 「`.where`/`.orderBy` 的键没进索引」栽过三次（v2 的 `recordedBy`、
     * v7 的 `stagingId`、v8 的 `editedAt`），每次都是 Dexie 抛异常、
     * 调用点吞掉、界面看着完全正常。第四次了，判据照抄：
     * **`.where(x)` / `.orderBy(x)` 之前先确认 x 在这张表的索引里。**
     */
    this.version(9).stores({
      notes: 'id, sync, createdAt, companyCode, recordedBy, threadId, stagingId, editedAt',
      companies: 'id, code, name',
      staging: 'id, status, created_at',
      threads: 'id, last_message_at',
      enums: 'id',
      records: 'id, captured_at, status',
    });
    /**
     * v10：2C 问卷（D138）。读它的地方是 `.where('sync')`（补传）和
     * `.where('recordedBy')`（只数自己的，T30）—— **两个都在索引里**
     * （v2 / v7 / v8 / v9 那四次的教训）。
     */
    this.version(10).stores({
      notes: 'id, sync, createdAt, companyCode, recordedBy, threadId, stagingId, editedAt',
      companies: 'id, code, name',
      staging: 'id, status, created_at',
      threads: 'id, last_message_at',
      enums: 'id',
      records: 'id, captured_at, status',
      surveys: 'id, sync, createdAt, recordedBy',
    });
  }
}

export const db = new CaptureDb();

/**
 * 🔴 **所有读速记的地方都必须走这里。**（T30）
 *
 * 展会上一定会发生的事：一台手机被两个人先后用。IndexedDB 是按域名存的，
 * 换个人登录之后**上一个人的速记还在本地**。直接 `db.notes.toArray()` 就会
 * 把别人的东西显示给现在这个人看 —— 而且因为看起来完全正常，没有人会发现。
 *
 * 退出登录**不删**本地数据（没传上去的还要等原主人回来补传，见 Me 页），
 * 所以隔离只能靠每次查询都带上 recordedBy。
 */
export const myNotes = (userCode: string | undefined) =>
  db.notes.where('recordedBy').equals(userCode ?? '\u0000never');

export const countBySync = async (state: SyncState, userCode?: string) =>
  userCode
    ? myNotes(userCode).and((n) => n.sync === state).count()
    : db.notes.where('sync').equals(state).count();

/** 同 `myNotes`：**只读自己的**（T30 —— 一台手机两个人用）。 */
export const mySurveys = (userCode: string | undefined) =>
  db.surveys.where('recordedBy').equals(userCode ?? '\u0000never');
