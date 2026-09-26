/**
 * 名字匹配。**这不是预防性代码 —— 它对应一次已经发生的事故。**
 *
 * 销售那份 Excel 就是因为拿名字当关联键而散架的：品牌名单三份文件的交集只有
 * 32/61，集团名的三份交集是 0。散架的具体形态就是下面这几种：
 *
 *   Brückner / Bruckner / Brueckner     变音符三种写法
 *   'Heron ' / Heron                    前后空格和引号
 *   Alpin Tannhof / ALPIN TANNHOF AG    大小写与法律后缀
 *
 * 所以查重不能用 `=`，也不能只用 `lower()`。这里做三件事：
 *   ① 折叠变音符 —— 而且是**两种折叠都要**（ü→u 和 ü→ue，德语两种写法都真实存在）
 *   ② 去掉法律后缀和标点
 *   ③ 剩下的用编辑距离兜住手误
 *
 * 用在两个地方：agent 的 `search_companies`，和 `POST /companies` 的强制查重。
 * 两处必须是**同一套规则** —— 不然会出现「agent 说没找到、建的时候被拒」。
 */

const UMLAUT: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

/**
 * 没有区分度的词。**按「词」去掉，不是按子串** —— 这个区别是量出来的：
 *
 *   按子串去 "mobil" → "VANTAmobil" 被切成 "VARIO"，一个品牌名被切没了；
 *   不去 "mobil"     → "Istra Mobil" 和 "Orba Mobil" 相似度 0.70，被误判成同一家。
 *
 * 按词去就两头都对：`Orba Mobil` → `orba`、`VANTAmobil` → `vantamobil`（它本来就是一个词）。
 * 实测对着真实的 56 家名单跑，误命中从 3 组降到 0 组，而集团/品牌的父子对
 * （Alpin Tannhof ↔ Alpin、Erwin Havel Group ↔ Havel）照样命中 —— 那些**本来就该命中**。
 */
const NOISE = new Set([
  // 法律后缀
  'gmbh', 'ag', 'kg', 'co', 'kgaa', 'sa', 'srl', 'spa', 'bv', 'nv', 'ltd', 'limited',
  'inc', 'llc', 'sas', 'sarl', 'oy', 'ab', 'as', 'aps', 'plc', 'holding',
  'group', 'gruppe', 'groupe', 'international', 'and', 'und',
  // 行业通用词
  'mobil', 'mobile', 'mobils', 'motor', 'motors', 'caravan', 'caravans', 'camper',
  'campers', 'reisemobil', 'reisemobile', 'wohnwagen', 'werk', 'werke', 'auto', 'fahrzeuge',
]);

const strip = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // 变音符直接去掉：ü → u
    .toLowerCase();

const expand = (s: string) =>
  s
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => UMLAUT[c] ?? c) // 变音符展开：ü → ue
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const clean = (s: string) => {
  const words = s.split(/[^a-z0-9]+/).filter(Boolean);
  const kept = words.filter((w) => !NOISE.has(w));
  // 整个名字都是噪声词就原样留着 —— 免得 "Auto Group" 这种被清空
  return (kept.length ? kept : words).join('');
};

/** 一个名字的所有规范形。两个名字只要有**一个**规范形相同，就是同一家。 */
export const nameKeys = (name: string): string[] => {
  const raw = String(name ?? '').trim();
  if (!raw) return [];
  const forms = new Set<string>();
  for (const base of [strip(raw), expand(raw)]) {
    const c = clean(base);
    if (c) forms.add(c);
  }
  return [...forms];
};

/** 编辑距离。名单只有几百家，O(n·m) 完全够用，不值得上 trigram 索引。 */
export const editDistance = (a: string, b: string): number => {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
};

/** 0–1。1 = 规范形完全一致。 */
export const similarity = (a: string, b: string): number => {
  const ka = nameKeys(a);
  const kb = nameKeys(b);
  if (!ka.length || !kb.length) return 0;
  if (ka.some((k) => kb.includes(k))) return 1;

  let best = 0;
  for (const x of ka) {
    for (const y of kb) {
      // 包含关系给 0.9 —— "Alpin" vs "Alpin Tannhof" 是真实会遇到的写法
      if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) {
        best = Math.max(best, 0.9);
        continue;
      }
      const d = editDistance(x, y);
      const s = 1 - d / Math.max(x.length, y.length);
      if (s > best) best = s;
    }
  }
  return best;
};

export type Candidate<T> = { item: T; score: number };

/**
 * 找相似的。**0.66 这个阈值是量出来的，不是拍的。**
 *
 * 定这个数的是一个真实样本：语音转写把 Rosenfeld 听成 "Rozenfelt"（2026-07-31 实测）。
 * 两个词的编辑距离是 3、长度 9，相似度 0.667 —— 阈值只要 ≥0.67 就捞不回来，
 * 而捞不回来的后果不是「没找到」，是 agent 转头调 `flag_new_company`
 * 提议新建一家叫 Rozenfelt 的客户。
 *
 * 往「宁可多报」那边偏也是有理由的：多报一个候选，人在界面上扫一眼就否掉；
 * 漏报一个，库里就多一家重复客户，而重复客户这件事在展会结束前不会有人发现。
 * 对着真实的 56 家名单跑过，没有出现互相误命中（`match.test.ts` 里有这条）。
 */
export const findSimilar = <T extends { name: string; code?: string }>(
  query: string,
  items: readonly T[],
  { limit = 5, threshold = 0.66 } = {},
): Array<Candidate<T>> => {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const qUpper = q.toUpperCase();
  const out: Array<Candidate<T>> = [];
  for (const item of items) {
    // 直接报 code 的情况（销售有时就说 "ALPIN"）
    const byCode = item.code && item.code.toUpperCase() === qUpper ? 1 : 0;
    const score = Math.max(byCode, similarity(q, item.name));
    if (score >= threshold) out.push({ item, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
};
