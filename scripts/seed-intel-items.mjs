#!/usr/bin/env node
/**
 * 情报清单进库（T36 / D17①：**清单是数据不是代码**）。
 *
 * 起因：`/gaps` 一直返回「情报清单还没有配置任何项」，于是
 *   · 每家客户的「情报完整度%」永远是空的
 *   · PWA 的客户情报页显示「都问过了」—— **那是一句谎话**
 *   · 「情报最缺的」那个视图排序没有依据
 *   · agent 的 `get_company_gaps` 工具形同虚设
 * 需求 1「这家还缺什么情报」整个卖点在实测里是空转的。
 *
 * 幂等：按 `itemKey` 认领。已存在的**更新问法与权重**，不新建第二条 ——
 * 改问法不发版（D17①）就是靠这条。
 *
 * ⚠️ **agent 当场造出来的项（`createdByAgent=true`）一律不碰。**
 * 那些是 D47 的产物，人还没决定要不要升级成正式列；
 * 这个脚本一视同仁地覆盖会把它们抹平，而抹掉之后没有任何地方查得回来。
 *
 * 用法：
 *   node scripts/seed-intel-items.mjs         # 预览
 *   node scripts/seed-intel-items.mjs --yes   # 真写
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
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${t.slice(0, 200)}`);
  await sleep(40);
  return JSON.parse(t || '{}');
};

const { items } = JSON.parse(readFileSync(join(ROOT, 'data', 'intel-items.json'), 'utf8'));

// 已有的：分页读回来，按 itemKey 建索引
const existing = new Map();
let cursor = null;
for (let p = 0; p < 20; p++) {
  const r = await call('GET', `/rest/intelItems?limit=60${cursor ? `&starting_after=${cursor}` : ''}`);
  for (const i of r?.data?.intelItems ?? []) if (i.itemKey) existing.set(i.itemKey, i);
  if (!r?.pageInfo?.hasNextPage || !r?.pageInfo?.endCursor) break;
  cursor = r.pageInfo.endCursor;
}

const agentMade = [...existing.values()].filter((i) => i.createdByAgent);
console.log(`\n库里已有 ${existing.size} 项${agentMade.length ? `（其中 ${agentMade.length} 项是 agent 造的，不碰）` : ''}`);
console.log(`清单里 ${items.length} 项\n`);

let created = 0;
let updated = 0;
let same = 0;

for (const it of items) {
  const body = {
    // 标题列给人看：问法本身就是最好的标题，比 `battery_chemistry` 好认
    name: it.question,
    itemKey: it.itemKey,
    question: it.question,
    questionEn: it.questionEn ?? null,
    // 🔴 SELECT 的值在 Twenty 里**必须大写**（写小写会 400，实测）。
    //    网关读回来时统一压成小写 —— 见 `twenty.ts` 的 normalizeIntelItem()。
    appliesTo: 'COMPANY',
    wave: it.wave ?? 1,
    weight: it.weight ?? 1,
    valueType: String(it.valueType ?? 'text').toUpperCase(),
    requiredForStage: it.requiredForStage ?? null,
    isEnabled: true,
    createdByAgent: false,
  };

  const hit = existing.get(it.itemKey);
  if (hit?.createdByAgent) {
    console.log(`  ⏭  ${it.itemKey.padEnd(24)} agent 造的，跳过`);
    same++;
    continue;
  }
  if (hit) {
    const diff = Object.keys(body).filter((k) => (hit[k] ?? null) !== (body[k] ?? null));
    if (!diff.length) {
      console.log(`  ＝ ${it.itemKey.padEnd(24)} 没变`);
      same++;
      continue;
    }
    console.log(`  ✎ ${it.itemKey.padEnd(24)} 改：${diff.join(', ')}`);
    if (YES) await call('PATCH', `/rest/intelItems/${hit.id}`, body);
    updated++;
    continue;
  }
  console.log(`  ＋ ${it.itemKey.padEnd(24)} w${it.wave} · 权重 ${it.weight}${it.requiredForStage ? ` · 门 ${it.requiredForStage}` : ''}`);
  if (YES) await call('POST', '/rest/intelItems', body);
  created++;
}

// 清单里没有、库里却有的（且不是 agent 造的）—— 报出来但**不删**。
// 有可能是人在界面上加的，删掉之后它指向的那些 intelValue 就成了孤儿。
const extra = [...existing.values()].filter(
  (i) => !i.createdByAgent && !items.some((x) => x.itemKey === i.itemKey),
);
if (extra.length) {
  console.log(`\n\x1b[33m⚠️ 库里有 ${extra.length} 项不在清单文件里（**不会删**，可能是人加的）：\x1b[0m`);
  for (const e of extra) console.log(`   · ${e.itemKey} —— ${e.question ?? ''}`);
  console.log('   要么补进 data/intel-items.json，要么在 Twenty 里把它停用。');
}

const totalWeight = items.reduce((s, i) => s + (i.weight ?? 0), 0);
console.log(
  YES
    ? `\n✅ 新建 ${created} · 更新 ${updated} · 未变 ${same}　（完整度分母 = ${totalWeight}）\n`
    : `\n这是预览：会新建 ${created} · 更新 ${updated}。真要写加 \x1b[1m--yes\x1b[0m。\n`,
);
