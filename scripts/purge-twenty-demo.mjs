#!/usr/bin/env node
/**
 * 清掉 **Twenty 官方镜像自带的示例数据**（Stripe / Airbnb / Figma / Notion / Anthropic）。
 *
 * 起因：2026-08-03 在 Chrome 里打开 Opportunities，**7 条里有 6 条是 Twenty 的假数据** ——
 * Platform Migration（Stripe）· AI Model Training（Anthropic）· Design Partnership（Figma）…
 * 它们和真实的 RV OEM 商机混在同一张表、同一个看板上。
 *
 * 为什么这不是小事：
 *   · 「机会地图 · 按阶段」看板上会出现 Airbnb —— 这个看板是需求 2 的主视图
 *   · Companies 61 家里有 5 家是假的，`accountType` 永远是 null（不是 bug，是它们本来就不是我们的）
 *   · 给同事演示的时候，第一屏就是五个硅谷公司
 *
 * 🔴 **按固定域名匹配，不按「没有 accountCode」猜。**
 * 「没有 accountCode」这个判据会误伤**人在 Twenty 界面上手工建的客户** ——
 * 那是真数据，而且恰恰是最没人备份的一种。
 *
 * 用法：
 *   node scripts/purge-twenty-demo.mjs         # 预览
 *   node scripts/purge-twenty-demo.mjs --yes   # 真删
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
const call = async (method, path, attempt = 0) => {
  const res = await fetch(`${URL_}${path}`, { method, headers: H });
  if (res.status === 429 && attempt < 5) {
    await sleep(500 * 2 ** attempt);
    return call(method, path, attempt + 1);
  }
  const t = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${t.slice(0, 160)}`);
  await sleep(50);
  return JSON.parse(t || '{}');
};
const listAll = async (plural) => {
  const out = [];
  let cursor = null;
  for (let p = 0; p < 20; p++) {
    const r = await call('GET', `/rest/${plural}?limit=60&depth=1${cursor ? `&starting_after=${cursor}` : ''}`);
    out.push(...(r?.data?.[plural] ?? []));
    if (!r?.pageInfo?.hasNextPage || !r?.pageInfo?.endCursor) break;
    cursor = r.pageInfo.endCursor;
  }
  return out;
};

/** Twenty `seed:dev` 里写死的那五家。**新版本加了别家的话，加在这里。** */
const DEMO_DOMAINS = ['notion.com', 'stripe.com', 'figma.com', 'airbnb.com', 'anthropic.com'];

const companies = await listAll('companies');
const demo = companies.filter((c) => {
  const url = String(c.domainName?.primaryLinkUrl ?? '').toLowerCase();
  const hit = DEMO_DOMAINS.some((d) => url.includes(d));
  // 双保险：有 accountCode 的一定是我们导进去的，无论域名像什么都不碰
  return hit && !c.accountCode;
});
const demoIds = new Set(demo.map((c) => c.id));

const people = (await listAll('people')).filter((p) => demoIds.has(p.company?.id ?? p.companyId));
const opps = (await listAll('opportunities')).filter((o) => demoIds.has(o.company?.id ?? o.companyId));

console.log(`\n\x1b[1m▸ Twenty 自带的示例数据\x1b[0m`);
console.log(`  companies    ${String(demo.length).padStart(3)}  ${demo.map((c) => c.name).join(', ') || '（没有）'}`);
console.log(
  `  people       ${String(people.length).padStart(3)}  ` +
    (people.map((p) => `${p.name?.firstName ?? ''} ${p.name?.lastName ?? ''}`.trim()).join(', ') || '（没有）'),
);
console.log(`  opportunities${String(opps.length).padStart(3)}  ${opps.map((o) => o.name).join(', ') || '（没有）'}`);

console.log(`\n\x1b[1m▸ 不会碰的\x1b[0m`);
console.log(`  带 accountCode 的客户 ${companies.filter((c) => c.accountCode).length} 家（我们导进去的 56 家 + 现场新建的）`);

if (!demo.length && !people.length && !opps.length) {
  console.log('\n✅ 已经清干净了。\n');
  process.exit(0);
}
if (!YES) {
  console.log('\n  这是预览。真要删加 \x1b[1m--yes\x1b[0m。\n');
  process.exit(0);
}

console.log('\n\x1b[1m▸ 删\x1b[0m');
let n = 0;
// 🔴 子在前父在后：opportunity / person 挂着 company，反过来删会被外键挡住
for (const [plural, rows] of [
  ['opportunities', opps],
  ['people', people],
  ['companies', demo],
]) {
  for (const r of rows) {
    try {
      await call('DELETE', `/rest/${plural}/${r.id}`);
      n++;
    } catch (e) {
      if (!/→ 404/.test(String(e.message))) console.warn(`  ⚠️ ${plural}/${r.id}：${String(e.message).slice(0, 110)}`);
    }
  }
  if (rows.length) console.log(`  ✓ ${plural}（${rows.length} 条）`);
}
console.log(`\n✅ 删掉 ${n} 条 Twenty 示例数据。\n`);
