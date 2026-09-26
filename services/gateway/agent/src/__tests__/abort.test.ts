import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

import { runAgent, type ModelBinding, type Skill } from '../runtime.ts';

/**
 * 手动叫停（D89 · issue #22）—— 全部不发网络请求。
 *
 * 维护者：「跑起来的 agent 必须能手动叫停。这是其他 agent / chatbot 的基础配置。」
 *
 * 这一档守的是三件事，每一件都对应 issue 里一条明说的要求：
 *   ① 叫停之后 `stopReason` **如实是 `aborted`** —— 不是 error、不是 timeout。
 *      混起来的话 `agent_run` 那张表就再也回答不了「今天有几条真的出问题了」。
 *   ② **排队期间点的停止也算数**：signal 进来时已经 abort 的，一次模型请求都不发。
 *      少了这一条，前面积压两条时点的停止会静默失效，几秒后它照样开跑、照样烧钱。
 *   ③ **已经跑到的一步都不丢**：trace 里那几步原样在 —— 「停下来之后不能什么都不留」。
 */

const fauxBinding = (steps: Array<any>) => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(steps);
  return {
    binding: { model: faux.getModel(), streamFn: models.streamSimple.bind(models) } as ModelBinding,
    faux,
  };
};

const noopSkill = (name: string, execute: Skill['execute']): Skill => ({
  name,
  label: name,
  description: `测试用工具 ${name}`,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute,
});

describe('手动叫停 agent（D89 · issue #22）', () => {
  it('🔴 排队期间就按了停止 —— 一次模型请求都不发，stopReason = aborted', async () => {
    const { binding, faux } = fauxBinding([fauxAssistantMessage('本来会说的话')]);
    const ctrl = new AbortController();
    ctrl.abort(); // 还没开跑就停了（队列里排着的那种）

    const r = await runAgent({
      systemPrompt: 't',
      prompt: '记一下',
      skills: [],
      binding,
      maxSteps: 4,
      signal: ctrl.signal,
    });

    assert.equal(r.stopReason, 'aborted', `🔴 停止被记成了 ${r.stopReason}`);
    assert.equal(r.steps, 0);
    assert.equal(
      faux.state.callCount,
      0,
      '🔴 点了停止还发了一次模型请求 —— 那就是「点了停止还烧一次钱」',
    );
  });

  it('🔴 跑到一半按停止 —— 已经跑完的那几步原样留在 trace 里', async () => {
    let i = 0;
    const ctrl = new AbortController();
    const { binding } = fauxBinding([
      () => fauxAssistantMessage([fauxToolCall('propose_fields', {}, { id: `c-${i++}` })]),
      // 第一个工具跑完之后人按了停止 —— 后面这一轮不该再发生
      () => fauxAssistantMessage([fauxToolCall('search_companies', {}, { id: `c-${i++}` })]),
      fauxAssistantMessage('还有话说'),
    ]);

    let second = false;
    const r = await runAgent({
      systemPrompt: 't',
      prompt: '记一下',
      skills: [
        // 第一步照常跑完，跑完那一刻人按下停止
        noopSkill('propose_fields', async () => {
          ctrl.abort();
          return { text: '已记下 3 个字段' };
        }),
        noopSkill('search_companies', async () => {
          second = true;
          return { text: '不该跑到这里' };
        }),
      ],
      binding,
      maxSteps: 6,
      signal: ctrl.signal,
    });

    assert.equal(r.stopReason, 'aborted', `🔴 停止被记成了 ${r.stopReason}`);
    assert.equal(second, false, '🔴 停止之后又跑了一个工具');
    const done = r.trace.filter((t) => t.tool === 'propose_fields');
    assert.equal(done.length, 1, '🔴 已经跑完的那一步从 trace 里消失了 —— 工作日志必须保留');
    assert.equal(done[0]!.ok, true);
    assert.match(done[0]!.summary, /已记下/);
  });

  it('🔴 叫停不算故障：不把 Pi 那句 abort 报文写成 error', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { binding } = fauxBinding([fauxAssistantMessage('x')]);
    const r = await runAgent({
      systemPrompt: 't',
      prompt: 'x',
      skills: [],
      binding,
      maxSteps: 2,
      signal: ctrl.signal,
    });
    // error 一旦有值就会流进 staging.error，核对卡上会出现一句像故障的英文 ——
    // 而实际上什么都没坏，是人自己按的停止
    assert.equal(r.error, undefined, `🔴 叫停被当成了故障：${r.error}`);
  });

  it('没给 signal 时行为一个字不变（老路径不受影响）', async () => {
    const { binding } = fauxBinding([fauxAssistantMessage('好了。')]);
    const r = await runAgent({ systemPrompt: 't', prompt: 'x', skills: [], binding, maxSteps: 2 });
    assert.equal(r.stopReason, 'done');
  });
});
