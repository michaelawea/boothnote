#!/usr/bin/env node
/**
 * schema 漂移守卫 —— **改 label 是安全的，改 name / 枚举 value 会静默毁数据**（§2.28 · D82）。
 *
 * 🔴 这条检查不是预防性条款，它是把一次真实事故的事后对账机械化。
 *    CLAUDE.md 里那句「部署前的两道机械对账值得固化成习惯」写的就是这件事：
 *
 *      改 schema 的 PR 要比对新旧 `twenty-schema.mjs` 的
 *      **字段 `name` 集合**与**枚举 `value` 集合** ——
 *      一样 = 只动了 label（安全）；不一样 = 有东西被改名，线上那份会变成孤儿。
 *
 *    在这个文件出现之前，那条判据只活在文档里，**靠人记得去 grep**。
 *
 * ── 为什么盯 name / value，而不是整个文件 ────────────────────────────
 *
 * `provision-twenty.mjs` 对**已经存在**的东西只做两件事：补缺的、改 label/color。
 * 于是同一个文件里的改动，后果分成完全不同的三档：
 *
 *   🟢 改 label / color / description / icon
 *      → 第 4 步标签同步会 PATCH 上去，数据一个字不动。D78 那 210 条双语标签就是这么上的。
 *
 *   🔴 改字段 `name`（或对象 `nameSingular`）
 *      → provision 找不到同名的，于是**新建一列**。老那列和它全部的数据还在库里，
 *        但再没有任何代码读它 —— **数据没丢，只是从此看不见了**，而且 HTTP 全是 200。
 *
 *   🔴 改枚举 `value`
 *      → `mergeOptions` 的规则 ④「线上有而 SPEC 没有的一律保留」会**保住老值**（数据不丢），
 *        但 `enums.ts` 的白名单、视图、统计从此只认新值 ——
 *        那些记录在按新值过滤的地方**集体消失**，同样没有一行报错。
 *
 *   🔴 改 `type` / 关系 `target` / `isUnique`
 *      → provision 对已存在的字段**根本不会动这几样**。SPEC 说的和线上从此是两回事，
 *        而且它下次跑还是绿的。`project.projectCode` 的 `isUnique` 尤其要命 ——
 *        D59 的「同一个编号重复提交只更新不新建」整个幂等性建在它上面。
 *
 * 所以快照只存那些**改了会静默出事**的东西：对象名 · 字段名+签名 · 枚举值（规范化后）。
 * label 全部不进快照 —— 一个每次改文案都要红一下的检查，很快就没人看了。
 *
 * ── 怎么用 ──────────────────────────────────────────────────────────
 *
 *   node scripts/check-schema-drift.mjs            检查（`./scripts/test.sh` 会自动跑）
 *   node scripts/check-schema-drift.mjs --update   确认这次改动是有意的，更新快照
 *
 * 红了之后**先别急着 --update**。先回答一个问题：线上已经有数据的那一列，
 * 改名之后谁去把数据搬过去？没有答案就改回去。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { OBJECTS, FIELDS, FIELD_UPDATES, toEnumValue } from './twenty-schema.mjs';

const SNAP = join(dirname(fileURLToPath(import.meta.url)), 'schema-snapshot.json');
const UPDATE = process.argv.includes('--update');

const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

/**
 * 字段签名 —— 只放「provision 对已存在字段不会去改」的那几样。
 * 它们变了 = SPEC 和线上从此对不上，而且没有任何报错。
 */
const signature = (f) => {
  if (f.type === 'RELATION') return `RELATION→${f.relation?.target ?? '?'}`;
  return f.isUnique ? `${f.type} unique` : String(f.type);
};

// ── 从 SPEC 里算出「线上会长成什么样」──────────────────────────────
const objects = OBJECTS.map((o) => o.nameSingular).sort();
const fields = {};
const enums = {};
/** 规范化之前的原样，给下面两条绝对判据用。 */
const rawEnums = [];
const defaults = [];

for (const [obj, specs] of Object.entries(FIELDS)) {
  const m = {};
  for (const f of specs) {
    m[f.name] = signature(f);
    if (Array.isArray(f.options)) {
      rawEnums.push({ key: `${obj}.${f.name}`, options: f.options });
      enums[`${obj}.${f.name}`] = [...new Set(f.options.map((o) => toEnumValue(o.value)))].sort();
    }
  }
  fields[obj] = sortKeys(m);
}
for (const u of FIELD_UPDATES) {
  const key = `${u.object}.${u.field}`;
  if (Array.isArray(u.patch?.options)) {
    rawEnums.push({ key, options: u.patch.options });
    enums[key] = [...new Set(u.patch.options.map((o) => toEnumValue(o.value)))].sort();
  }
  if (u.patch?.defaultValue !== undefined) defaults.push({ key, value: u.patch.defaultValue });
}

const current = { objects, fields: sortKeys(fields), enums: sortKeys(enums) };

// ══════════════════════════════════════════════════════════════════
//  一、绝对判据 —— 不用跟任何基线比，本身就是错的
//     （D82 的教训：只会做相对比较的守卫，看不见「基线之前就已经错了的」）
// ══════════════════════════════════════════════════════════════════
const absolute = [];

// ① 两个 value 规范化之后撞成同一个 → 线上只会剩一个选项，静默少一个
for (const { key, options } of rawEnums) {
  const seen = new Map();
  for (const o of options) {
    const norm = toEnumValue(o.value);
    if (seen.has(norm)) {
      absolute.push(
        `枚举 ${key} 里 '${seen.get(norm)}' 和 '${o.value}' 规范化后都是 ${norm} —— ` +
          `Twenty 上只会存在一个选项，另一个**无声无息地不见了**`,
      );
    }
    seen.set(norm, o.value);
  }
}

// ② FIELD_UPDATES 的 defaultValue 必须真的在选项里
//    schema 文件自己的注释点过这个名：「内置默认是 'NEW'，而我们的枚举里没有 NEW」
for (const { key, value } of defaults) {
  const norm = toEnumValue(value);
  if (!enums[key]?.includes(norm)) {
    absolute.push(
      `${key} 的 defaultValue '${value}'（→ ${norm}）不在它自己的 options 里 —— ` +
        `新建的记录会带一个这一列不认识的默认值`,
    );
  }
}

// ══════════════════════════════════════════════════════════════════
//  二、跟快照比 —— 消失的会静默出事，新增的只是要人确认一句
// ══════════════════════════════════════════════════════════════════
let snapshot;
try {
  snapshot = JSON.parse(readFileSync(SNAP, 'utf8'));
} catch {
  if (!UPDATE) {
    console.error(`\n🔴 找不到 ${SNAP} —— 它是签入仓库的基线，不该缺。\n`);
    console.error('   如果是第一次建，跑：node scripts/check-schema-drift.mjs --update\n');
    process.exit(1);
  }
  snapshot = { objects: [], fields: {}, enums: {} };
}

const gone = [];
const changed = [];
const added = [];

for (const o of snapshot.objects ?? []) {
  if (!current.objects.includes(o)) {
    gone.push(`对象 ${o} —— provision 会当成新对象再建一个，老那份连同它的记录变孤儿`);
  }
}
for (const o of current.objects) {
  if (!(snapshot.objects ?? []).includes(o)) added.push(`对象 ${o}`);
}

const goneFields = new Set();
for (const [obj, m] of Object.entries(snapshot.fields ?? {})) {
  for (const [name, sig] of Object.entries(m)) {
    const now = current.fields[obj]?.[name];
    if (now === undefined) {
      goneFields.add(`${obj}.${name}`);
      gone.push(`字段 ${obj}.${name}（原 ${sig}）—— 改名的话 provision 会**新建一列**，线上老那列的数据从此没人读`);
    } else if (now !== sig) {
      changed.push(`字段 ${obj}.${name}：${sig} → ${now} —— provision 对已存在的字段不改这几样，改了它也不会生效，线上仍是「${sig}」`);
    }
  }
}
for (const [obj, m] of Object.entries(current.fields)) {
  for (const name of Object.keys(m)) {
    if (snapshot.fields?.[obj]?.[name] === undefined) added.push(`字段 ${obj}.${name}`);
  }
}

for (const [key, vals] of Object.entries(snapshot.enums ?? {})) {
  const now = current.enums[key];
  if (!now) {
    // 字段整个没了的话上面已经说过一次，这里不重复
    if (!goneFields.has(key)) gone.push(`枚举 ${key} 整组选项都不见了`);
    continue;
  }
  for (const v of vals) {
    if (!now.includes(v)) {
      gone.push(
        `枚举值 ${key} = ${v} —— 线上那个值会被原样留着（mergeOptions ④，数据不丢），` +
          `但白名单和视图从此不认它，**已有记录在按新值过滤的地方集体消失**`,
      );
    }
  }
}
for (const [key, vals] of Object.entries(current.enums)) {
  const was = snapshot.enums?.[key];
  if (!was) {
    added.push(`枚举 ${key}（${vals.length} 个值）`);
    continue;
  }
  for (const v of vals) if (!was.includes(v)) added.push(`枚举值 ${key} = ${v}`);
}

// ══════════════════════════════════════════════════════════════════
//  三、报告
// ══════════════════════════════════════════════════════════════════
const counts = `${current.objects.length} 个对象 · ${Object.values(current.fields).reduce((n, m) => n + Object.keys(m).length, 0)} 个字段 · ${Object.keys(current.enums).length} 个枚举`;

if (UPDATE) {
  if (absolute.length) {
    console.error('\n🔴 有绝对错误，先修掉再更新快照：\n');
    for (const a of absolute) console.error(`   · ${a}`);
    console.error('');
    process.exit(1);
  }
  writeFileSync(SNAP, `${JSON.stringify(current, null, 2)}\n`);
  const moved = [...gone, ...changed];
  console.log(`\n✅ 快照已更新（${counts}）→ ${SNAP}`);
  if (moved.length) {
    console.log(`\n⚠️  这次记进快照的改动里，有 ${moved.length} 处是「线上已有数据会受影响」的那类：\n`);
    for (const g of moved) console.log(`   · ${g}`);
    console.log('\n   记进快照 ≠ 数据搬过去了。部署前先想清楚线上那份怎么办。');
  }
  if (added.length) console.log(`\n   另有 ${added.length} 处新增（安全）。`);
  console.log('');
  process.exit(0);
}

const blocking = [...absolute, ...gone, ...changed];
if (!blocking.length) {
  const tail = added.length ? `，${added.length} 处新增（安全，跑 --update 记进快照）` : '';
  console.log(`  ✅ schema 无危险漂移：${counts}${tail}`);
  process.exit(0);
}

console.error(`\n🔴 schema 有 ${blocking.length} 处改动会**静默**影响线上已有数据：\n`);
for (const a of absolute) console.error(`   ⛔ ${a}`);
for (const g of gone) console.error(`   ⛔ ${g}`);
for (const c of changed) console.error(`   ⛔ ${c}`);
if (added.length) console.error(`\n   （另有 ${added.length} 处新增，那些是安全的）`);
console.error(`
   判据：**改元数据时「HTTP 200」不等于「没坏事」** ——
   上面每一条 provision-twenty.mjs 都会照跑照回 200，日志里一个字都没有。

   两条出路：
     · 改回去 —— 只动 label / color / description / icon 是安全的，随便改。
     · 确认是有意的，且**想好了线上那份数据怎么办**，再跑：
         node scripts/check-schema-drift.mjs --update
`);
process.exit(1);
