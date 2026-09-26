#!/usr/bin/env node
/**
 * 全量重算情报完整度，写回客户档案（D17③）。
 *
 * 网关在每次确认入库之后会自己重算这家客户的（`confirm.ts`），
 * 这个脚本管的是**另外两件事**：
 *   ① 清单改了之后 —— 加一项、改权重、停用一项，56 家的完整度全部要跟着变
 *   ② 第一次灌清单之后 —— 在那之前所有人的这一列都是空的
 *
 * 没有它，「情报最缺的」那个视图（D60）只是一张乱序的表，
 * 客户列表里「情报完整度%」永远是空的 —— 而需求 1 的全部界面表达就是这一列。
 *
 * 幂等，随便重跑。**只写三个派生列**（`intelCompleteness` / `missingIntel` / `nextAsk`），
 * 别的一个字都不碰。
 *
 * 用法：
 *   node scripts/recompute-intel.mjs         # 预览
 *   node scripts/recompute-intel.mjs --yes   # 真写
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const YES = process.argv.includes('--yes');

const envFile = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);
// ⚠️ SERVER_URL 是 .env 里实际存在的那个键（provision-twenty.mjs 读的也是它）。
// 只认 TWENTY_API_URL 的话，在 `docker run --network boothnote_default` 的一次性容器里
// 会回退到 localhost:3000 —— 那里什么都没有，于是 deploy.sh 绿着跑完但一步都没生效。
const URL_ =
  process.env.TWENTY_API_URL ??
  process.env.SERVER_URL ??
  envFile.TWENTY_API_URL ??
  envFile.SERVER_URL ??
  'http://localhost:3000';

const KEY = process.env.TWENTY_API_KEY ?? envFile.TWENTY_API_KEY;
if (!KEY) {
  console.error('🔴 .env 里没有 TWENTY_API_KEY。');
  process.exit(1);
}

const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (method, path, body, attempt = 0) => {
  const res = await fetch(`${URL_}${path}`, { method, headers: H, body: body && JSON.stringify(body) });
  if (res.status === 429 && attempt < 5) {
    await sleep(500 * 2 ** attempt);
    return call(method, path, body, attempt + 1);
  }
  const t = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${t.slice(0, 160)}`);
  await sleep(40);
  return JSON.parse(t || '{}');
};
const listAll = async (plural, extra = '') => {
  const out = [];
  let cursor = null;
  for (let p = 0; p < 30; p++) {
    const r = await call('GET', `/rest/${plural}?limit=60${extra}${cursor ? `&starting_after=${cursor}` : ''}`);
    out.push(...(r?.data?.[plural] ?? []));
    if (!r?.pageInfo?.hasNextPage || !r?.pageInfo?.endCursor) break;
    cursor = r.pageInfo.endCursor;
  }
  return out;
};

// ⚠️ SELECT 在 Twenty 里是大写的 —— 和网关的 normalizeIntelItem() 保持一致
const items = (await listAll('intelItems'))
  .map((i) => ({
    id: i.id,
    itemKey: i.itemKey,
    question: i.question ?? '',
    appliesTo: String(i.appliesTo ?? 'company').toLowerCase(),
    wave: i.wave ?? null,
    weight: i.weight ?? null,
    isEnabled: i.isEnabled !== false,
    requiredForStage: i.requiredForStage ?? null,
  }))
  .filter((i) => i.isEnabled && i.appliesTo === 'company');

if (!items.length) {
  console.error('🔴 情报清单是空的。先跑 `node scripts/seed-intel-items.mjs --yes`。');
  process.exit(1);
}
const scored = items.filter((i) => (i.weight ?? 0) > 0);
const totalWeight = scored.reduce((s, i) => s + (i.weight ?? 0), 0);
console.log(`\n清单 ${items.length} 项（有权重的 ${scored.length} 项，分母 ${totalWeight}）\n`);

const companies = (await listAll('companies', '&depth=1')).filter((c) => c.accountCode);
const values = await listAll('intelValues', '&depth=1');
const valuesByCompany = new Map();
for (const v of values) {
  const cid = v.company?.id ?? v.companyId;
  if (!cid) continue;
  if (!valuesByCompany.has(cid)) valuesByCompany.set(cid, []);
  valuesByCompany.get(cid).push(v);
}

const isBlank = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
const sortMissing = (rows) =>
  [...rows].sort(
    (a, b) =>
      (a.wave ?? 9) - (b.wave ?? 9) ||
      Number(Boolean(b.requiredForStage)) - Number(Boolean(a.requiredForStage)) ||
      (b.weight ?? 0) - (a.weight ?? 0),
  );

let wrote = 0;
let unchanged = 0;
const dist = {};

for (const c of companies) {
  const filled = new Set(
    (valuesByCompany.get(c.id) ?? []).map((v) => v.intelItem?.itemKey).filter(Boolean),
  );
  const missing = sortMissing(items.filter((i) => !filled.has(i.itemKey) && isBlank(c[i.itemKey])));
  const missingSet = new Set(missing);
  const got = scored.filter((i) => !missingSet.has(i)).reduce((s, i) => s + (i.weight ?? 0), 0);
  const pct = totalWeight ? Math.round((got / totalWeight) * 100) : null;

  const patch = {
    intelCompleteness: pct,
    missingIntel: missing.map((m) => m.itemKey).join(', ').slice(0, 500) || null,
    // 🔴 只放前三个（D17④）。一次摊 19 项等于回到钉钉文档，销售直接放弃。
    nextAsk: missing.slice(0, 3).map((m) => m.question).join('　/　').slice(0, 500) || null,
  };

  const same = Object.entries(patch).every(([k, v]) => (c[k] ?? null) === (v ?? null));
  const bucket = pct == null ? '—' : `${Math.floor(pct / 20) * 20}–${Math.floor(pct / 20) * 20 + 19}%`;
  dist[bucket] = (dist[bucket] ?? 0) + 1;

  if (same) {
    unchanged++;
    continue;
  }
  if (YES) await call('PATCH', `/rest/companies/${c.id}`, patch);
  wrote++;
}

console.log('完整度分布：');
for (const [k, v] of Object.entries(dist).sort()) console.log(`  ${k.padEnd(8)} ${v} 家`);

const worst = companies
  .map((c) => ({ name: c.name, pct: c.intelCompleteness }))
  .filter((x) => x.pct != null)
  .sort((a, b) => a.pct - b.pct)
  .slice(0, 5);
if (YES && worst.length) {
  console.log('\n（重算前的）最缺的五家：' + worst.map((w) => `${w.name} ${w.pct}%`).join(' · '));
}

console.log(
  YES
    ? `\n✅ 更新 ${wrote} 家 · 未变 ${unchanged} 家\n`
    : `\n这是预览：会更新 ${wrote} 家、${unchanged} 家没变。真要写加 \x1b[1m--yes\x1b[0m。\n`,
);
