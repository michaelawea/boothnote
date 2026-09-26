#!/usr/bin/env node
/**
 * Twenty 侧边栏 —— **唯一真相源**，幂等，随便重跑。
 *
 * 和另外两个 provision 的分工：
 *   `provision-twenty.mjs`  管**有哪些对象和字段**（数据结构）
 *   `provision-views.mjs`   管**打开一个对象看到什么列**（视图）
 *   这一个                   管**侧边栏上出现哪几项、什么顺序**（导航）
 *
 * 三个都是声明式的：改这个文件、重跑，**不要在 Twenty 界面上拖来拖去** ——
 * 手拖的顺序下次换环境（或重建工作区）就没了，而且没人记得当初为什么那么排。
 *
 * ── 🔴 这个脚本删的是「导航项」，不是对象 ──────────────────────────
 *
 * 维护者 2026-08-13 定的要求原话是：「保留页面的简洁，但字段内部数据库结构
 * 肯定是完全不变的」。所以这里只删 `navigationMenuItem`，**绝不动对象**。
 *
 * 让一项从侧边栏消失有两条路，**2026-08-13 在 v2.25.1 上逐条实测过**
 * （拿 `product` 做的，它 0 条记录）：
 *
 *   | 做法                   | 侧边栏 | REST/GraphQL | 对象元数据 | schema 漂移守卫 |
 *   |------------------------|--------|--------------|-----------|----------------|
 *   | 删导航项（本脚本）      | 消失   | 200/201/200  | 一个字不动 | 绿（本来就没变）|
 *   | 对象 `isActive: false` | 消失   | **也是 200** | isActive 变了 | **也绿（看不见）**|
 *
 * ⚠️ **注意第二行第二格** —— 我原本在这里写的是「停用会掐断 API」，
 * 实测**是错的**：停用之后 `GET /rest/products` 仍是 200、`POST` 仍是 201、
 * GraphQL 照读。**这个仓库最贵的几次都是把推断当成事实写进注释**，所以这行
 * 留着，改成实测的样子。
 *
 * 那为什么仍然选「删导航项」？三条，按份量排：
 *   ① **它是最小的那个改动** —— 对象元数据一个字段都不改，
 *      `check-schema-drift.mjs` 的基线一格不动。
 *   ② 「停用对象」是关于**对象本身**的声明；我们只想声明**侧边栏**。
 *      需求是「页面简洁」，不是「这个对象不用了」。
 *   ③ 🔴 **停用还额外关掉了什么，我没查清楚**（全局搜索？命令菜单？
 *      工作流？下一个版本？）。导航项是我们唯一真正想去掉的东西，
 *      那就只去掉它 —— 不确定的副作用不要买。
 *
 * 🔴 **判据：一个「让它不显示」的需求，先问清楚是「不显示」还是「不存在」；
 *    再问「这条路顺带关掉了什么」。** 和 §2.38 那次「REST DELETE 到底是软删
 *    还是硬删」是同一个形状 —— 两条路的表象一样，只有去看数据/API 本身才分得开。
 *
 * ── 另一条要记住的 ────────────────────────────────────────────────
 * Twenty 在**新建自定义对象时会自动补一个导航项**。所以 `provision-twenty.mjs`
 * 加了新对象之后，这个脚本会把它从侧边栏拿掉（因为不在下面的清单里）。
 * 这是**有意的**：清单是唯一真相源。要让新对象出现在侧边栏，往清单里加一行。
 *
 * 用法：
 *   node scripts/provision-nav.mjs         # 预览（不动手）
 *   node scripts/provision-nav.mjs --yes   # 真写
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
// ⚠️ SERVER_URL 是 .env 里真正存在的那个键（D65：别再发明第二个名字）。
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

// 侧边栏清单住在 `sidebar-spec.mjs` —— `verify-deploy.mjs` 也 import 它。
// 抄第二份的话，「配置」和「对账」会各自说自己是对的（见那个文件的头部）。
const { SIDEBAR, HIDDEN_ON_PURPOSE } = await import(join(ROOT, 'scripts/sidebar-spec.mjs'));

const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gql = async (query, variables, attempt = 0) => {
  const res = await fetch(`${URL_}/metadata`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429 && attempt < 5) {
    await sleep(500 * 2 ** attempt);
    return gql(query, variables, attempt + 1);
  }
  const j = await res.json().catch(() => ({}));
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  await sleep(40);
  return j.data;
};

const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`,
            g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`,
            y: (s) => `\x1b[33m${s}\x1b[0m` };

console.log(`\n${c.b('▸ Twenty 侧边栏')}  ${URL_}${YES ? '' : c.dim('   （预览，不动手）')}\n`);

// ── 现状 ────────────────────────────────────────────────────────────
const objects = (
  await gql('query { objects(paging:{first:200}) { edges { node { id nameSingular labelSingular } } } }')
).objects.edges.map((e) => e.node);
const byName = Object.fromEntries(objects.map((o) => [o.nameSingular, o]));
const byId = Object.fromEntries(objects.map((o) => [o.id, o]));

const missing = SIDEBAR.filter((n) => !byName[n]);
if (missing.length) {
  console.error(c.r(`🔴 清单里这几个对象在 Twenty 上不存在：${missing.join(' / ')}`));
  console.error('   先跑 node scripts/provision-twenty.mjs，再跑这个。\n');
  process.exit(1);
}

const all = (
  await gql(`query { navigationMenuItems {
    id name type position userWorkspaceId targetObjectMetadataId folderId pageLayoutId
  } }`)
).navigationMenuItems;

// 🔴 只管工作区级的。`userWorkspaceId` 非空 = 某个人自己拖出来的，
//    那是他的界面偏好，不是我们的配置 —— 碰它等于替别人重排桌面。
const items = all.filter((n) => n.userWorkspaceId == null);
const perUser = all.length - items.length;

const label = (n) =>
  n.targetObjectMetadataId
    ? `${byId[n.targetObjectMetadataId]?.labelSingular ?? '?'} ${c.dim(byId[n.targetObjectMetadataId]?.nameSingular ?? '')}`
    : `${n.name ?? '?'} ${c.dim(`(${n.type})`)}`;

// ── 算差异 ──────────────────────────────────────────────────────────
const wanted = new Set(SIDEBAR.map((n) => byName[n].id));
const keep = [];   // 留下的（可能要改 position）
const drop = [];   // 拿掉的
for (const n of items) {
  if (n.type === 'OBJECT' && wanted.has(n.targetObjectMetadataId)) keep.push(n);
  else drop.push(n);
}
// 缺的（这个工作区上压根没有导航项的）
const have = new Set(keep.map((n) => n.targetObjectMetadataId));
const add = SIDEBAR.filter((n) => !have.has(byName[n].id));

// 🔴 删 FOLDER 要排在它的子项**后面** —— 先删空壳、子项就成了指向不存在
//    文件夹的孤儿。按「有 folderId 的排前面」排一次就够（只有一层嵌套）。
drop.sort((a, b) => (b.folderId ? 1 : 0) - (a.folderId ? 1 : 0));

// position：按清单顺序重排，从 0 开始，连号。
const posOf = Object.fromEntries(SIDEBAR.map((n, i) => [byName[n].id, i]));
const repos = keep.filter((n) => n.position !== posOf[n.targetObjectMetadataId]);

// ── 报表 ────────────────────────────────────────────────────────────
console.log(`  ${c.b('留在侧边栏')}（${SIDEBAR.length} 项，顺序即下面这个顺序）`);
SIDEBAR.forEach((n, i) => console.log(`    ${String(i).padStart(2)}  ${byName[n].labelSingular} ${c.dim(n)}`));

console.log(`\n  ${c.b('从侧边栏拿掉')}（${drop.length} 项 —— ${c.y('对象与字段一个字不动')}）`);
if (!drop.length) console.log(c.dim('    （没有）'));
for (const n of drop) {
  const why = n.targetObjectMetadataId
    ? HIDDEN_ON_PURPOSE[byId[n.targetObjectMetadataId]?.nameSingular]
    : n.type === 'PAGE_LAYOUT'
      ? '2026-07-31 那个原型应用的页面（apps/boothnote-capture/），数据只在浏览器里'
      : null;
  console.log(`    − ${label(n)}`);
  if (why) console.log(`        ${c.dim(why)}`);
}

// ── 🔴 原型应用：只报，不自己动手 ──────────────────────────────────
//
// 2026-07-31 那个原型应用（`apps/boothnote-capture/`）会往侧边栏塞两页（速记 / Agent）。
// 这个脚本删得掉它的**导航项**，但删不掉**应用本身** —— 于是它会以「装着但看不见」
// 的状态留在工作区里，下一次谁跑 `twenty apply` 又会冒出来。
//
// **为什么只报不卸**：`uninstallApplication` 是比「删一个导航项」大一号的动作，
// 而这个脚本会在每次部署里自动跑。判据同 §2.50 —— **不确定的副作用不要买**，
// 会连带删什么由人看一眼再决定。报出来就不会被忘掉，这是它和「静默留着」的区别。
try {
  const apps = (await gql('query { findManyApplications { name universalIdentifier canBeUninstalled } }'))
    .findManyApplications.filter((a) => a.canBeUninstalled);
  if (apps.length) {
    console.log(`\n  ${c.y('⚠️ 工作区里还装着可卸载的应用')}（本脚本${c.b('不会')}自己卸）`);
    for (const a of apps) {
      console.log(`    · ${a.name}  ${c.dim(a.universalIdentifier)}`);
      if (a.name === 'Boothnote') {
        console.log(c.dim('      这就是「速记 / Agent」两页的来源（apps/boothnote-capture/，已废弃 · D114）。'));
        console.log(c.dim('      导航项这一轮会删掉，但应用还在。要彻底拿掉，见 docs/deploy.md §7.10。'));
      }
    }
  }
} catch (e) {
  console.log(c.dim(`\n  （查不到已安装应用，跳过这项提示：${String(e).slice(0, 80)}）`));
}

if (add.length) console.log(`\n  ${c.b('补上')}（${add.length} 项）\n${add.map((n) => `    + ${byName[n].labelSingular}`).join('\n')}`);
if (repos.length) console.log(`\n  ${c.b('重排')}（${repos.length} 项）`);
if (perUser) console.log(`\n  ${c.dim(`（另有 ${perUser} 项是某个人自己拖的，按 userWorkspaceId 跳过）`)}`);

if (!drop.length && !add.length && !repos.length) {
  console.log(`\n${c.g('✅ 侧边栏已经和清单一致，什么都不用做。')}\n`);
  process.exit(0);
}

if (!YES) {
  console.log(`\n${c.dim('   加 --yes 真写。')}\n`);
  process.exit(0);
}

// ── 写 ──────────────────────────────────────────────────────────────
for (const n of drop) {
  await gql('mutation($id:UUID!){ deleteNavigationMenuItem(id:$id){ id } }', { id: n.id });
}
for (const name of add) {
  await gql(
    'mutation($input:CreateNavigationMenuItemInput!){ createNavigationMenuItem(input:$input){ id } }',
    { input: { type: 'OBJECT', targetObjectMetadataId: byName[name].id, position: posOf[byName[name].id] } },
  );
}
for (const n of repos) {
  // ⚠️ 这三个 mutation 的参数形状**各不相同**，都是实测出来的（`__schema` 内省）：
  //      delete → `id: UUID`
  //      create → `input: CreateNavigationMenuItemInput`
  //      update → `input: { id, update }`   ← 唯一多包一层的
  //    照着前两个的样子写 update 会报 `Unknown argument "id"`。
  //    和 `provision-views.mjs` 顶上那张表是同一类账：这套 API 没有统一形状，
  //    **别「统一写个循环」**。
  await gql(
    'mutation($input:UpdateOneNavigationMenuItemInput!){ updateNavigationMenuItem(input:$input){ id } }',
    { input: { id: n.id, update: { position: posOf[n.targetObjectMetadataId] } } },
  );
}

// ── 回读对账 ────────────────────────────────────────────────────────
// 🔴 「跑完了」和「生效了」是两件事（verify-deploy.mjs 存在的全部理由）。
const after = (
  await gql('query { navigationMenuItems { id type userWorkspaceId targetObjectMetadataId } }')
).navigationMenuItems.filter((n) => n.userWorkspaceId == null);

const bad = [];
if (after.length !== SIDEBAR.length) bad.push(`侧边栏应有 ${SIDEBAR.length} 项，回读到 ${after.length} 项`);
for (const name of SIDEBAR) {
  if (!after.some((n) => n.targetObjectMetadataId === byName[name].id)) bad.push(`${name} 没在侧边栏上`);
}
// 顺带确认没有误伤对象：清单外那些对象必须还 isActive
const stillActive = (
  await gql('query { objects(paging:{first:200}) { edges { node { nameSingular isActive } } } }')
).objects.edges.map((e) => e.node);
for (const name of Object.keys(HIDDEN_ON_PURPOSE)) {
  const o = stillActive.find((x) => x.nameSingular === name);
  if (o && !o.isActive) bad.push(`🔴 ${name} 被停用了 —— 这个脚本只该删导航项，不该动对象`);
}

if (bad.length) {
  console.log(`\n${c.r('🔴 回读对不上：')}\n${bad.map((b) => `   · ${b}`).join('\n')}\n`);
  process.exit(1);
}
console.log(`\n${c.g(`✅ 侧边栏 ${SIDEBAR.length} 项，对象与字段全部保持 active。`)}\n`);
