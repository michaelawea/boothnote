import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createModels } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';

import {
  appendThreadHistory,
  loadThreadHistory,
  runAgent,
  type ModelBinding,
  type Skill,
} from '../runtime.ts';

/**
 * D73 的三件事，全部不发网络请求：
 *   ① 出口契约：跑完欠着产出 → 点名追问一轮（而不是直接伪造兜底）；
 *   ② ask_user 的 terminate：问出问题就收工，不再空转烧钱；
 *   ③ 消息史落盘 / 恢复：JSONL 写得进、读得回、图片不进盘。
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

const noopSkill = (name: string, out = 'ok', extra: Partial<Skill> = {}): Skill => ({
  name,
  label: name,
  description: `测试用工具 ${name}，回一个字符串`,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute: async () => ({ text: out }),
  ...extra,
});

describe('出口契约（D73③）', () => {
  it('第一遍没交货 → 追问一轮，模型第二遍补交，trace 里有 follow_up', async () => {
    let proposed = false;
    const propose: Skill = {
      ...noopSkill('propose_fields'),
      execute: async () => {
        proposed = true;
        return { text: '已记下' };
      },
    };
    let i = 0;
    const { binding } = fauxBinding([
      fauxAssistantMessage('这条我不太确定，先不提交了。'), // 第一遍：光说不做
      () => fauxAssistantMessage([fauxToolCall('propose_fields', {}, { id: `c-${i++}` })]),
      fauxAssistantMessage('补交完成。'),
    ]);

    const r = await runAgent({
      systemPrompt: 't',
      prompt: '记一下',
      skills: [propose],
      binding,
      maxSteps: 4,
      exitCheck: () => (proposed ? null : '你还没调 propose_fields，现在就交。'),
    });

    assert.equal(proposed, true, '追问之后必须真的补交了');
    assert.equal(r.stopReason, 'done');
    assert.ok(
      r.trace.some((t) => t.tool === 'follow_up'),
      'trace 里要能看出发生过追问 —— 不然排查时以为它一遍就交了',
    );
    assert.ok(r.trace.some((t) => t.tool === 'propose_fields'));
  });

  it('第一遍就交了货 → 不追问（exitCheck 返回 null，不多花一分钱）', async () => {
    let checks = 0;
    const { binding } = fauxBinding([fauxAssistantMessage('搞定。')]);
    const r = await runAgent({
      systemPrompt: 't',
      prompt: 'x',
      skills: [],
      binding,
      maxSteps: 4,
      exitCheck: () => {
        checks++;
        return null;
      },
    });
    assert.equal(checks, 1);
    assert.equal(r.stopReason, 'done');
    assert.equal(r.trace.some((t) => t.tool === 'follow_up'), false);
  });

  it('追问那一小轮有自己的步数余量（cap +2），不会立刻撞 max_steps', async () => {
    let i = 0;
    // maxSteps=1：第一轮就到顶的话，追问必须还能跑
    const { binding } = fauxBinding([
      fauxAssistantMessage('先这样。'),
      () => fauxAssistantMessage([fauxToolCall('ping', {}, { id: `p-${i++}` })]),
      fauxAssistantMessage('好了。'),
    ]);
    let pinged = false;
    const r = await runAgent({
      systemPrompt: 't',
      prompt: 'x',
      skills: [
        { ...noopSkill('ping'), execute: async () => ((pinged = true), { text: 'pong' }) },
      ],
      binding,
      maxSteps: 1,
      exitCheck: () => (pinged ? null : '去调一次 ping。'),
    });
    assert.equal(pinged, true, `追问轮没跑起来（stop=${r.stopReason}）`);
  });
});

describe('ask_user 收工（D73②）', () => {
  it('工具返回 terminate → 这一轮到此为止，后面的模型轮次不再发生', async () => {
    let i = 0;
    const { binding, faux } = fauxBinding([
      () => fauxAssistantMessage([fauxToolCall('ask_user', {}, { id: `a-${i++}` })]),
      // 如果 terminate 没生效，Pi 会再要一条 —— faux 没有下一条就会报错，
      // 所以这里故意**只给一条**：跑通本身就是断言的一半
    ]);
    const asker: Skill = {
      ...noopSkill('ask_user'),
      execute: async () => ({ text: '问题已发给销售，这一轮先收在这里。', terminate: true }),
    };
    const r = await runAgent({
      systemPrompt: 't',
      prompt: 'x',
      skills: [asker],
      binding,
      maxSteps: 6,
    });
    assert.equal(r.trace.length, 1);
    assert.equal(r.trace[0]!.tool, 'ask_user');
    assert.notEqual(r.stopReason, 'error', `不该是 error：${r.error}`);
    void faux;
  });
});

describe('消息史落盘 / 恢复（D73①）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'boothnote-sess-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('一轮跑完 → 追加落盘 → 读回来的消息史让下一轮从中续跑', async () => {
    const t1 = fauxBinding([fauxAssistantMessage('第一轮记下了 Alpin 的事。')]);
    const r1 = await runAgent({
      systemPrompt: 't',
      prompt: 'Alpin 年产 12000 台',
      skills: [],
      binding: t1.binding,
      maxSteps: 4,
    });
    assert.ok(r1.messages.length >= 2, 'user + assistant 至少两条');

    await appendThreadHistory(tmp, 'thread-1', 0, r1.messages);
    assert.ok(existsSync(join(tmp, 'thread-1.jsonl')), 'JSONL 要真的落在盘上');

    const restored = await loadThreadHistory(tmp, 'thread-1');
    assert.equal(restored.length, r1.messages.length);

    // 第二轮带着历史续跑：最终消息史 = 恢复的 + 新增的
    const t2 = fauxBinding([fauxAssistantMessage('第二轮改成紧急。')]);
    const r2 = await runAgent({
      systemPrompt: 't',
      prompt: '把优先级改成紧急',
      skills: [],
      binding: t2.binding,
      maxSteps: 4,
      history: restored,
    });
    assert.ok(r2.messages.length > restored.length, '新增的消息要接在历史后面');

    // 只追加新增部分 —— 不会把历史重写一遍
    await appendThreadHistory(tmp, 'thread-1', restored.length, r2.messages);
    const again = await loadThreadHistory(tmp, 'thread-1');
    assert.equal(again.length, r2.messages.length, '两轮之后读回来的长度 = 最终消息史长度');
  });

  it('图片不进盘 —— 落进 JSONL 前被换成一句占位文本', async () => {
    const withImage = [
      { role: 'user', content: [{ type: 'text', text: '看看这张' }], timestamp: 1 },
      {
        role: 'toolResult',
        toolCallId: 'x',
        toolName: 'read_attachment',
        content: [{ type: 'image', data: 'QUJD'.repeat(1000), mimeType: 'image/jpeg' }],
        isError: false,
        timestamp: 2,
      },
    ];
    await appendThreadHistory(tmp, 'thread-img', 0, withImage);
    const restored = (await loadThreadHistory(tmp, 'thread-img')) as any[];
    const tool = restored.find((m) => m.role === 'toolResult');
    assert.ok(tool, '工具结果那条要在');
    assert.equal(tool.content[0].type, 'text', '图片必须被换成文本占位');
    assert.match(tool.content[0].text, /read_attachment/);
  });

  it('没有历史文件 → 空数组，不炸（续跑降级成全新一轮）', async () => {
    assert.deepEqual(await loadThreadHistory(tmp, 'no-such-thread'), []);
  });
});
