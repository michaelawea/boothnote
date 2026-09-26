import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 启动序列里那几条**「顺序错了不报错，只是行为不对」**的（T99）。
 *
 * 🔴 为什么是扫源码而不是跑起来测：`reapStaleRuns()` 的正确性建立在
 * 「调用时这个进程一轮 agent 都还没建过」上，而这件事**只有启动那一刻成立**。
 * 集成测试连的是一个**已经起来的**网关，它没法回到那一刻 ——
 * 于是「函数写对了」和「它真的接在了启动序列上」之间就隔着一个没人看的缝。
 * 这个仓库已经在同样的缝里掉过两次东西（i18n 守卫空转三天、`window.test.ts`
 * 躺了两天没被执行过），判据是 **「写了」≠「接上了」**。
 *
 * ⚠️ 真要重构启动序列（比如收进一个 `bootstrap()`）的话，这条会红 ——
 *    那是对的：它红的时候请去确认收尸仍然排在 `resumePending()` 前面，然后改这里。
 */
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'index.ts'), 'utf8');
const loopSrc = readFileSync(join(here, '..', '..', 'agent', 'src', 'loop.ts'), 'utf8');

describe('启动序列（T99）', () => {
  it('🔴 收尸真的接在启动序列上 —— 不然那个函数只是写着好看', () => {
    assert.match(
      src,
      /await reapStaleRuns\(\)/,
      '🔴 index.ts 里没有 await reapStaleRuns() —— 上个进程被杀留下的 running 没人收，' +
        '那几条对话会永远显示「正在思考…」',
    );
  });

  it('🔴 收尸排在 resumePending() 前面 —— 反过来会把刚排上队的那一轮当尸体收掉', () => {
    const reap = src.indexOf('await reapStaleRuns()');
    const resume = src.indexOf('await resumePending()');
    // 🔴 两个都要先确认存在：`indexOf` 找不到给的是 -1，而 -1 比什么都小 ——
    //    整个调用被删掉时这一条会「顺利通过」，那是个恒真命题，不是通过
    assert.ok(reap > 0, '🔴 找不到 await reapStaleRuns()');
    assert.ok(resume > 0, '🔴 找不到 await resumePending()');
    assert.ok(
      reap < resume,
      '🔴 顺序反了：resumePending() 会立刻建出新的 agent_run，' +
        '排在它后面收尸就是把活着的那一轮当尸体收掉（loop.ts 里的 runsCreated 会拒跑并喊一声，' +
        '但那时人已经在查为什么动画一闪就没了）',
    );
  });

  it('收尸排在 app.listen() 前面 —— 端口一开就可能有新的一轮进来', () => {
    const reap = src.indexOf('await reapStaleRuns()');
    const listen = src.indexOf('await app.listen(');
    assert.ok(reap > 0, '🔴 找不到 await reapStaleRuns()'); // 同上：-1 会让这条恒真
    assert.ok(listen > 0, '🔴 找不到 await app.listen(');
    assert.ok(reap < listen, '🔴 顺序反了：监听已经开了，新来的那一轮可能被当成尸体');
  });
});

/**
 * 收尸的**前提判据**本身（T99）。
 *
 * `reapStaleRuns()` 敢把库里所有 `running` 一刀切掉，全靠 `runsCreated === 0`
 * 这一个条件 —— 而那个计数器只在 `process_()` 建 `agent_run` 的那一行 +1。
 * 🔴 **那一行被删掉的话，守卫会变成一个永远为真的摆设，而且一声不吭**：
 * 集成测试那条用例是 `__setRunsCreated(1)` 假造出来的，它照样绿。
 * （2026-09-01 变异测试实测漏网，这一条就是补上的那道。）
 */
describe('收尸的前提判据（T99）', () => {
  it('🔴 建 agent_run 的地方真的在给 runsCreated 计数（注释掉也算没有）', () => {
    assert.match(
      loopSrc,
      /^\s*runsCreated\+\+;/m,
      '🔴 loop.ts 里没有一行实打实的 runsCreated++ —— reapStaleRuns() 的位置守卫会永远放行',
    );
  });

  it('计数排在 insert into agent_run 之后 —— 它数的是「建过几轮」', () => {
    const insert = loopSrc.indexOf('insert into agent_run');
    const bump = loopSrc.search(/^\s*runsCreated\+\+;/m);
    assert.ok(insert > 0 && bump > 0, '🔴 两处至少有一处找不到了');
    assert.ok(bump > insert, '🔴 计数跑到 insert 前面去了');
  });
});
