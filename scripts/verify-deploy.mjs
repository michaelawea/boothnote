#!/usr/bin/env node
/**
 * 部署出口对账 —— **「跑完了」和「生效了」是两件事。**
 *
 * 起因是同一个形状栽了三次：
 *
 *   D65   8 个脚本读的 `TWENTY_API_URL` 在 .env 里不存在（真名是 SERVER_URL），
 *         一进 docker run 的一次性容器就连不上 → 视图/清单/timeline 一步都没生效，
 *         而部署一路绿到「完成」。
 *   #2    `deploy.sh` 里从来没有 `seed-suppliers` 这一步 → 线上 supplier 表是空的，
 *         每条在位品牌都对不上受控名单。**没有任何一处报错。**
 *   #5    `accountType` 是后加的字段，导入时被静默丢掉 → 61 家全 null，
 *         按它筛的两个视图永远是空表。导入脚本报的是「✅ 成功」。
 *
 * 三次的共同点：**每一步都写着「失败不阻断部署」**（那是对的，一条 timeline
 * 不该挡住上线），于是没有任何一个地方回头看一眼「东西到底在不在」。
 *
 * 这个脚本就是那一眼。它不修任何东西，只回读、只报数 ——
 * 有一项是 0 就 exit 1，让 `deploy.sh` 停在这里而不是打印「✅ 完成」。
 *
 * 用法：node scripts/verify-deploy.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const envFile = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);
// ⚠️ SERVER_URL 是 .env 里真正存在的那个键（D65 的教训：别再发明第二个名字）
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
const get = async (path, attempt = 0) => {
  const res = await fetch(`${URL_}${path}`, { headers: H });
  if (res.status === 429 && attempt < 5) {
    await sleep(500 * 2 ** attempt);
    return get(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  await sleep(40);
  return res.json();
};
const listAll = async (plural, extra = '') => {
  const out = [];
  let cursor = null;
  for (let p = 0; p < 30; p++) {
    const r = await get(`/rest/${plural}?limit=60${extra}${cursor ? `&starting_after=${cursor}` : ''}`);
    out.push(...(r?.data?.[plural] ?? []));
    if (!r?.pageInfo?.hasNextPage || !r?.pageInfo?.endCursor) break;
    cursor = r.pageInfo.endCursor;
  }
  return out;
};

const gql = async (query) => {
  const r = await fetch(`${URL_}/metadata`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200));
  return j.data;
};

console.log(`\n\x1b[1m▸ 部署出口对账\x1b[0m  ${URL_}\n`);

const rows = [];
/** `ok` 为假 = 这一项没生效，最后 exit 1。`why` 是给人看的「所以呢」。 */
const check = (name, n, ok, why) => rows.push({ name, n, ok, why });

// ── 逐项回读 ────────────────────────────────────────────────────────
const companies = await listAll('companies', '&depth=1');
const ours = companies.filter((c) => c.accountCode);
check('客户（带账户代号）', ours.length, ours.length >= 50, '导入没跑，或者 Twenty 是空的');

const typed = ours.filter((c) => c.accountType);
check(
  '其中填了账户类型',
  typed.length,
  typed.length === ours.length,
  '「情报最缺的」「渠道链上的客户」两个视图按它筛选 —— 空的话那两个视图永远是空表（issue #5）',
);

const demo = companies.filter(
  (c) =>
    !c.accountCode &&
    ['notion.com', 'stripe.com', 'figma.com', 'airbnb.com', 'anthropic.com'].some((d) =>
      String(c.domainName?.primaryLinkUrl ?? '').toLowerCase().includes(d),
    ),
);
check(
  'Twenty 自带示例公司（应为 0）',
  demo.length,
  demo.length === 0,
  '机会地图看板上会出现 Airbnb —— 而那是需求 2 的主视图（issue #5）',
);

const suppliers = await listAll('suppliers');
check(
  '竞品/供应商受控名单',
  suppliers.length,
  suppliers.length > 0,
  '空的话每条在位品牌都对不上名单，全部落进「来源说明」—— 需求 2 的聚合永远算不出来（issue #2）',
);

const items = (await listAll('intelItems')).filter((i) => i.isEnabled !== false);
check(
  '情报清单项（启用的）',
  items.length,
  items.length > 0,
  '空的话「这家还缺什么」一直显示「清单还没配内容」—— 需求 1 整个不成立（T36）',
);

// D140：门户建项目要先选类型。一个在用类型都没有（或有类型但阶段全停了）时，
// 门户那一屏是空的而且不报错 —— 和 issue #2 / T36 同一个形状，所以在这里卡住。
// 布尔一律按 `=== true` 读（空值 = 没启用），和网关、门户同一条规则。
const activeTypes = (await listAll('projectTypes')).filter((t) => t.isActive === true);
const activeStages = (await listAll('projectTypeStages')).filter((s) => s.isActive === true);
const usableTypes = activeTypes.filter((t) =>
  activeStages.some((s) => (s.projectTypeId ?? s.projectType?.id) === t.id),
);
check(
  '项目类型（在用且带在用阶段）',
  usableTypes.length,
  usableTypes.length > 0,
  '门户里建项目时没有类型可选（D140）—— seed-project-types.mjs 没跑，或者类型/阶段全被停用了',
);

const scored = ours.filter((c) => c.intelCompleteness != null);
check(
  '算过完整度的客户',
  scored.length,
  scored.length > 0,
  '「情报最缺的」那个视图排序没有依据（D17③）',
);

// ── 侧边栏（D114）───────────────────────────────────────────────────
// 🔴 **这道对账卡的位置是有讲究的**（D82）：`provision-twenty.mjs` 每新建一个
//    自定义对象，Twenty 就自动补一个导航项 —— 那是「可能弄坏它的那一步」。
//    这里在它之后回读一次，才知道 `provision-nav.mjs` 到底收干净了没有。
const { SIDEBAR, HIDDEN_ON_PURPOSE } = await import(join(ROOT, 'scripts/sidebar-spec.mjs'));
const objMeta = (
  await gql(`{ objects(paging:{first:200}) { edges { node { id nameSingular isActive } } } }`)
).objects.edges.map((e) => e.node);
const idOf = Object.fromEntries(objMeta.map((o) => [o.nameSingular, o.id]));
const navItems = (
  await gql(`{ navigationMenuItems { id type userWorkspaceId targetObjectMetadataId } }`)
).navigationMenuItems.filter((n) => n.userWorkspaceId == null);
const onBar = new Set(navItems.map((n) => n.targetObjectMetadataId));
const declared = SIDEBAR.filter((n) => onBar.has(idOf[n]));
check(
  '侧边栏项',
  navItems.length,
  navItems.length === SIDEBAR.length && declared.length === SIDEBAR.length,
  `应为 ${SIDEBAR.length} 项（${SIDEBAR.join(' / ')}）—— 多出来的多半是 provision-twenty 新建对象时` +
    ' Twenty 自动补的导航项，重跑 node scripts/provision-nav.mjs --yes',
);

// 🔴 **和上面那一项问的不是同一个问题。** 上面问「左边那一栏干不干净」，
//    这一项问「**收拾的时候用的是哪条路**」—— 把对象 `isActive: false` 同样能
//    让它从侧边栏消失，两种做法在界面上长得一模一样。
//    ⚠️ 而 `check-schema-drift.mjs` **看不见 isActive**（2026-08-13 实测：
//    停用 product 期间它照样报「无危险漂移」）—— 所以这道回读不是冗余，
//    它补的就是那个盲区。为什么坚持走导航项那条路，见 provision-nav.mjs 头部。
const hidden = Object.keys(HIDDEN_ON_PURPOSE);
const stillActive = hidden.filter((n) => objMeta.find((o) => o.nameSingular === n)?.isActive);
check(
  '隐藏项仍然 active',
  stillActive.length,
  stillActive.length === hidden.length,
  `${hidden.filter((n) => !stillActive.includes(n)).join(' / ')} 被停用了 ——` +
    ' 侧边栏声明的做法是「删导航项」，不是「停用对象」。停用是关于对象本身的声明，' +
    '副作用（搜索 / 命令菜单 / 后续版本）没有查清，而 schema 漂移守卫看不见它。',
);

const views = (await gql(`{ getViews { id name } }`)).getViews ?? [];
const MINE = ['机会地图 · 按阶段', '决策窗口临近', '没关掉的', '待办', '按来源', '情报最缺的'];
const got = MINE.filter((n) => views.some((v) => v.name === n));
check(
  '我们声明的视图',
  got.length,
  got.length === MINE.length,
  `缺 ${MINE.filter((n) => !got.includes(n)).join(' / ')} —— 人打开 CRM 看到的还是默认列（D60）`,
);

// ── 报表 ────────────────────────────────────────────────────────────
const w = Math.max(...rows.map((r) => [...r.name].length)) + 2;
for (const r of rows) {
  const pad = ' '.repeat(Math.max(0, w - [...r.name].length));
  console.log(`  ${r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${r.name}${pad}${String(r.n).padStart(4)}`);
}

const bad = rows.filter((r) => !r.ok);
if (!bad.length) {
  console.log('\n\x1b[32m✅ 每一项都真的生效了。\x1b[0m\n');
  process.exit(0);
}

console.log(`\n\x1b[31m🔴 有 ${bad.length} 项没生效 —— 部署「跑完了」但没「做到」：\x1b[0m\n`);
for (const r of bad) console.log(`   · \x1b[1m${r.name}\x1b[0m = ${r.n}\n     ${r.why}`);
console.log(
  '\n   这三步各自都写着「失败不阻断部署」（那是对的），所以中途只打了一行 ⚠️。\n' +
    '   对着上面那几项，回去看部署日志里对应那一步的输出。\n',
);
process.exit(1);
