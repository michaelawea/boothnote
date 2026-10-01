#!/usr/bin/env node
/**
 * 把刚跑出来的**业务场景数据留下**，不被清理脚本收走。
 *
 * 起因（维护者 2026-08-03）：「项目、情报、售后怎么都还是全是白的啊」。
 * 追下来不是 bug，是一个**循环**：
 *
 *     ./scripts/test.sh scenarios   → CRM 里长出项目/线程/文档/售后
 *     ./scripts/test.sh all         → 末尾自动清理，把它们连同测试垃圾一起删掉
 *     打开 CRM                       → 又是白的
 *
 * 两边都对：`api.test.ts` 造的几十条一次性记录**必须**清掉（他上一轮的原话是
 * 「我数据库里面全是你测试的屎」），而 `scenarios` 跑的是 `docs/test_example`
 * 的六个真实业务用例 —— 那是**演示级的数据**，正是打开 CRM 该看到的东西。
 *
 * 修法：把这批记录的 `recordedBy` 改成真人（默认 alex）。
 * 于是 `purge-test-records.mjs` 的**出口复核**会自动放过它们 ——
 * 不需要再维护第二张白名单，两个脚本靠同一条规则说话。
 *
 * 用法（跑完 `./scripts/test.sh scenarios` 之后）：
 *   node scripts/keep-scenarios.mjs         # 预览
 *   node scripts/keep-scenarios.mjs --yes   # 真改
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const YES = process.argv.includes('--yes');
const KEEPER = process.argv.find((a) => a.startsWith('--as='))?.slice(5) ?? 'alex';

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

/**
 * ── 守卫：非本地一律拒跑（2026-08-10 补）────────────────────────────
 *
 * 🔴 **这是测试配套脚本，却是这一族里唯一没有闸门的**（2026-08-10 逐个对过：
 *    `purge-test-records.mjs` / `reset-testdata.mjs` / `e2e-agent.mjs` /
 *    `api.test.ts` / `scenarios.test.ts` 都有，只有它没有）。
 *
 * 它做的事是**把一批记录的 `recordedBy` 改成真人**。在本地这是「把演示数据留住」；
 * 在生产上跑就是**把线上记录的录入人改掉** —— 而 `recordedBy` 正是
 * 「这条情报是谁报的」的唯一答案（D34/D35④，`createdBy` 答的是另一个问题）。
 * 改错了没有任何地方能还原。
 *
 * 和集成测试同一条判据，也同一种写法：绕过要把**目标主机名**写出来，`=1` 不管用。
 */
const isLocalUrl = (u) => /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(u);
if (!isLocalUrl(URL_)) {
  const host = (() => {
    try {
      return new URL(URL_).host;
    } catch {
      return URL_;
    }
  })();
  if (process.env.ALLOW_NONLOCAL_TESTS !== host) {
    console.error(`
🔴 这个脚本会改记录的 recordedBy（「这条情报是谁报的」），只对本地跑。
   目标 = ${URL_}

   真要对 ${host} 跑：ALLOW_NONLOCAL_TESTS=${host}（把主机名写出来，'1' 不管用）
`);
    process.exit(1);
  }
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
const listAll = async (plural) => {
  const out = [];
  let cursor = null;
  for (let p = 0; p < 30; p++) {
    const r = await call('GET', `/rest/${plural}?limit=60&depth=1${cursor ? `&starting_after=${cursor}` : ''}`);
    out.push(...(r?.data?.[plural] ?? []));
    if (!r?.pageInfo?.hasNextPage || !r?.pageInfo?.endCursor) break;
    cursor = r.pageInfo.endCursor;
  }
  return out;
};

const contributors = await listAll('contributors');
const keeper = contributors.find((c) => c.userCode === KEEPER);
if (!keeper) {
  console.error(`🔴 Twenty 里没有 userCode=${KEEPER} 的录入人。用 --as=<代号> 指定一个存在的。`);
  console.error(`   现有：${contributors.map((c) => c.userCode).join(', ')}`);
  process.exit(1);
}

/** 场景验收用的账号。`scenarios.test.ts` 里写死的前缀。 */
const SCENARIO_PREFIX = 't-admin-sc-';
const scenarioIds = new Set(
  contributors.filter((c) => String(c.userCode ?? '').startsWith(SCENARIO_PREFIX)).map((c) => c.id),
);

if (!scenarioIds.size) {
  console.log('\n没有找到场景验收的录入人 —— 先跑 `./scripts/test.sh scenarios`。\n');
  process.exit(0);
}

// ⚠️ projectUpdates（D139）不在这里：它没有 recordedBy（门户账号不进 CRM），场景验收也不建它。
//    它跟着项目走 —— 项目改到真人名下之后，purge-test-records 就不会去反查它。
const PLURALS = ['visits', 'projects', 'workItems', 'projectDocs', 'supportCases', 'productFitments', 'intelValues'];
const move = [];
for (const plural of PLURALS) {
  const rows = await listAll(plural);
  for (const r of rows) if (scenarioIds.has(r.recordedBy?.id)) move.push({ plural, id: r.id, name: r.name });
}

console.log(`\n\x1b[1m▸ 会改成「${keeper.name}」名下的记录\x1b[0m`);
const by = {};
for (const m of move) by[m.plural] = (by[m.plural] ?? 0) + 1;
for (const [k, v] of Object.entries(by)) console.log(`  ${k.padEnd(18)} ${String(v).padStart(3)} 条`);
if (!move.length) console.log('  （没有）');

console.log(`\n\x1b[1m▸ 为什么这样就留得住\x1b[0m`);
console.log('  purge-test-records.mjs 删之前会逐条回读 recordedBy，是真人就跳过。');
console.log('  改完之后再跑清理，这些记录会被明确地「挡下」而不是删掉。');

if (!move.length) process.exit(0);
if (!YES) {
  console.log('\n  这是预览。真要改加 \x1b[1m--yes\x1b[0m。\n');
  process.exit(0);
}

let n = 0;
for (const m of move) {
  try {
    await call('PATCH', `/rest/${m.plural}/${m.id}`, { recordedById: keeper.id });
    n++;
  } catch (e) {
    console.warn(`  ⚠️ ${m.plural}/${m.id.slice(0, 8)}：${String(e).slice(0, 110)}`);
  }
}
console.log(`\n✅ ${n} 条记录已改到「${keeper.name}」名下，清理脚本不会再动它们。`);
console.log('   记得跑一次 `node scripts/backfill-timeline.mjs --yes` 把 timeline 对上。\n');
