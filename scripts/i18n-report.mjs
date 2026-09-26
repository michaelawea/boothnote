#!/usr/bin/env node
/**
 * i18n 覆盖率 —— 「英文模式下还有哪些地方会显示中文」（D80）。
 *
 *   node scripts/i18n-report.mjs           按文件汇总
 *   node scripts/i18n-report.mjs --list    逐条列出来（拿去补字典）
 *   node scripts/i18n-report.mjs --check   有缺口就 exit 1（test.sh 用这一档）
 *
 * ══ 🔴 2026-08-11：这个脚本自己坏过一次，而且是最贵的那种坏法 ══════
 *
 * 上一版把**「过了 `t()`」当成「翻得出来」** —— 它数 `t('中文')` 的出现次数，
 * 从不回头查那条中文在字典里有没有，于是报出 **82%**。
 * 更要命的是它**一档都不会红**：`test.sh` 里根本没有它，只有人想起来才跑一次。
 *
 * 第二个洞：**只认单引号字符串字面量**，看不见 `<span>第 {wave} 次问</span>`
 * 这类 **JSX 文本节点**。那是根本没走 `t()` 的中文，补字典也修不好，得改代码 ——
 * 2026-08-11 维护者 报上来的三条里，有两条正是这一类（共 34 处）。
 *
 * 判据（已进 CLAUDE.md）：**一个覆盖率数字必须由「查得到译文」定义，
 * 不能由「调用了翻译函数」定义。** 后者只证明有人写过那行代码。
 *
 * ⚠️ **写这一版的时候，我自己在同一个地方栽了一次，记在这里当反面教材：**
 *    第一版的 key 解析只认 `'中文':` 和裸 key，**漏掉了 148 条 `"中文":`**，
 *    于是它报「覆盖率 32%、缺 338 条」—— 一个吓人但是假的数字，
 *    差点照着它把已经翻好的东西再翻一遍。真实起点是 **87%**（缺 69 条）。
 *    🔴 **量之前先验尺子**：拿几个一定存在的 key（`取消`/`关闭`/`返回`）
 *    去 assert 一遍解析结果，再信它报的数。同 §2.44。
 *
 * ══ 它现在怎么判 ══════════════════════════════════════════════════
 *
 * ① 扫出所有**会显示给人**的中文串：
 *    · 单引号 / 双引号 / 模板串里的中文字面量（标签表也在内 —— 那些在渲染处才过 t()）
 *    · JSX 文本节点里的中文（这类根本没走 t()）
 * ② 逐条去 `i18n.ts` 的 EN 表里查。**查不到 = 英文模式下显示中文。**
 * ③ `--check` 下任何一条查不到就 exit 1。
 *
 * 不算数的两类，都有明确理由：
 *   · `console.*` 里的中文 —— 日志是给开发看的（CLAUDE.md 明写「刻意不翻」）
 *   · 行尾带 `i18n-ignore` 注释的 —— 逃生口，但要在代码里写出理由
 *
 * ══ ⚠️ 它守不住的两件事，**别把它的绿当成全部** ══════════════════
 *
 * ① **「字典里有」不等于「那一行过了 `t()`」。**
 *    脚本只看字面量在不在字典里，看不出它有没有真的被翻。
 *    这是**故意的**：标签表（`{ pending: '待整理' }`）是在渲染处才过 `t()` 的，
 *    要求「必须同行调用 t()」会把那一整套写法全判成红。
 *    代价就是 `join('、')` 这种漏网它抓不到 —— 2026-08-11 实测栽过一次：
 *    往字典里加了 `'、'`，脚本当场变绿，而那一行**根本没调 `t()`**。
 *    🔴 **加字典条目之前，先去调用点确认那一行真的会过 `t()`。**
 *
 * ② **服务端给的中文它一个字也看不见。**
 *    `/enums`、`/gaps`、`/staging/:id/targets` 的 label 都在网关里生成，
 *    PWA 源码里只有一个 `{a}` 占位符。那几处只能靠 `labelsFor(locale, …)`
 *    在服务端做，靠这个脚本发现不了。**扫源码的守卫只能守住源码里的东西。**
 */
import { readFileSync, globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'apps/capture-pwa/src');
const LIST = process.argv.includes('--list');
const CHECK = process.argv.includes('--check');

const HAN = /[一-鿿]/;
/**
 * JSX 文本节点还要抓**光有中文标点、一个汉字都没有**的那种。
 *
 * 🔴 实测漏过一个：`{t('再跑一次')}<code> seed-suppliers</code>。` ——
 *    结尾那个裸的 `。` 不在 `[一-鿿]` 里，扫不出来，
 *    于是英文界面上是 `… Run it again seed-suppliers。`。
 *    **一个字都没有的中文，仍然是中文。**
 * ⚠️ 不收 `——`（U+2014）和 `…` —— 英文译文里本来就在用。
 */
const CJK_PUNCT = /[。，、；：？！「」『』（）【】《》]/;

// ── 字典：直接从 i18n.ts 的 EN 对象里抠 key ────────────────────────
const dictSrc = readFileSync(join(SRC, 'i18n.ts'), 'utf8');
const body = dictSrc.slice(dictSrc.indexOf('const EN'), dictSrc.indexOf('export const DICT_EN'));
/**
 * key 有**三种写法**，一种都不能漏：`'中文':` / `"中文":` / 裸的 `速记:`。
 *
 * 🔴 2026-08-11 自己在这里栽过一次：只认单引号和裸 key，
 *    于是 148 条双引号条目**被当成不存在**，报出来的覆盖率整整低了一大截，
 *    差点照着一份虚高的缺口清单去重复翻译已经翻好的东西。
 *    **量之前先验尺子** —— 和 §2.44「变异测试的第一步是确认变异真的应用了」同一条。
 */
const keys = new Set(
  [...body.matchAll(/^\s*(?:'([^']+)'|"([^"]+)"|([^\s'":,{}()[\]]+))\s*:\s*(?:'|"|$)/gm)].map(
    (m) => m[1] ?? m[2] ?? m[3],
  ),
);

/**
 * 一行里所有会显示给人的中文串。
 * 🔴 **JSX 文本节点单独一类**：它没走 `t()`，补字典修不好，必须改代码。
 */
const scan = (line) => {
  const lit = [];
  /**
   * 🔴 字面量也要认**中文标点**，不能只认汉字。
   *    `t('。')` 和 `t('「{a}」')` 一个汉字都没有 —— 只认 `[一-鿿]` 的话
   *    它们既不算「用到的串」、也不算「缺的串」，**在统计里根本不存在**，
   *    于是 100% 是假的。这两条正是这么漏出去的。
   */
  const isCjk = (x) => HAN.test(x) || CJK_PUNCT.test(x);
  for (const m of line.matchAll(/'([^'\n]*)'/g)) if (isCjk(m[1])) lit.push(m[1]);
  for (const m of line.matchAll(/"([^"\n]*)"/g)) if (isCjk(m[1])) lit.push(m[1]);
  /**
   * 模板串：先把 `${…}` 挖掉再看还剩不剩中文。
   * 不挖的话 `` ` · ${t('当前')}` `` 会被当成一条**整串没翻**的漏网 ——
   * 而它里头那个 `t()` 明明是对的。**误报会让人去改一处本来没问题的代码。**
   */
  for (const m of line.matchAll(/`([^`\n]*)`/g)) {
    const outer = m[1].replace(/\$\{[^}]*\}/g, '');
    if (isCjk(outer)) lit.push(outer);
  }

  const bare = line
    .replace(/'[^'\n]*'/g, '')
    .replace(/"[^"\n]*"/g, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(/\{[^{}]*\}/g, '') // {表达式}
    .replace(/<[^<>]*>/g, ''); // 标签
  const leaks = HAN.test(bare) || CJK_PUNCT.test(bare);
  return { lit, jsx: leaks ? bare.trim().replace(/\s+/g, ' ') : null };
};

const per = new Map();
const missing = new Map(); // 中文串 → [出处]
const jsxHits = [];
const used = new Set();

for (const f of globSync('**/*.{ts,tsx}', { cwd: SRC }).sort()) {
  if (f.includes('__tests__') || f === 'i18n.ts') continue;
  const raw = readFileSync(join(SRC, f), 'utf8');
  // 注释不算，但要保住行号 → 原样长度的空白替换
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
  const rawLines = raw.split('\n');
  const stat = { ok: 0, miss: 0, jsx: 0 };

  code.split('\n').forEach((line, i) => {
    if (!HAN.test(line) && !CJK_PUNCT.test(line)) return;
    const orig = rawLines[i];
    if (/console\./.test(line)) return; // 日志刻意不翻
    if (/i18n-ignore/.test(orig)) return; // 显式逃生口

    const at = `${f}:${i + 1}`;
    const { lit, jsx } = scan(line);
    for (const s of lit) {
      used.add(s);
      if (keys.has(s)) stat.ok++;
      else {
        stat.miss++;
        if (!missing.has(s)) missing.set(s, []);
        missing.get(s).push(at);
      }
    }
    if (jsx) {
      stat.jsx++;
      jsxHits.push({ at, txt: orig.trim() });
    }
  });
  if (stat.ok || stat.miss || stat.jsx) per.set(f, stat);
}

// ── 输出 ──────────────────────────────────────────────────────────
const totalMiss = [...per.values()].reduce((s, v) => s + v.miss, 0);
const totalJsx = jsxHits.length;
/** 🔴 **向下取整**：529/531 四舍五入是 100%，而那 2 条真的会显示中文。
 *  一个「100%」盖住 5 处漏网，正是这个脚本存在的理由。 */
const pct = used.size ? Math.floor(((used.size - missing.size) / used.size) * 100) : 100;

console.log('\n📊 PWA i18n 覆盖率 —— 按「字典里查得到译文」算，不按「调用了 t()」算\n');
console.log('  查得到   查不到   JSX裸中文   文件');
for (const [f, v] of [...per].sort((a, b) => b[1].miss + b[1].jsx - (a[1].miss + a[1].jsx))) {
  const mark = v.miss === 0 && v.jsx === 0 ? '✅' : v.ok ? '🔸' : '  ';
  console.log(
    `  ${String(v.ok).padStart(6)}   ${String(v.miss).padStart(6)}   ${String(v.jsx).padStart(9)}   ${mark} ${f}`,
  );
}
console.log(
  `\n  用到的中文串（去重）${used.size} 条 · 字典命中 ${used.size - missing.size} · **覆盖率 ${pct}%**`,
);
console.log(`  字典里 ${keys.size} 条；查不到的出现 ${totalMiss} 次 · JSX 裸中文 ${totalJsx} 处`);

/**
 * 字典里有、代码里却搜不到的条目。**只提示，不阻断** —— 它有真误报：
 * 服务端给的中文（CRM 对象名「拜访」「商机」…）是 `t(name)` 这样动态翻的，
 * 源码里根本不会出现那个字面量。**别照着这张表删条目，先去搜一遍用法。**
 */
const dead = [...keys].filter((k) => !used.has(k));
if (dead.length)
  console.log(`  ℹ️ 字典里 ${dead.length} 条在代码里搜不到字面量（可能是中文改过字，也可能是动态 t()）`);

if (LIST) {
  console.log('\n── 字典里查不到的（补 i18n.ts）──\n');
  for (const [s, ats] of [...missing].sort((a, b) => b[1].length - a[1].length))
    console.log(`  ${JSON.stringify(s)}\n       ${ats.join(' ')}`);
  console.log('\n── JSX 文本节点里的裸中文（要改代码，补字典没用）──\n');
  for (const j of jsxHits) console.log(`  ${j.at}\n       ${j.txt.slice(0, 120)}`);
  if (dead.length) {
    console.log('\n── 字典里已经失效的条目 ──\n');
    for (const k of dead) console.log(`  ${JSON.stringify(k)}`);
  }
}

if (!CHECK) process.exit(0);

if (!missing.size && !totalJsx) {
  console.log('\n  ✅ i18n 覆盖完整：英文模式下没有会退回中文的界面串\n');
  process.exit(0);
}
console.error(
  `\n🔴 英文模式下会显示中文 —— 字典缺 ${missing.size} 条 · JSX 裸中文 ${totalJsx} 处\n` +
    `   逐条看：node scripts/i18n-report.mjs --list\n` +
    `   判据：**覆盖率由「查得到译文」定义，不由「调用了 t()」定义。**\n` +
    `   确实不该翻的（开发用文案），在那一行加 \`// i18n-ignore\` 并写清理由。\n`,
);
process.exit(1);
