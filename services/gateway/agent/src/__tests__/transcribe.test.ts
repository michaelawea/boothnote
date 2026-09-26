import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  OPTIONAL_PARAMS,
  buildForm,
  narrowsOn,
  sendWithFallback,
  silentWav,
  type OptionalParam,
} from '../transcribe.ts';

/**
 * 转写的 multipart 编码与降级（issue #19 · D85）。
 *
 * 🔴 **为什么这个文件必须存在**：2026-08-07 生产上语音输入 100% 不可用，
 * 根因是 `languages` 用 `JSON.stringify` 发进了 multipart（数组在 multipart 里
 * 只能是重复字段）。而**设计好的降级探测按关键词认报文，认不出真实的 400，
 * 于是一次都没触发** —— 那套探测在仓库里躺了两天，从来没有被执行过。
 *
 * 这里测的正是那两件：**编码是不是重复字段**，**被拒之后退不退、退得对不对**。
 * 都是纯逻辑，不发一个字节的网络请求。
 */

const TERMS = ['CI-Bus', 'VLB12150-CIBUS', 'Rosenfeld'];
const AUDIO = Buffer.from([1, 2, 3, 4]);
const all = () => new Set<OptionalParam>(OPTIONAL_PARAMS);

describe('multipart 编码：数组只能是重复字段', () => {
  it('languages 是 5 个独立字段，不是一串 JSON', () => {
    const f = buildForm(AUDIO, 'audio/webm', 'a.webm', TERMS, all());
    const langs = f.getAll('languages');
    assert.deepEqual(langs, ['en', 'de', 'it', 'fr', 'zh']);
    // 🔴 这一条就是生产上那个 bug 本身：出现 `[` 说明又是 JSON.stringify 发出去的
    for (const l of langs) assert.ok(!String(l).includes('['), `languages 又被 JSON 化了：${l}`);
  });

  it('keywords 同样是重复字段，一个词一个字段', () => {
    const f = buildForm(AUDIO, 'audio/webm', 'a.webm', TERMS, all());
    assert.deepEqual(f.getAll('keywords'), TERMS);
  });

  it('最小参数集：file / model / prompt 三样在，可选参数一个都没有', () => {
    const f = buildForm(AUDIO, 'audio/webm', 'a.webm', TERMS, new Set());
    assert.ok(f.get('file'));
    assert.ok(f.get('model'));
    assert.ok(String(f.get('prompt')).includes('CI-Bus'), 'prompt 里要带词表');
    assert.equal(f.getAll('keywords').length, 0);
    assert.equal(f.getAll('languages').length, 0);
  });

  it('只关掉 languages 时，keywords 还在 —— 降级是逐个退不是一刀切', () => {
    const f = buildForm(AUDIO, 'audio/webm', 'a.webm', TERMS, new Set<OptionalParam>(['keywords']));
    assert.equal(f.getAll('keywords').length, TERMS.length);
    assert.equal(f.getAll('languages').length, 0);
  });
});

describe('退不退：只看状态码，不认报文', () => {
  it('4xx 里「我们发的内容对面不认」那些要退', () => {
    for (const s of [400, 404, 415, 422]) assert.equal(narrowsOn(s), true, `${s} 应该退`);
  });

  it('401 / 403 / 429 不退 —— 少发个参数帮不上忙，限流时还帮倒忙', () => {
    for (const s of [401, 403, 429]) assert.equal(narrowsOn(s), false, `${s} 不该退`);
  });

  it('2xx / 5xx 不退：5xx 是对面的事，交给 loop.ts 的 transient 预算', () => {
    for (const s of [200, 500, 502, 503]) assert.equal(narrowsOn(s), false, `${s} 不该退`);
  });

  /**
   * 🔴 这一条是**回归锁**。真实的 400 报文长这样：
   *   {"error":{"message":"Invalid request.","code":"invalid_value","param":null}}
   * 里面**没有任何一个参数名**。老判据按 `keywords|languages|unknown parameter`
   * 去认它，于是永远返回 false，降级一次都不触发。
   */
  it('真实的 400 报文里一个参数名都没有，照样要退', () => {
    const body = '{"error":{"message":"Invalid request.","type":"invalid_request_error","param":null,"code":"invalid_value"}}';
    assert.equal(/keywords|languages|unknown[_ ]parameter/i.test(body), false, '报文确实什么都没说');
    assert.equal(narrowsOn(400), true, '而我们照样退 —— 退不退是我们说了算的');
  });
});

describe('被拒之后怎么退', () => {
  const okRes = { ok: true, status: 200, text: '{"text":"hi"}' };
  const badRes = { ok: false, status: 400, text: '{"error":{"message":"Invalid request."}}' };

  it('一次就成：不丢任何参数，两个都记成「收下了」', async () => {
    const seen: Array<OptionalParam[]> = [];
    const state = { keywords: null, languages: null } as Record<OptionalParam, boolean | null>;
    const r = await sendWithFallback(async (e) => (seen.push([...e]), okRes), state);
    assert.equal(r.ok, true);
    assert.deepEqual(r.dropped, []);
    assert.equal(seen.length, 1, '只该发一次');
    assert.deepEqual(state, { keywords: true, languages: true });
  });

  /** 生产上那个 bug 的形状：languages 是坏的，keywords 是好的。 */
  it('languages 被拒 → 只丢它，keywords 一次都不被牵连', async () => {
    const seen: Array<OptionalParam[]> = [];
    const state = { keywords: null, languages: null } as Record<OptionalParam, boolean | null>;
    const r = await sendWithFallback(async (e) => {
      seen.push([...e]);
      return e.has('languages') ? badRes : okRes;
    }, state);
    assert.equal(r.ok, true);
    assert.deepEqual(r.dropped, ['languages']);
    assert.deepEqual(seen, [['languages', 'keywords'], ['keywords']]);
    assert.equal(state.languages, false, 'languages 记成不接受');
    assert.equal(state.keywords, true, '🔴 keywords 必须留着 —— 它是好的');
  });

  it('记住之后，下一条录音一次就过（不再撞那个 400）', async () => {
    const state = { keywords: true, languages: false } as Record<OptionalParam, boolean | null>;
    const seen: Array<OptionalParam[]> = [];
    await sendWithFallback(async (e) => (seen.push([...e]), okRes), state);
    assert.deepEqual(seen, [['keywords']], '被拒过的不再带上去');
  });

  it('退到最小参数集才成功：丢掉的都记下来，且不会无限退', async () => {
    const seen: Array<OptionalParam[]> = [];
    const state = { keywords: null, languages: null } as Record<OptionalParam, boolean | null>;
    const r = await sendWithFallback(async (e) => {
      seen.push([...e]);
      return e.size ? badRes : okRes;
    }, state);
    assert.equal(r.ok, true);
    assert.deepEqual(r.dropped, ['languages', 'keywords']);
    assert.equal(seen.length, 3, '两个可选参数 → 最多三次');
  });

  /**
   * 🔴 全都试完还是失败 = 多半是音频本身有问题（或者 key 过期）。
   * 这时候**绝不能**把参数记成「不接受」—— 那是拿一次故障换一整场展会的识别质量。
   */
  it('全试完仍失败：状态一个字不动', async () => {
    const state = { keywords: null, languages: null } as Record<OptionalParam, boolean | null>;
    const r = await sendWithFallback(async () => badRes, state);
    assert.equal(r.ok, false);
    assert.deepEqual(state, { keywords: null, languages: null });
  });

  it('429 只发一次 —— 限流时多打两次请求是帮倒忙', async () => {
    let n = 0;
    const state = { keywords: null, languages: null } as Record<OptionalParam, boolean | null>;
    await sendWithFallback(async () => {
      n++;
      return { ok: false, status: 429, text: 'rate limited' };
    }, state);
    assert.equal(n, 1);
  });

  it('401 也只发一次 —— 少发个参数换不来一把新钥匙', async () => {
    let n = 0;
    const state = { keywords: null, languages: null } as Record<OptionalParam, boolean | null>;
    await sendWithFallback(async () => {
      n++;
      return { ok: false, status: 401, text: 'bad key' };
    }, state);
    assert.equal(n, 1);
  });
});

describe('自检用的那段静音', () => {
  it('是一个结构正确的 WAV，而且足够小', () => {
    const w = silentWav();
    assert.equal(w.subarray(0, 4).toString(), 'RIFF');
    assert.equal(w.subarray(8, 12).toString(), 'WAVE');
    assert.equal(w.readUInt32LE(4), w.length - 8, 'RIFF 长度字段要对得上');
    assert.equal(w.readUInt32LE(40), w.length - 44, 'data 长度字段要对得上');
    assert.ok(w.length < 8192, `自检音频不该大：${w.length}B`);
  });

  /** 在代码里现算，不放文件 —— `data/` 在 .dockerignore 里，文件可能根本没进镜像。 */
  it('不依赖任何文件', () => {
    assert.equal(silentWav(0.1).length, 44 + 800 * 2);
  });
});
