#!/usr/bin/env node
/**
 * 把**测试产生的** Twenty 记录删干净。
 *
 * 起因（维护者 2026-08-03）：「你每次测试的时候，都会在 crm 里面产生一堆屎山，
 * 你能不能相应的都删除一下，要不然我数据库里面全是你测试的屎。」
 *
 * 🔴 **靠 `staging.twenty_refs` 反查，不靠名字猜。**
 *
 * 每次确认入库都会把建出来的 Twenty 记录 id 记进 `staging.twenty_refs`。
 * 所以「哪些记录是测试造的」有一份精确的账：
 *   测试账号的 inbox → 它的 staging → twenty_refs 里的那些 id。
 * 按名字匹配（「回归」「测试」这类词）会误伤 —— 真实数据里也可能出现这些字。
 *
 * ⚠️ **真人账号一个字都不碰。** 名单写死在 `HUMANS` 里。
 * ⚠️ **不删导入的 56 家客户**：只删测试**新建**的那些（有 `intel_field_log` 留痕）。
 *
 * 用法：
 *   node scripts/purge-test-records.mjs           # 预览，什么都不删
 *   node scripts/purge-test-records.mjs --yes     # 真删
 *   node scripts/purge-test-records.mjs --yes --db   # 顺带清掉 boothnote 里那些测试行
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 走网关自己的 db.ts —— `postgres` 装在 services/gateway 下，不在仓库根
const { sql } = await import(join(ROOT, 'services/gateway/src/db.ts'));
const YES = process.argv.includes('--yes');
const ALSO_DB = process.argv.includes('--db');

/**
 * 🔴 **真人账号。这几个名下的东西一个都不许删。**
 * 加测试账号前缀之前先看一眼这里 —— 写错一个字就是删真数据。
 */
const HUMANS = new Set(['alex', 'dev-admin', 'jonas', 'lena']);

/** 测试账号的前缀。集成测试与各种验证脚本建的都长这样。 */
const TEST_PREFIXES = [
  't-admin-', 't-user-',   // 集成测试
  'e2e-',                  // scripts/e2e-agent.mjs
  'm2-', 'v-', 'v2-', 'v3-', 'v4-', 'v5-', // 一次性验证脚本
  'ui-check', 'smoke-',
];

const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);
const DB = process.env.APP_DATABASE_URL ?? env.APP_DATABASE_URL;
// ⚠️ 见 provision-views.mjs 同处注释：SERVER_URL 才是 .env 里实际存在的键。
const URL_ =
  process.env.TWENTY_API_URL ??
  process.env.SERVER_URL ??
  env.TWENTY_API_URL ??
  env.SERVER_URL ??
  'http://localhost:3000';
const KEY = process.env.TWENTY_API_KEY ?? env.TWENTY_API_KEY;
if (!DB || !KEY) {
  console.error('🔴 .env 里缺 APP_DATABASE_URL 或 TWENTY_API_KEY。');
  process.exit(1);
}

// ── 安全闸门：非本地一律拒跑 ────────────────────────────────────────
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(DB) && process.env.ALLOW_NONLOCAL_PURGE !== '1') {
  console.error(`
🔴 这个脚本会**删 Twenty 记录**，只对本地跑。
   APP_DATABASE_URL = ${DB.replace(/:\/\/[^@]*@/, '://***@')}
`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ⚠️ **Twenty 有速率限制。**
 * 第一次跑这个脚本时一口气发了 111 个 DELETE，**58 个撞 429 失败** ——
 * 而那时 boothnote 里的 `twenty_refs` 已经删掉了，失败的那些再也追不回来。
 * 所以：每次调用之间歇一下，撞到 429 就退避重试。
 */
const call = async (method, path, body, attempt = 0) => {
  const res = await fetch(`${URL_}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.status === 429 && attempt < 6) {
    await sleep(500 * 2 ** attempt); // 0.5s → 16s
    return call(method, path, body, attempt + 1);
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 160)}`);
  await sleep(60); // 常速也别打满
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};

// ── 谁是测试账号 ────────────────────────────────────────────────────
const users = await sql`select id, user_code from app_user`;
const testUsers = users.filter(
  (u) => !HUMANS.has(u.user_code) && TEST_PREFIXES.some((p) => u.user_code.startsWith(p)),
);
const humanUsers = users.filter((u) => HUMANS.has(u.user_code));

console.log(`\n\x1b[1m▸ 账号\x1b[0m`);
console.log(`  真人（不碰）  ${humanUsers.map((u) => u.user_code).join(', ') || '（无）'}`);
console.log(`  测试账号      ${testUsers.length} 个`);
const other = users.filter((u) => !HUMANS.has(u.user_code) && !testUsers.includes(u));
if (other.length) {
  console.log(`  \x1b[33m⚠️ 认不出的 ${other.length} 个（当成真人，不碰）：${other.map((u) => u.user_code).join(', ')}\x1b[0m`);
}
/**
 * ⚠️ **这里不能早退。**
 *
 * 第一版写的是「没有测试账号就 exit」—— 而恰恰是「库已经清过、Twenty 还没清干净」
 * 这个状态最需要它跑：boothnote 的行没了，`twenty_refs` 那条线索断了，
 * 只剩下 Twenty 自己身上的 `contributor` 能认出孤儿。
 * 所以哪怕一个测试账号都没有，也要往下走完 contributor 那一遍。
 */
if (!testUsers.length) console.log('  （boothnote 里已经没有测试账号了，只按 contributor 清 Twenty）');

// ── 这些账号建出来的 Twenty 记录 ────────────────────────────────────
const ids = testUsers.map((u) => u.id);
const refs = await sql`
  select s.twenty_refs from staging s join inbox i on i.id = s.inbox_id
  where i.user_id = any(${ids}) and s.twenty_refs is not null`;

/** twenty_refs 的键 → REST 复数路径。**认不出的键跳过**，宁可漏删不可错删。 */
const PATHS = {
  visitId: 'visits',
  productFitmentId: 'productFitments',
  supportCaseId: 'supportCases',
  opportunityId: 'opportunities',
  intelValueId: 'intelValues',
  // D59：项目链。⚠️ 任务线程和文档挂在项目下，**必须先删子再删父**，
  // 否则外键挡着删不掉项目 —— 所以顺序就是这里的书写顺序。
  projectDocId: 'projectDocs',
  projectId: 'projects',
};
const targets = new Map(); // path → Set<id>
for (const r of refs) {
  for (const [k, v] of Object.entries(r.twenty_refs ?? {})) {
    const path = PATHS[k];
    if (!path || typeof v !== 'string' || v.length < 30) continue; // opportunityWas 这种不是 id
    if (!targets.has(path)) targets.set(path, new Set());
    targets.get(path).add(v);
  }
}

/**
 * 第二条线索：**Twenty 里的 `contributor`**。
 *
 * `twenty_refs` 那条线索有个致命弱点 —— boothnote 的行一删，线索就断了。
 * 第一次跑这个脚本正是这样：DB 清干净了，58 条撞 429 没删掉的记录
 * 从此再也追不回来。
 *
 * 而每个账号在 Twenty 里都有一个 `contributor`，记录上的 `recordedBy` 指向它，
 * **这条线索留在 Twenty 自己身上，删库也不影响**。两条线索一起用。
 */
const isTestCode = (code) =>
  !!code && !HUMANS.has(code) && TEST_PREFIXES.some((p) => code.startsWith(p));

const contributors = (await call('GET', '/rest/contributors?limit=200'))?.data?.contributors ?? [];
const testContribIds = new Set(
  contributors.filter((c) => isTestCode(c.userCode)).map((c) => c.id),
);
if (testContribIds.size) {
  // D59 的三个新对象也有 recordedBy —— 不列进来就永远清不掉
  for (const [plural, _] of [
    ['visits'],
    ['productFitments'],
    ['supportCases'],
    ['intelValues'],
    ['projects'],
    ['workItems'],
    ['projectDocs'],
  ]) {
    const rows =
      (await call('GET', `/rest/${plural}?limit=200&depth=1`))?.data?.[plural] ?? [];
    for (const r of rows) {
      if (!testContribIds.has(r.recordedBy?.id)) continue;
      if (!targets.has(plural)) targets.set(plural, new Set());
      targets.get(plural).add(r.id);
    }
  }
}

/**
 * 任务线程按项目反查 —— `twenty_refs.workItems` 存的是**条数**不是 id
 * （一次跟进能拆出好几条，塞不进一个键）。
 * 项目要删掉，它下面的线程就得先删，不然外键挡着。
 */
for (const pid of targets.get('projects') ?? []) {
  const r = await call(
    'GET',
    `/rest/workItems?filter=${encodeURIComponent(`projectId[eq]:${pid}`)}&limit=200`,
  ).catch(() => null);
  for (const w of r?.data?.workItems ?? []) {
    if (!targets.has('workItems')) targets.set('workItems', new Set());
    targets.get('workItems').add(w.id);
  }
  const d = await call(
    'GET',
    `/rest/projectDocs?filter=${encodeURIComponent(`projectId[eq]:${pid}`)}&limit=200`,
  ).catch(() => null);
  for (const x of d?.data?.projectDocs ?? []) {
    if (!targets.has('projectDocs')) targets.set('projectDocs', new Set());
    targets.get('projectDocs').add(x.id);
  }
}

// ── 测试**新建**的客户（导进去的 56 家一个都不动）──────────────────
const madeCompanies = await sql`
  select company_code, value, created_by from intel_field_log
  where item_key like 'company_created:%' and created_by = any(${testUsers.map((u) => u.user_code)})`;

console.log(`\n\x1b[1m▸ 会删掉的 Twenty 记录\x1b[0m`);
let total = 0;
for (const [path, set] of targets) {
  console.log(`  ${path.padEnd(18)} ${String(set.size).padStart(4)} 条`);
  total += set.size;
}
if (madeCompanies.length) {
  console.log(`  companies（测试新建）${String(madeCompanies.length).padStart(3)} 条`);
  for (const c of madeCompanies) console.log(`      · ${c.value}（${c.company_code}）`);
}

/**
 * ── 它们的 timeline 事件（D61）────────────────────────────────────
 *
 * 从 D61 起，每条入库都会在客户 / 录入人 / 项目的 Timeline 上留一行。
 * 只删记录不删事件的话，客户页上会挂着一串**点不开的**灰名字 ——
 * 记录没了，chip 靠 `linkedRecordCachedName` 照样渲染出来。
 * 那正是 维护者 说的「一堆屎」的下一个版本：看起来有内容，点进去是空的。
 */
const doomed = new Set([...targets.values()].flatMap((s) => [...s]));
const orphanEvents = [];
if (doomed.size) {
  let cursor = null;
  for (let page = 0; page < 40; page++) {
    const q = `/rest/timelineActivities?limit=60${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ''}`;
    const r = await call('GET', q).catch(() => null);
    const rows = r?.data?.timelineActivities ?? [];
    for (const t of rows) if (t.linkedRecordId && doomed.has(t.linkedRecordId)) orphanEvents.push(t.id);
    if (!r?.pageInfo?.hasNextPage || !r?.pageInfo?.endCursor) break;
    cursor = r.pageInfo.endCursor;
  }
}
if (orphanEvents.length) {
  console.log(`  timelineActivities ${String(orphanEvents.length).padStart(3)} 条（指向上面这些记录的）`);
}
if (testContribIds.size) console.log(`  contributors      ${String(testContribIds.size).padStart(4)} 个测试录入人`);
if (!total && !madeCompanies.length && !testContribIds.size) {
  console.log('  （没有）');
}

if (ALSO_DB) {
  const [n] = await sql`select count(*)::int n from inbox where user_id = any(${ids})`;
  console.log(`\n\x1b[1m▸ boothnote 里的测试行\x1b[0m\n  inbox 及其派生 ${n.n} 条（会连同 staging/thread/attachment 一起删）`);
}

if (!YES) {
  console.log('\n  这是预览。真要删加 \x1b[1m--yes\x1b[0m。');
  console.log('  （\x1b[1m--db\x1b[0m 会顺带清掉 boothnote 里那些测试行）\n');
  await sql.end();
  process.exit(0);
}

// ── 动手 ────────────────────────────────────────────────────────────
/**
 * ── 🔴 最后一道防线：**删之前逐条回读 `recordedBy`** ────────────────
 *
 * 上面那两条线索（`staging.twenty_refs` + 测试 contributor）都是**推断**。
 * 推断错了的后果是删掉真人的记录 —— 而这个仓库的架构说得很明白：
 * 「整个系统里不存在删 Twenty 记录的路径」（D48），这个脚本是唯一的例外。
 * 唯一的例外就该有兜底。
 *
 * 2026-08-03 审计发现 `alex` 的一条拜访 + 一条售后、`dev-admin` 的两条商机
 * 在 Twenty 里已经 404 —— 而这两个账号**都在 `HUMANS` 名单里**。
 * 哪一次跑删的已经查不回来了（记录没了，日志也没留），
 * 但结论是清楚的：**光在入口处判断是不够的，出口也要判一次。**
 *
 * 这一遍很便宜（只对已经决定要删的那些回读一次），
 * 换的是「线索算错时不会毁掉不可再生的数据」。
 */
const humanContribIds = new Set(
  contributors.filter((c) => HUMANS.has(c.userCode)).map((c) => c.id),
);
const spared = [];
for (const [plural, set] of targets) {
  for (const id of [...set]) {
    const r = await call('GET', `/rest/${plural}/${id}?depth=1`).catch(() => null);
    const rec = r?.data?.[plural.replace(/ies$/, 'y').replace(/s$/, '')] ?? r?.data;
    const by = rec?.recordedBy?.id;
    if (by && humanContribIds.has(by)) {
      set.delete(id);
      spared.push(`${plural}/${String(id).slice(0, 8)}（recordedBy=真人）`);
    }
  }
}
if (spared.length) {
  console.log(`\n\x1b[33m🛡 出口复核挡下 ${spared.length} 条真人的记录（线索算错了）：\x1b[0m`);
  for (const s of spared.slice(0, 20)) console.log(`   · ${s}`);
}

console.log('\n\x1b[1m▸ 删 Twenty\x1b[0m');
let ok = 0;
let fail = 0;
// timeline 事件**先删**：记录还在的时候它们才好认，而且删空了也不影响记录本身
for (const id of orphanEvents) {
  await call('DELETE', `/rest/timelineActivities/${id}`).catch(() => {});
  ok++;
}
if (orphanEvents.length) console.log(`  ✓ timelineActivities（${orphanEvents.length} 条）`);
// 🔴 **子在前，父在后。** 项目下面挂着线程和文档，反过来删会被外键挡住。
const ORDER = ['workItems', 'projectDocs', 'visits', 'productFitments', 'supportCases', 'intelValues', 'opportunities', 'projects'];
// 不在 ORDER 里的排最后（认不出的对象最不可能是别人的父）
const rank = (k) => (ORDER.indexOf(k) < 0 ? ORDER.length : ORDER.indexOf(k));
const ordered = [...targets.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
for (const [path, set] of ordered) {
  for (const id of set) {
    try {
      await call('DELETE', `/rest/${path}/${id}`);
      ok++;
    } catch (e) {
      // 已经不在了（前一次删过、或被级联删掉）不算错
      if (/→ 404/.test(String(e.message))) ok++;
      else {
        fail++;
        console.warn(`  ⚠️ ${path}/${id}：${e.message.slice(0, 100)}`);
      }
    }
  }
  console.log(`  ✓ ${path}`);
}
for (const c of madeCompanies) {
  const r = await call(
    'GET',
    `/rest/companies?filter=${encodeURIComponent(`accountCode[eq]:${c.company_code}`)}`,
  ).catch(() => null);
  const hit = r?.data?.companies?.[0];
  if (!hit) continue;
  await call('DELETE', `/rest/companies/${hit.id}`).catch(() => fail++);
  console.log(`  ✓ 客户 ${c.value}`);
  ok++;
}
for (const id of testContribIds) {
  try {
    await call('DELETE', `/rest/contributors/${id}`);
    ok++;
  } catch (e) {
    // 还有记录挂着就删不掉 —— 不是错，下次再跑就好了
    if (!/→ 404/.test(String(e.message))) fail++;
  }
}
if (testContribIds.size) console.log(`  ✓ contributors（${testContribIds.size} 个测试录入人）`);
console.log(`  删掉 ${ok} 条${fail ? `，失败 ${fail} 条` : ''}`);

if (ALSO_DB) {
  console.log('\n\x1b[1m▸ 清 boothnote 里的测试行\x1b[0m');
  // 只增不改的触发器要临时关掉。**和 enable 在同一个事务里** ——
  // 中途炸了整体回滚，不会留下一个「守卫关着」的库。
  /**
   * 🔴 **按表关，不按触发器名字猜。**
   *
   * 踩了两次：第一版匹配 `tgname like '%append%'`（实际叫 `inbox_no_update`），
   * 第二版匹配函数名 `append_only_guard`（结果 inbox 上挂的是
   * 另一个函数 `inbox_is_append_only`）。两次都是「以为匹配上了，其实一个没匹配」，
   * 而失败的形态是 delete 撞在守卫上 —— **幸好 disable 和 enable 在同一个事务里**，
   * 整体回滚，没有把守卫留在关闭状态。
   *
   * `DISABLE TRIGGER USER` 关掉这张表上全部用户触发器，不需要知道它们叫什么。
   */
  const GUARDED_TABLES = ['inbox', 'attachment', 'thread_message'];
  const before = await sql`
    select c.relname tbl, count(*)::int n from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal and c.relname = any(${GUARDED_TABLES})
    group by c.relname`;

  await sql.begin(async (tx) => {
    for (const t of GUARDED_TABLES) await tx.unsafe(`alter table ${t} disable trigger user`);
    const inboxIds = (await tx`select id from inbox where user_id = any(${ids})`).map((r) => r.id);
    if (inboxIds.length) {
      await tx`delete from attachment_text where attachment_id in (select id from attachment where inbox_id = any(${inboxIds}))`;
      await tx`delete from attachment where inbox_id = any(${inboxIds})`;
      await tx`delete from agent_run where inbox_id = any(${inboxIds})`;
      await tx`delete from thread_message where inbox_id = any(${inboxIds})`;
      await tx`delete from staging where inbox_id = any(${inboxIds})`;
      await tx`delete from inbox where id = any(${inboxIds})`;
    }
    await tx`delete from thread where user_id = any(${ids})`;
    await tx`delete from intel_field_log where created_by = any(${testUsers.map((u) => u.user_code)})`;
    await tx`delete from app_user where id = any(${ids})`;
    for (const t of GUARDED_TABLES) await tx.unsafe(`alter table ${t} enable trigger user`);
  });

  // 自检：守卫必须原样装回去。忘了这一步 = 只增不改的保证悄悄没了，而且没人会发现。
  const back = await sql`
    select c.relname tbl, t.tgname trg, t.tgenabled from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal and c.relname = any(${GUARDED_TABLES})`;
  const off = back.filter((r) => r.tgenabled !== 'O');
  const missing = before.filter((b) => back.filter((r) => r.tbl === b.tbl).length !== b.n);
  if (off.length || missing.length) {
    console.error(
      `  🔴 触发器没原样装回去！关着的：${off.map((r) => r.trg).join(', ') || '无'}；` +
        `数量对不上的表：${missing.map((r) => r.tbl).join(', ') || '无'}\n` +
        `     只增不改的保证现在是破的，手动 \`alter table X enable trigger user\` 修回来。`,
    );
    process.exitCode = 1;
  } else {
    console.log(`  ✓ 只增不改的守卫都原样装回去了（${back.length} 个触发器）`);
  }
  console.log(`  ✓ 删了 ${testUsers.length} 个测试账号及其全部数据`);
}

console.log('\n✅ 清完了。\n');
await sql.end();
