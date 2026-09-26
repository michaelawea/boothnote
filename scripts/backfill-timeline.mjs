#!/usr/bin/env node
/**
 * Timeline 对账（D61）—— **两个方向都管**：
 *
 *   ① 补：已经在 CRM 里、但没有 timeline 事件的记录
 *   ② 清：指向**已经不存在的记录**的 timeline 事件
 *
 * D61 改的是网关的写入路径 —— 从现在起每条新记录都会在客户 / 录入人 / 项目
 * 的 Timeline 上留痕。但在那之前入库的东西不会自己长出来：
 * 打开客户页仍然只有 `company.created` 两行，等于这个修复看不见。
 *
 * ② 是必须的另一半：删掉一条记录，它的 timeline 事件**不会跟着走**。
 * 于是客户页上挂着一串点不开的灰名字 —— chip 靠 `linkedRecordCachedName`
 * 照样渲染出来，只是点进去什么都没有。看起来有内容、其实是空的，
 * 比一开始就空白更难发现。跑测试、清测试数据之后一定会留下这种。
 *
 * 🔴 **`happensAt` 用记录自己的时间，不是「现在」。**
 * 全部盖上今天的时间戳的话，一条时间线会在同一秒里堆 20 件事 ——
 * 那比空白还糟：它看起来是有内容的，而顺序全是假的。
 *
 * 幂等：补过的跳过，清过的不在了。随便重跑。
 *
 * 用法：
 *   node scripts/backfill-timeline.mjs         # 预览
 *   node scripts/backfill-timeline.mjs --yes   # 真写
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
  const res = await fetch(`${URL_}${path}`, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429 && attempt < 5) {
    await sleep(500 * 2 ** attempt);
    return call(method, path, body, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  await sleep(50); // Twenty 的限流不宽，慢一点总比退避重试便宜
  return JSON.parse(text || '{}');
};

/** 分页把一个对象全取回来。depth=1 才拿得到 company / recordedBy / project 的 id。 */
const listAll = async (plural) => {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 30; page++) {
    const q = `/rest/${plural}?limit=60&depth=1${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ''}`;
    const r = await call('GET', q);
    const rows = r?.data?.[plural] ?? [];
    out.push(...rows);
    if (!r?.pageInfo?.hasNextPage || !r?.pageInfo?.endCursor) break;
    cursor = r.pageInfo.endCursor;
  }
  return out;
};

// ── 哪些对象要补，以及每条记录该挂到谁身上 ─────────────────────────
//
// `name` 是 timeline 上那个可点 chip 的文字，`when` 决定它排在时间线的哪一格。
// 两个都从记录**自己**身上取 —— 补历史的全部意义就是不伪造时间。
const PLAN = [
  {
    object: 'visit',
    plural: 'visits',
    label: '拜访/事件',
    when: (r) => r.startedAt ?? r.createdAt,
    targets: (r) => ({ company: r.company?.id, contributor: r.recordedBy?.id, project: r.project?.id }),
  },
  {
    object: 'productFitment',
    plural: 'productFitments',
    label: '产品选型情报',
    when: (r) => r.recordedAt ?? r.createdAt,
    targets: (r) => ({ company: r.company?.id, contributor: r.recordedBy?.id }),
  },
  {
    object: 'supportCase',
    plural: 'supportCases',
    label: '售后问题',
    when: (r) => r.reportedAt ?? r.createdAt,
    targets: (r) => ({ company: r.company?.id, contributor: r.recordedBy?.id }),
  },
  {
    object: 'opportunity',
    plural: 'opportunities',
    label: '商机',
    when: (r) => r.createdAt,
    targets: (r) => ({ company: r.company?.id }),
  },
  {
    object: 'project',
    plural: 'projects',
    label: '项目',
    when: (r) => r.createdAt,
    targets: (r) => ({ company: r.company?.id, contributor: r.recordedBy?.id }),
  },
  {
    object: 'workItem',
    plural: 'workItems',
    label: '任务线程',
    when: (r) => r.createdAt,
    targets: (r) => ({ company: r.company?.id, contributor: r.recordedBy?.id, project: r.project?.id }),
  },
  {
    object: 'projectDoc',
    plural: 'projectDocs',
    label: '项目文档',
    when: (r) => r.createdAt,
    targets: (r) => ({ company: r.company?.id, contributor: r.recordedBy?.id, project: r.project?.id }),
  },
  {
    object: 'intelValue',
    plural: 'intelValues',
    label: '情报取值',
    when: (r) => r.recordedAt ?? r.createdAt,
    targets: (r) => ({ company: r.company?.id, contributor: r.recordedBy?.id }),
  },
];

const objRes = await call('GET', '/rest/metadata/objects?limit=200');
const objs = objRes?.data?.objects ?? (Array.isArray(objRes?.data) ? objRes.data : []);
const metaId = Object.fromEntries(objs.map((o) => [o.nameSingular, o.id]));

// 已经补过的 —— 一次全捞回来，比每条记录查一次便宜得多
console.log('读已有的 timeline 事件…');
const events = await listAll('timelineActivities');
const seen = new Set();
for (const t of events) if (t.linkedRecordId) seen.add(t.linkedRecordId);
console.log(`  已有 ${seen.size} 条带链接的事件\n`);

let planned = 0;
let wrote = 0;
let skipped = 0;
/** 活着的记录 id —— 对账的另一半靠它认出孤儿事件 */
const alive = new Set();

for (const p of PLAN) {
  if (!metaId[p.object]) {
    console.log(`⚠️ 对象 ${p.object} 不存在，跳过`);
    continue;
  }
  const rows = await listAll(p.plural);
  for (const r of rows) alive.add(r.id);
  const todo = rows.filter((r) => !seen.has(r.id)).filter((r) => Object.values(p.targets(r)).some(Boolean));
  const noTarget = rows.length - rows.filter((r) => Object.values(p.targets(r)).some(Boolean)).length;

  console.log(
    `\x1b[1m【${p.label}】\x1b[0m ${rows.length} 条 → 要补 ${todo.length}` +
      (noTarget ? ` · ${noTarget} 条没有任何归属（挂不上，跳过）` : '') +
      (rows.length - todo.length - noTarget ? ` · ${rows.length - todo.length - noTarget} 条已有` : ''),
  );
  skipped += noTarget;

  for (const r of todo) {
    planned++;
    if (!YES) continue;
    const body = {
      name: `linked-${p.object}.created`,
      happensAt: p.when(r) ?? r.createdAt,
      properties: {},
      linkedRecordId: r.id,
      linkedRecordCachedName: String(r.name ?? r.projectCode ?? r.itemCode ?? '').slice(0, 200),
      linkedObjectMetadataId: metaId[p.object],
    };
    for (const [k, v] of Object.entries(p.targets(r))) {
      if (v) body[`target${k[0].toUpperCase()}${k.slice(1)}Id`] = v;
    }
    try {
      await call('POST', '/rest/timelineActivities', body);
      wrote++;
    } catch (e) {
      console.log(`   ⚠️ ${r.id.slice(0, 8)}：${String(e).slice(0, 120)}`);
    }
  }
}

// ── ② 清孤儿：事件还在，它指的那条记录已经没了 ─────────────────────
//
// 🔴 **只碰我们自己造的那些**（`linked-<我们管的对象>.`）。
// Twenty 自己写的 `company.created`、Note/Task 的事件一律不动 ——
// 一个「顺手清理」的脚本删掉别人的数据，是这类工具最典型的翻车方式。
const MINE = new Set(PLAN.map((p) => p.object));
const orphans = events.filter((t) => {
  if (!t.linkedRecordId || !String(t.name ?? '').startsWith('linked-')) return false;
  const obj = String(t.name).split('.')[0].replace('linked-', '');
  return MINE.has(obj) && !alive.has(t.linkedRecordId);
});

if (orphans.length) {
  console.log(
    `\n\x1b[1m【孤儿事件】\x1b[0m ${orphans.length} 条指向已经不存在的记录` +
      `（客户页上那些点不开的灰名字）`,
  );
  const by = {};
  for (const t of orphans) by[t.name] = (by[t.name] ?? 0) + 1;
  for (const [k, v] of Object.entries(by).sort()) console.log(`   ${k.padEnd(34)} ${v}`);
}
let pruned = 0;
if (YES) {
  for (const t of orphans) {
    try {
      await call('DELETE', `/rest/timelineActivities/${t.id}`);
      pruned++;
    } catch (e) {
      console.log(`   ⚠️ ${t.id.slice(0, 8)}：${String(e).slice(0, 120)}`);
    }
  }
}

console.log(
  YES
    ? `\n✅ 补了 ${wrote} 条 · 清了 ${pruned} 条孤儿${skipped ? `（${skipped} 条记录没有归属，挂不上）` : ''}\n`
    : `\n这是预览：会补 ${planned} 条、清 ${orphans.length} 条。真要写加 \x1b[1m--yes\x1b[0m。\n`,
);
