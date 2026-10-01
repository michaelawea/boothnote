#!/usr/bin/env node
/**
 * 把一个环境**录入产生的一切**清干净，回到「谁都还没录过」的状态（D116）。
 *
 * 维护者 2026-08-13 的原话：「现在产品的稳定度逐渐提升，我准备把云端那边
 * 测试所涉及到的数据全部删除，以便保持全新的录入。」
 *
 * ── 和另外两个清理脚本的分工（别用错）───────────────────────────────
 *
 *   `reset-testdata.mjs`      本地开发重置。只清 boothnote + Twenty 上**今天**新增的
 *                             5 类记录，`companies` 一律不碰。
 *   `purge-test-records.mjs`  按 `staging.twenty_refs` 反查，只删**测试账号**造的，
 *                             真人账号（alex / dev-admin / …）一个字不碰。
 *   **这一个**                 清**所有人**录的一切，包括你自己录的。
 *                             它是「重新开始」，不是「打扫」。
 *
 * ── 删什么 / 留什么 ────────────────────────────────────────────────
 *
 *   删（Twenty）：拜访 · 选型情报 · 情报取值 · 商机 · 售后 · 项目 · 任务线程 ·
 *                 项目文档 · 项目进展（D139）· Timeline 事件 · **不在 56 家名单里的客户**
 *   删（boothnote）：  inbox · thread · thread_message · staging · attachment ·
 *                 attachment_text · agent_run · intel_field_log · 音频文件
 *   留：          56 家客户名单（`data/accounts.json`）· 竞品名单 supplier ·
 *                 情报清单 intelItem · 录入人 contributor · 联系人 person ·
 *                 项目类型 + 类型阶段（D140，门户配的模板）· `app_user` 账号
 *   ⚠️ 门户里建的项目（D139）也是 `projects`，**一样会被删** —— 门户上线之后跑这个之前先想清楚。
 *
 * 🔴 **`inbox` 的只增不改在这里被临时关掉**（§4.2 第 2 条）。
 *    那条纪律护的是「展会现场说过的话不可再生」—— 而展会还没开，
 *    现在库里的是测试数据。**展会开始之后不要再跑这个脚本。**
 *    关/开/自检那一整段在 `wipe-boothnote.mjs`，只有一份实现（D115）。
 *
 * 🔴 **Twenty 侧走 REST DELETE = 硬删，不是软删**（§2.38 实测）。
 *    这里要的就是真删掉 —— 「保持全新的录入」意味着回收站里也不该有。
 *    回不来。所以默认是预览，`--yes` 之外还要**把机器名字打出来**。
 *
 * 用法：
 *   node scripts/reset-entry-data.mjs                      # 预览，什么都不动
 *   node scripts/reset-entry-data.mjs --yes --i-am-on <主机名>
 *
 * ⚠️ **`--i-am-on` 必须写出 `SERVER_URL` 里那个主机名**，对不上就拒跑。
 *    不接受 `=1` 这种开关 —— 一个忘在 shell profile 里的 `1`
 *    会在你完全没想起它的那天清空生产库（同 `ALLOW_NONLOCAL_TESTS` 那条账）。
 */
import { readFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const YES = process.argv.includes('--yes');
// `--i-am-on=<host>` 和 `--i-am-on <host>` 两种写法都认。
// ⚠️ `indexOf` 找不到时返回 -1，`argv[-1+1]` 就是 node 自己的路径 ——
//    不挡一下的话，忘了写参数会变成「拿 node 的路径去比主机名」，
//    虽然一定对不上、但报错会指向一个莫名其妙的字符串。
const TARGET = (() => {
  const eq = process.argv.find((a) => a.startsWith('--i-am-on='));
  if (eq) return eq.slice('--i-am-on='.length);
  const i = process.argv.indexOf('--i-am-on');
  return i >= 0 ? (process.argv[i + 1] ?? '') : '';
})();

const { sql } = await import(join(ROOT, 'services/gateway/src/db.ts'));
const { env } = await import(join(ROOT, 'services/gateway/src/env.ts'));
const { TABLES, countBoothnote, wipeBoothnote } = await import(join(ROOT, 'scripts/wipe-boothnote.mjs'));

const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
};
const line = (s = '') => console.log(s);

const host = (() => { try { return new URL(env.twentyUrl).host; } catch { return env.twentyUrl; } })();
const dbHost = env.databaseUrl.replace(/^.*@/, '').replace(/\/.*$/, '');

// ── 闸门 ────────────────────────────────────────────────────────────
if (YES && TARGET !== host) {
  console.error(`
${c.r('🔴 拒跑。')}

   这个脚本会${c.b('硬删')} Twenty 记录、清空 boothnote 库、删掉音频文件，${c.b('回不来')}。
   所以你必须把要清的那台机器的名字${c.b('打出来')}：

     node scripts/reset-entry-data.mjs --yes --i-am-on ${c.b(host)}

   ${TARGET ? `你写的是「${TARGET}」，而 SERVER_URL 指向「${host}」。` : '（这次一个字都没写。）'}
`);
  await sql.end();
  process.exit(1);
}

line(`\n${c.b('▸ 清空录入数据')}`);
line(`  Twenty  ${host}`);
line(`  boothnote    ${dbHost}`);
line(`  音频    ${env.audioDir}`);
if (!YES) line(c.dim('  （预览 —— 下面每一行都只是数出来的，什么都没动）'));

// ═══════════════════════════════════════════════════════════════════
//  一、盘点
// ═══════════════════════════════════════════════════════════════════
const H = { Authorization: `Bearer ${env.twentyKey}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 🔴 **读不到就抛，绝不返回 null**（D98）。
 * `return res.ok ? data : null` 会把「我读不到」变成「它是空的」——
 * 在这个脚本里那意味着**漏删**，而报表会说「0 条，清干净了」。
 */
const tw = async (method, path, attempt = 0) => {
  const res = await fetch(`${env.twentyUrl}${path}`, { method, headers: H });
  if (res.status === 429 && attempt < 6) {
    line(c.dim(`    · 撞到限流，退避 ${2 ** attempt}s 后重试 ${path.slice(0, 40)}`));
    await sleep(1000 * 2 ** attempt);
    return tw(method, path, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Twenty ${method} ${path} → ${res.status} ${text.slice(0, 160)}`);
  await sleep(40);
  try { return JSON.parse(text); } catch { return {}; }
};

const listAll = async (plural) => {
  const out = [];
  let cursor = null;
  for (let p = 0; p < 60; p++) {
    const r = await tw('GET', `/rest/${plural}?limit=60${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ''}`);
    out.push(...(r?.data?.[plural] ?? []));
    if (!r?.pageInfo?.hasNextPage || !r?.pageInfo?.endCursor) break;
    cursor = r.pageInfo.endCursor;
  }
  return out;
};

/**
 * 删除顺序 = 外键的反方向（子在前）。
 * ⚠️ `workItem.blockedBy` 和 `visit.parent` 是**自引用**，同一批里也有先后 ——
 * 所以下面收集失败的再重试一轮，而不是把顺序写得更死。
 */
const WIPE = [
  ['projectDocs',     '项目文档'],
  ['workItems',       '任务线程'],
  ['projectUpdates',  '项目进展'],   // D139 —— 挂在项目下，必须排在 projects 前面
  ['projects',        '项目'],
  ['productFitments', '产品选型情报'],
  ['intelValues',     '情报取值'],
  ['supportCases',    '售后问题'],
  ['visits',          '拜访/事件'],
  ['opportunities',   '商机'],
  ['consumerSurveys', '2C 问卷'],   // D138 —— 答卷的人本身是「名单外的客户」，下面那一步一起删
  // 🔴 **Timeline 事件不在这里删。**
  //    库里那 3600 条里混着 Twenty 自己给 56 家客户写的 `company.created` ——
  //    一刀切会把要保留的那批客户自己的历史一起削掉。
  //    `backfill-timeline.mjs` 早就把这件事做对了：它只清**我们自己造的**
  //    （`linked-<对象>.` 前缀）且目标记录已经没了的那些，别人的一律不动。
  //    所以这里不碰，末尾提示跑它。那个文件里写着一句正好适用于此的话：
  //    「一个『顺手清理』的脚本删掉别人的数据，是这类工具最典型的翻车方式。」
];

/** 留下的 —— 盘点时也报一次数，好让人看见「它们确实没被算进删除范围」。 */
const KEEP = [
  ['suppliers',    '竞品/供应商名单'],
  ['intelItems',   '情报清单项'],
  // D140：类型和阶段是**模板**不是录入 —— 门户 admin 配的，清空录入数据不该连它一起带走
  ['projectTypes',      '项目类型'],
  ['projectTypeStages', '类型阶段'],
  ['contributors', '录入人'],
  ['people',       '联系人'],
];

line(`\n${c.b('  ▸ Twenty · 要删的')}`);
const targets = {};
let twTotal = 0;
for (const [plural, label] of WIPE) {
  const rows = await listAll(plural);
  targets[plural] = rows.map((x) => x.id);
  twTotal += rows.length;
  line(`    ${label.padEnd(16)} ${String(rows.length).padStart(5)} 条`);
}

// ── 客户：只删不在 56 家名单里的 ─────────────────────────────────────
// 🔴 **靠名单反查，不靠名字猜。**「测试建的客户」有一份精确的账：
//    `data/accounts.json` 的 56 个 accountCode 是导入的那批，其余都是录入产生的
//    （`POST /companies` 建的，D28 修订）。按名字里有没有「测试」去猜会误伤。
const roster = new Set(
  JSON.parse(readFileSync(join(ROOT, 'data/accounts.json'), 'utf8')).accounts.map((a) => a.accountCode),
);
const companies = await listAll('companies');
const extra = companies.filter((x) => !roster.has(x.accountCode));
targets.companies = extra.map((x) => x.id);
twTotal += extra.length;
line(`    ${'客户（名单外）'.padEnd(15)} ${String(extra.length).padStart(5)} 条`);
if (extra.length) {
  for (const x of extra.slice(0, 15)) line(c.dim(`        · ${x.name}（${x.accountCode ?? '无代号'}）`));
  if (extra.length > 15) line(c.dim(`        · …… 还有 ${extra.length - 15} 家`));
}

line(`\n${c.b('  ▸ Twenty · 留着不动')}`);
line(`    ${'客户（56 家名单内）'.padEnd(14)} ${String(companies.length - extra.length).padStart(5)} 条`);
for (const [plural, label] of KEEP) {
  line(`    ${label.padEnd(16)} ${String((await listAll(plural)).length).padStart(5)} 条`);
}

// ── boothnote ────────────────────────────────────────────────────────────
line(`\n${c.b('  ▸ boothnote 库 · 要清的')}`);
const counts = await countBoothnote(sql);
let dbTotal = 0;
for (const t of TABLES) { dbTotal += counts[t]; line(`    ${t.padEnd(18)} ${String(counts[t]).padStart(5)} 行`); }
const [users] = await sql`select count(*)::int as n from app_user`;
line(`\n${c.b('  ▸ boothnote 库 · 留着不动')}`);
line(`    ${'app_user（账号）'.padEnd(16)} ${String(users.n).padStart(5)} 行`);

// ── 音频 ────────────────────────────────────────────────────────────
//
// 🔴 **`GATEWAY_AUDIO_DIR` 没显式给的时候，绝不猜。**
//
// `env.ts` 在读不到它时会回退到 `<仓库根>/data/audio`，而生产上音频真正在的地方是
// **Dockerfile 里 `ENV GATEWAY_AUDIO_DIR=/data/audio` + `audio-data` 卷** ——
// 那个值烧在网关镜像里，**不在 compose 的 environment 白名单里，也不一定在 `.env` 里**。
// 于是一次性容器（`--env-file .env`）很可能拿到回退值，删掉一个空目录，
// 然后报告「清干净了」，而卷里的真音频一个字节没动。
//
// ⚠️ 这比删错更阴：**「我以为它清了」和「它没清」长得一模一样**（同 D101 那条）。
// 所以这里区分「显式给了」和「回退猜的」，后者一律不动手、大声说出来。
const audioExplicit = (process.env.GATEWAY_AUDIO_DIR ?? '').trim()
  || (readFileSync(join(ROOT, '.env'), 'utf8').match(/^\s*GATEWAY_AUDIO_DIR\s*=\s*(.+)$/m)?.[1] ?? '')
    .trim().replace(/^["']|["']$/g, '');
const audioDir = audioExplicit || env.audioDir;
const audioOk = Boolean(audioExplicit) && existsSync(audioDir);
const audioFiles = audioOk ? readdirSync(audioDir).filter((f) => !f.startsWith('.')) : [];
const audioBytes = audioFiles.reduce((n, f) => { try { return n + statSync(join(audioDir, f)).size; } catch { return n; } }, 0);
line(`\n${c.b('  ▸ 音频文件')}`);
if (audioOk) line(`    ${String(audioFiles.length).padStart(5)} 个 · ${(audioBytes / 1048576).toFixed(1)} MB   ${c.dim(audioDir)}`);
else if (!audioExplicit) {
  line(`    ${c.y('🔴 不动 —— GATEWAY_AUDIO_DIR 没显式给')}`);
  line(c.dim(`    env.ts 会回退到 ${env.audioDir}，那多半不是音频真正在的地方。`));
  line(c.dim('    生产上音频在 `audio-data` 卷、路径由网关镜像里的 ENV 定死。这样跑：'));
  line(c.dim('      docker run … -v boothnote_audio-data:/data/audio -e GATEWAY_AUDIO_DIR=/data/audio …'));
} else {
  line(`    ${c.y('目录不存在')} —— ${audioDir}`);
  line(c.dim('    卷没挂进来的话就是这个样子，加 -v boothnote_audio-data:/data/audio'));
}

// ═══════════════════════════════════════════════════════════════════
//  二、动手
// ═══════════════════════════════════════════════════════════════════
if (!YES) {
  line(`\n  ${c.b('这是预览。')}真要清：`);
  line(`    node scripts/reset-entry-data.mjs --yes --i-am-on ${c.b(host)}\n`);
  line(c.dim('  ⚠️ 手机 / 浏览器里的本地速记清不掉 —— 那在 IndexedDB 里，只能在那台设备上清。\n'));
  await sql.end();
  process.exit(0);
}

line(`\n${c.b('▸ 清 Twenty')}  ${c.y('（REST DELETE = 硬删，回不来）')}`);
const failed = [];
for (const [plural, label] of [...WIPE, ['companies', '客户（名单外）']]) {
  let ok = 0;
  for (const id of targets[plural] ?? []) {
    try { await tw('DELETE', `/rest/${plural}/${id}`); ok++; }
    catch (e) { failed.push({ plural, id, msg: e.message }); }
  }
  line(`  ✓ ${label.padEnd(16)} ${String(ok).padStart(5)} 条${failed.some((f) => f.plural === plural) ? c.y(`（${failed.filter((f) => f.plural === plural).length} 条失败，稍后重试）`) : ''}`);
}

// 自引用（workItem.blockedBy / visit.parent）会让同一批里出现先后 —— 重试一轮。
if (failed.length) {
  line(`\n  ${c.dim(`重试 ${failed.length} 条（自引用关系有先后）`)}`);
  const still = [];
  for (const f of failed) {
    try { await tw('DELETE', `/rest/${f.plural}/${f.id}`); }
    catch (e) { still.push({ ...f, msg: e.message }); }
  }
  if (still.length) {
    line(`  ${c.r(`🔴 ${still.length} 条删不掉：`)}`);
    for (const s of still.slice(0, 10)) line(`     ${s.plural}/${s.id.slice(0, 8)} — ${s.msg.slice(0, 110)}`);
  } else line(`  ${c.g('✓ 重试全部成功')}`);
}

line(`\n${c.b('▸ 清 boothnote')}`);
let checks;
try {
  checks = await wipeBoothnote(sql, (t) => line(`  ✓ ${t.padEnd(18)} ${String(counts[t]).padStart(5)} 行`));
} catch (e) {
  console.error(`\n${e.message}\n`);
  await sql.end();
  process.exit(1);
}
line(`\n${c.b('▸ 自检：只增不改的触发器装回去了没有')}`);
for (const ck of checks) line(`  ✅ ${ck.table}.${ck.trigger} 已启用`);

line(`\n${c.b('▸ 音频')}`);
if (audioOk && audioFiles.length) {
  let n = 0;
  for (const f of audioFiles) { try { unlinkSync(join(audioDir, f)); n++; } catch {} }
  line(`  ✓ ${n} 个文件  ${c.dim(audioDir)}`);
} else if (audioOk) {
  line(`  ✓ 本来就是空的  ${c.dim(audioDir)}`);
} else {
  // 🔴 **没删就要说没删。** 静默跳过会让下一句「清干净了」变成假话。
  line(`  ${c.y('⏭ 跳过了 —— 上面写了原因。音频还在，要另外清一次。')}`);
}

// ═══════════════════════════════════════════════════════════════════
//  三、回读对账 —— 「跑完了」和「清干净了」是两件事
// ═══════════════════════════════════════════════════════════════════
line(`\n${c.b('▸ 回读对账')}`);
const bad = [];
for (const [plural, label] of WIPE) {
  const n = (await listAll(plural)).length;
  line(`  ${n === 0 ? c.g('✓') : c.r('✗')} ${label.padEnd(16)} ${String(n).padStart(5)} 条`);
  if (n !== 0) bad.push(`${label} 还剩 ${n} 条`);
}
const after = await listAll('companies');
const kept = after.filter((x) => roster.has(x.accountCode)).length;
line(`  ${after.length === kept ? c.g('✓') : c.r('✗')} ${'客户'.padEnd(16)} ${String(after.length).padStart(5)} 条${c.dim(`（名单内 ${kept}）`)}`);
if (after.length !== kept) bad.push(`还有 ${after.length - kept} 家名单外的客户没删掉`);
const afterDb = await countBoothnote(sql);
for (const t of TABLES) {
  if (afterDb[t] !== 0) bad.push(`boothnote.${t} 还剩 ${afterDb[t]} 行`);
}
line(`  ${Object.values(afterDb).every((n) => n === 0) ? c.g('✓') : c.r("✗")} boothnote ${TABLES.length} 张表`);

if (bad.length) {
  line(`\n${c.r('🔴 没清干净：')}\n${bad.map((b) => `   · ${b}`).join('\n')}\n`);
  await sql.end();
  process.exit(1);
}

line(`
${audioOk ? c.g('✅ 清干净了。') : c.y('✅ 记录和库清干净了 —— 但音频没动（上面写了原因）。')}

${c.b('还要跑三步')}（都幂等，随便重跑）：
   node scripts/backfill-timeline.mjs --yes      # 清掉指向已删记录的孤儿事件
                                                 ${c.dim('（它只清我们自己造的，Twenty 给客户记的历史不动）')}
   node scripts/import-accounts.mjs --backfill   # 名单内客户被录入改过的格子补回官方值
   node scripts/recompute-intel.mjs --yes        # 情报完整度重算（现在应该全是 0 或空）

${c.y('⚠️ 清不到的两处，要人自己动手：')}
   · ${c.b('手机 / 浏览器里的本地速记')}（IndexedDB）—— 只能在那台设备上清：
     DevTools → Application → Storage → Clear site data（会连登录态一起清，清完要重登）
   · ${c.b('名单内客户上被录入填过的自由文本')} —— 比如 annualProduction。
     ${c.dim('它在 accounts.json 里本来就有，所以分不清是导入写的还是录入写的；')}
     ${c.dim('上面那条 --backfill 会把有官方值的补回去，官方值为空的那些留着。')}
`);
await sql.end();
