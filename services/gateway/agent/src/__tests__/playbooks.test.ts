import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { systemPrompt } from '../prompt.ts';
import { __resetPlaybooks, loadPlaybooks, playbook, playbookIndex, playbookNames } from '../skills.ts';
import { buildSkills, newContext } from '../tools/index.ts';
import { env } from '../host.ts';

/**
 * 标准 SKILL.md 技能库（D72）。
 *
 * 这一组守三件事：
 *   ① 四本手册真的加载得出来（frontmatter 坏一个就少一本，而加载是静默的）；
 *   ② 渐进披露的链路通：索引进 prompt → read_skill 拉得到全文 → 推送塞得进去；
 *   ③ 老 prompt 里那些**用血换来的判据**搬进手册后一条都没丢
 *      （在位品牌只追加 · RUMOR 判据 · milestone 拆解 · docSource 如实填）。
 */

const ctx = (over: Partial<Parameters<typeof newContext>[0]> = {}) =>
  newContext({
    inboxId: '00000000-0000-0000-0000-000000000001',
    stagingId: '00000000-0000-0000-0000-000000000002',
    threadId: null,
    userId: '00000000-0000-0000-0000-000000000003',
    userCode: 'test',
    displayName: '测试',
    companies: [{ id: 'c1', code: 'ALPIN', name: 'Alpin Tannhof AG', group: '', type: '' }],
    suppliers: [{ id: 's1', name: 'Voltaro' }],
    attachments: [],
    maxSteps: 8,
    pushPlaybooks: [],
    resumed: false,
    source: null,
    ...over,
  });

before(async () => {
  __resetPlaybooks();
  await loadPlaybooks();
});

describe('加载', () => {
  it('四本都在 —— 少一本就是某个 frontmatter 坏了（加载是静默的，只有这里能抓住）', () => {
    assert.deepEqual(playbookNames().sort(), ['attachment', 'fitment', 'project', 'support']);
  });

  it('每本都有 description —— 索引里没有描述，模型永远不会翻它', () => {
    for (const name of playbookNames()) {
      assert.ok((playbook(name)?.description.length ?? 0) > 20, `${name} 的 description 太短`);
    }
  });
});

describe('渐进披露的链路', () => {
  it('索引块是 agentskills.io 的 <available_skills> 形状，四本都列上了', () => {
    const idx = playbookIndex();
    assert.match(idx, /<available_skills>/);
    for (const name of ['project', 'support', 'fitment', 'attachment']) {
      assert.ok(idx.includes(`<name>${name}</name>`), `索引里没有 ${name}`);
    }
  });

  it('系统提示词带上了索引 + read_skill 的用法说明', () => {
    const p = systemPrompt(ctx());
    assert.match(p, /<available_skills>/);
    assert.match(p, /read_skill/);
  });

  it('read_skill 拉得到全文；瞎编的名字会被指回正确的清单', async () => {
    const tool = buildSkills(ctx()).find((s) => s.name === 'read_skill')!;
    const good = await tool.execute({ name: 'project' });
    assert.match(good.text, /propose_project/);
    assert.match(good.text, /<skill name="project"/);
    const bad = await tool.execute({ name: 'banana' });
    assert.match(bad.text, /project \/ support \/ fitment \/ attachment|attachment \/ fitment \/ project \/ support/);
  });

  it('推送（pushPlaybooks）把全文塞进系统提示词，省一步往返', () => {
    const p = systemPrompt(ctx({ pushPlaybooks: ['project'] }));
    assert.match(p, /<skill name="project"/);
    assert.match(p, /milestone/);
    // 没推的那本不该整本进来（索引里那一行不算）
    assert.equal(p.includes('<skill name="fitment"'), false);
  });
});

describe('用血换来的判据一条没丢', () => {
  it('project 手册：propose_project 义务 · 编号不自编 · milestone 拆解 · dueDate 必填', () => {
    const t = playbook('project')!.content;
    assert.match(t, /必须调一次 `propose_project`/);
    assert.match(t, /多事项路径用 `propose_records`/);
    assert.match(t, /fields 带完整 project\/workItems\/docs/);
    assert.match(t, /不能再压回一个 `propose_fields`/);
    assert.match(t, /不要自己编一个编号/);
    assert.match(t, /threadType=milestone/);
    assert.match(t, /`dueDate` 必填/);
  });

  it('fitment 手册：在位品牌只追加 · 销售在场就是一手 · 挂在被说的那家', () => {
    const t = playbook('fitment')!.content;
    assert.match(t, /只追加的日志/);
    assert.match(t, /销售在场就是一手/);
    assert.match(t, /被说的那家/);
  });

  it('support 手册：影响台数不猜 · 根因没定论要写未定论', () => {
    const t = playbook('support')!.content;
    assert.match(t, /只有原话明确说了数字才填/);
    assert.match(t, /未定论/);
  });

  it('attachment 手册：宁可长不要漏 · 口述为主 · 不推测图里没写的', () => {
    const t = playbook('attachment')!.content;
    assert.match(t, /宁可长，不要漏/);
    assert.match(t, /销售说的话永远是主/);
    assert.match(t, /不要推测图里没写的/);
  });

  it('多事项prompt要求实际提案，并保住单项项目义务和完整多事项字段', () => {
    const p = systemPrompt(ctx());
    assert.match(p, /必须至少调一次 `propose_fields` 或 `propose_records`/);
    assert.match(p, /project 或 followup 时，这一轮必须再调一次 `propose_project`/);
    assert.match(p, /project\/workItems\/docs 完整写在 propose_records 的 fields/);
    assert.match(p, /propose_records 已经保存多事项后，不再用 propose_fields/);
    assert.match(p, /绝对不要输出任何自然人姓名/);
  });

  it('渠道和停用开关保住单项提案义务，推送/拉取手册不要求未注册的多事项工具', async () => {
    const previous = Object.getOwnPropertyDescriptor(env, 'agentMultiItems')!;
    try {
      for (const source of ['dingtalk', 'pwa']) {
        Object.defineProperty(env, 'agentMultiItems', { ...previous, value: source === 'dingtalk' });
        const current = ctx({ source, pushPlaybooks: ['project', 'support'] });
        const p = systemPrompt(current);
        assert.match(p, /必须至少调一次 `propose_fields`/);
        assert.match(p, /必须再调一次 `propose_project`/);
        assert.doesNotMatch(p, /propose_records/);
        const reader = buildSkills(current).find((skill) => skill.name === 'read_skill')!;
        assert.doesNotMatch((await reader.execute({ name: 'project' })).text, /propose_records/);
      }
    } finally { Object.defineProperty(env, 'agentMultiItems', previous); }
  });
});
