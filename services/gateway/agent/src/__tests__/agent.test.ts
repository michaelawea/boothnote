import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createModels } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';

import {
  ACCOUNT_TYPES,
  CATEGORIES,
  RECORD_TYPES_V2,
  RECORD_TYPE_LABELS,
  STAGES,
  chainRank,
  isValidChain,
  keepCategory,
  keepStage,
} from '../enums.ts';
import { sanitizeFieldEdits } from '../../../src/confirm.ts';
import { runAgent, type ModelBinding, type Skill } from '../runtime.ts';
import { FORBIDDEN_TOOL_NAMES, TOOL_NAMES, buildSkills, newContext } from '../tools/index.ts';

/**
 * agent 的单元测试。**一行网络请求都不发** —— 模型换成 pi-ai 自带的 fauxProvider。
 *
 * 这里有六个必须有的测试里的第 ② 条（工具清单快照）。
 * 那一条是 Ring 3 唯一的执行机制：Ring 3 的工具不是「禁止调用」，
 * 是压根没注册；而「压根没注册」这件事只有这个测试在守。
 */

const ctx = () =>
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
  });

// ── ② 工具清单快照 ─────────────────────────────────────────────────
describe('工具清单 —— 能力边界的唯一执行机制', () => {
  it('注册的工具恰好是清单上那些，一个不多一个不少', () => {
    const names = buildSkills(ctx()).map((s) => s.name).sort();
    assert.deepEqual(names, [...TOOL_NAMES].sort());
    // 数量写死。加工具本身没问题，但**必须是有意识地加** ——
    // 改这个数字的那一刻，就得回头看一眼 docs/agent.md 里的圈层图还对不对。
    // 2026-08-05：14 → 15，加了 read_skill（D72，Ring 1 只读手册）。docs/agent.md 已同步。
    assert.equal(names.length, 15, `工具数量变了（${names.length}）—— 顺手更新 docs/agent.md`);
  });

  it('Ring 3 的工具一个都没注册', () => {
    const names = new Set(buildSkills(ctx()).map((s) => s.name));
    for (const forbidden of FORBIDDEN_TOOL_NAMES) {
      assert.equal(names.has(forbidden), false, `🔴 ${forbidden} 被注册了 —— Ring 3 破了`);
    }
  });

  it('每个工具都有 description 和 parameters —— 没有描述的工具模型不会用', () => {
    for (const s of buildSkills(ctx())) {
      assert.ok(s.description.length > 10, `${s.name} 的 description 太短`);
      assert.ok(s.parameters, `${s.name} 缺 parameters`);
    }
  });

  it('工具名没有重名', () => {
    const names = buildSkills(ctx()).map((s) => s.name);
    assert.equal(new Set(names).size, names.length);
  });

  /**
   * 🔴🔴 **枚举对账：`list_enums` 说得出来的，必须等于系统真正认的那一套。**
   *
   * 这一条是 issue #17 根因 A 的执行机制。2026-08-05 生产实测：
   * `list_enums` 用的是 `RECORD_TYPES`（V1，两个值），而给人用的 `/enums`
   * 端点用的是 `RECORD_TYPES_V2`（四个值）—— 于是界面上选得到「项目」，
   * **agent 手上根本没有这个值**，`keepRecordTypeV2` 还会把它认不出的静默还成
   * `fitment`。维护者 反复强调「这是个项目」也没用：它没地方表达。
   *
   * 这是 D65/D66「写了 ≠ 读得到」的第三次复发。**这种事只有机械对账挡得住** ——
   * 和 `preflight.sh` 拿 env.ts 读的键去和 compose 传的键对账是同一招。
   */
  it('🔴 list_enums 的输出覆盖每一个合法 recordType（写了 ≠ 读得到）', async () => {
    const tool = buildSkills(ctx()).find((s) => s.name === 'list_enums')!;
    const { text } = await tool.execute({});
    for (const v of RECORD_TYPES_V2) {
      // 用「· v = 标签」这个严格形状，不要用 includes(v) ——
      // 「project」这个词在别处也可能出现，那样断言会假绿
      assert.ok(
        text.includes(`· ${v} = `),
        `🔴 list_enums 里没有 "${v}" —— agent 看不到这个值，就永远不会用它。` +
          `（issue #17：project 缺席时，「帮我建个项目」必然被记成选型情报）`,
      );
    }
    // 反向：它也不能说出系统不认的值 —— 那会让模型交上来的东西被静默丢弃
    for (const v of ['opportunity', 'lead', 'task']) {
      assert.equal(text.includes(`· ${v} =`), false, `🔴 list_enums 报了一个系统不认的值 ${v}`);
    }
  });

  it('每一个 recordType 都有中文标签 —— 少一个界面上就会显示成别的那种', () => {
    for (const v of RECORD_TYPES_V2) {
      assert.ok(RECORD_TYPE_LABELS[v], `🔴 ${v} 没有中文标签`);
    }
  });
});

// ── 白名单 ─────────────────────────────────────────────────────────
describe('枚举白名单', () => {
  it('不在白名单里的值一律还成 null —— 不指望模型自觉', () => {
    assert.equal(keepCategory('BATTERY'), 'BATTERY');
    assert.equal(keepCategory('battery'), null);
    assert.equal(keepCategory('ROOF_TENT'), null);
    assert.equal(keepStage('RFQ_QUOTE'), 'RFQ_QUOTE');
    assert.equal(keepStage('随便编一个'), null);
  });

  it('枚举没有重复项（复制粘贴改的时候最容易出这个错）', () => {
    assert.equal(new Set(CATEGORIES).size, CATEGORIES.length);
    assert.equal(new Set(STAGES).size, STAGES.length);
  });
});

// ── 循环上限 ───────────────────────────────────────────────────────
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

const countingSkill = (calls: { n: number }): Skill => ({
  name: 'ping',
  label: 'ping',
  description: '测试用的工具，回一个字符串',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute: async () => {
    calls.n++;
    return { text: 'pong' };
  },
});

describe('循环上限与降级', () => {
  it('模型一直调工具不收手时，在上限那一步被切断，而且已经拿到的结果还在', async () => {
    // 一个「永远再调一次」的模型 —— 展会现场真出现过的形态是模型陷在自我确认里
    let i = 0;
    const forever = Array.from({ length: 40 }, () =>
      () => fauxAssistantMessage([fauxToolCall('ping', {}, { id: `call-${i++}` })]),
    );
    const { binding } = fauxBinding(forever);
    const calls = { n: 0 };

    const r = await runAgent({
      systemPrompt: 'test',
      prompt: '开始',
      skills: [countingSkill(calls)],
      binding,
      maxSteps: 4,
      timeoutMs: 20_000,
    });

    assert.equal(r.stopReason, 'max_steps', `实际 ${r.stopReason} / ${r.error}`);
    assert.ok(r.steps <= 4, `steps=${r.steps} 超了上限`);
    // 不是空的，也不是卡死的 —— 已经跑完的工具留在 trace 里
    assert.ok(r.trace.length > 0, 'trace 是空的 —— 被切断时把已有结果也丢了');
    assert.ok(r.trace.every((t) => t.tool === 'ping'));
  });

  it('正常收尾时 stopReason=done，最后那段话拿得到', async () => {
    const { binding } = fauxBinding([fauxAssistantMessage('已经记下来了')]);
    const r = await runAgent({
      systemPrompt: 'test',
      prompt: '记一下',
      skills: [],
      binding,
      maxSteps: 8,
    });
    assert.equal(r.stopReason, 'done');
    assert.equal(r.text, '已经记下来了');
    assert.equal(r.trace.length, 0);
  });

  it('工具抛异常不会让整轮崩掉，错误进 trace', async () => {
    let i = 0;
    const { binding } = fauxBinding([
      () => fauxAssistantMessage([fauxToolCall('boom', {}, { id: `b-${i++}` })]),
      fauxAssistantMessage('那我跳过这一步'),
    ]);
    const r = await runAgent({
      systemPrompt: 'test',
      prompt: 'x',
      skills: [
        {
          name: 'boom',
          label: 'boom',
          description: '故意炸的工具',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          execute: async () => {
            throw new Error('数据库连不上');
          },
        },
      ],
      binding,
      maxSteps: 6,
    });
    assert.equal(r.trace.length, 1);
    assert.equal(r.trace[0]!.ok, false);
    assert.match(r.trace[0]!.summary, /数据库连不上/);
    assert.equal(r.text, '那我跳过这一步');
  });
});

// ── 人「改一格」之后发回来的值（手册 P8）────────────────────────
describe('核对卡改过的字段同样要过白名单', () => {
  it('合法值原样收下', () => {
    const { fields, rejected } = sanitizeFieldEdits({
      stage: 'RFQ_QUOTE',
      caseStatus: 'RESOLVED',
      sourceConfidence: 'RUMOR',
    });
    assert.deepEqual(fields, {
      stage: 'RFQ_QUOTE',
      caseStatus: 'RESOLVED',
      sourceConfidence: 'RUMOR',
    });
    assert.deepEqual(rejected, []);
  });

  it('🔴 非法值必须拒掉整次请求 —— 悄悄当成「没改」入库最糟', () => {
    // 人明明亲手改成了别的值，界面显示「已入库」，
    // 而 CRM 里躺着的还是他刚改掉的那个 —— 没有任何迹象
    const { rejected } = sanitizeFieldEdits({ stage: '随便编一个' });
    assert.deepEqual(rejected, ['stage=随便编一个']);
  });

  it('🔴 不在可改清单里的键静默丢弃 —— 前端不能靠这条路改别的字段', () => {
    const { fields, rejected } = sanitizeFieldEdits({
      summary: '偷偷改小结',
      details: '偷偷改正文',
      companyCode: 'ALPIN',
      chain: [{ name: 'x', role: 'DEALER' }],
      stage: 'SOP',
    });
    assert.deepEqual(fields, { stage: 'SOP' }, '只有六个可改的格子能过来');
    assert.deepEqual(rejected, [], '不认识的键不算错，只是丢掉');
  });

  it('乱七八糟的输入不炸', () => {
    for (const junk of [null, undefined, 'string', 42, [], [1, 2]]) {
      const r = sanitizeFieldEdits(junk);
      assert.deepEqual(r.fields, {});
      assert.deepEqual(r.rejected, []);
    }
  });

  it('有默认值的那几个不会被判成非法（recordType / caseStatus / severity）', () => {
    // keepRecordType 等认不出会给默认值而不是 null，
    // 所以它们永远进 fields、永远不进 rejected —— 这是有意的：
    // 那三个字段「一定有一个值」，落到默认比拒掉整条入库好
    const { fields, rejected } = sanitizeFieldEdits({ recordType: '瞎写', severity: '瞎写' });
    assert.equal(fields.recordType, 'fitment');
    assert.equal(fields.severity, 'MEDIUM');
    assert.deepEqual(rejected, []);
  });
});

// ── 渠道链的顺序校验（D54）─────────────────────────────────────────
describe('渠道链只能从上游到下游', () => {
  it('分销商 → 经销商 → 终端客户 合法', () => {
    assert.equal(isValidChain(['DISTRIBUTOR', 'DEALER', 'END_USER']), true);
  });

  it('中间层可以缺 —— 分销商直接卖给终端客户是常见的', () => {
    assert.equal(isValidChain(['DISTRIBUTOR', 'END_USER']), true);
  });

  it('🔴 顺序反了必须拒绝 —— 建出来的关系会让「这家经销商下面有几个终端客户」永久算错', () => {
    assert.equal(isValidChain(['END_USER', 'DEALER']), false);
    assert.equal(isValidChain(['DEALER', 'DISTRIBUTOR']), false);
  });

  it('同一层出现两次也不行', () => {
    assert.equal(isValidChain(['DEALER', 'DEALER']), false);
  });

  it('OEM 那三个不在渠道链上 —— 它们走集团树，不是「谁卖给谁」', () => {
    assert.equal(isValidChain(['OEM_BRAND', 'END_USER']), false);
    assert.equal(chainRank('OEM_BRAND'), -1);
    assert.ok(chainRank('DEALER') >= 0);
  });

  it('账户类型和 twenty-schema.mjs 对得上（不含我编出来的那些）', () => {
    for (const bogus of ['RENTAL', 'CONVERTER', 'OTHER']) {
      assert.equal(
        (ACCOUNT_TYPES as readonly string[]).includes(bogus),
        false,
        `🔴 ${bogus} 又回来了 —— Twenty 不认这个值，界面上选得到就会 500`,
      );
    }
    assert.ok((ACCOUNT_TYPES as readonly string[]).includes('OEM_SUB_GROUP'));
  });
});
