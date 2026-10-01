#!/usr/bin/env node
/**
 * 项目类型模板进库（D140：阶段按项目类型配模板）。
 *
 * 起因：门户里建项目必须先选一个类型（`POST /portal/projects` 要 projectTypeId），
 * 一个类型都没有的话，门户那一屏是空的 —— 而且**没有任何一处报错**。
 * 所以部署时灌一个默认模板，`verify-deploy.mjs` 再回读一次「至少一个在用类型、至少一个在用阶段」。
 *
 * 模板写在这个文件里，不放 data/ —— 公开版导出不带 data/，放那儿就得再配一份 overlay。
 *
 * 幂等：类型按 `typeCode` 认领，阶段按「同一类型下的 `stageKey`」认领。
 *
 * 🔴 **已经在库里的一律不改，只补缺的。**
 * 类型和阶段是**门户 admin 在管**的（改名、调顺序、停用都在门户里做）。
 * 这个脚本每次部署都跑 —— 它要是按模板覆盖，admin 在门户里改的东西每部署一次就被打回去一次，
 * 而且没有任何地方会告诉他为什么。所以对已存在的只报差异，不动手。
 * 缺的阶段只可能是「第一次灌到一半断了」（门户只停用、从不删阶段），补上就是把那次补完。
 *
 * ⚠️ 从不删任何东西。
 *
 * 用法：
 *   node scripts/seed-project-types.mjs         # 预览（也是「库里和模板差在哪」的报告 —— 只读）
 *   node scripts/seed-project-types.mjs --yes   # 真写
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPPORTUNITY_STAGES } from './twenty-schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const YES = process.argv.includes('--yes');

const envFile = (() => {
  try {
    return Object.fromEntries(
      readFileSync(join(ROOT, '.env'), 'utf8')
        .split('\n')
        .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
        }),
    );
  } catch {
    return {}; // 一次性容器里靠 --env-file 进来的 process.env
  }
})();
// ⚠️ SERVER_URL 是 .env 里实际存在的那个键（D65：别再发明第二个名字）
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

/** 分页读全。**超过页数上限就抛** —— 静默截断会让「缺的」看起来像「没有」。 */
const listAll = async (plural, filter = '') => {
  const out = [];
  let cursor = null;
  for (let p = 0; p < 50; p++) {
    const r = await call(
      'GET',
      `/rest/${plural}?limit=60${filter ? `&filter=${encodeURIComponent(filter)}` : ''}` +
        (cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ''),
    );
    out.push(...(r?.data?.[plural] ?? []));
    if (!r?.pageInfo?.hasNextPage || !r?.pageInfo?.endCursor) return out;
    cursor = r.pageInfo.endCursor;
  }
  throw new Error(`${plural} 超过 50 页还没读完 —— 不截断，停在这里`);
};

// ── 默认模板 ──────────────────────────────────────────────────────────
/**
 * `Sample Testing 样品/台架测试` → { en: 'Sample Testing', zh: '样品/台架测试' }。
 * 英文部分给客户看（门户只显示 name），中文给内部看。
 */
const splitLabel = (label, fallback) => {
  const i = String(label).search(/[　-鿿＀-￯]/);
  const en = (i < 0 ? label : label.slice(0, i)).replace(/[\s/]+$/, '').trim();
  const zh = i < 0 ? '' : label.slice(i).trim();
  return { en: en || fallback, zh: zh || en || fallback };
};

/**
 * 阶段 = D59 的**项目**那一段：定点 → 样品测试 → 整车验证 → SOP → 量产。
 * 🔴 **不是整条商机漏斗**（未接触 / 已接触 / 报价 是「这单能不能做成」，项目回答的是「做成之后怎么交付」，D59②）——
 * 客户在门户里看得到这条进度条，给他看「Not Contacted」是在说我们还没联系过他。
 * ⚠️ 顺序照 D59 写在这里，**不照枚举的顺序**：枚举里 `nominated` 排在测试之后（那是商机漏斗的顺序）。
 * `stageKey` = 那个枚举值 —— 老项目的 projectStage 以后要对到新阶段上，靠的就是它；
 * 名字取枚举 label（英文那半给客户，中文那半给内部）。
 */
const PROJECT_STAGE_KEYS = ['nominated', 'sampleTesting', 'vehicleValidation', 'sop', 'massProduction'];
const stageFromEnum = (key) => {
  const s = OPPORTUNITY_STAGES.find((x) => x.value === key);
  if (!s) throw new Error(`OPPORTUNITY_STAGES 里没有 ${key} —— 枚举改过名？先对 D59`);
  const { en, zh } = splitLabel(s.label, s.value);
  return { stageKey: s.value, name: en, nameZh: zh };
};

const TEMPLATES = [
  {
    typeCode: 'OEM-PROGRAM',
    name: 'RV OEM Program',
    description: 'Default stage template for vehicle OEM programmes.',
    stages: PROJECT_STAGE_KEYS.map(stageFromEnum),
  },
];

console.log(`\n▸ 项目类型模板  ${URL_}\n`);

const types = await listAll('projectTypes');
const byCode = new Map(types.filter((t) => t.typeCode).map((t) => [t.typeCode, t]));
console.log(`库里已有 ${types.length} 个类型\n`);

let created = 0;
let same = 0;
const drift = [];

for (const tpl of TEMPLATES) {
  let type = byCode.get(tpl.typeCode);
  if (!type) {
    console.log(`  ＋ 类型 ${tpl.typeCode}「${tpl.name}」`);
    created++;
    if (YES) {
      const r = await call('POST', '/rest/projectTypes', {
        name: tpl.name,
        typeCode: tpl.typeCode,
        description: tpl.description,
        isActive: true,
      });
      type = r?.data?.createProjectType ?? r?.data;
    }
  } else {
    console.log(`  ＝ 类型 ${tpl.typeCode}「${type.name}」已在库里`);
    same++;
    if (type.name !== tpl.name) drift.push(`${tpl.typeCode} 的名字是「${type.name}」（模板写的是「${tpl.name}」）`);
  }

  const stages = type?.id ? await listAll('projectTypeStages', `projectTypeId[eq]:${type.id}`) : [];
  const byKey = new Map(stages.filter((s) => s.stageKey).map((s) => [s.stageKey, s]));
  for (const [i, st] of tpl.stages.entries()) {
    const hit = byKey.get(st.stageKey);
    if (hit) {
      same++;
      if (hit.name !== st.name) drift.push(`${tpl.typeCode}/${st.stageKey} 叫「${hit.name}」（模板：「${st.name}」）`);
      if ((hit.nameZh ?? '') !== st.nameZh) drift.push(`${tpl.typeCode}/${st.stageKey} 中文名「${hit.nameZh ?? ''}」（模板：「${st.nameZh}」）`);
      if (hit.isActive !== true) drift.push(`${tpl.typeCode}/${st.stageKey} 已停用`);
      continue;
    }
    console.log(`    ＋ 阶段 ${String(i + 1).padStart(2)} ${st.stageKey.padEnd(18)} ${st.name} · ${st.nameZh}`);
    created++;
    if (YES && type?.id) {
      await call('POST', '/rest/projectTypeStages', {
        name: st.name,
        nameZh: st.nameZh,
        stageKey: st.stageKey,
        stageOrder: i + 1,
        isActive: true,
        projectTypeId: type.id,
      });
    }
  }

  // 库里**在用**、模板里没有的阶段（例如旧模板留下的整条商机漏斗）—— 只报，不停用：
  // 可能有项目正停在上面，停用要走门户（它会挡 stage_in_use）
  const want = new Set(tpl.stages.map((s) => s.stageKey));
  const extra = stages.filter((s) => s.isActive === true && !want.has(s.stageKey));
  for (const s of extra) drift.push(`${tpl.typeCode} 多一个在用阶段 ${s.stageKey ?? '(无 stageKey)'}「${s.name}」（模板里没有）`);

  // 在用阶段的顺序和模板不一样
  const liveOrder = stages
    .filter((s) => s.isActive === true)
    .sort((a, b) => (a.stageOrder ?? 0) - (b.stageOrder ?? 0))
    .map((s) => s.stageKey ?? '?');
  const tplOrder = tpl.stages.map((s) => s.stageKey);
  if (stages.length && liveOrder.join('>') !== tplOrder.join('>'))
    drift.push(`${tpl.typeCode} 在用阶段的顺序是 ${liveOrder.join(' → ')}（模板：${tplOrder.join(' → ')}）`);
}

if (drift.length) {
  console.log(`\n  和模板不一样的地方 ${drift.length} 处（**只报不改** —— 门户里改的算数；要对齐就在门户里改，或者人工处理）：`);
  for (const d of drift) console.log(`   · ${d}`);
} else console.log('\n  和模板一致，没有差异。');

console.log(
  YES
    ? `\n✅ 新建 ${created} · 已在库里 ${same}\n`
    : `\n这是预览：会新建 ${created}。真要写加 \x1b[1m--yes\x1b[0m。\n`,
);
