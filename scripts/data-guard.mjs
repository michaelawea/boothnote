#!/usr/bin/env node
/**
 * 部署时的数据守卫 —— 改之前拍一张，改之后再拍一张，**掉了就中止**（D79）。
 *
 * 用法：
 *   node scripts/data-guard.mjs snapshot [文件]     拍快照（默认 .data-guard.json）
 *   node scripts/data-guard.mjs check    [文件]     再拍一次并逐条比对，掉了 exit 1
 *
 * ══ 为什么需要它 ══════════════════════════════════════════════════
 *
 * 2026-08-07 实测（§2.28）：`provision-twenty.mjs` 整包 PATCH 枚举 `options`，
 * Twenty 把它当成一组全新选项，**引用旧选项的数据一起清空** ——
 * 而接口返回 **HTTP 200**，脚本日志里一片绿，`verify-deploy.mjs` 也照样过
 * （它查的是「清单/视图/supplier 生效了没有」，不查数据还在不在）。
 *
 * 🔴 **判据：写操作的返回码不能证明数据没坏。**
 * 唯一可信的验证是**改前改后各拍一次数据快照再逐条对**。
 * 这条对任何「重写一整组东西」的接口都成立，不只是 Twenty 的枚举。
 *
 * ══ 比什么 ════════════════════════════════════════════════════════
 *
 *   · 每个对象的记录总数
 *   · 每个 SELECT 字段**非空值的条数**，以及每个枚举值各有几条
 *   · boothnote 库里几张关键表的行数
 *
 * 判定：**只许涨不许跌。** 部署过程本来就会新建记录（seed / import），
 * 所以涨是正常的；而任何一格的非空计数**下降**都意味着有东西被清掉了。
 *
 * ══ 相对比较有个结构性盲区，所以还有一道绝对判据 ══════════════════
 *
 * 2026-08-07 实测：`visit.visitType` 在**拍第一张快照时就已经是 6 条记录 / 非空 0 条**了
 * （被同日上午那次用旧代码的部署清空，而这个字段没有 backfill 可以自愈）。
 * 于是 `check` 一路报绿 —— **它比的是「和 10 分钟前相比」，而那时东西已经没了。**
 *
 * 🔴 **判据：只会做相对比较的守卫，看不见「在它上岗之前就已经丢掉的东西」。**
 * 所以加一条不依赖任何历史的绝对判据：**对象有记录、而某个枚举字段非空率 0%**，
 * 本身就可疑 —— 一个所有记录都没填的枚举列，要么是被清空了，要么就不该存在。
 *
 * ⚠️ 它只**告警不阻断**：分不清「从没填过」和「被清空了」需要历史，
 * 而历史正是它没有的。把它做成硬门槛会让「确实还没用上的可选字段」挡住部署。
 *
 * ══ 快照有历史，不是只有一张 ══════════════════════════════════════
 *
 * 每次 snapshot 除了写 `.data-guard.json`（当前基线），还在
 * `backups/data-guard/` 留一份带时间戳的。原因是个真实的脚：
 * 部署中途失败 → 重跑 `deploy.sh` → 它再拍一次快照，
 * **用「中途的、可能已经损坏的」状态覆盖掉部署前的基线**，回退的参照就没了。
 * 有了历史目录，`check <某个历史文件>` 可以和任意一张旧快照对，不只是 10 分钟前那张。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [, , CMD, FILE = join(ROOT, '.data-guard.json')] = process.argv;

/** 带时间戳的快照历史。和 backups/ 放一起 —— 它们回答的是同一类问题。 */
const HISTORY = join(ROOT, 'backups', 'data-guard');

/**
 * 退出码是有约定的，`deploy.sh` 按它分叉：
 *   0 = 没掉    1 = 有东西掉了（**中止部署**）    2 = 没法比（用法错 / 没有基线快照，跳过）
 */
const EXIT_OK = 0, EXIT_DROPPED = 1, EXIT_SKIP = 2;

if (!['snapshot', 'check'].includes(CMD)) {
  console.error('用法：node scripts/data-guard.mjs snapshot|check [文件]');
  process.exit(EXIT_SKIP);
}

// ── .env ───────────────────────────────────────────────────────────
const env = {};
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch { /* 靠 process.env */ }

const BASE = (process.env.SERVER_URL || env.SERVER_URL || 'http://localhost:3000').replace(/\/$/, '');
const KEY = process.env.TWENTY_API_KEY || env.TWENTY_API_KEY;
if (!KEY) { console.error('❌ 缺少 TWENTY_API_KEY'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 🔴 **429 要退避重试。** Twenty 的限流是 **100 次 / 60 秒**，而这个脚本
 * 一次快照要对着 18 个对象各发一次列表请求 —— 部署序列里前面几步
 * （provision / import / seed / views / timeline）刚烧完一批额度，
 * 撞上限流是常态而不是意外。
 *
 * 仓库里每一处调 Twenty 的地方都有这个退避（`twenty.ts` 的 `call`、
 * `scripts/` 那几个脚本），**只有这里没有** —— 于是它撞限流时
 * 会安静地少读几个对象，然后：
 *   · 拍基线时少读 → 那个对象**从此不在守卫范围内**，一个无声的洞；
 *   · check 时少读 → `compare` 报「对象 X 整个不见了」→ 中止部署，
 *     而数据一条没少。
 * 两种都是这个仓库最贵的那类 bug：**守卫自己成了故障源，且长得像真事故。**
 */
const get = async (path, attempt = 0) => {
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${KEY}` } });
  if (r.status === 429 && attempt < 5) {
    await sleep(500 * 2 ** attempt);
    return get(path, attempt + 1);
  }
  if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}`);
  return r.json();
};

/** Twenty 的 REST 包装层形状不稳定，统一挖数组（和 provision-twenty.mjs 同一套路）。 */
const asList = (json, key) => json?.data?.[key] ?? json?.data ?? [];

// ── 拍快照 ─────────────────────────────────────────────────────────
async function snapshot() {
  const meta = await get('/rest/metadata/objects');
  const objects = asList(meta, 'objects').filter((o) => o?.isActive !== false);

  const out = { at: new Date().toISOString(), base: BASE, objects: {} };

  for (const o of objects) {
    // 内置的系统对象（workspaceMember / apiKey 之类）不看 —— 它们不是业务数据，
    // 而且有些没有 REST 列表端点，查它们只会制造噪声。
    if (o.isSystem) continue;
    let rows;
    try {
      rows = asList(await get(`/rest/${o.namePlural}?limit=1000`), o.namePlural);
    } catch (e) {
      /**
       * 🔴 **读不到 ≠ 没有。** 原来这里是 `continue`（静默跳过），
       *    理由写的是「别让守卫自己变成部署的失败点」—— 方向对，做法漏了一半：
       *    悄悄跳过的后果是「这个对象从守卫里消失了」，而没有任何人知道。
       *    退避重试之后还读不到，那就**记下来并说出来**，让 compare 能
       *    区分「这次没读到」和「记录真的没了」。
       */
      out.objects[o.nameSingular] = { unreadable: String(e?.message).slice(0, 120), total: 0, fields: {} };
      continue;
    }
    if (!Array.isArray(rows)) continue;

    const entry = { total: rows.length, fields: {} };
    for (const f of o.fields ?? []) {
      // 只看枚举 —— 今天这个 bug 的形状就是「枚举选项被换掉、值全清空」。
      // 文本字段也可能被清，但那需要另一种事故，先解决已经真实发生过的这一种。
      if (!Array.isArray(f.options) || !f.options.length) continue;
      const dist = {};
      let nonNull = 0;
      for (const r of rows) {
        const v = r?.[f.name];
        if (v === null || v === undefined || v === '') continue;
        nonNull++;
        const k = Array.isArray(v) ? v.join('|') : String(v);
        dist[k] = (dist[k] ?? 0) + 1;
      }
      entry.fields[f.name] = { nonNull, dist };
    }
    out.objects[o.nameSingular] = entry;
  }
  return out;
}

/**
 * ── 人为删除的额度（D94 · issue #25）────────────────────────────────
 *
 * 🔴 **不查这一条，这个守卫会拦住每一次正常部署。**
 *
 * D82 立的判据是「任何一格的非空计数下降就中止」，它的前提是
 * **删除只可能是意外**。#25 让人能在界面上删自己的记录，这个前提就没了：
 * 人正常删掉一条拜访 → 下次部署 `visit` 记录数从 6 掉到 5 → exit 1。
 * 而它拦得完全「正确」——**这种告警最贵，因为人会开始习惯性忽略它**，
 * 然后某天真的 §2.28 再来一次时，那条红字看起来和前二十次一模一样。
 *
 * 所以要问库：基线之后，有多少条是**人明确删掉、而且现在还删着**的。
 * 撤销过的不算（撤销会把 `record_deleted_at` 清回 null，记录也真的回来了）。
 *
 * 拿不到库（脚本在别的机器上跑、密码没配）就返回 null ——
 * **退回原来的严格行为，宁可多拦一次也不放过真丢**。
 */
async function deliberateDeletions(sinceIso) {
  const DB = process.env.APP_DATABASE_URL || env.APP_DATABASE_URL;
  if (!DB) return null;
  let sql;
  try {
    // `postgres` 装在 services/gateway 下，不在仓库根（和 purge-test-records.mjs 同一处境）。
    // 这里不走 db.ts —— 那个会连带 import env.ts，缺任何一个网关变量就直接退出，
    // 而这个脚本对绝大多数网关变量并不关心。
    const { default: postgres } = await import(join(ROOT, 'services/gateway/node_modules/postgres/src/index.js'));
    sql = postgres(DB, { max: 1, onnotice: () => {} });
    const rows = await sql`
      select r->>'object' as obj, count(*)::int as n
      from staging s, jsonb_array_elements(coalesce(s.record_deleted_refs, '[]'::jsonb)) r
      where s.record_deleted_at is not null and s.record_deleted_at > ${sinceIso}
      group by 1`;
    return Object.fromEntries(rows.map((r) => [r.obj, r.n]));
  } catch (e) {
    // migration 012 还没跑时这里会报「列不存在」—— 那是正常的，当作没有人为删除
    if (/record_deleted_refs|does not exist/i.test(String(e?.message))) return {};
    console.warn(`   ⚠️ 没能核对人为删除（${String(e?.message).slice(0, 100)}）—— 按最严格的方式比对`);
    return null;
  } finally {
    await sql?.end({ timeout: 5 }).catch(() => {});
  }
}

// ── 比对 ───────────────────────────────────────────────────────────
/**
 * `allowance` = { 对象名: 人为删掉的条数 }，null 表示核对不上（按严格比对）。
 *
 * ⚠️ **字段级用的是同一个额度，这是个刻意的松动**：快照只存「非空多少条」，
 *    存不下「被删的那 3 条里有几条填了 visitType」。所以对象删了 3 条，
 *    它每个枚举字段就都允许跌 3 条。代价是**可能盖住一次 ≤3 条的真丢**，
 *    换来的是守卫不会天天误报。额度用掉多少会打出来，人看得见。
 */
function compare(before, after, allowance) {
  const drops = [];
  const used = [];
  const unreadable = [];
  for (const [obj, b] of Object.entries(before.objects)) {
    const a = after.objects[obj];
    if (!a) { drops.push(`对象 ${obj} 整个不见了（之前 ${b.total} 条）`); continue; }

    /**
     * 任一边没读到就**不比**这个对象 —— 但要说出来。
     * 「这次没读到」和「记录真的没了」在计数上一模一样，
     * 而把前者当成后者就是一次不该发生的部署中止。
     */
    if (a.unreadable || b.unreadable) {
      unreadable.push(`${obj}（${a.unreadable ?? b.unreadable}）`);
      continue;
    }

    const ok = allowance?.[obj] ?? 0; // 这个对象被人为删掉了几条
    if (ok) used.push(`${obj} ${ok} 条`);

    // 记录总数：部署会新建记录，所以只管跌不管涨；人为删掉的那几条先扣掉
    if (a.total < b.total - ok) {
      drops.push(`${obj}：记录数 ${b.total} → ${a.total}${ok ? `（已扣除人为删除 ${ok} 条）` : ''}`);
    }

    for (const [fname, bf] of Object.entries(b.fields)) {
      const af = a.fields[fname];
      if (!af) { drops.push(`${obj}.${fname} 这个字段不见了`); continue; }
      if (af.nonNull < bf.nonNull - ok) {
        // 把哪几个枚举值掉了也说出来 —— 「少了 60 条」和
        // 「OEM_BRAND 那 49 条全没了」对排查是两个信息量
        const lost = Object.entries(bf.dist)
          .filter(([v, n]) => (af.dist[v] ?? 0) < n)
          .map(([v, n]) => `${v} ${n}→${af.dist[v] ?? 0}`)
          .join(' · ');
        drops.push(
          `🔴 ${obj}.${fname}：有值的从 ${bf.nonNull} 条掉到 ${af.nonNull} 条${lost ? `（${lost}）` : ''}` +
            (ok ? `（已扣除人为删除 ${ok} 条）` : ''),
        );
      }
    }
  }
  return { drops, used, unreadable };
}

/**
 * ── 绝对判据：不看历史，只看这一张快照本身合不合理 ──────────────────
 *
 * 「对象有记录，而某个枚举字段一条都没填」= 可疑。
 * 这是 `visit.visitType`（6 条记录 / 非空 0）那个盲区的正面解法：
 * 相对比较永远发现不了它，因为它在守卫上岗之前就已经是 0 了。
 *
 * 只告警不阻断 —— 见文件头。
 */
function suspicious(snap) {
  const out = [];
  for (const [obj, e] of Object.entries(snap.objects)) {
    if (!e.total) continue; // 一条记录都没有，字段当然全空，不算可疑
    for (const [fname, f] of Object.entries(e.fields)) {
      if (f.nonNull === 0) out.push(`${obj}.${fname}：${e.total} 条记录，非空 0 条`);
    }
  }
  return out;
}

/** 可疑项的告警文案。snapshot 和 check 两条路都要打，所以抽出来。 */
function warnSuspicious(list) {
  if (!list.length) return;
  console.warn(`\n⚠️  ${list.length} 个枚举字段「有记录但一条都没填」——`);
  for (const s of list) console.warn(`   · ${s}`);
  console.warn(`
   分不清「从没填过」和「被清空了」需要历史，所以这里**只告警不阻断**。
   要判断是哪一种：翻 backups/data-guard/ 里更早的快照，或
   backups/labeled/ 里某次部署前的库 —— 那时候有值，就是被清掉的。`);
}

// ── 主流程 ─────────────────────────────────────────────────────────
const snap = await snapshot();

if (CMD === 'snapshot') {
  // 🔴 覆盖当前基线之前，先把旧的那张归档 —— 部署中途失败重跑时，
  //    否则「部署前」的基线会被「中途的」覆盖掉，回退就没有参照了。
  mkdirSync(HISTORY, { recursive: true });
  if (existsSync(FILE)) {
    try {
      const old = JSON.parse(readFileSync(FILE, 'utf8'));
      const stamp = String(old.at).replace(/[^0-9]/g, '').slice(0, 14);
      copyFileSync(FILE, join(HISTORY, `snap-${stamp}.json`));
      console.log(`   ↩︎ 上一张基线（${new Date(old.at).toLocaleString()}）已归档进 backups/data-guard/`);
    } catch { /* 旧文件坏了就不归档，别让守卫自己变成失败点 */ }
  }

  writeFileSync(FILE, JSON.stringify(snap, null, 1));
  const stamp = String(snap.at).replace(/[^0-9]/g, '').slice(0, 14);
  writeFileSync(join(HISTORY, `snap-${stamp}.json`), JSON.stringify(snap, null, 1));

  const n = Object.keys(snap.objects).length;
  const cells = Object.values(snap.objects).reduce((a, o) => a + Object.keys(o.fields).length, 0);
  console.log(`📸 快照已存 ${FILE}\n   ${n} 个对象 · ${cells} 个枚举字段 · ${new Date(snap.at).toISOString()}`);
  console.log(`   历史留档 backups/data-guard/snap-${stamp}.json`);
  warnSuspicious(suspicious(snap));
  process.exit(EXIT_OK);
}

if (!existsSync(FILE)) {
  // 🔴 **这里不能 exit 1。** deploy.sh 里拍快照那一步是「失败只告警」的
  //    （Twenty 没起来时拍不上），如果 check 把「没有基线」也当成
  //    「数据掉了」，一次拍不上快照就会让整个部署以最吓人的方式中止。
  //    exit 2 = 没法比，跳过；exit 1 严格保留给「真的掉了东西」。
  console.error(`⚠️  找不到基线快照 ${FILE} —— 这一道跳过（先跑 snapshot 才有得比）`);
  warnSuspicious(suspicious(snap));
  process.exit(EXIT_SKIP);
}
const before = JSON.parse(readFileSync(FILE, 'utf8'));
// 基线之后人明确删掉的那些，先问出来（D94）——否则每一次正常删除都会拦部署
const allowance = await deliberateDeletions(before.at);
const { drops, used, unreadable } = compare(before, snap, allowance);

console.log(`\n🛡  数据守卫：对比 ${new Date(before.at).toLocaleString()} 的快照`);
if (unreadable.length) {
  console.warn(`   ⚠️ ${unreadable.length} 个对象这次没读到，**没有比对**：${unreadable.join(' · ')}`);
  console.warn(`      （退避重试之后仍失败。Twenty 限流是 100 次/60 秒，隔一会儿重跑一次就好）`);
}
if (allowance === null) {
  console.log(`   ⚠️ 核对不到人为删除记录 —— 按最严格的方式比对（人删过东西的话这里会红）`);
} else if (used.length) {
  console.log(`   ↩︎ 已扣除人为删除：${used.join(' · ')}（issue #25，可撤销）`);
}
if (!drops.length) {
  const n = Object.keys(before.objects).length;
  console.log(`   ✅ ${n} 个对象、所有枚举字段，没有一格的非空计数下降`);
  // 绿了也要打可疑项 —— 相对比较看不见的东西，正是靠这一条露出来的
  warnSuspicious(suspicious(snap));
  process.exit(EXIT_OK);
}

console.error(`\n🔴 有数据不见了 —— ${drops.length} 处：\n`);
for (const d of drops) console.error(`   ${d}`);
console.error(`
${'─'.repeat(58)}
**先别继续部署。** 这正是 §2.28 那类事故的形状：
接口全绿、日志没报错，而数据没了。

回退：backups/labeled/ 里有这次部署前打的标签备份
   gunzip -c backups/labeled/pre-deploy-<sha>-default-*.sql.gz | \\
     docker compose exec -T db psql -U postgres -d default
`);
warnSuspicious(suspicious(snap));
process.exit(EXIT_DROPPED);
