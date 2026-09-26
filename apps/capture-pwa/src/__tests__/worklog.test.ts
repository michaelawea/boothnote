import { describe, expect, it } from 'vitest';

import { agentIsRunning, workLogTitle } from '../components/WorkLog';

/**
 * 工作日志那一行写什么（D88 · issue #24）。
 *
 * 维护者 点名的形态就是这一行字：
 *
 *     思考了 25s   ›
 *
 * 而改之前它是 `AI 工作日志 · 6 次调用 · 12.3s` —— 「N 次调用」是实现细节，
 * 人关心的是它想了多久。这一档守的就是那句话本身：它藏在 JSX 里的话
 * 只能靠眼睛看，而「打开页面是不是对的」恰恰是这个仓库里测试最抓不到的一类。
 *
 * ⚠️ 断言用中文 —— `t()` 在中文下是恒等函数（i18n.ts），
 *    测试跑在没有登录态的环境里，`locale()` 退回 'zh'。
 */
describe('工作日志标题（D88 · issue #24）', () => {
  it('跑完 → 「思考了 X」，秒数一位小数', () => {
    expect(workLogTitle({ durationMs: 25_400 })).toBe('思考了 25.4s');
    expect(workLogTitle({ durationMs: 12_300, stopReason: 'done' })).toBe('思考了 12.3s');
  });

  it('一秒以内用毫秒 —— 「思考了 0.0s」是句废话', () => {
    expect(workLogTitle({ durationMs: 840 })).toBe('思考了 840ms');
  });

  it('正在跑 → 「正在思考…」，不显示时长', () => {
    expect(workLogTitle({ live: true, durationMs: 9_000 })).toBe('正在思考…');
  });

  it('🔴 正常收工不啰嗦：stopReason=done 不往标题上加东西', () => {
    expect(workLogTitle({ durationMs: 3_000, stopReason: 'done' })).toBe('思考了 3.0s');
  });

  it('🔴 非正常收工要说出来 —— 「等你回答」和「干完了」必须分得开', () => {
    expect(workLogTitle({ durationMs: 3_000, stopReason: 'waiting_user' })).toBe(
      '思考了 3.0s · 等你回答',
    );
    // D89：人自己按的停止，标题上和「出错了」分开
    expect(workLogTitle({ durationMs: 3_000, stopReason: 'aborted' })).toBe('思考了 3.0s · 你叫停了');
    expect(workLogTitle({ durationMs: 3_000, stopReason: 'error' })).toBe('思考了 3.0s · 出错了');
  });

  it('认不出来的停止原因原样显示，不吞掉', () => {
    expect(workLogTitle({ durationMs: 1_000, stopReason: 'weird_new_reason' })).toBe(
      '思考了 1.0s · weird_new_reason',
    );
  });

  it('没有时长（老数据）→ 退回「思考过程」，不显示 NaN 也不显示空标题', () => {
    expect(workLogTitle({})).toBe('思考过程');
    expect(workLogTitle({ durationMs: null })).toBe('思考过程');
  });
});

/**
 * 显不显示那一行（issue #50，维护者 2026-09-01 展会现场报：第一轮没有，第二轮才有）。
 *
 * 这一档守的是**判据问的是谁**：「它在跑吗」是服务端的事实，
 * 不是这个标签页记不记得自己按过发送。三条会走成「第一轮没动画」的路
 * 在下面逐条钉死 —— 它们的共同点是 `waiting` 为 false 而服务端明明在跑。
 */
describe('思考动画显不显示（issue #50）', () => {
  const RUN = { stage: '查客户', steps: 2, max_steps: 8, trace: null };

  it('我刚按下发送、服务端还没把 run 建出来 —— 那 1~2 秒也要有动画', () => {
    // 🔴 这一条就是「并集不是替换」：换成纯服务端判据，现场按下发送先看到的是一片空白
    expect(agentIsRunning({ waiting: true, running: null })).toBe(true);
  });

  it('🔴 速记 → 发给 AI 打开的那一轮：不是 send() 发起的，服务端说在跑就得有动画', () => {
    expect(agentIsRunning({ waiting: false, running: RUN })).toBe(true);
  });

  it('🔴 从看板/历史点进一条正在跑的对话（pickThread 刚 setWaiting(false)）', () => {
    expect(agentIsRunning({ waiting: false, running: RUN })).toBe(true);
  });

  it('两边都说在跑 —— 不重复、不打架', () => {
    expect(agentIsRunning({ waiting: true, running: RUN })).toBe(true);
  });

  it('都没在跑 → 不显示（跑完那一行由 workLogTitle 接手，不是这里）', () => {
    expect(agentIsRunning({ waiting: false, running: null })).toBe(false);
  });

  it('running 是 undefined（老服务端不给这一格）也算没在跑，不是「在跑」', () => {
    // `!= null` 而不是 `!== null` —— undefined 要一起挡掉，否则老服务端上永远转圈
    expect(agentIsRunning({ waiting: false, running: undefined })).toBe(false);
  });
});
