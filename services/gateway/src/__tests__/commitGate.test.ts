import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 自动入库的确信度门槛（D144）—— 规则表逐条钉住。纯函数，零依赖。
 *
 * 判据：维护者 2026-10-01「如果信息非常不完善，还是要挡」。
 * 三级：hard（`入库 #N` 也越不过）/ soft（`入库 #N` 可越过）/ warn（照常倒计时）。
 */
const { commitGate, canForceCommit } = await import('../channels/commitGate.ts');

const FULL = {
  companyCode: 'ALPIN',
  recordType: 'fitment',
  category: 'INVERTER',
  supplierName: 'Voltaro',
  modelName: 'PowerFlex 2000',
  summary: 'Alpin 换逆变器',
};
const gate = (
  extracted: Record<string, unknown>,
  over: Partial<{ status: string; partial: boolean; suggestedCompany: string | null; confidence: Record<string, string> }> = {},
) => commitGate({ status: 'ready', partial: false, suggestedCompany: null, confidence: {}, extracted, ...over });

describe('commitGate：完整的选型情报 → 自动入库', () => {
  it('客户 + 品类 + 一项事实 → auto，三级全空', () => {
    const r = gate(FULL);
    assert.deepEqual(r, { auto: true, hard: [], soft: [], warn: [] });
  });
});

describe('commitGate：hard —— `入库 #N` 也越不过（D28 入库前必须有归属）', () => {
  it('客户没对上 → hard', () => {
    const r = gate({ ...FULL, companyCode: '' });
    assert.equal(r.auto, false);
    assert.match(r.hard.join(), /客户没对上名单/);
    assert.equal(canForceCommit(r), false);
  });

  it('只提议了新客户 → hard，并点名那家（新客户要先在 CRM 建好）', () => {
    const r = gate({ ...FULL, companyCode: null }, { suggestedCompany: 'Neumeyer' });
    assert.match(r.hard.join(), /Neumeyer.*不在名单里/);
    assert.equal(canForceCommit(r), false);
  });

  it('agent 失败 → hard', () => {
    const r = gate(FULL, { status: 'failed' });
    assert.match(r.hard.join(), /没处理成/);
    assert.equal(canForceCommit(r), false);
  });
});

describe('commitGate：soft —— 默认挡，`入库 #N` 可越过', () => {
  const cases: Array<[string, Record<string, unknown>, Partial<{ partial: boolean; confidence: Record<string, string>; suggestedCompany: string }>, RegExp]> = [
    ['AI 没整理出字段（兜底原文）', { companyCode: 'ALPIN', agentSkipped: true, summary: 'x' }, {}, /AI 没整理出/],
    ['跑到上限', FULL, { partial: true }, /上限/],
    ['客户识别把握 low', FULL, { confidence: { companyCode: 'low' } }, /客户识别把握低/],
    ['客户有值又提议了新客户（多半是继承来的客户）', FULL, { suggestedCompany: 'Neumeyer' }, /提议了新客户「Neumeyer」/],
    ['选型情报缺品类', { ...FULL, category: '' }, {}, /缺品类/],
    ['品类把握 low', FULL, { confidence: { category: 'low' } }, /品类把握低/],
    [
      '选型情报一项事实都没有',
      { companyCode: 'ALPIN', recordType: 'fitment', category: 'INVERTER' },
      {},
      /一项都没有/,
    ],
    ['售后缺描述', { companyCode: 'ALPIN', recordType: 'support', modelName: 'X' }, {}, /缺问题描述/],
    ['售后缺型号和品类', { companyCode: 'ALPIN', recordType: 'support', details: '水泵异响' }, {}, /缺型号或品类/],
    ['判成项目没提案', { companyCode: 'ALPIN', recordType: 'project' }, {}, /没有项目提案/],
    ['跟进没指向任何项目', { companyCode: 'ALPIN', recordType: 'followup' }, {}, /没指向任何项目/],
  ];
  for (const [name, x, over, re] of cases) {
    it(name, () => {
      const r = gate(x, over);
      assert.equal(r.auto, false, name);
      assert.equal(r.hard.length, 0, `${name}：不该是 hard`);
      assert.match(r.soft.join('；'), re);
      assert.equal(canForceCommit(r), true);
    });
  }

  it('兜底原文不再逐类查最低字段（那些字段本来就不会有，报一条就够）', () => {
    const r = gate({ companyCode: 'ALPIN', agentSkipped: true });
    assert.deepEqual(r.soft, ['AI 没整理出结构化字段（下面是原文）']);
  });
});

describe('commitGate：够格的其它类型', () => {
  it('售后：描述 + 型号 → auto', () => {
    assert.equal(gate({ companyCode: 'ALPIN', recordType: 'support', details: '水泵异响', modelName: 'P1' }).auto, true);
  });
  it('项目：有提案 → auto', () => {
    assert.equal(gate({ companyCode: 'ALPIN', recordType: 'project', project: { name: 'X' } }).auto, true);
  });
  it('跟进：有任务线程 → auto；有项目编号 → auto', () => {
    assert.equal(gate({ companyCode: 'ALPIN', recordType: 'followup', workItems: [{ itemCode: 'A-01' }] }).auto, true);
    assert.equal(gate({ companyCode: 'ALPIN', recordType: 'followup', projectCode: 'KNA-1' }).auto, true);
  });
  it('没写类型 = 按选型情报判（和 confirm.ts 的默认同一条）', () => {
    const { recordType: _drop, ...rest } = FULL;
    assert.equal(gate(rest).auto, true);
    assert.match(gate({ companyCode: 'ALPIN' }).soft.join(), /缺品类/);
  });
});

describe('commitGate：把握度读的是 staging.confidence 那一列', () => {
  it('🔴 塞在 extracted 里的 confidence 不算数（生产上它从来不在那儿 —— 第一版就是读错了地方）', () => {
    const r = gate({ ...FULL, confidence: { companyCode: 'low' } });
    assert.equal(r.auto, true);
  });
});

describe('commitGate：warn —— 不挡，只列「待核」', () => {
  it('型号把握 low → warn，照常 auto', () => {
    const r = gate(FULL, { confidence: { modelName: 'low' } });
    assert.equal(r.auto, true);
    assert.deepEqual(r.warn, ['型号（把握低）']);
  });
  it('传闻 → warn，不挡（传闻本身就是情报，按传闻记）', () => {
    const r = gate({ ...FULL, sourceConfidence: 'RUMOR' });
    assert.equal(r.auto, true);
    assert.deepEqual(r.warn, ['信息来源是传闻']);
  });
  it('空格子上的 low 不提（没值就没什么可核的）', () => {
    assert.deepEqual(gate(FULL, { confidence: { targetPrice: 'low' } }).warn, []);
  });
  it('🔴 模型自评只往严里用：confidence 写 high 也不能让缺品类的过关', () => {
    const r = gate({ ...FULL, category: '' }, { confidence: { category: 'high', companyCode: 'high' } });
    assert.equal(r.auto, false);
  });
});
