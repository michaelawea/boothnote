#!/usr/bin/env node
/**
 * 核对 .env 里配的模型在这个账号下到底存不存在。
 *
 *   node scripts/check-models.mjs
 *
 * 为什么要有这个脚本：模型名是**猜不得**的东西 —— 猜错了不会在启动时报错，
 * 而是等到展会现场第一次录音才 404。这个脚本 30 秒给答案。
 *
 * 🔴 它只读 process.env，**不打印 key**，也不写日志。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 从 .env 取值但绝不回显 —— 只用来发请求
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
    return {};
  }
})();

const key = process.env.OPENAI_API_KEY || envFile.OPENAI_API_KEY;
if (!key) {
  console.error('✗ 没找到 OPENAI_API_KEY（环境变量或 .env 里都没有）');
  process.exit(1);
}

const want = {
  转写: process.env.OPENAI_TRANSCRIBE_MODEL || envFile.OPENAI_TRANSCRIBE_MODEL || 'gpt-transcribe',
  抽取: process.env.OPENAI_EXTRACT_MODEL || envFile.OPENAI_EXTRACT_MODEL || 'gpt-5.6-luna',
};

const res = await fetch('https://api.openai.com/v1/models', {
  headers: { Authorization: `Bearer ${key}` },
});
if (!res.ok) {
  console.error(`✗ 拉模型列表失败 ${res.status} —— key 可能无效或没权限`);
  process.exit(1);
}
const ids = new Set((await res.json()).data.map((m) => m.id));

console.log(`\n账号下可见 ${ids.size} 个模型。核对 .env 里配的两个：\n`);
let bad = 0;
for (const [用途, id] of Object.entries(want)) {
  const ok = ids.has(id);
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${用途}  ${id}${ok ? '' : '   ← 这个账号下没有'}`);
}

// 猜错时给出同族的候选，省得人去翻文档
if (bad) {
  const hint = (kw) => [...ids].filter((i) => i.includes(kw)).sort().slice(0, 12);
  console.log('\n同族的候选（供参考）：');
  console.log('  转写类：', hint('transcribe').join(', ') || '（没找到）');
  console.log('  推理类：', hint('gpt-5').join(', ') || '（没找到）');
}
console.log('');
process.exit(bad ? 1 : 0);
