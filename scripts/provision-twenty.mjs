#!/usr/bin/env node
/**
 * 把 twenty-schema.mjs 里的结构写进 Twenty —— 幂等，可反复跑。
 *
 * 用法：
 *   node scripts/provision-twenty.mjs           # 执行
 *   node scripts/provision-twenty.mjs --dry     # 只看要做什么，不写
 *   node scripts/provision-twenty.mjs --probe   # 只探测 API 响应形状（排错用）
 *
 * 需要 .env 里有：
 *   SERVER_URL=http://localhost:3000
 *   TWENTY_API_KEY=...      ← 在 Twenty 界面 Settings → API & Webhooks / Playground 生成
 *
 * D8：只经 Metadata API，绝不直写 Twenty 的表。
 * 这个脚本就是「VPS 上重建结构 = 一条命令」的那条命令。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { OBJECTS, FIELDS, FIELD_UPDATES, toEnumValue } from './twenty-schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const PROBE = process.argv.includes('--probe');

// ── .env ───────────────────────────────────────────────────────────
const env = {};
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch { /* 没有 .env 就靠 process.env */ }

const BASE = (process.env.SERVER_URL || env.SERVER_URL || 'http://localhost:3000').replace(/\/$/, '');
const KEY = process.env.TWENTY_API_KEY || env.TWENTY_API_KEY;

if (!KEY) {
  console.error(`
❌ 缺少 TWENTY_API_KEY。

   1. 打开 ${BASE}
   2. Settings → API & Webhooks（或 Playground）→ 生成一个 API key
   3. 把它加到 .env：   TWENTY_API_KEY=粘贴在这里
   4. 重跑本脚本

   （.env 已在 .gitignore 里，不会进版本库）
`);
  process.exit(1);
}

// ── HTTP ───────────────────────────────────────────────────────────
const log = (...a) => console.log(...a);
let created = { objects: 0, fields: 0, updated: 0 }, skipped = { objects: 0, fields: 0 }, failures = [];

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json };
}

/** Twenty 的 REST 包装层在不同版本里形状不完全一致，这里统一挖出数组。 */
function asList(json) {
  const seen = new Set();
  const dig = (v, depth = 0) => {
    if (!v || depth > 4 || typeof v !== 'object') return null;
    if (Array.isArray(v)) return v;
    if (seen.has(v)) return null; seen.add(v);
    for (const k of ['data', 'objects', 'fields', 'items', 'results', 'edges', 'node']) {
      if (k in v) { const r = dig(v[k], depth + 1); if (r) return r; }
    }
    for (const val of Object.values(v)) { const r = dig(val, depth + 1); if (r) return r; }
    return null;
  };
  const list = dig(json) || [];
  return list.map(x => (x && typeof x === 'object' && 'node' in x ? x.node : x));
}

const normalizeOptions = (options) =>
  options.map((o, i) => ({ ...o, value: toEnumValue(o.value), position: o.position ?? i }));

/** 创建接口在不同版本可能收扁平体或包一层，两种都试。 */
async function createWithFallback(path, payload, wrapKey) {
  const first = await api('POST', path, payload);
  if (first.ok) return first;
  if (first.status === 400 || first.status === 422) {
    const wrapped = await api('POST', path, { [wrapKey]: payload });
    if (wrapped.ok) return wrapped;
  }
  // 只在扁平体成功时才用包一层的结果；失败时**永远回报第一次的错误**，
  // 否则包一层那次会抱怨「objectMetadataId 缺失」，把真正的原因盖掉。
  return first;
}

/** 从 Twenty 的嵌套校验错误里挖出人能看懂的那句话。 */
function explain(json) {
  const msgs = [];
  const walk = (v, d = 0) => {
    if (!v || d > 6) return;
    if (Array.isArray(v)) return v.forEach(x => walk(x, d + 1));
    if (typeof v !== 'object') return;
    if (typeof v.message === 'string' && v.code) msgs.push(v.message);
    Object.values(v).forEach(x => walk(x, d + 1));
  };
  walk(json);
  const uniq = [...new Set(msgs)];
  return uniq.length ? uniq.slice(0, 2).join(' | ') : JSON.stringify(json).slice(0, 180);
}

// ── 主流程 ─────────────────────────────────────────────────────────
log(`\n🔗 ${BASE}\n`);

const probe = await api('GET', '/rest/metadata/objects');
if (!probe.ok) {
  console.error(`❌ 读取对象元数据失败 (HTTP ${probe.status})`);
  console.error(JSON.stringify(probe.json).slice(0, 500));
  console.error('\n   401/403 → API key 无效或权限不足，去 Settings 重新生成一个。');
  process.exit(1);
}
if (PROBE) {
  const l = asList(probe.json);
  log('响应顶层键：', Object.keys(probe.json));
  log(`解析出 ${l.length} 个对象`);
  log('第一个对象的键：', l[0] ? Object.keys(l[0]) : '(空)');
  log(JSON.stringify(l[0], null, 2).slice(0, 1200));
  process.exit(0);
}

const refresh = async () => {
  const r = await api('GET', '/rest/metadata/objects');
  const map = new Map();
  for (const o of asList(r.json)) if (o?.nameSingular) map.set(o.nameSingular, o);
  return map;
};

let objects = await refresh();
log(`现有对象 ${objects.size} 个：${[...objects.keys()].join(', ')}\n`);

// ── 1. 建对象 ──────────────────────────────────────────────────────
log('━━ 1/4 自定义对象 ━━');
for (const spec of OBJECTS) {
  if (objects.has(spec.nameSingular)) { log(`  ⏭  ${spec.nameSingular}（已存在）`); skipped.objects++; continue; }
  if (DRY) { log(`  ＋ ${spec.nameSingular}  ${spec.labelSingular}`); continue; }
  const r = await createWithFallback('/rest/metadata/objects', spec, 'object');
  if (r.ok) { log(`  ✅ ${spec.nameSingular}  ${spec.labelSingular}`); created.objects++; }
  else { log(`  ❌ ${spec.nameSingular} → HTTP ${r.status} ${explain(r.json)}`); failures.push(`object:${spec.nameSingular}`); }
}
if (!DRY && created.objects) objects = await refresh();

// ── 2. 建字段 ──────────────────────────────────────────────────────
log('\n━━ 2/4 字段 ━━');
for (const [objName, fieldSpecs] of Object.entries(FIELDS)) {
  const obj = objects.get(objName);
  if (!obj) { log(`  ⚠️  对象 ${objName} 不存在，跳过它的 ${fieldSpecs.length} 个字段`); failures.push(`missing-object:${objName}`); continue; }
  const existing = new Set(asList(obj.fields ?? obj).map(f => f?.name).filter(Boolean));
  log(`\n  【${objName}】已有 ${existing.size} 个字段`);

  for (const spec of fieldSpecs) {
    if (existing.has(spec.name)) { log(`    ⏭  ${spec.name}`); skipped.fields++; continue; }

    const { relation, options, ...rest } = spec;
    const payload = { ...rest, objectMetadataId: obj.id };
    if (options) payload.options = normalizeOptions(options);
    if (relation) {
      const target = objects.get(relation.target);
      if (!target) { log(`    ❌ ${spec.name} → 关系目标 ${relation.target} 不存在`); failures.push(`rel-target:${objName}.${spec.name}`); continue; }
      payload.type = 'RELATION';
      payload.relationCreationPayload = {
        type: relation.type,
        targetObjectMetadataId: target.id,
        targetFieldLabel: relation.targetFieldLabel,
        targetFieldIcon: relation.targetFieldIcon,
      };
    }
    if (DRY) { log(`    ＋ ${spec.name.padEnd(22)} ${payload.type}`); continue; }
    const r = await createWithFallback('/rest/metadata/fields', payload, 'field');
    if (r.ok) { log(`    ✅ ${spec.name.padEnd(22)} ${payload.type}`); created.fields++; }
    else { log(`    ❌ ${spec.name.padEnd(22)} HTTP ${r.status} ${explain(r.json)}`); failures.push(`field:${objName}.${spec.name}`); }
  }
}

/**
 * 合并枚举选项 —— **这是全脚本最危险的一个函数**（D78 · §2.28）。
 *
 * 🔴 **整包把 SPEC 的 options PATCH 上去 = 静默清空这一列的所有数据。**
 *
 * 2026-08-07 受控实验（本地真库）：
 *   A 整包换（SPEC 的 options，没有 id）→ **HTTP 200**，记录的值变成空
 *   B 保住每个选项的 id、只换 label      → HTTP 200，值完好
 * 也就是说 Twenty 把「没有 id 的选项数组」当成**一组全新的选项**，
 * 旧选项连同引用它们的数据一起没了 —— 而接口回的是 200，日志里什么都没有。
 *
 * 这条不是预防性条款：本仓库已经被它咬过一次而且没查出根因 ——
 * §2.22 ②「`accountType` 61 家全 null，我上一轮报告说 backfill 补好了实际没有」。
 * 真相是 backfill 补好了，**下一次 `provision-twenty.mjs` 又清掉了**。
 * 而 `opportunity.stage` 没有任何 backfill，所以每次部署都把全部商机打回「未接触」——
 * 那是需求 2 机会地图的核心列。
 *
 * 规则：
 *   ① 以**线上**的选项为底，逐个保留（`id` / `value` 一个字节不动）
 *   ② SPEC 里有同 `value` 的，只覆盖 `label` / `color`
 *   ③ SPEC 里多出来的 `value` **追加**在后面（这才是 FIELD_UPDATES 存在的理由）
 *   ④ 线上有而 SPEC 没有的**一律保留** —— 可能是别人在界面上加的，也可能是历史值
 * 返回 null = 没有需要改的，别发这次 PATCH。
 */
const mergeOptions = (live, specOpts) => {
  if (!Array.isArray(specOpts)) return null;
  const spec = normalizeOptions(specOpts);
  const byValue = new Map(spec.map((o) => [o.value, o]));
  const seen = new Set();
  let dirty = false;

  const out = (Array.isArray(live) ? live : []).map((o) => {
    seen.add(o.value);
    const w = byValue.get(o.value);
    if (!w) return o; // ④ 线上独有的原样留着
    const next = { ...o, label: w.label ?? o.label, color: w.color ?? o.color };
    if (next.label !== o.label || next.color !== o.color) dirty = true;
    return next; // ①② id / value 不动
  });

  for (const o of spec) {
    if (seen.has(o.value)) continue;
    out.push({ ...o, position: out.length }); // ③ 新的追加在末尾
    dirty = true;
  }
  return dirty ? out : null;
};

// ── 3. 内置字段：**往里加**选项，不是换掉 ───────────────────────────
log('\n━━ 3/4 内置字段调整 ━━');
for (const u of FIELD_UPDATES) {
  const obj = objects.get(u.object);
  const f = asList(obj?.fields ?? obj ?? {}).find(x => x?.name === u.field);
  if (!f) { log(`  ⚠️  找不到 ${u.object}.${u.field}`); continue; }

  const patch = {};
  const opts = u.patch.options ? mergeOptions(f.options, u.patch.options) : null;
  if (opts) patch.options = opts;
  /**
   * `defaultValue` 只在它**真的要变**时才发。
   * 原来这里无条件重设，配合整包换选项一起，正是上面说的那条数据丢失链。
   * SELECT 的 defaultValue 形如 `'NOT_CONTACTED'`（值本身带单引号）。
   */
  if (u.patch.defaultValue) {
    const want = `'${toEnumValue(u.patch.defaultValue)}'`;
    if (f.defaultValue !== want) patch.defaultValue = want;
  }
  if (!Object.keys(patch).length) { log(`  ⏭  ${u.object}.${u.field}（选项已经齐了）`); continue; }

  if (DRY) {
    const added = opts ? opts.length - (f.options?.length ?? 0) : 0;
    log(`  ~ ${u.object}.${u.field} → ${added > 0 ? `新增 ${added} 个选项` : '选项改标签'}${patch.defaultValue ? ' · 换默认值' : ''}`);
    continue;
  }
  const r = await api('PATCH', `/rest/metadata/fields/${f.id}`, patch);
  if (r.ok) { log(`  ✅ ${u.object}.${u.field}`); created.updated++; }
  else { log(`  ❌ ${u.object}.${u.field} → HTTP ${r.status} ${explain(r.json)}`); failures.push(`update:${u.object}.${u.field}`); }
}

/**
 * ── 4. 标签同步（D78：双语标签）─────────────────────────────────
 *
 * 🔴 **前面三步是「有没有」，这一步是「叫什么」。**
 *
 * 1/4 和 2/4 对已存在的对象/字段是**纯跳过**（`⏭ 已存在`）—— 这是对的，
 * 它们管的是结构。但代价是：改了 `twenty-schema.mjs` 里的 `label` 重跑，
 * **什么都不会发生**。2026-08-07 要把 300 条标签改成双语时才发现这件事。
 *
 * 🔴 **三条不许越过的线**（每一条对应一种「跑完之后数据坏了但界面正常」）：
 *   ① **绝不动 `value`。** 记录里存的是 value，改了它 = 所有引用它的记录成孤儿。
 *   ② **绝不丢选项的 `id`。** 线上选项带 id（实测 `{id,color,label,value,position}`），
 *      而 SPEC 里没有。整包换上去 Twenty 会当成一组**新选项** —— 同样是孤儿。
 *      所以合并规则是「以线上为底，按 value 找到对应项，只换 label」。
 *   ③ **绝不删线上多出来的选项。** SPEC 里没有 ≠ 该删。可能是别人在界面上加的，
 *      也可能是历史值 —— 删了引用它的记录同样成孤儿。
 *
 * ⚠️ `isLabelSyncedWithName` 为 true 的字段**跳过并报出来**：那种字段改 label
 * 会连带改 name，而 name 是网关 API 契约的一部分。实测我们的 268 个字段全是 false，
 * 但这条守卫要留着 —— 以后有人在界面上建字段时默认可能是 true。
 */
log('\n━━ 4/4 标签同步（双语，D78）━━');
objects = await refresh();

let relabelled = 0;
for (const spec of OBJECTS) {
  const obj = objects.get(spec.nameSingular);
  if (!obj) continue;
  const patch = {};
  if (spec.labelSingular && obj.labelSingular !== spec.labelSingular) patch.labelSingular = spec.labelSingular;
  if (spec.labelPlural && obj.labelPlural !== spec.labelPlural) patch.labelPlural = spec.labelPlural;
  if (!Object.keys(patch).length) continue;
  if (obj.isLabelSyncedWithName) {
    log(`  ⚠️  ${spec.nameSingular}：isLabelSyncedWithName=true，改 label 会连带改 name，跳过`);
    failures.push(`label-synced:${spec.nameSingular}`);
    continue;
  }
  if (DRY) { log(`  ~ ${spec.nameSingular}  「${obj.labelSingular}」→「${spec.labelSingular}」`); relabelled++; continue; }
  const r = await api('PATCH', `/rest/metadata/objects/${obj.id}`, patch);
  if (r.ok) { log(`  ✅ ${spec.nameSingular}  →「${spec.labelSingular}」`); relabelled++; }
  else { log(`  ❌ ${spec.nameSingular} → HTTP ${r.status} ${explain(r.json)}`); failures.push(`relabel-object:${spec.nameSingular}`); }
}

for (const [objName, fieldSpecs] of Object.entries(FIELDS)) {
  const obj = objects.get(objName);
  if (!obj) continue;
  const live = new Map(asList(obj.fields ?? obj).filter((f) => f?.name).map((f) => [f.name, f]));
  for (const spec of fieldSpecs) {
    const f = live.get(spec.name);
    if (!f) continue;

    const patch = {};
    if (spec.label && f.label !== spec.label) patch.label = spec.label;
    const opts = mergeOptions(f.options, spec.options);
    if (opts) patch.options = opts;
    if (!Object.keys(patch).length) continue;

    if (f.isLabelSyncedWithName) {
      log(`  ⚠️  ${objName}.${spec.name}：isLabelSyncedWithName=true，跳过`);
      failures.push(`label-synced:${objName}.${spec.name}`);
      continue;
    }
    if (DRY) {
      const what = [patch.label && `「${f.label}」→「${patch.label}」`, patch.options && `${patch.options.length} 个选项换标签`].filter(Boolean).join(' · ');
      log(`  ~ ${objName}.${spec.name.padEnd(20)} ${what}`);
      relabelled++;
      continue;
    }
    const r = await api('PATCH', `/rest/metadata/fields/${f.id}`, patch);
    if (r.ok) { log(`  ✅ ${objName}.${spec.name}`); relabelled++; }
    else { log(`  ❌ ${objName}.${spec.name} → HTTP ${r.status} ${explain(r.json)}`); failures.push(`relabel:${objName}.${spec.name}`); }
  }
}
log(`  ${relabelled ? `共 ${relabelled} 处标签${DRY ? '待同步' : '已同步'}` : '标签都是最新的，没什么可改'}`);

// ── 汇总 ───────────────────────────────────────────────────────────
log(`\n${'─'.repeat(58)}`);
if (DRY) log('🔍 DRY RUN —— 什么都没写。去掉 --dry 才会真的执行。');
else log(`✅ 新建对象 ${created.objects} · 新建字段 ${created.fields} · 更新 ${created.updated}`);
log(`⏭  跳过（已存在）对象 ${skipped.objects} · 字段 ${skipped.fields}`);
if (failures.length) {
  log(`\n⚠️  ${failures.length} 项失败：`);
  for (const f of failures) log(`   · ${f}`);
  log('\n   脚本是幂等的，修好后直接重跑，成功的不会重复创建。');
  process.exit(1);
}
log('\n下一步：打开 ' + BASE + ' 看左侧对象列表，再按 §4.4 配视图。');
