#!/usr/bin/env node
/**
 * 把本地的测试数据清干净，好从头测一遍。
 *
 *   node scripts/reset-testdata.mjs           先看要删什么（不动手）
 *   node scripts/reset-testdata.mjs --yes     真的删
 *   node scripts/reset-testdata.mjs --yes --keep-twenty   只清 boothnote，不动 Twenty
 *
 * 🔴 **只对本地。** 非本地直接拒绝，和集成测试同一道守卫。
 *
 * ⚠️ 这个脚本会**临时关掉三张表的「只增不改」触发器**
 *    （inbox / thread_message / attachment，§4.2 第2条）。
 *    这是整个项目最硬的一条纪律，所以：
 *      · 关和开在同一个事务里，中途炸了会整体回滚；
 *      · 跑完**必须**自检三个触发器都装回去了，没装回去就以非零码退出并大声报警。
 *    「关了忘了开」= 那条纪律从此静默失效，而没有人会发现 —— 这正是要自检的原因。
 *
 * 不动的东西：`app_user`（账号）· Twenty 里的 `companies`（56 家客户名单）。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { sql } = await import(join(ROOT, 'services/gateway/src/db.ts'));
const { env } = await import(join(ROOT, 'services/gateway/src/env.ts'));

const YES = process.argv.includes('--yes');
const KEEP_TWENTY = process.argv.includes('--keep-twenty');

// ── 守卫：非本地一律拒跑 ────────────────────────────────────────────
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(env.databaseUrl)) {
  console.error(`
🔴 这个脚本只对本地跑（它会删数据、还会临时关掉只增不改的触发器）。
   APP_DATABASE_URL = ${env.databaseUrl.replace(/:\/\/[^@]*@/, '://***@')}
`);
  process.exit(1);
}

// 表清单、触发器名、以及「关→删→装回去→自检」那一整段，都在共享模块里。
// 🔴 **别在这里抄第二份**（D115）：漏掉「装回去」或漏掉自检的那一份不会报错，
//    它会打印「清完了」，而 §4.2 第 2 条从此静默失效。
const { GUARDED, TABLES, countBoothnote, wipeBoothnote } = await import(join(ROOT, 'scripts/wipe-boothnote.mjs'));

const line = (s = '') => console.log(s);

line('\n\x1b[1m▸ boothnote 库\x1b[0m');
const counts = await countBoothnote(sql);
for (const t of TABLES) line(`  ${t.padEnd(16)} ${String(counts[t]).padStart(5)} 行`);

// ── Twenty：只删今天新增的自定义对象记录，绝不碰 companies ──────────
const today = new Date().toISOString().slice(0, 10);
const tw = async (method, path) => {
  const res = await fetch(`${env.twentyUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.twentyKey}`, 'Content-Type': 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Twenty ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};

const TW_OBJECTS = ['intelValues', 'intelItems', 'productFitments', 'supportCases', 'visits'];
const twTargets = {};
if (!KEEP_TWENTY) {
  line('\n\x1b[1m▸ Twenty（只看今天新增的，companies 一律不动）\x1b[0m');
  for (const name of TW_OBJECTS) {
    const r = await tw('GET', `/rest/${name}?limit=200`);
    const rows = (r?.data?.[name] ?? []).filter((x) => (x.createdAt ?? '').slice(0, 10) === today);
    twTargets[name] = rows.map((x) => x.id);
    line(`  ${name.padEnd(16)} ${String(rows.length).padStart(5)} 条`);
  }

  /**
   * 🔴 **客户不清 —— 这一条要主动说出来，不能让它悄悄留着。**
   *
   * `companies` 是导进去的资产（56 家展会目标），误删代价太大，所以这个脚本
   * 一律不碰。但测渠道链（D54）时人会**真的建出新客户**（`KWR Reisemobile`、
   * `KESSEL GmbH` 这种）—— 它们不在清理范围里，会留在下拉框里。
   * 不说的话，下一次「我明明重置过了，怎么还有」就要查半天。
   */
  const cs = await tw('GET', '/rest/companies?limit=200');
  const newToday = (cs?.data?.companies ?? []).filter(
    (c) => (c.createdAt ?? '').slice(0, 10) === today,
  );
  if (newToday.length) {
    line(`\n  ⚠️ 今天新建了 ${newToday.length} 家客户，\x1b[1m这个脚本不删\x1b[0m：`);
    for (const c of newToday) line(`     · ${c.name}（${c.accountCode}）— ${c.id}`);
    line('     要清就去 Twenty 界面上删，或者 DELETE /rest/companies/<id>。');
  }
}

if (!YES) {
  line('\n  这是预览。真要删加 \x1b[1m--yes\x1b[0m。');
  line('  ⚠️ 手机 / 浏览器里的本地速记清不掉 —— 那在 IndexedDB 里，只能在那台设备上清。\n');
  await sql.end();
  process.exit(0);
}

// ── 动手 ───────────────────────────────────────────────────────────
line('\n\x1b[1m▸ 清 boothnote\x1b[0m');
let checks;
try {
  checks = await wipeBoothnote(sql, (t) => line(`  ✓ ${t}（${counts[t]} 行）`));
} catch (e) {
  console.error(`\n${e.message}\n`);
  await sql.end();
  process.exit(1);
}

line('\n\x1b[1m▸ 自检：只增不改的触发器装回去了没有\x1b[0m');
for (const c of checks) line(`  ✅ ${c.table}.${c.trigger} 已启用`);

// ── Twenty ─────────────────────────────────────────────────────────
if (!KEEP_TWENTY) {
  line('\n\x1b[1m▸ 清 Twenty（今天新增的）\x1b[0m');
  for (const name of TW_OBJECTS) {
    let ok = 0;
    for (const id of twTargets[name] ?? []) {
      try {
        await tw('DELETE', `/rest/${name}/${id}`);
        ok++;
      } catch (e) {
        console.error(`    ✗ ${name}/${id.slice(0, 8)}：${e.message.slice(0, 90)}`);
      }
    }
    line(`  ✓ ${name}（${ok} 条）`);
  }
}

line(`
\x1b[1m清完了。\x1b[0m

⚠️ 还有一处清不到：**你设备上的本地速记**（IndexedDB）。
   那是采集端的真相源，只能在那台设备上清：
     DevTools → Application → Storage → Clear site data
   ⚠️ 它会连登录态一起清掉，清完要重新登录。
`);
await sql.end();
