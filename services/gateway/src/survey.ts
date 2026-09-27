/**
 * 2C 问卷：手机交上来的答案 → Twenty 的 `consumerSurvey` 一行（D138）。
 *
 * **这里全是纯函数**，写库和调 Twenty 在 `surveys.ts` —— 分开是为了
 * 「哪些答案会被收下、落到哪一列」能不碰数据库地单测。
 *
 * 🔴 选项清单有三份：PWA 的题目（`apps/capture-pwa/src/survey.ts`）、这里、
 * `scripts/twenty-schema.mjs`。网关镜像里只有 `services/gateway`，读不到另外两份，
 * 只能各存一份 —— 所以 `survey.test.ts` 把三份逐个对账，任何一份多一个、少一个都红。
 * 对不上的后果是**静默的**：PWA 能点、网关丢掉（或 Twenty 回 400），界面上一切正常。
 */

/** 和 `scripts/twenty-schema.mjs` 的 `toEnumValue` 同一条规则（测试里对过）。 */
export const toEnum = (v: string) =>
  v.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9_]+/g, '_').toUpperCase();

export const OPTIONS = {
  equipment: ['lithium', 'solar', 'inverter', 'dcdc', 'none'],
  appliances: ['ac', 'fridge', 'coffee', 'hob', 'microwave', 'hairdryer', 'tv', 'laptop', 'ebike'],
  install: ['diy', 'pro'],
  brand_chooser: ['me', 'installer'],
  overnight: ['camping', 'aire', 'autonomy'],
} as const;

/** 现在只收这一套题。以后别的展会换题，在这里加一个 key，而不是让任何字符串都能进来。 */
export const SURVEYS: Record<string, { eventName: string }> = {
  vdl2026: { eventName: 'VDL 2026' },
};

export type Contact = { name?: string; email?: string; phone?: string; postcode?: string };

export type SurveyInput = {
  answers: Record<string, unknown>;
  contact: Contact;
  consentAt: string | null;
};

const TEXT_MAX = 2000;
const text = (v: unknown, max = TEXT_MAX) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** 只留认识的选项，去重，保持原顺序。 */
const pick = (v: unknown, allowed: readonly string[]): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && allowed.includes(x)))] : [];

/**
 * 校验并规范化。返回 `{ error }` 就是 422。
 *
 * 🔴 **有姓名 / 电话 / 邮箱，就必须有同意时间**（R20 · GDPR）。
 * 挡在服务端，不只挡在界面上 —— 前端的校验等于没有（CLAUDE.md 第 4 条同一个道理）。
 * 邮编单独不算可识别到人，不要求同意。
 */
export const normalizeSurvey = (
  raw: { answers?: unknown; contact?: unknown; consentAt?: unknown },
): { ok: SurveyInput } | { error: string } => {
  const a = (raw.answers && typeof raw.answers === 'object' ? raw.answers : {}) as Record<string, unknown>;
  const c = (raw.contact && typeof raw.contact === 'object' ? raw.contact : {}) as Record<string, unknown>;

  const answers: Record<string, unknown> = {};
  const equipment = pick(a.equipment, OPTIONS.equipment);
  // 「都没有」和其它互斥 —— 两个都来了说明客户端坏了，宁可只信具体的那几个
  if (equipment.length) answers.equipment = equipment.length > 1 ? equipment.filter((x) => x !== 'none') : equipment;

  if (a.appliances && typeof a.appliances === 'object') {
    const hw: Record<string, 'have' | 'want'> = {};
    for (const [k, v] of Object.entries(a.appliances as Record<string, unknown>))
      if ((OPTIONS.appliances as readonly string[]).includes(k) && (v === 'have' || v === 'want')) hw[k] = v;
    if (Object.keys(hw).length) answers.appliances = hw;
  }
  for (const k of ['install', 'brand_chooser'] as const)
    if (typeof a[k] === 'string' && (OPTIONS[k] as readonly string[]).includes(a[k] as string)) answers[k] = a[k];
  const overnight = pick(a.overnight, OPTIONS.overnight);
  if (overnight.length) answers.overnight = overnight;
  for (const k of ['camping_pain', 'wish'] as const) if (text(a[k])) answers[k] = text(a[k]);

  const contact: Contact = {};
  if (text(c.name, 120)) contact.name = text(c.name, 120);
  if (text(c.email, 200)) contact.email = text(c.email, 200);
  if (text(c.phone, 60)) contact.phone = text(c.phone, 60);
  if (text(c.postcode, 20)) contact.postcode = text(c.postcode, 20);

  const consentAt =
    typeof raw.consentAt === 'string' && !Number.isNaN(Date.parse(raw.consentAt))
      ? new Date(raw.consentAt).toISOString()
      : null;
  const identifying = Boolean(contact.name || contact.email || contact.phone);
  if (identifying && !consentAt) return { error: 'consent_required' };
  if (!Object.keys(answers).length && !Object.keys(contact).length) return { error: 'empty' };

  return { ok: { answers, contact, consentAt: identifying ? consentAt : null } };
};

/**
 * 客户叫什么。**问卷里没留名字也要建一家** —— 每个答过问卷的人都是一位终端客户
 * （维护者：「全部进入 Twenty」），匿名的用展会 + 手机上那份 id 的前 4 位区分。
 */
export const customerName = (contact: Contact, eventName: string, clientId: string) =>
  contact.name || `${eventName} · #${clientId.slice(0, 4).toUpperCase()}`;

/** `consumerSurvey` 的请求体（不含关系字段 —— 那两个 id 在写的时候才有）。 */
export const surveyBody = (
  s: SurveyInput & { clientId: string; eventName: string; surveyedAt: string },
): Record<string, unknown> => {
  const a = s.answers as {
    equipment?: string[];
    appliances?: Record<string, 'have' | 'want'>;
    install?: string;
    brand_chooser?: string;
    overnight?: string[];
    camping_pain?: string;
    wish?: string;
  };
  const hw = Object.entries(a.appliances ?? {});
  const body: Record<string, unknown> = {
    // 匿名时客户名里已经带着展会名了，别拼成「VDL 2026 · VDL 2026 · #3F2A」
    name: (s.contact.name ? `${s.eventName} · ${s.contact.name}` : customerName(s.contact, s.eventName, s.clientId)).slice(0, 120),
    clientId: s.clientId,
    eventName: s.eventName,
    surveyedAt: s.surveyedAt,
    equipment: (a.equipment ?? []).map(toEnum),
    appliancesInUse: hw.filter(([, v]) => v === 'have').map(([k]) => toEnum(k)),
    appliancesWanted: hw.filter(([, v]) => v === 'want').map(([k]) => toEnum(k)),
    overnight: (a.overnight ?? []).map(toEnum),
  };
  // 单选和文字：没答就不发，别拿空值去占一格
  if (a.install) body.installPreference = toEnum(a.install);
  if (a.brand_chooser) body.brandChooser = toEnum(a.brand_chooser);
  if (a.camping_pain) body.campingPain = a.camping_pain;
  if (a.wish) body.wish = a.wish;
  if (s.contact.email) body.contactEmail = s.contact.email;
  if (s.contact.phone) body.contactPhone = s.contact.phone;
  if (s.contact.postcode) body.postcode = s.contact.postcode;
  if (s.consentAt) body.consentAt = s.consentAt;
  return body;
};

/** 写 Twenty 失败后多久再试：30s · 1m · 2m · 4m … 封顶 1 小时。**不设次数上限** —— 问卷总要进去。 */
export const backoffSeconds = (attempts: number) => Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
