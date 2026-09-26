#!/usr/bin/env node
/**
 * 把 `data/suppliers.json` 里的在位竞品导进 Twenty。**幂等** —— 随便重跑。
 *
 * 为什么需要这个脚本：`productFitment.supplier` 是关系字段，
 * 值必须指向已存在的 supplier 记录（D23a）。名单是空的时候，
 * agent 抽出来的「他们在用 Voltaro」**永远填不进那一格** ——
 * 而这不会报错，只会让「谁在用谁」这个视图一直是空的。
 *
 * 名单是**数据不是代码**（同 D17①）：改 `data/suppliers.json` 不需要发版。
 *
 * 用法：
 *   node scripts/seed-suppliers.mjs          # 看会做什么，不写
 *   node scripts/seed-suppliers.mjs --yes    # 真写
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const YES = process.argv.includes('--yes');

// .env 自己读 —— 这个脚本不依赖网关跑着
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
  console.error('🔴 .env 里没有 TWENTY_API_KEY。（只有 维护者 能填这个值。）');
  process.exit(1);
}

const call = async (method, path, body) => {
  const res = await fetch(`${URL_}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Twenty ${method} ${path} → ${res.status} ${text.slice(0, 240)}`);
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};

const { suppliers } = JSON.parse(readFileSync(join(ROOT, 'data', 'suppliers.json'), 'utf8'));
if (!Array.isArray(suppliers) || !suppliers.length) {
  console.error('🔴 data/suppliers.json 里 suppliers 是空的。');
  process.exit(1);
}

const existing = (await call('GET', '/rest/suppliers?limit=200'))?.data?.suppliers ?? [];
const have = new Map(existing.map((s) => [String(s.name).trim().toLowerCase(), s.id]));

console.log(`\nTwenty 里已有 ${existing.length} 家 · 名单里 ${suppliers.length} 家\n`);

let added = 0;
for (const s of suppliers) {
  const key = String(s.name ?? '').trim().toLowerCase();
  if (!key) continue;
  if (have.has(key)) {
    console.log(`  ⏭  ${s.name}`);
    continue;
  }
  if (!YES) {
    console.log(`  +  ${s.name}（${(s.categories ?? []).join(' · ') || '未分品类'}）`);
    added++;
    continue;
  }
  await call('POST', '/rest/suppliers', {
    name: s.name,
    ...(s.categories?.length ? { categories: s.categories } : {}),
    ...(s.note ? { supplierNote: s.note } : {}),
  });
  console.log(`  ✅ ${s.name}`);
  added++;
}

console.log(
  YES
    ? `\n✅ 新建 ${added} 家。\n`
    : `\n这是预览，会新建 ${added} 家。真要写加 \x1b[1m--yes\x1b[0m。\n` +
        `⚠️ 名单不全的话，抽出来的在位品牌会静默留空 —— 补全 data/suppliers.json 再跑一次。\n`,
);
