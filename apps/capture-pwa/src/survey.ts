/**
 * 2C 客户问卷的题目与答案形状（D136 · T104）。
 *
 * 题目是 维护者 2026-09-27 给的六道（法语原句 + 中文），这里**压成一行一问**：
 * 销售对着客户念法语那一句，中文那一行给自己看。原文里的举例
 * （Batterie lithium, panneau solaire…）变成可以点的选项 —— 展台上边聊边点，比打字快得多。
 *
 * ── 三条约束 ──────────────────────────────────────────────────────
 *
 * ① **答案里存 id，不存文字**（D80：数据路径存规范形式）。`lithium` 永远是 `lithium`，
 *    界面是中文还是英文、法语措辞以后怎么改，都不影响已经收上来的答案能不能统计。
 *    🔴 所以**已经上线收过数据之后，id 一个都不许改** —— 改名只改 `fr` / `zh`。
 * ② `zh` 存中文原文，**渲染时才过 `t()`**（模块级不许调 `t()`）；`fr` 是念给客户听的，不翻译。
 * ③ 这里只有「题目 + 答案怎么变 + 能不能交」；存到哪在 `sync.ts`（D138：
 *    手机本地 → 网关 `POST /surveys` → Twenty，不走 AI）。
 */

/** 交给网关时说「这是哪一套题」。网关只认它白名单里的 key。 */
export const SURVEY_KEY = 'vdl2026';

export type Choice = { id: string; fr: string; zh: string };

type Base = { id: string; fr: string; zh: string };
export type Question =
  | (Base & { kind: 'multi'; options: Choice[] })
  /** 每个选项三态：没点 → 在用 → 想加 → 没点（第 2 题「现在用哪些 / 以后想要哪些」） */
  | (Base & { kind: 'havewant'; options: Choice[] })
  | (Base & { kind: 'single'; options: Choice[]; followUp?: Base & { options: Choice[] } })
  | (Base & { kind: 'text' });

export type HaveWant = 'have' | 'want';
/** 一份问卷的答案。键是题目 id（追问用它自己的 id，和主问平级）。 */
export type Answers = Record<string, string | string[] | Record<string, HaveWant>>;

export const VDL_2026: Question[] = [
  {
    id: 'equipment',
    kind: 'multi',
    fr: 'Quels équipements électriques avez-vous ?',
    zh: '现在有哪些电力设备？',
    options: [
      { id: 'lithium', fr: 'Batterie lithium', zh: '锂电池' },
      { id: 'solar', fr: 'Panneau solaire', zh: '太阳能板' },
      { id: 'inverter', fr: 'Convertisseur', zh: '逆变器' },
      { id: 'dcdc', fr: 'Chargeur DC-DC', zh: '充电器' },
      // 原题没有这一项。加上是为了统计：不点任何项 = 「没问到」还是「都没有」分不开
      { id: 'none', fr: 'Aucun', zh: '都没有' },
    ],
  },
  {
    id: 'appliances',
    kind: 'havewant',
    fr: 'Quels appareils utilisez-vous ? Et lesquels aimeriez-vous ?',
    zh: '在用哪些电器？想加哪些？',
    options: [
      { id: 'ac', fr: 'Clim', zh: '空调' },
      { id: 'fridge', fr: 'Frigo', zh: '冰箱' },
      { id: 'coffee', fr: 'Machine à café', zh: '咖啡机' },
      { id: 'hob', fr: 'Plaque de cuisson', zh: '电炉灶' },
      { id: 'microwave', fr: 'Micro-ondes', zh: '微波炉' },
      { id: 'hairdryer', fr: 'Sèche-cheveux', zh: '吹风机' },
      { id: 'tv', fr: 'Télé', zh: '电视' },
      { id: 'laptop', fr: 'Ordinateur', zh: '电脑' },
      { id: 'ebike', fr: 'Vélo électrique', zh: '电动车充电' },
    ],
  },
  {
    id: 'install',
    kind: 'single',
    fr: 'Pour installer : vous-même ou un pro ?',
    zh: '自己装还是找专业的？',
    options: [
      { id: 'diy', fr: 'Moi-même', zh: '自己装' },
      { id: 'pro', fr: 'Un pro', zh: '专业人士' },
    ],
    followUp: {
      id: 'brand_chooser',
      fr: 'Qui choisit la marque : vous ou l’installateur ?',
      zh: '品牌谁选？',
      options: [
        { id: 'me', fr: 'Moi', zh: '自己' },
        { id: 'installer', fr: 'L’installateur', zh: '安装商' },
      ],
    },
  },
  {
    id: 'overnight',
    kind: 'multi',
    fr: 'Où passez-vous la nuit en voyage ?',
    zh: '旅行时在哪过夜？',
    options: [
      { id: 'camping', fr: 'Camping', zh: '营地' },
      { id: 'aire', fr: 'Aire de camping-car', zh: '房车停车区' },
      { id: 'autonomy', fr: 'En autonomie', zh: '离网露营' },
    ],
  },
  {
    id: 'camping_pain',
    kind: 'text',
    fr: 'Au camping, qu’est-ce qui vous déplaît ?',
    zh: '住营地有什么不满意？',
  },
  {
    id: 'wish',
    kind: 'text',
    fr: 'Que voudriez-vous faire que votre système ne permet pas ?',
    zh: '现在的电力系统做不到、但想做的事？',
  },
];

/** 三态往下走一格：没点 → 在用 → 想加 → 没点。 */
export const cycleHaveWant = (cur: HaveWant | undefined): HaveWant | undefined =>
  cur === undefined ? 'have' : cur === 'have' ? 'want' : undefined;

/**
 * 多选点一下。「都没有」和其它选项互斥 —— 否则会收上来
 * 「有锂电池 + 什么都没有」这种统计不了的答案。
 */
export const toggleMulti = (cur: string[], id: string, exclusive = 'none'): string[] => {
  if (cur.includes(id)) return cur.filter((x) => x !== id);
  if (id === exclusive) return [id];
  return [...cur.filter((x) => x !== exclusive), id];
};

/** 答了几道（追问不单独算 —— 它是第 3 题的一部分）。 */
export const answeredCount = (qs: Question[], a: Answers): number =>
  qs.filter((q) => {
    const v = a[q.id];
    if (v === undefined) return false;
    if (typeof v === 'string') return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    return Object.keys(v).length > 0;
  }).length;

export type Contact = { name: string; phone: string; email: string; postcode: string };
export const EMPTY_CONTACT: Contact = { name: '', phone: '', email: '', postcode: '' };

/**
 * 能不能交（D138）。**和网关 `normalizeSurvey` 同一条规则**：
 *   · 什么都没答、也没留联系方式 → 不交
 *   · 留了姓名 / 电话 / 邮箱 → 必须勾同意（R20 · GDPR）；只留邮编不算可识别到人
 * 界面上挡一次是为了让人当场知道缺什么；真正的闸门在服务端。
 */
export const submitState = (
  qs: Question[],
  a: Answers,
  c: Contact,
  consent: boolean,
): 'ok' | 'empty' | 'consent' => {
  const identifying = Boolean(c.name.trim() || c.phone.trim() || c.email.trim());
  if (identifying && !consent) return 'consent';
  if (!answeredCount(qs, a) && !a.brand_chooser && !identifying && !c.postcode.trim()) return 'empty';
  return 'ok';
};
