#!/usr/bin/env node
/**
 * 把 data/accounts.json 的账户骨架导入 Twenty（T16a）。幂等：按 accountCode 认记录。
 *
 *   node scripts/import-accounts.mjs --dry   # 预览
 *   node scripts/import-accounts.mjs         # 执行
 *
 * 为什么骨架必须先进库（T17）：D28 规定归属必填、Agent 不许猜。库里没有客户记录，
 * 销售录完音就选不到客户 —— 采集端在展会第一天就是死的。
 * 「留空位」指的是**情报字段**空，骨架不能空。
 *
 * 两趟：先集团（无上级），再品牌（挂 parentCompanyId）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeCountry } from '../shared/countries.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
/**
 * `--backfill`：已存在的记录**只补空着的字段**，绝不覆盖有值的。
 *
 * 起因：2026-08-03 实测发现导进去的 56 家客户 `accountType` **全是 null** ——
 * `accounts.json` 里明明有 `OEM_GROUP` / `OEM_BRAND`，是那一次导入时
 * Twenty 上还没建这个字段，于是它被静默丢掉了，而导入脚本报的是「✅ 成功」。
 *
 * 默认的「已存在就跳过」是对的（不冲掉人工修正），但它也意味着
 * **后来补上的 schema 字段永远补不回去**。这个模式补的正是那一类：
 * 只填 null / 空字符串的格子，任何有值的一律不动。
 */
const BACKFILL = process.argv.includes('--backfill');

const env = {};
for (const line of (process.env.SERVER_URL && process.env.TWENTY_API_KEY ? '' : readFileSync(join(ROOT, '.env'), 'utf8')).split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const BASE = (process.env.SERVER_URL || env.SERVER_URL || 'http://localhost:3000').replace(/\/$/, '');
const KEY = process.env.TWENTY_API_KEY || env.TWENTY_API_KEY;
if (!KEY) { console.error('❌ .env 里缺 TWENTY_API_KEY'); process.exit(1); }

const api = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json };
};

const explain = (j) => {
  const out = [];
  const walk = (v, d = 0) => {
    if (!v || d > 6 || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(x => walk(x, d + 1));
    if (typeof v.message === 'string') out.push(v.message);
    Object.values(v).forEach(x => walk(x, d + 1));
  };
  walk(j);
  return [...new Set(out)].slice(0, 2).join(' | ') || JSON.stringify(j).slice(0, 160);
};

/** 拉全部公司（分页游标）→ accountCode → record */
async function fetchExisting() {
  const map = new Map();
  let cursor = null;
  for (let page = 0; page < 30; page++) {
    // OpenAPI 的 servers.url 是 http://host/rest/，所以路径是 /rest/companies（不是 /rest/core/…）
    //
    // 🔴 **`depth=1` 不能省。** 默认深度下 Twenty **不返回嵌套的 `parentCompany`**，
    //    而 `--backfill` 判断「父公司这格空不空」看的正是 `hit.parentCompany?.id` ——
    //    读不到就一律当成空，于是**每跑一趟都把同样的 43 条重写一遍，还每次都打印「✎ 补了」**。
    //    2026-08-04 部署时实测：连跑五趟，趟趟都说补了，而 CRM 里那 43 条一直是好的。
    //    危害不是写坏数据（写的是同一个值），是**让「补了」这个词失去意义** ——
    //    真有一条没补上时，它混在 43 行同样的字里，没人看得出来。
    const q = `/rest/companies?limit=60&depth=1${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ''}`;
    const r = await api('GET', q);
    if (!r.ok) { console.error(`❌ 读取公司列表失败 HTTP ${r.status} ${explain(r.json)}`); process.exit(1); }
    const rows = r.json?.data?.companies ?? r.json?.data ?? [];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const c of rows) if (c?.accountCode) map.set(c.accountCode, c);
    const pi = r.json?.pageInfo;
    if (!pi?.hasNextPage || !pi?.endCursor) break;
    cursor = pi.endCursor;
  }
  return map;
}

const { accounts, warnings } = JSON.parse(readFileSync(join(ROOT, 'data', 'accounts.json'), 'utf8'));
const strip = (o) => Object.fromEntries(
  Object.entries(o).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))
);

console.log(`\n🔗 ${BASE}`);
console.log(`📄 待导入 ${accounts.length} 条（集团 ${accounts.filter(a => a.accountType === 'OEM_GROUP').length} · 品牌 ${accounts.filter(a => a.accountType === 'OEM_BRAND').length}）\n`);

let existing = await fetchExisting();
console.log(`库里已有带 accountCode 的公司 ${existing.size} 条\n`);

let created = 0, updated = 0, skipped = 0, failed = [];

for (const pass of ['OEM_GROUP', 'OEM_BRAND']) {
  const batch = accounts.filter(a => a.accountType === pass);
  console.log(`━━ ${pass === 'OEM_GROUP' ? '第 1 趟 · 集团' : '第 2 趟 · 品牌'}（${batch.length} 条）━━`);

  for (const a of batch) {
    const { parentCode, hqCountry, ...rest } = a;
    const country = normalizeCountry(hqCountry);
    if (hqCountry && !country) { console.error(`❌ ${a.accountCode}：invalid_country`); failed.push(a.accountCode); continue; }
    const payload = strip({ ...rest, hqCountryCode: country });

    if (parentCode) {
      const parent = existing.get(parentCode);
      if (!parent) { console.log(`  ⚠️  ${a.name}：上级 ${parentCode} 不在库里，先不挂`); }
      else payload.parentCompanyId = parent.id;
    }

    const hit = existing.get(a.accountCode);
    if (hit) {
      if (!BACKFILL) {
        // 幂等：已存在就不覆盖（避免把人工修正过的数据冲掉）
        console.log(`  ⏭  ${a.name.padEnd(24)} 已存在`);
        skipped++; continue;
      }
      // 只补空着的格子。**有值的一个都不动。**
      const empty = {};
      for (const [k, v] of Object.entries(payload)) {
        const cur = hit[k];
        const isEmpty = cur === null || cur === undefined || cur === '' ||
          (k === 'parentCompanyId' && !hit.parentCompany?.id);
        if (isEmpty && v !== null && v !== undefined && v !== '') empty[k] = v;
      }
      if (!Object.keys(empty).length) {
        console.log(`  ⏭  ${a.name.padEnd(24)} 没有空格子`);
        skipped++; continue;
      }
      if (DRY) {
        console.log(`  ✎ ${a.name.padEnd(24)} 会补：${Object.keys(empty).join(', ')}`);
        updated++; continue;
      }
      const r = await api('PATCH', `/rest/companies/${hit.id}`, empty);
      if (r.ok) { console.log(`  ✎ ${a.name.padEnd(24)} 补了 ${Object.keys(empty).join(', ')}`); updated++; }
      else { console.log(`  ❌ ${a.name.padEnd(24)} HTTP ${r.status} ${explain(r.json)}`); failed.push(a.accountCode); }
      continue;
    }
    if (DRY) {
      console.log(`  ＋ ${a.name.padEnd(24)} ${a.accountCode}${payload.parentCompanyId ? `  ↳ ${parentCode}` : ''}`);
      continue;
    }
    const r = await api('POST', '/rest/companies', payload);
    if (r.ok) {
      const rec = r.json?.data?.createCompany ?? r.json?.data ?? r.json;
      if (rec?.id) existing.set(a.accountCode, rec);
      console.log(`  ✅ ${a.name.padEnd(24)} ${a.accountCode}${payload.parentCompanyId ? `  ↳ ${parentCode}` : ''}`);
      created++;
    } else {
      console.log(`  ❌ ${a.name.padEnd(24)} HTTP ${r.status} ${explain(r.json)}`);
      failed.push(a.accountCode);
    }
  }
  if (!DRY && pass === 'OEM_GROUP') existing = await fetchExisting();  // 品牌要用集团的真实 id
  console.log();
}

console.log('─'.repeat(58));
if (DRY) console.log('🔍 DRY RUN —— 什么都没写。');
else console.log(`✅ 新建 ${created} · 跳过（已存在）${skipped}`);
if (warnings?.length) {
  console.log(`\n⚠️  抽取阶段的 ${warnings.length} 条提示（归 T16b / Lena）：`);
  for (const w of warnings) console.log(`   · ${w}`);
}
if (failed.length) { console.log(`\n❌ 失败 ${failed.length} 条：${failed.join(', ')}`); process.exit(1); }
