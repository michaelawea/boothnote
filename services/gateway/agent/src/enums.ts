/**
 * 枚举白名单 —— **唯一来源**。
 *
 * 为什么单独一个文件：上一版这些常量散在 `ai.ts` 的 prompt 字符串里，
 * 于是「代码加了一个品类、prompt 忘了加」是随时会发生的事，而且不会报错，
 * 只会让模型永远抽不出那个新品类。现在 prompt、白名单校验、`list_enums`
 * 这个工具三处都从这里取，改一处即可。
 *
 * 与 `scripts/twenty-schema.mjs` 的关系：那边是 Twenty 侧 schema 的真相源，
 * 这边是网关侧的副本。两边不一致会被集成测试抓到（枚举对不上 → 白名单全丢弃）。
 */

import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS } from './host.ts';

export const CATEGORIES = [
  'BATTERY',
  'INVERTER',
  'MONITOR_EIOT',
  'DISTRIBUTION_BOX',
  'ACDC_CHARGER',
  'DCDC_CHARGER',
  'BATTERY_CHARGER',
  'SOLAR_PANEL',
] as const;

export const STAGES = [
  'NOT_CONTACTED',
  'CONTACTED',
  'SAMPLE_TESTING',
  'VEHICLE_VALIDATION',
  'RFQ_QUOTE',
  'NOMINATED',
  'SOP',
  'MASS_PRODUCTION',
  'DORMANT',
] as const;

/**
 * 新建客户时必填（维护者 2026-07-30）：名字、国家、类型缺一不可。
 *
 * 🔴 **这些值必须和 `scripts/twenty-schema.mjs` 的 `ACCOUNT_TYPES` 逐字对应。**
 *
 * 我第一版凭印象编了 `RENTAL` / `CONVERTER` / `OTHER` 三个 Twenty 里根本没有的，
 * 还漏了真实存在的 `OEM_SUB_GROUP`。后果：界面上能选「其他」，
 * 一提交就 500 —— `Invalid value "OTHER" for field "accountType"`（2026-08-03 实测）。
 *
 * 这正是这个文件开头那句话要防的事，而我自己违反了它：
 * **枚举只能有一个来源。** 现在多了一条集成测试，拿 Twenty 的真实选项对一遍。
 */
export { ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS };

/**
 * 渠道链从上游到下游的顺序（D54）。
 *
 * 🔴 **这根轴和集团树（`parentCompany`）是两回事。**
 * 「Rovena 的上级是 KWR」在集团意义上是错的 —— KWR 只是卖给终端客户的那家经销商，
 * 它不拥有 Rovena。混进一棵树之后，「这个集团下面有几个品牌」和
 * 「这家经销商下面有几个终端客户」会同时算错，而且没有人会立刻发现。
 *
 * 中间层可以缺（分销商直接卖给终端客户是常见的），但**顺序不能反**。
 */
export const CHAIN_ORDER = [
  'DISTRIBUTOR',
  'SUB_DISTRIBUTOR',
  'DEALER',
  'SUB_DEALER',
  'END_USER',
] as const;

export type ChainRole = (typeof CHAIN_ORDER)[number];

/** 这一环在链上排第几。不在链上（OEM 那三个）返回 -1。 */
export const chainRank = (t: string): number =>
  (CHAIN_ORDER as readonly string[]).indexOf(t);

/**
 * 一条链合不合法：**必须严格从上游到下游**，允许跳级。
 * 「分销商 → 终端客户」可以；「终端客户 → 分销商」不行。
 */
export const isValidChain = (types: string[]): boolean => {
  const ranks = types.map(chainRank);
  if (ranks.some((r) => r < 0)) return false;
  return ranks.every((r, i) => i === 0 || r > ranks[i - 1]!);
};

/**
 * 🔴 **这条速记该落成哪种记录。**
 *
 * 之前没有这个字段 —— 于是「帮我记录一下这个售后问题」被抽成了
 * `category=MONITOR_EIOT` 的**产品选型情报**，人去 CRM 的「售后问题」里找是空的
 * （维护者 2026-08-03 实测）。模型当时没做错什么：**它没有任何地方可以表达
 * 「这是售后」**。缺的是字段，不是提示词。
 */
export const RECORD_TYPES = ['fitment', 'support'] as const;

/** 售后问题的状态与严重度（对应 twenty-schema.mjs 的 supportCase）。 */
export const CASE_STATUSES = ['NEW', 'ACKNOWLEDGED', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED'] as const;
export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

/** 情报项的取值类型（对应 twenty-schema.mjs 里 intelItem.valueType）。 */
export const VALUE_TYPES = ['text', 'number', 'select', 'boolean'] as const;

/**
 * 界面上的中文。
 *
 * 🔴 **值来自这个文件，标签必须和 `scripts/twenty-schema.mjs` 的中文部分逐字一致。**
 * 那边是 Twenty 侧的真相源，人在 CRM 里看到的是那边的字。
 * 两边写得不一样，就会出现「手机上选的是『样品/台架测试』、
 * CRM 里显示的是别的词」，而没有人会想到去查这是同一个值。
 *
 * ⚠️ **2026-08-07（D78）起 schema 那边是双语的**（`"Sample Testing 样品/台架测试"`）——
 * Twenty 的元数据里一个 label 只能有一个值，没有多语言机制（实测 `Field` 类型上
 * 连 locale 字段都没有），所以只能把两种语言塞进同一个字符串。
 * 手机上没必要显示两遍，**这里仍然只放中文**，两边靠「中文那一半」对齐。
 *
 * 有一条集成测试拿 `twenty-schema.mjs` 逐条对（比中文部分），改了一边不改另一边会红。
 */
export const CATEGORY_LABELS: Record<string, string> = {
  BATTERY: 'Battery 电池',
  INVERTER: 'Inverter 逆变器',
  MONITOR_EIOT: 'Monitor / EIOT 显示屏',
  DISTRIBUTION_BOX: 'Distribution Box 配电盒',
  ACDC_CHARGER: 'AC/DC Charger Controller',
  DCDC_CHARGER: 'DC/DC Charger Controller',
  BATTERY_CHARGER: 'Battery Charger 充电器',
  SOLAR_PANEL: 'Solar Panel 太阳能板',
};

export const STAGE_LABELS: Record<string, string> = {
  NOT_CONTACTED: '未接触',
  CONTACTED: '已接触',
  SAMPLE_TESTING: '样品/台架测试',
  VEHICLE_VALIDATION: '整车验证',
  RFQ_QUOTE: 'RFQ / 报价',
  NOMINATED: 'Nominated 定点',
  SOP: 'SOP',
  MASS_PRODUCTION: '量产',
  DORMANT: 'Dormant（须填原因）',
};

export const CASE_STATUS_LABELS: Record<string, string> = {
  NEW: '新报',
  ACKNOWLEDGED: '已受理',
  IN_PROGRESS: '处理中',
  WAITING_CUSTOMER: '等客户回复',
  RESOLVED: '已解决',
  CLOSED: '已关闭',
};

export const SEVERITY_LABELS: Record<string, string> = {
  LOW: '低',
  MEDIUM: '中',
  HIGH: '高',
  CRITICAL: '严重',
};

export const RECORD_TYPE_LABELS: Record<string, string> = {
  fitment: '选型情报',
  support: '售后问题',
  project: '项目',
  followup: '项目跟进',
};

/**
 * 情报与在位品牌的可信度（对应 `productFitment.confidence` / `intelValue.confidence`）。
 *
 * 手册 P18 那一页整页在讲这件事：**传闻必须标成传闻**。
 * 「传闻被当成事实用下去，才是真正的坏账。」
 * 之前这个值在 `confirm.ts` 里写死成 `LIKELY`，人没有办法把它降下来。
 */
// ── D59：项目执行链 ─────────────────────────────────────────────────
/**
 * 一条速记最后落成哪一类记录。
 *
 * 原来只有 fitment / support 两种，于是 test_example 的 T02–T05
 * （建项目、跟进、拆任务线程、生成文档）**没有任何地方可以表达**。
 * 和当初 `support` 缺失时一模一样：缺的是字段，不是提示词。
 */
export const RECORD_TYPES_V2 = ['fitment', 'support', 'project', 'followup'] as const;

/** 任务线程的四类 + 里程碑。T04 要求「按文档、硬件接口、通信协议、测试软件拆开」。 */
export const THREAD_TYPES = ['doc', 'hardware', 'protocol', 'software', 'milestone', 'other'] as const;
export const THREAD_TYPE_LABELS: Record<string, string> = {
  doc: '文档',
  hardware: '硬件接口',
  protocol: '通信协议',
  software: '测试软件',
  milestone: '里程碑',
  other: '其他',
};

export const PRIORITIES = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'] as const;
export const PRIORITY_LABELS: Record<string, string> = {
  URGENT: '紧急',
  HIGH: '高',
  MEDIUM: '中',
  LOW: '低',
};

export const ITEM_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING', 'DONE', 'CANCELLED'] as const;
export const ITEM_STATUS_LABELS: Record<string, string> = {
  OPEN: '待处理',
  IN_PROGRESS: '处理中',
  WAITING: '等对方',
  DONE: '已完成',
  CANCELLED: '已取消',
};

/**
 * 🔴 **文档来源。这一栏是整个 projectDoc 对象存在的理由。**
 *
 * 客户给的规格书 / AI 生成的整理稿 / 按口述记的需求 —— 三者在 CRM 里长得一样的话，
 * 迟早有人拿 AI 整理的参数去下单。test_example 的跨用例断言写着：
 * 「输入附件、Agent 生成文档和原始口述能清楚区分来源」。
 */
export const DOC_SOURCES = ['CUSTOMER_ATTACHMENT', 'AGENT_GENERATED', 'DICTATION', 'INTERNAL'] as const;
export const DOC_SOURCE_LABELS: Record<string, string> = {
  CUSTOMER_ATTACHMENT: '客户提供的附件',
  AGENT_GENERATED: 'AI 生成',
  DICTATION: '按口述整理',
  INTERNAL: '我方内部编写',
};

export const REVIEW_STATUSES = ['DRAFT', 'IN_REVIEW', 'CUSTOMER_CONFIRMED', 'SUPERSEDED'] as const;
export const REVIEW_STATUS_LABELS: Record<string, string> = {
  DRAFT: '草稿',
  IN_REVIEW: '评审中',
  CUSTOMER_CONFIRMED: '客户已确认',
  SUPERSEDED: '已被新版取代',
};

export const CONFIDENCES = ['CONFIRMED', 'LIKELY', 'RUMOR'] as const;
/**
 * ⚠️ 措辞是判据本身，不是文案：这三档说的是**录入的人离这件事有几手**。
 * 原来第一档写的是「本人说的」—— 「本人」指谁有歧义（客户本人？录入人本人？），
 * 而模型正是往「销售在转述客户的话」那个方向读的，于是一手会议记录全落 RUMOR（issue #3）。
 */
export const CONFIDENCE_LABELS: Record<string, string> = {
  CONFIRMED: '高 · 我在场',
  LIKELY: '中 · 有据可查',
  RUMOR: '低 · 听说的',
};

export type Category = (typeof CATEGORIES)[number];
export type Stage = (typeof STAGES)[number];
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export type ValueType = (typeof VALUE_TYPES)[number];
export type RecordType = (typeof RECORD_TYPES)[number];

const has = <T extends readonly string[]>(list: T, v: unknown): v is T[number] =>
  typeof v === 'string' && (list as readonly string[]).includes(v);

/** 不在白名单里就还成 null。**不指望模型自觉**（§4.2 第3条）。 */
export const keepCategory = (v: unknown) => (has(CATEGORIES, v) ? v : null);
export const keepStage = (v: unknown) => (has(STAGES, v) ? v : null);
export const keepAccountType = (v: unknown) => (has(ACCOUNT_TYPES, v) ? v : null);
export const keepValueType = (v: unknown) => (has(VALUE_TYPES, v) ? v : 'text');
/** 认不出就当选型 —— 那是绝大多数情况，也是原来唯一的行为。 */
export const keepRecordType = (v: unknown) => (has(RECORD_TYPES, v) ? v : 'fitment');
export const keepCaseStatus = (v: unknown) => (has(CASE_STATUSES, v) ? v : 'NEW');
export const keepSeverity = (v: unknown) => (has(SEVERITIES, v) ? v : 'MEDIUM');
/** 认不出就还成 null，由调用点决定默认 —— **不要在这里默认成「较可信」**（手册 P18）。 */
export const keepConfidence = (v: unknown) => (has(CONFIDENCES, v) ? v : null);

// ── D59 的白名单。**和别处一样：不在表里的一律还成安全默认。** ──────
export const keepRecordTypeV2 = (v: unknown) => (has(RECORD_TYPES_V2, v) ? v : 'fitment');
export const keepThreadType = (v: unknown) => (has(THREAD_TYPES, v) ? v : 'other');
export const keepPriority = (v: unknown) => (has(PRIORITIES, v) ? v : 'MEDIUM');
export const keepItemStatus = (v: unknown) => (has(ITEM_STATUSES, v) ? v : 'OPEN');
/**
 * 🔴 认不出来源时**默认 AGENT_GENERATED**，不是 CUSTOMER_ATTACHMENT。
 * 宁可把客户给的东西误标成 AI 生成（有人会来纠正），
 * 也不能把 AI 生成的误标成客户提供的（没人会怀疑，然后拿去下单）。
 */
export const keepDocSource = (v: unknown) => (has(DOC_SOURCES, v) ? v : 'AGENT_GENERATED');

// ══════════════════════════════════════════════════════════════════
//  英文标签（D80 · PWA 英文版）
//
//  🔴 **为什么另起一份而不是把上面那些改成双语。**
//     `twenty-schema.mjs` 那边只能塞一个字符串（Twenty 元数据没有多语言机制，
//     D78），所以那边是 `"Sample Testing 样品/台架测试"`。
//     但手机上**语言是跟账号走的**（D80）——中文用户看中文、英文用户看英文，
//     没有任何人需要同时看到两遍。塞双语在 375px 的 chip 上是灾难。
//
//  ⚠️ **英文取自 `twenty-schema.mjs` 里那一半，逐字一致。**
//     有一条集成测试拿 schema 逐条对：schema 的 label 必须以中文那份结尾、
//     以英文那份开头。改了一边不改另一边会红。
// ══════════════════════════════════════════════════════════════════

export const CATEGORY_LABELS_EN: Record<string, string> = {
  BATTERY: 'Battery',
  INVERTER: 'Inverter',
  MONITOR_EIOT: 'Monitor / EIOT',
  DISTRIBUTION_BOX: 'Distribution Box',
  ACDC_CHARGER: 'AC/DC Charger Controller',
  DCDC_CHARGER: 'DC/DC Charger Controller',
  BATTERY_CHARGER: 'Battery Charger',
  SOLAR_PANEL: 'Solar Panel',
};

export const STAGE_LABELS_EN: Record<string, string> = {
  NOT_CONTACTED: 'Not Contacted',
  CONTACTED: 'Contacted',
  SAMPLE_TESTING: 'Sample Testing',
  VEHICLE_VALIDATION: 'Vehicle Validation',
  RFQ_QUOTE: 'RFQ / Quote',
  NOMINATED: 'Nominated',
  SOP: 'SOP',
  MASS_PRODUCTION: 'Mass Production',
  DORMANT: 'Dormant (reason required)',
};

export const CASE_STATUS_LABELS_EN: Record<string, string> = {
  NEW: 'New',
  ACKNOWLEDGED: 'Acknowledged',
  IN_PROGRESS: 'In Progress',
  WAITING_CUSTOMER: 'Waiting Customer',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

export const SEVERITY_LABELS_EN: Record<string, string> = {
  LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', CRITICAL: 'Critical',
};

export const RECORD_TYPE_LABELS_EN: Record<string, string> = {
  fitment: 'Fitment', support: 'Support Case', project: 'Project', followup: 'Follow-up',
};

/** 可信度。中文那份带「我在场 / 有据可查 / 听说的」的语气，英文保持同样的直白。 */
export const CONFIDENCE_LABELS_EN: Record<string, string> = {
  CONFIRMED: 'High · I was there',
  LIKELY: 'Medium · documented',
  RUMOR: 'Low · hearsay',
};

export const ACCOUNT_TYPE_LABELS_EN: Record<string, string> = {
  OEM_GROUP: 'OEM Group',
  OEM_SUB_GROUP: 'OEM Sub-Group',
  OEM_BRAND: 'OEM Brand',
  DISTRIBUTOR: 'distributor',
  SUB_DISTRIBUTOR: 'sub-distributor',
  DEALER: 'dealer',
  SUB_DEALER: 'sub-dealer',
  END_USER: 'End User',
};

export type Locale = 'zh' | 'en';

/**
 * 按语言取一组标签。**找不到英文时退回中文** —— 显示中文比显示一个裸的
 * `SAMPLE_TESTING` 好得多：前者至少人能猜，后者只有开发看得懂。
 */
export const labelsFor = (
  locale: Locale,
  zh: Record<string, string>,
  en: Record<string, string>,
): Record<string, string> => (locale === 'en' ? { ...zh, ...en } : zh);
