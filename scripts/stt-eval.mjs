#!/usr/bin/env node
/**
 * 转写效果打分。
 *
 *   node scripts/stt-eval.mjs                # 跑 docs/test_example/audio 下全部
 *   node scripts/stt-eval.mjs T07            # 只跑名字里带 T07 的
 *   node scripts/stt-eval.mjs --compare      # 带词表 vs 不带词表，两种配置并排跑
 *
 * ── 为什么要有这个脚本（issue #15）────────────────────────────────
 *
 * 转写改动是**最容易自我欺骗**的一类：加几个词进 prompt，新词对了，
 * 于是你以为改好了 —— 而原来对的那些可能已经被带坏。
 *
 * 规划文档 §2 那条实测：品牌名 prompt 偏置在 12/20/30/56 个品牌下**非单调**。
 * 「加词表」不是单向变好的操作，它是在一条噪声曲线上移动位置。
 * **没有基准音频，就没有办法知道自己往哪边移动了。**
 *
 * 🔴 它会真的调转写接口 —— **要花钱**（一段 60 秒的音频很便宜）。
 * 🔴 它只读 `.env` 里的 key，**绝不回显**（和 check-models.mjs 同一条规矩）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIO_DIR = join(ROOT, 'docs', 'test_example', 'audio');

// ── 配置。只用来发请求，一个字都不打印 ────────────────────────────
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
const KEY = process.env.OPENAI_API_KEY || envFile.OPENAI_API_KEY;
const BASE = (process.env.OPENAI_BASE_URL || envFile.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || envFile.OPENAI_TRANSCRIBE_MODEL || 'gpt-transcribe';

if (!KEY) {
  console.error('✗ 没找到 OPENAI_API_KEY（环境变量或 .env 里都没有）');
  process.exit(1);
}

// ── 词表。和 transcribe.ts 读的是**同一份文件** ──────────────────────
// 两份词表迟早会分叉，而分叉的表现是「脚本说好了，线上还是听错」。
const terms = (() => {
  try {
    const raw = JSON.parse(readFileSync(join(ROOT, 'data', 'stt-terms.json'), 'utf8'));
    return Object.entries(raw)
      .filter(([k, v]) => !k.startsWith('_') && Array.isArray(v))
      .flatMap(([, v]) => v)
      .map((s) => String(s).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
})();

/**
 * 归一化后再比。
 *
 * `CI-Bus` / `CI Bus` / `cibus` 都算听对了 —— 下游的抽取那一步本来就会归一化，
 * 我们要的是「它听出了这个东西」，不是「一个字符不差」。
 */
const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s\-_.]/g, '');
const hit = (haystack, needle) => norm(haystack).includes(norm(needle));

const MIME = { '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.mp4': 'audio/mp4' };

const transcribe = async (buf, filename, withTerms) => {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: MIME[extname(filename).toLowerCase()] ?? 'audio/mpeg' }), filename);
  form.append('model', MODEL);
  form.append(
    'prompt',
    withTerms
      ? 'This is a technical field note about European motorhomes, caravans, batteries, ' +
        'inverters, solar systems and RV communication protocols. ' +
        'Brand, product and protocol names must retain their official spelling. ' +
        `Expected terms: ${terms.slice(0, 40).join(', ')}.`
      : '',
  );
  if (withTerms) {
    // 这两个参数网关那边是「试一次，被拒就退回」。这里同样：先带上，400 了就重来一次
    form.append('keywords', JSON.stringify(terms.slice(0, 40)));
    form.append('languages', JSON.stringify(['en', 'de', 'it', 'fr', 'zh']));
  }

  let res = await fetch(`${BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}` },
    body: form,
  });
  let text = await res.text();

  if (!res.ok && withTerms && /keywords|languages|unknown|unrecognized|not supported/i.test(text)) {
    console.log('    · 接口不认 keywords/languages，退回只用 prompt 再试一次');
    const f2 = new FormData();
    f2.append('file', new Blob([buf], { type: MIME[extname(filename).toLowerCase()] ?? 'audio/mpeg' }), filename);
    f2.append('model', MODEL);
    f2.append(
      'prompt',
      'This is a technical field note about European motorhomes, caravans, batteries, ' +
        `inverters and RV communication protocols. Expected terms: ${terms.slice(0, 40).join(', ')}.`,
    );
    res = await fetch(`${BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}` },
      body: f2,
    });
    text = await res.text();
  }
  if (!res.ok) throw new Error(`转写失败 ${res.status}: ${text.slice(0, 200)}`);
  return (JSON.parse(text).text ?? '').trim();
};

const score = (text, expect) => {
  const must = (expect.must ?? []).map((w) => ({ w, ok: hit(text, w) }));
  const nice = (expect.nice ?? []).map((w) => ({ w, ok: hit(text, w) }));
  const bad = (expect.mustNot ?? []).filter((w) => hit(text, w));
  return {
    must,
    nice,
    bad,
    pass: must.every((m) => m.ok) && bad.length === 0,
  };
};

const show = (label, text, s) => {
  console.log(`\n  ── ${label} ────────────────────────────`);
  console.log(`  ${text.slice(0, 220)}${text.length > 220 ? '…' : ''}`);
  console.log(
    `\n  必须听对：${s.must.map((m) => `${m.ok ? '✓' : '✗'}${m.w}`).join('  ')}`,
  );
  if (s.nice.length) {
    console.log(`  最好听对：${s.nice.map((m) => `${m.ok ? '✓' : '·'}${m.w}`).join('  ')}`);
  }
  if (s.bad.length) console.log(`  🔴 出现了已知的错法：${s.bad.join('、')}`);
  console.log(`  → ${s.pass ? '✅ 通过' : '❌ 不通过'}`);
};

// ── 主流程 ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const compare = args.includes('--compare');
const filter = args.find((a) => !a.startsWith('--'));

if (!existsSync(AUDIO_DIR)) {
  console.error(`✗ 没有 ${AUDIO_DIR}`);
  process.exit(1);
}

const expects = readdirSync(AUDIO_DIR)
  .filter((f) => f.endsWith('.expect.json'))
  .filter((f) => !filter || f.includes(filter));

if (!expects.length) {
  console.error(`✗ ${AUDIO_DIR} 下没有${filter ? `匹配「${filter}」的` : ''} .expect.json`);
  process.exit(1);
}

console.log(`\n转写评测 · 模型 ${MODEL} · 词表 ${terms.length} 个词\n`);

let failed = 0;
let skipped = 0;

for (const ef of expects) {
  const stem = basename(ef, '.expect.json');
  const audio = readdirSync(AUDIO_DIR).find(
    (f) => basename(f, extname(f)) === stem && f !== ef && !f.endsWith('.json') && !f.endsWith('.md'),
  );
  console.log(`\n▌ ${stem}`);

  if (!audio) {
    /**
     * 🔴 **没有音频不是「通过」，是「没测」。**
     * 这两个混在一起，就会出现「评测全绿但一条都没跑」——
     * 这个仓库栽过三次的那个形状（D65 / issue #2 / issue #5）。
     */
    console.log(`  ⏭  没找到对应的音频文件（放一个 ${stem}.m4a 进来）—— **没测，不是通过**`);
    skipped++;
    continue;
    }

  const expect = JSON.parse(readFileSync(join(AUDIO_DIR, ef), 'utf8'));
  const buf = readFileSync(join(AUDIO_DIR, audio));

  try {
    const withTerms = await transcribe(buf, audio, true);
    const s1 = score(withTerms, expect);
    show('带词表（线上就是这个配置）', withTerms, s1);
    if (!s1.pass) failed++;

    if (compare) {
      const bare = await transcribe(buf, audio, false);
      const s0 = score(bare, expect);
      show('不带词表（对照组）', bare, s0);
      const gained = s1.must.filter((m) => m.ok).length - s0.must.filter((m) => m.ok).length;
      console.log(
        `\n  词表的净效果：必听词 ${gained >= 0 ? '+' : ''}${gained}` +
          `，已知错法 ${s0.bad.length} → ${s1.bad.length}`,
      );
    }
  } catch (e) {
    console.log(`  ✗ ${e.message}`);
    failed++;
  }
}

console.log(
  `\n${'─'.repeat(50)}\n` +
    `${expects.length - skipped - failed} 通过 · ${failed} 不通过 · ${skipped} 没测（缺音频）\n`,
);
if (skipped) {
  console.log(
    `🟠 有 ${skipped} 条没有音频文件。**「没测」不等于「通过」** ——\n` +
      `   录音怎么录见 docs/test_example/audio/README.md（要用真手机、真 https 页面）。\n`,
  );
}
process.exit(failed ? 1 : 0);
