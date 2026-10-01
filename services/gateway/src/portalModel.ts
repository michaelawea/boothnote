/**
 * 客户项目进度：门户 ⇄ 网关 ⇄ Twenty 之间的**纯函数**（D139–D142 · docs/portal-projects.md）。
 *
 * 这里不 import `db.ts`、不碰网络 —— 调 Twenty 在 `twenty.ts`，路由在 `portal.ts`。
 * 分开是为了「哪些输入会被收下、落到哪一列、客户那边读到什么」能不起服务地单测。
 *
 * 🔴 三件事全在这一个文件里定，别的地方不许再写第二份：
 *   ① **写进来的东西长什么样**（消毒 + 长度上限 + 枚举）——门户那边也消毒一遍，那是纵深，不是替代；
 *   ② **读出去的东西长什么样**（快照的形状，SELECT 一律 camelCase、布尔一律 true/false）；
 *   ③ **布尔只认 `=== true`**：Twenty 里没填的 BOOLEAN 读回来是 null（实测），
 *      `portalVisible` / `customerVisible` 空值 = 不公开 —— 失败即关闭。
 *
 * 🔴 枚举有两份：这里和 `scripts/twenty-schema.mjs`。网关镜像里读不到后者，
 * 只能各存一份 —— `portalModel.test.ts` 逐个对账，多一个少一个都红。
 */
import { toEnum } from './survey.ts';

// ── 枚举（与 twenty-schema.mjs 的 PROJECT_STATUSES / PROJECT_UPDATE_KINDS / DATE_PRECISIONS 对账）──
export const PROJECT_STATUSES = ['active', 'onHold', 'done', 'cancelled'] as const;
export const UPDATE_KINDS = ['communication', 'milestone', 'stageChange', 'note'] as const;
export const DATE_PRECISIONS = ['minute', 'day'] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type UpdateKind = (typeof UPDATE_KINDS)[number];
export type DatePrecision = (typeof DATE_PRECISIONS)[number];

/** 门户能建的进展类型。stageChange 只由网关在换阶段时自动写（D139）。 */
export const PORTAL_KINDS = ['communication', 'milestone', 'note'] as const;

/** 「还在跑」的项目 —— 停用它的类型会被拒（type_in_use）。 */
export const LIVE_STATUSES: readonly ProjectStatus[] = ['active', 'onHold'];

/**
 * 长度上限。和门户那边的消毒上限逐个相同（门户先挡，网关再挡一次）。
 * **超了就拒，不截断** —— 静默截掉客户看到的那句话，比报错更难发现。
 */
export const LIMITS = {
  projectName: 120,
  title: 160,
  customerSummary: 1000,
  customerMessage: 2000,
  summary: 4000,
  result: 4000,
  party: 160, // initiator / recipient
  typeName: 80,
  typeDescription: 500,
  stageName: 60,
  stageNameZh: 60,
  stagesMin: 1,
  stagesMax: 20,
  clientId: 64,
  actor: 80,
} as const;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_ID_RE = /^[A-Za-z0-9_.:-]{8,64}$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// ── 枚举换算 ────────────────────────────────────────────────────────
/** `ON_HOLD` → `onHold`，`OEM_SUB_GROUP` → `oemSubGroup`。和 toEnum 互逆（测试里对过全部现有枚举）。 */
export const camelOf = (upper: string): string =>
  String(upper)
    .toLowerCase()
    .replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

/** Twenty 读回来的 UPPER_SNAKE → 我们的 camelCase；不认识的 → null（不猜）。 */
export const fromEnum = <T extends string>(raw: unknown, allowed: readonly T[]): T | null => {
  if (typeof raw !== 'string' || !raw) return null;
  const hit = allowed.find((v) => toEnum(v) === raw.toUpperCase() || v === raw);
  return hit ?? null;
};

/** 没有固定清单的 SELECT（accountType / projectStage）：原样换成 camelCase，空 → null。 */
const looseEnum = (raw: unknown): string | null =>
  typeof raw === 'string' && raw ? camelOf(raw) : null;

// ── 日期 ────────────────────────────────────────────────────────────
/** `YYYY-MM-DD` 且是真实存在的日子（2026-02-30 不算）。 */
export const isRealDay = (s: string): boolean => {
  const m = DAY_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
};

/**
 * 发生时间按精度规范化。
 *
 * · `day`：**取调用方写的那个日历日**（字符串的前 10 位，不先换算时区），存成当天正午 UTC ——
 *   欧洲任何时区显示都落在同一天。先换算的话「柏林 00:30 的 9 月 30 日」会变成 UTC 的 29 日。
 * · `minute`：任何 Date.parse 认得的 ISO 时间 → 标准 ISO（UTC）。
 * 认不出 → null（调用方报错）。
 */
export const normalizeOccurredAt = (raw: string, precision: DatePrecision): string | null => {
  const s = raw.trim();
  if (precision === 'day') {
    const day = s.slice(0, 10);
    if (!isRealDay(day)) return null;
    // 后面如果还有东西，得是个合法时间 —— 「2026-09-30garbage」不收
    if (s.length > 10 && Number.isNaN(Date.parse(s))) return null;
    return `${day}T12:00:00.000Z`;
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

// ── 消毒工具 ────────────────────────────────────────────────────────
type Body = Record<string, unknown>;
const asBody = (raw: unknown): Body | null =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Body) : null;

const unknownKeys = (b: Body, allowed: readonly string[], errors: string[]) => {
  for (const k of Object.keys(b)) if (!allowed.includes(k)) errors.push(`${k}: unknown field`);
};

/**
 * 读一个文本字段。
 * · 没给（undefined）→ undefined（PATCH 里 = 不改）
 * · null → 可清空的字段返回 ''，不可清空的报错
 * · 字符串 → trim；必填且为空报错；超长报错（不截断）
 */
const text = (
  b: Body,
  key: string,
  max: number,
  errors: string[],
  opt: { required?: boolean; clearable?: boolean } = {},
): string | undefined => {
  const v = b[key];
  if (v === undefined) {
    if (opt.required) errors.push(`${key}: required`);
    return undefined;
  }
  if (v === null) {
    if (opt.clearable) return '';
    errors.push(`${key}: must be a string`);
    return undefined;
  }
  if (typeof v !== 'string') {
    errors.push(`${key}: must be a string`);
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (opt.required && !s) {
    errors.push(`${key}: required`);
    return undefined;
  }
  if (s.length > max) {
    errors.push(`${key}: longer than ${max} characters`);
    return undefined;
  }
  return s;
};

const uuid = (b: Body, key: string, errors: string[], opt: { required?: boolean; nullable?: boolean } = {}) => {
  const v = b[key];
  if (v === undefined) {
    if (opt.required) errors.push(`${key}: required`);
    return undefined;
  }
  if (v === null && opt.nullable) return null;
  if (typeof v !== 'string' || !UUID_RE.test(v)) {
    errors.push(`${key}: must be an existing record id (UUID)`);
    return undefined;
  }
  return v.toLowerCase();
};

/**
 * 🔴 **布尔只收真正的布尔。** `"true"` / `1` / `"yes"` 一律报错 ——
 * 猜一次「"false" 是 true」（非空字符串）就是把内部记录公开给客户。
 */
const bool = (b: Body, key: string, errors: string[], opt: { required?: boolean } = {}) => {
  const v = b[key];
  if (v === undefined) {
    if (opt.required) errors.push(`${key}: required (true or false)`);
    return undefined;
  }
  if (v !== true && v !== false) {
    errors.push(`${key}: must be true or false`);
    return undefined;
  }
  return v;
};

const oneOf = <T extends string>(b: Body, key: string, allowed: readonly T[], errors: string[]): T | undefined => {
  const v = b[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    errors.push(`${key}: must be one of ${allowed.join(' | ')}`);
    return undefined;
  }
  return v as T;
};

const clientIdOf = (b: Body, errors: string[]) => {
  const v = b.clientId;
  if (typeof v !== 'string' || !CLIENT_ID_RE.test(v)) {
    errors.push('clientId: required (8–64 characters of A-Z a-z 0-9 _ . : -)');
    return undefined;
  }
  return v;
};

/** 门户 admin 用户名（X-Portal-Actor）→ authorName。空 / 不是字符串 → null。 */
export const actorName = (raw: unknown): string | null => {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, LIMITS.actor);
  return s || null;
};

// ═══════════════════════════════════════════════════════════════════
//  一、写进来：每个 /portal 写入口的消毒。返回 {value, errors}，errors 非空 = 400 invalid
// ═══════════════════════════════════════════════════════════════════

/** `nameZh` 没给 = 不改（PATCH）/ 空（新建）；给 null 或 '' = 清空。 */
export type StageInput = { id?: string; name: string; nameZh?: string };

const stagesOf = (b: Body, errors: string[], withIds: boolean): StageInput[] | undefined => {
  const v = b.stages;
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    errors.push('stages: must be an array');
    return undefined;
  }
  if (v.length < LIMITS.stagesMin || v.length > LIMITS.stagesMax) {
    errors.push(`stages: needs ${LIMITS.stagesMin}–${LIMITS.stagesMax} stages`);
    return undefined;
  }
  const out: StageInput[] = [];
  const names = new Set<string>();
  v.forEach((raw, i) => {
    const s = asBody(raw);
    if (!s) {
      errors.push(`stages[${i}]: must be an object`);
      return;
    }
    const errs: string[] = [];
    unknownKeys(s, withIds ? ['id', 'name', 'nameZh'] : ['name', 'nameZh'], errs);
    const name = text(s, 'name', LIMITS.stageName, errs, { required: true });
    const nameZh = text(s, 'nameZh', LIMITS.stageNameZh, errs, { clearable: true });
    const id = withIds ? uuid(s, 'id', errs) : undefined;
    for (const e of errs) errors.push(`stages[${i}].${e}`);
    if (errs.length || name === undefined) return;
    const k = name.toLowerCase();
    if (names.has(k)) errors.push(`stages[${i}].name: duplicate stage name "${name}"`);
    names.add(k);
    out.push({ ...(id ? { id } : {}), name, ...(nameZh !== undefined ? { nameZh } : {}) });
  });
  return out;
};

export type TypeCreate = { name: string; description: string; stages: StageInput[] };
export const sanitizeTypeCreate = (raw: unknown): { value: TypeCreate; errors: string[] } => {
  const errors: string[] = [];
  const b = asBody(raw) ?? {};
  if (!asBody(raw)) errors.push('body: must be a JSON object');
  unknownKeys(b, ['name', 'description', 'stages'], errors);
  const name = text(b, 'name', LIMITS.typeName, errors, { required: true });
  const description = text(b, 'description', LIMITS.typeDescription, errors, { clearable: true });
  const stages = stagesOf(b, errors, false);
  if (b.stages === undefined) errors.push('stages: required');
  return { value: { name: name ?? '', description: description ?? '', stages: stages ?? [] }, errors };
};

export type TypePatch = { name?: string; description?: string; isActive?: boolean; stages?: StageInput[] };
export const sanitizeTypePatch = (raw: unknown): { value: TypePatch; errors: string[] } => {
  const errors: string[] = [];
  const b = asBody(raw) ?? {};
  if (!asBody(raw)) errors.push('body: must be a JSON object');
  unknownKeys(b, ['name', 'description', 'isActive', 'stages'], errors);
  const value: TypePatch = {};
  const name = text(b, 'name', LIMITS.typeName, errors, { required: b.name !== undefined });
  if (name !== undefined) value.name = name;
  const description = text(b, 'description', LIMITS.typeDescription, errors, { clearable: true });
  if (description !== undefined) value.description = description;
  const isActive = bool(b, 'isActive', errors);
  if (isActive !== undefined) value.isActive = isActive;
  const stages = stagesOf(b, errors, true);
  if (stages !== undefined) value.stages = stages;
  if (!errors.length && !Object.keys(value).length) errors.push('body: nothing to change');
  return { value, errors };
};

export type ProjectCreate = {
  clientId: string;
  name: string;
  companyId: string;
  projectTypeId: string;
  currentStageId?: string;
  status?: ProjectStatus;
  portalVisible?: boolean;
  customerSummary?: string;
  targetDate?: string;
};

const targetDateOf = (b: Body, errors: string[], nullable: boolean): string | null | undefined => {
  const v = b.targetDate;
  if (v === undefined) return undefined;
  if (v === null && nullable) return null;
  if (typeof v !== 'string' || !isRealDay(v)) {
    errors.push('targetDate: must be YYYY-MM-DD');
    return undefined;
  }
  return v;
};

export const sanitizeProjectCreate = (raw: unknown): { value: ProjectCreate; errors: string[] } => {
  const errors: string[] = [];
  const b = asBody(raw) ?? {};
  if (!asBody(raw)) errors.push('body: must be a JSON object');
  unknownKeys(
    b,
    ['clientId', 'name', 'companyId', 'projectTypeId', 'currentStageId', 'status', 'portalVisible', 'customerSummary', 'targetDate'],
    errors,
  );
  const clientId = clientIdOf(b, errors);
  const name = text(b, 'name', LIMITS.projectName, errors, { required: true });
  const companyId = uuid(b, 'companyId', errors, { required: true });
  const projectTypeId = uuid(b, 'projectTypeId', errors, { required: true });
  const currentStageId = uuid(b, 'currentStageId', errors, { nullable: true });
  const status = oneOf(b, 'status', PROJECT_STATUSES, errors);
  const portalVisible = bool(b, 'portalVisible', errors);
  const customerSummary = text(b, 'customerSummary', LIMITS.customerSummary, errors, { clearable: true });
  const targetDate = targetDateOf(b, errors, true);
  return {
    value: {
      clientId: clientId ?? '',
      name: name ?? '',
      companyId: companyId ?? '',
      projectTypeId: projectTypeId ?? '',
      ...(currentStageId ? { currentStageId } : {}),
      ...(status ? { status } : {}),
      ...(portalVisible !== undefined ? { portalVisible } : {}),
      ...(customerSummary ? { customerSummary } : {}),
      ...(targetDate ? { targetDate } : {}),
    },
    errors,
  };
};

export type ProjectPatch = {
  name?: string;
  companyId?: string;
  projectTypeId?: string;
  currentStageId?: string;
  status?: ProjectStatus;
  portalVisible?: boolean;
  customerSummary?: string;
  /** null = 清空（契约里唯一允许 null 的一格）。 */
  targetDate?: string | null;
};

export const sanitizeProjectPatch = (raw: unknown): { value: ProjectPatch; errors: string[] } => {
  const errors: string[] = [];
  const b = asBody(raw) ?? {};
  if (!asBody(raw)) errors.push('body: must be a JSON object');
  if ('clientId' in b) errors.push('clientId: cannot be changed');
  unknownKeys(
    b,
    ['clientId', 'name', 'companyId', 'projectTypeId', 'currentStageId', 'status', 'portalVisible', 'customerSummary', 'targetDate'],
    errors,
  );
  const value: ProjectPatch = {};
  const name = text(b, 'name', LIMITS.projectName, errors, { required: b.name !== undefined });
  if (name !== undefined) value.name = name;
  const companyId = uuid(b, 'companyId', errors);
  if (companyId) value.companyId = companyId;
  const projectTypeId = uuid(b, 'projectTypeId', errors);
  if (projectTypeId) value.projectTypeId = projectTypeId;
  const currentStageId = uuid(b, 'currentStageId', errors);
  if (currentStageId) value.currentStageId = currentStageId;
  const status = oneOf(b, 'status', PROJECT_STATUSES, errors);
  if (status) value.status = status;
  const portalVisible = bool(b, 'portalVisible', errors);
  if (portalVisible !== undefined) value.portalVisible = portalVisible;
  const customerSummary = text(b, 'customerSummary', LIMITS.customerSummary, errors, { clearable: true });
  if (customerSummary !== undefined) value.customerSummary = customerSummary;
  const targetDate = targetDateOf(b, errors, true);
  if (targetDate !== undefined) value.targetDate = targetDate;
  if (!errors.length && !Object.keys(value).length) errors.push('body: nothing to change');
  return { value, errors };
};

export type UpdateCreate = {
  clientId: string;
  title: string;
  kind: UpdateKind;
  occurredAt: string | null;
  datePrecision: DatePrecision | null;
  stageId?: string;
  initiator?: string;
  recipient?: string;
  summary?: string;
  result?: string;
  customerVisible: boolean;
  customerMessage?: string;
};

/** 发生时间 + 精度一起读（精度决定怎么规范化时间）。 */
const occurredOf = (
  b: Body,
  errors: string[],
  fallbackPrecision: DatePrecision | null,
): { occurredAt?: string | null; datePrecision?: DatePrecision | null } => {
  const precision = oneOf(b, 'datePrecision', DATE_PRECISIONS, errors);
  const v = b.occurredAt;
  if (v === undefined) return precision ? { datePrecision: precision } : {};
  if (v === null) return { occurredAt: null, datePrecision: null };
  if (typeof v !== 'string') {
    errors.push('occurredAt: must be an ISO 8601 date-time');
    return {};
  }
  const p: DatePrecision = precision ?? fallbackPrecision ?? 'minute';
  const at = normalizeOccurredAt(v, p);
  if (!at) {
    errors.push(`occurredAt: not a valid ${p === 'day' ? 'date (YYYY-MM-DD…)' : 'ISO 8601 date-time'}`);
    return {};
  }
  return { occurredAt: at, datePrecision: p };
};

const UPDATE_TEXTS = [
  ['initiator', LIMITS.party],
  ['recipient', LIMITS.party],
  ['summary', LIMITS.summary],
  ['result', LIMITS.result],
] as const;

export const sanitizeUpdateCreate = (raw: unknown): { value: UpdateCreate; errors: string[] } => {
  const errors: string[] = [];
  const b = asBody(raw) ?? {};
  if (!asBody(raw)) errors.push('body: must be a JSON object');
  unknownKeys(
    b,
    ['clientId', 'title', 'kind', 'occurredAt', 'datePrecision', 'stageId', 'initiator', 'recipient', 'summary', 'result', 'customerVisible', 'customerMessage'],
    errors,
  );
  const clientId = clientIdOf(b, errors);
  const title = text(b, 'title', LIMITS.title, errors, { required: true });
  if (b.kind === 'stageChange') errors.push('kind: stageChange is written by the gateway when the stage changes');
  const kind = b.kind === 'stageChange' ? undefined : oneOf(b, 'kind', PORTAL_KINDS, errors);
  const when = occurredOf(b, errors, null);
  if (b.occurredAt === undefined && b.datePrecision !== undefined) errors.push('datePrecision: needs occurredAt');
  const stageId = uuid(b, 'stageId', errors, { nullable: true });
  const texts: Partial<Record<(typeof UPDATE_TEXTS)[number][0], string>> = {};
  for (const [k, max] of UPDATE_TEXTS) {
    const v = text(b, k, max, errors, { clearable: true });
    if (v) texts[k] = v;
  }
  const customerVisible = bool(b, 'customerVisible', errors, { required: true });
  const customerMessage = text(b, 'customerMessage', LIMITS.customerMessage, errors, { clearable: true });
  // 公开给客户的进展必须有一句给客户的话（stageChange 除外，门户会显示「进入阶段 X」）
  if (customerVisible === true && !customerMessage) errors.push('customerMessage: required when customerVisible is true');
  return {
    value: {
      clientId: clientId ?? '',
      title: title ?? '',
      kind: kind ?? 'communication',
      occurredAt: when.occurredAt ?? null,
      datePrecision: when.occurredAt ? (when.datePrecision ?? 'minute') : null,
      ...(stageId ? { stageId } : {}),
      ...texts,
      customerVisible: customerVisible === true,
      ...(customerMessage ? { customerMessage } : {}),
    },
    errors,
  };
};

export type UpdatePatch = {
  title?: string;
  occurredAt?: string | null;
  datePrecision?: DatePrecision | null;
  stageId?: string | null;
  initiator?: string;
  recipient?: string;
  summary?: string;
  result?: string;
  customerVisible?: boolean;
  customerMessage?: string;
};

/** stageChange 那条记录上只许改这几格（它的其余内容是网关写的事实，不是人写的话）。 */
export const STAGE_CHANGE_EDITABLE = ['customerVisible', 'customerMessage', 'occurredAt'] as const;

export const sanitizeUpdatePatch = (
  raw: unknown,
  existing: { kind: UpdateKind | null; datePrecision: DatePrecision | null; customerVisible: boolean; customerMessage: string | null },
): { value: UpdatePatch; errors: string[] } => {
  const errors: string[] = [];
  const b = asBody(raw) ?? {};
  if (!asBody(raw)) errors.push('body: must be a JSON object');
  if ('clientId' in b) errors.push('clientId: cannot be changed');
  if ('kind' in b) errors.push('kind: cannot be changed');
  unknownKeys(
    b,
    ['clientId', 'kind', 'title', 'occurredAt', 'datePrecision', 'stageId', 'initiator', 'recipient', 'summary', 'result', 'customerVisible', 'customerMessage'],
    errors,
  );
  if (existing.kind === 'stageChange') {
    for (const k of Object.keys(b))
      if (!(STAGE_CHANGE_EDITABLE as readonly string[]).includes(k) && k !== 'clientId' && k !== 'kind')
        errors.push(`${k}: a stageChange update only allows ${STAGE_CHANGE_EDITABLE.join(', ')}`);
  }
  const value: UpdatePatch = {};
  const title = text(b, 'title', LIMITS.title, errors, { required: b.title !== undefined });
  if (title !== undefined) value.title = title;
  const when = occurredOf(b, errors, existing.datePrecision);
  if (when.occurredAt !== undefined) value.occurredAt = when.occurredAt;
  if (when.datePrecision !== undefined) value.datePrecision = when.datePrecision;
  // 只改精度不改时间：已有时间要按新精度重新落一次，这里拿不到旧时间 —— 要求一起给
  if (b.datePrecision !== undefined && b.occurredAt === undefined) errors.push('datePrecision: send occurredAt with it');
  const stageId = uuid(b, 'stageId', errors, { nullable: true });
  if (stageId !== undefined) value.stageId = stageId;
  for (const [k, max] of UPDATE_TEXTS) {
    const v = text(b, k, max, errors, { clearable: true });
    if (v !== undefined) value[k] = v;
  }
  const customerVisible = bool(b, 'customerVisible', errors);
  if (customerVisible !== undefined) value.customerVisible = customerVisible;
  const customerMessage = text(b, 'customerMessage', LIMITS.customerMessage, errors, { clearable: true });
  if (customerMessage !== undefined) value.customerMessage = customerMessage;

  // 合并之后判：公开给客户的非 stageChange 进展必须有一句给客户的话
  const visible = value.customerVisible ?? existing.customerVisible === true;
  const message = value.customerMessage ?? existing.customerMessage ?? '';
  if (existing.kind !== 'stageChange' && visible && !message.trim())
    errors.push('customerMessage: required when customerVisible is true');
  if (!errors.length && !Object.keys(value).length) errors.push('body: nothing to change');
  return { value, errors };
};

// ═══════════════════════════════════════════════════════════════════
//  二、判断：公开前提 / 阶段增删计划 / 代号生成
// ═══════════════════════════════════════════════════════════════════

/**
 * 公开前提（409 needs_type）：没有类型或当前阶段的项目，客户那边画不出进度条 ——
 * 门户会把它藏起来，而 admin 以为已经公开了。所以在「打开公开」那一刻就挡。
 */
export const needsType = (p: { portalVisible?: boolean; projectTypeId: string | null; currentStageId: string | null }) =>
  p.portalVisible === true && (!p.projectTypeId || !p.currentStageId);

export type LiveStage = {
  id: string;
  name: string;
  nameZh: string;
  stageKey: string;
  order: number | null;
  isActive: boolean;
};

export type StagePlan = {
  errors: string[];
  create: Array<{ name: string; nameZh: string; stageKey: string; stageOrder: number }>;
  update: Array<{ id: string; patch: { name?: string; nameZh?: string; stageOrder?: number; isActive?: true } }>;
  deactivate: string[];
  /** 要停用的阶段里，有项目正停在上面的 —— 有一条就整个 409 stage_in_use，什么都不写。 */
  inUse: Array<{ stageId: string; stageName: string; projects: Array<{ id: string; name: string }> }>;
};

/**
 * PATCH project-types 的 `stages` = 期望的**在用**阶段有序全集（契约 §4）：
 * 有 id 改、无 id 建、库里在用而清单里没有的置 `isActive:false`。
 * 清单里带着一个已停用阶段的 id = 把它请回来（isActive:true）。
 *
 * 🔴 **要停用的阶段正是某个项目的当前阶段 → 整个计划作废（stage_in_use）**，
 * 不做「能改的先改」—— 半个计划落地之后，admin 看到的阶段表和他提交的对不上，而且回不去。
 */
export const planStages = (
  live: LiveStage[],
  desired: StageInput[],
  projects: Array<{ id: string; name: string; currentStageId: string | null }>,
): StagePlan => {
  const plan: StagePlan = { errors: [], create: [], update: [], deactivate: [], inUse: [] };
  const byId = new Map(live.map((s) => [s.id, s]));
  const keys = new Set(live.map((s) => s.stageKey).filter(Boolean));
  const kept = new Set<string>();

  desired.forEach((d, i) => {
    const order = i + 1;
    if (d.id) {
      const cur = byId.get(d.id);
      if (!cur) {
        plan.errors.push(`stages[${i}].id: not a stage of this project type`);
        return;
      }
      if (kept.has(d.id)) {
        plan.errors.push(`stages[${i}].id: listed twice`);
        return;
      }
      kept.add(d.id);
      const patch: StagePlan['update'][number]['patch'] = {};
      if (cur.name !== d.name) patch.name = d.name;
      if (d.nameZh !== undefined && (cur.nameZh ?? '') !== d.nameZh) patch.nameZh = d.nameZh;
      if (cur.order !== order) patch.stageOrder = order;
      if (cur.isActive !== true) patch.isActive = true;
      if (Object.keys(patch).length) plan.update.push({ id: d.id, patch });
    } else {
      const stageKey = stageKeyFor(d.name, keys);
      keys.add(stageKey);
      plan.create.push({ name: d.name, nameZh: d.nameZh ?? '', stageKey, stageOrder: order });
    }
  });

  for (const s of live) {
    if (s.isActive !== true || kept.has(s.id)) continue;
    plan.deactivate.push(s.id);
    const users = projects.filter((p) => p.currentStageId === s.id).map((p) => ({ id: p.id, name: p.name }));
    if (users.length) plan.inUse.push({ stageId: s.id, stageName: s.name, projects: users });
  }
  return plan;
};

/** `Sample Testing` → `sampleTesting`；类型内唯一（撞了加 2、3…）。纯中文名 → `stage`。 */
export const stageKeyFor = (name: string, taken: Set<string>): string => {
  const words = String(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const base =
    words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join('').slice(0, 40) ||
    'stage';
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}${n}`;
  return key;
};

/** `Dealer Project` → `DEALER-PROJECT`；全库唯一（撞了加 -2、-3…）。纯中文名 → `TYPE`。 */
export const typeCodeFor = (name: string, taken: Iterable<string | null | undefined>): string => {
  const used = new Set([...taken].filter(Boolean).map((c) => String(c).toUpperCase()));
  const base =
    String(name)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'TYPE';
  let code = base;
  for (let n = 2; used.has(code); n++) code = `${base}-${n}`;
  return code;
};

// ═══════════════════════════════════════════════════════════════════
//  三、写出去：Twenty 请求体。**只放给了的字段**（PATCH 里空值会抹掉别人填的东西）
// ═══════════════════════════════════════════════════════════════════

export const projectTypeBody = (i: { name?: string; typeCode?: string; description?: string; isActive?: boolean }) => ({
  ...(i.name !== undefined ? { name: i.name } : {}),
  ...(i.typeCode !== undefined ? { typeCode: i.typeCode } : {}),
  ...(i.description !== undefined ? { description: i.description } : {}),
  ...(i.isActive !== undefined ? { isActive: i.isActive } : {}),
});

export const stageBody = (i: {
  projectTypeId?: string;
  name?: string;
  nameZh?: string;
  stageKey?: string;
  stageOrder?: number;
  isActive?: boolean;
}) => ({
  ...(i.projectTypeId ? { projectTypeId: i.projectTypeId } : {}),
  ...(i.name !== undefined ? { name: i.name } : {}),
  ...(i.nameZh !== undefined ? { nameZh: i.nameZh } : {}),
  ...(i.stageKey !== undefined ? { stageKey: i.stageKey } : {}),
  ...(i.stageOrder !== undefined ? { stageOrder: i.stageOrder } : {}),
  ...(i.isActive !== undefined ? { isActive: i.isActive } : {}),
});

/**
 * project 上**只动门户那几列**（D139）。`projectStage` / `ownerTeam` / `budget` … 这里一个都写不到 ——
 * 那些是速记管道（D59）的，门户改不着。SELECT 值写 UPPER_SNAKE（Twenty 拒 camelCase，实测 400）。
 */
export const portalProjectBody = (i: ProjectPatch & { projectCode?: string }) => ({
  ...(i.name !== undefined ? { name: i.name } : {}),
  ...(i.projectCode ? { projectCode: i.projectCode } : {}),
  ...(i.companyId ? { companyId: i.companyId } : {}),
  ...(i.projectTypeId ? { projectTypeId: i.projectTypeId } : {}),
  ...(i.currentStageId ? { currentStageId: i.currentStageId } : {}),
  ...(i.status ? { projectStatus: toEnum(i.status) } : {}),
  ...(i.portalVisible !== undefined ? { portalVisible: i.portalVisible } : {}),
  ...(i.customerSummary !== undefined ? { customerSummary: i.customerSummary } : {}),
  ...(i.targetDate !== undefined ? { targetDate: i.targetDate } : {}),
});

type UpdateWrite = Omit<UpdatePatch, 'datePrecision'> & {
  kind?: UpdateKind;
  datePrecision?: DatePrecision | null;
  projectId?: string;
  authorName?: string | null;
  clientId?: string;
};

/**
 * 进展的请求体。`create` 时**空关系一律不带**（Twenty 对显式 null 的关系 id 不总是宽容）；
 * PATCH 时 null = 清空（stageId / occurredAt / datePrecision 实测都能清）。
 */
export const projectUpdateBody = (i: UpdateWrite, mode: 'create' | 'patch') => {
  const keepNull = mode === 'patch';
  const put = (k: string, v: unknown) => (v === undefined || (v === null && !keepNull) ? {} : { [k]: v });
  return {
    ...put('name', i.title),
    ...put('projectId', i.projectId),
    ...put('stageId', i.stageId),
    ...put('kind', i.kind ? toEnum(i.kind) : i.kind),
    ...put('occurredAt', i.occurredAt),
    ...put('datePrecision', i.datePrecision ? toEnum(i.datePrecision) : i.datePrecision),
    ...put('initiator', i.initiator),
    ...put('recipient', i.recipient),
    ...put('summary', i.summary),
    ...put('result', i.result),
    ...put('customerVisible', i.customerVisible),
    ...put('customerMessage', i.customerMessage),
    ...put('authorName', i.authorName),
    ...put('clientId', i.clientId),
  };
};

// ═══════════════════════════════════════════════════════════════════
//  四、读出去：Twenty REST 行 → 快照（docs/portal-projects.md §4 那个形状）
// ═══════════════════════════════════════════════════════════════════

type Row = Record<string, any>;
const idOf = (r: Row, rel: string): string | null => r?.[`${rel}Id`] ?? r?.[rel]?.id ?? null;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export type SnapshotCompany = {
  id: string;
  name: string;
  accountCode: string | null;
  accountType: string | null;
  hqCountry: string | null;
};
export type SnapshotStage = {
  id: string;
  name: string;
  nameZh: string | null;
  stageKey: string | null;
  order: number | null;
  isActive: boolean;
};
export type SnapshotType = {
  id: string;
  typeCode: string | null;
  name: string;
  description: string | null;
  isActive: boolean;
  stages: SnapshotStage[];
};
export type SnapshotProject = {
  id: string;
  name: string;
  projectCode: string | null;
  companyId: string | null;
  projectTypeId: string | null;
  currentStageId: string | null;
  legacyStage: string | null;
  status: ProjectStatus;
  portalVisible: boolean;
  customerSummary: string | null;
  targetDate: string | null;
  primaryProductName: string | null;
  ownerTeam: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};
export type SnapshotUpdate = {
  id: string;
  projectId: string | null;
  stageId: string | null;
  kind: UpdateKind | null;
  title: string;
  occurredAt: string | null;
  datePrecision: DatePrecision | null;
  initiator: string | null;
  recipient: string | null;
  summary: string | null;
  result: string | null;
  customerVisible: boolean;
  customerMessage: string | null;
  authorName: string | null;
  createdAt: string | null;
};
export type Snapshot = {
  generatedAt: string;
  companies: SnapshotCompany[];
  projectTypes: SnapshotType[];
  projects: SnapshotProject[];
  updates: SnapshotUpdate[];
};

export const normCompany = (r: Row): SnapshotCompany => ({
  id: r.id,
  name: typeof r.name === 'string' ? r.name : '',
  accountCode: str(r.accountCode),
  accountType: looseEnum(r.accountType),
  hqCountry: str(r.hqCountry),
});

export const normStage = (r: Row): SnapshotStage & { projectTypeId: string | null } => ({
  id: r.id,
  name: typeof r.name === 'string' ? r.name : '',
  nameZh: str(r.nameZh),
  stageKey: str(r.stageKey),
  order: typeof r.stageOrder === 'number' && Number.isFinite(r.stageOrder) ? r.stageOrder : null,
  isActive: r.isActive === true,
  projectTypeId: idOf(r, 'projectType'),
});

/** 阶段顺序：stageOrder 升序，没有的排最后；再按名字 —— 保证每次读出来的顺序一样。 */
export const byStageOrder = (a: { order: number | null; name: string }, b: { order: number | null; name: string }) =>
  (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name);

export const normType = (r: Row, stages: Row[]): SnapshotType => ({
  id: r.id,
  typeCode: str(r.typeCode),
  name: typeof r.name === 'string' ? r.name : '',
  description: str(r.description),
  isActive: r.isActive === true,
  stages: stages
    .map(normStage)
    .filter((s) => s.projectTypeId === r.id)
    .sort(byStageOrder)
    .map(({ projectTypeId: _drop, ...s }) => s),
});

/**
 * 项目状态。
 * · 空值按 schema 默认（ACTIVE）读 —— 新列加上时 Twenty 已经给老行回填了默认值（2026-09-30 实测），
 *   这一格只兜「有人在界面上把它清空」那一种。
 * · **认不出的值当 cancelled**（有人在 CRM 界面上加了个新选项）：门户只把 cancelled 藏起来，
 *   猜成 active 就是把一个不知道什么状态的项目摆到客户面前 —— 失败即关闭。
 */
export const statusOf = (raw: unknown): ProjectStatus =>
  raw === null || raw === undefined || raw === '' ? 'active' : (fromEnum(raw, PROJECT_STATUSES) ?? 'cancelled');

export const normProject = (r: Row): SnapshotProject => ({
  id: r.id,
  name: typeof r.name === 'string' ? r.name : '',
  projectCode: str(r.projectCode),
  companyId: idOf(r, 'company'),
  projectTypeId: idOf(r, 'projectType'),
  currentStageId: idOf(r, 'currentStage'),
  legacyStage: looseEnum(r.projectStage),
  status: statusOf(r.projectStatus),
  portalVisible: r.portalVisible === true,
  customerSummary: str(r.customerSummary),
  targetDate: str(r.targetDate)?.slice(0, 10) ?? null,
  primaryProductName: str(r.primaryProductName),
  ownerTeam: str(r.ownerTeam),
  createdAt: str(r.createdAt),
  updatedAt: str(r.updatedAt),
});

export const normUpdate = (r: Row): SnapshotUpdate => ({
  id: r.id,
  projectId: idOf(r, 'project'),
  stageId: idOf(r, 'stage'),
  kind: fromEnum(r.kind, UPDATE_KINDS),
  title: typeof r.name === 'string' ? r.name : '',
  occurredAt: str(r.occurredAt),
  datePrecision: fromEnum(r.datePrecision, DATE_PRECISIONS),
  initiator: str(r.initiator),
  recipient: str(r.recipient),
  summary: str(r.summary),
  result: str(r.result),
  customerVisible: r.customerVisible === true,
  customerMessage: str(r.customerMessage),
  authorName: str(r.authorName),
  createdAt: str(r.createdAt),
});

/** 较新的在前：有发生时间的按它，没有的按建档时间。 */
const updateTime = (u: SnapshotUpdate) => Date.parse(u.occurredAt ?? u.createdAt ?? '') || 0;

export const buildSnapshot = (
  raw: { companies: Row[]; projectTypes: Row[]; stages: Row[]; projects: Row[]; updates: Row[] },
  now: Date,
): Snapshot => ({
  generatedAt: now.toISOString(),
  companies: raw.companies.map(normCompany).sort((a, b) => a.name.localeCompare(b.name)),
  projectTypes: raw.projectTypes.map((t) => normType(t, raw.stages)).sort((a, b) => a.name.localeCompare(b.name)),
  projects: raw.projects.map(normProject).sort((a, b) => a.name.localeCompare(b.name)),
  updates: raw.updates.map(normUpdate).sort((a, b) => updateTime(b) - updateTime(a)),
});
