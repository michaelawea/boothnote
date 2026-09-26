#!/usr/bin/env node
/**
 * i18n 安全守卫 —— **换语言只许改显示，绝不许改数据**（D80）。
 *
 * 维护者 2026-08-07：「确保不要因为换了个语言，我系统层面就不稳定了」。
 *
 * 🔴 触发它的是一个真的 bug：`sync.ts` 里
 *    `db.notes.add({ text: … ?? t('（语音，待转写）') })` ——
 *    那一行把翻译结果**写进了 IndexedDB**。后果：同一条语音速记在英文账号下
 *    存成英文、中文账号下存成中文，**同一份数据因为界面语言而不同**；
 *    而它之后可能被 `saveNoteText` 推到服务端，而 `inbox` 只增不改。
 *    **一个界面设置就把不可再生的原文写脏了。**
 *
 * 这个脚本查三类，任何一类命中就 exit 1：
 *   ① 数据路径的文件里出现 `t(`（sync/db/retry/companies —— 它们写本地库）
 *      例外：错误消息（`lastError` / `Error` / `msg` / `throw`）—— 那是给人看的
 *   ② `t()` 的结果被拿去比较（`=== t('…')`）—— 那等于用译文当判据
 *   ③ **模块级 `t()`** —— 语言是运行时才确定的，模块加载时求值会拿到旧语言
 *      （实测过：管理员改完语言，人第一次打开还是旧语言，刷新第二次才对）
 */
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps/capture-pwa/src');
// 写本地库的那几个。⚠️ `retry.ts` **不在**里面 —— 它是纯显示格式化（syncLabel），
// 不碰 IndexedDB。把它算进来只会制造误报，而一个天天误报的检查很快就没人看了。
const DATA_PATH = /^(sync|db|companies)\.ts$/;
const ERRISH = /lastError|Error|throw|msg|message|reject/;

const bad = [];
for (const f of globSync('**/*.{ts,tsx}', { cwd: SRC })) {
  if (f.includes('__tests__') || f === 'i18n.ts') continue;
  const src = readFileSync(join(SRC, f), 'utf8');
  let depth = 0;
  src.split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*/, '');
    const at = `${f}:${i + 1}`;
    if (/\bt(?:r)?\(\s*'/.test(code)) {
      if (DATA_PATH.test(f) && !ERRISH.test(code))
        bad.push(`① ${at}  数据路径里出现 t() —— 存进本地库的值不能随语言变\n     ${code.trim().slice(0, 90)}`);
      if (depth === 0)
        bad.push(`③ ${at}  模块级 t() —— 会在模块加载时求值，拿到的是旧语言\n     ${code.trim().slice(0, 90)}`);
    }
    if (/(===|!==)\s*t(?:r)?\(|t(?:r)?\('[^']*'\)\s*(===|!==)/.test(code))
      bad.push(`② ${at}  拿译文做比较 —— 判据不能随语言变\n     ${code.trim().slice(0, 90)}`);
    depth += (code.match(/[{(]/g) ?? []).length - (code.match(/[})]/g) ?? []).length;
  });
}

if (!bad.length) {
  console.log('  ✅ i18n 安全：数据路径无 t() · 无译文比较 · 无模块级 t()');
  process.exit(0);
}
console.error(`\n🔴 换语言会影响的不只是显示 —— ${bad.length} 处：\n`);
for (const b of bad) console.error(`   ${b}`);
console.error('\n   判据：**数据路径存规范形式（中文），只有渲染那一层才翻译。**\n');
process.exit(1);
