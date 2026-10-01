import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 钉钉汇报（D145）：状态先行、少 emoji、拟写入详尽。纯函数 + 可注入的查找，不碰 Twenty。
 */
process.env.AGENT_ENABLED = '1';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'unit-test-placeholder';

const { planOf, diffOf, renderReport, renderNotice, askFor } = await import('../channels/report.ts');

const none = {
  findOpportunity: async () => null,
  findProjectByCode: async () => null,
  findWorkItemByCode: async () => null,
};
const boom = {
  findOpportunity: async () => {
    throw new Error('twenty down');
  },
  findProjectByCode: async () => {
    throw new Error('twenty down');
  },
  findWorkItemByCode: async () => {
    throw new Error('twenty down');
  },
};

const FIT = {
  companyCode: 'ALPIN',
  recordType: 'fitment',
  category: 'INVERTER',
  supplierName: 'Voltaro',
  modelName: 'PowerFlex 2000',
  stage: 'SAMPLE_TEST',
  decisionWindow: '2026 Q4',
  sourceConfidence: 'CONFIRMED',
  summary: 'Alpin 想把逆变器换成 2000W',
  details: '与采购负责人聊，Q4 送样',
};
const C = { companyId: 'c1', companyName: 'Alpin', prevRefs: null as Record<string, unknown> | null };

describe('planOf：分支结构照抄 commitToTwenty', () => {
  it('选型情报 + 有阶段 → 拜访 · 选型情报 · 商机（三条，字段逐条列）', async () => {
    const p = await planOf(FIT, C, none);
    assert.deepEqual(p.map((x) => x.what), ['拜访记录', '选型情报', '商机']);
    assert.match(p[1]!.detail, /品类 [^；]*逆变器/);
    assert.match(p[1]!.detail, /在位品牌 Voltaro/);
    assert.match(p[1]!.detail, /型号 PowerFlex 2000/);
    assert.match(p[2]!.action, /新建「Alpin · [^」]*逆变器」/);
    assert.match(p[2]!.detail, /决策窗口 2026 Q4/);
  });

  it('没有阶段 / 窗口 / 预算 → 不动商机（和 confirm.ts 同一个条件）', async () => {
    const { stage: _s, decisionWindow: _d, ...x } = FIT;
    const p = await planOf(x, C, none);
    assert.deepEqual(p.map((y) => y.what), ['拜访记录', '选型情报']);
  });

  it('已有商机 → 「更新已有」+ 阶段写成 旧 → 新', async () => {
    const look = { ...none, findOpportunity: async () => ({ name: 'Alpin · 逆变器', stage: 'CONTACTED' }) };
    const p = await planOf(FIT, C, look);
    assert.match(p[2]!.action, /更新已有「Alpin · 逆变器」/);
    assert.match(p[2]!.detail, /阶段 .+ → .+/);
  });

  it('🔴 CRM 查不到 → 如实写「新建或更新」，不猜', async () => {
    const p = await planOf({ ...FIT, project: { projectCode: 'KNA-1', name: 'X' } }, C, boom);
    assert.match(p.find((x) => x.what === '商机')!.action, /新建或更新/);
    assert.match(p.find((x) => x.what === '项目')!.action, /新建或更新/);
  });

  it('售后 → 拜访 + 售后，不出选型情报', async () => {
    const p = await planOf({ companyCode: 'K', recordType: 'support', category: 'PUMP', details: '异响', severity: 'HIGH' }, C, none);
    assert.deepEqual(p.map((x) => x.what), ['拜访记录', '售后问题']);
    assert.match(p[1]!.detail, /严重程度 [^；]*高/);
  });

  it('项目 + 任务线程：编号撞上已有的写「更新」，逐条列子项', async () => {
    const look = {
      ...none,
      findProjectByCode: async () => ({ name: 'Alpin 逆变器项目', projectStage: 'SAMPLE_TEST' }),
      findWorkItemByCode: async (code: string) => (code === 'KNA-01' ? { id: 'w1' } : null),
    };
    const x = {
      companyCode: 'K',
      recordType: 'followup',
      project: { projectCode: 'KNA-1', name: 'Alpin 逆变器项目', projectStage: 'SAMPLE_TEST' },
      workItems: [
        { itemCode: 'KNA-01', title: '接口文档', threadType: 'doc', dueDate: '2026-10-10' },
        { itemCode: 'KNA-02', title: '送样', threadType: 'milestone' },
      ],
    };
    const p = await planOf(x, C, look);
    const proj = p.find((y) => y.what === '项目')!;
    assert.match(proj.action, /更新已有 KNA-1/);
    const wi = p.find((y) => y.what.startsWith('任务线程'))!;
    assert.equal(wi.action, '新建 1，更新 1');
    assert.equal(wi.children!.length, 2);
    assert.match(wi.children![0]!, /KNA-01 接口文档（更新；类型 .+；截止 2026-10-10/);
  });

  it('redo（接管已入库的那一版）：上一版建过的对象才是「更新上一版那条」，一次查找都不做', async () => {
    const p = await planOf(FIT, { ...C, prevRefs: { visitId: 'v', productFitmentId: 'pf', opportunityId: 'o' } }, boom);
    assert.equal(p[0]!.action, '更新正文');
    assert.match(p[1]!.action, /更新（上一版/);
    assert.match(p[2]!.action, /更新（上一版/);
  });

  it('🔴 redo 但上一版**没建过**商机（这次才说了阶段）→ 照常判新旧，不说「更新上一版」', async () => {
    const p = await planOf(FIT, { ...C, prevRefs: { visitId: 'v', productFitmentId: 'pf' } }, none);
    assert.match(p.find((x) => x.what === '商机')!.action, /^新建/);
  });

  it('🔴 客户变了：先列「上一版 N 条软删」，其余全部新建（和 commitToTwenty 的 movedCompany 一致）', async () => {
    const p = await planOf(FIT, { ...C, prevRefs: null, softDeleted: 2 }, none);
    assert.equal(p[0]!.what, '上一版写入的记录');
    assert.match(p[0]!.action, /软删 2 条/);
    assert.equal(p[1]!.action, '新建');
  });

  it('决策窗口解析不出日期（「明年吧」）且没阶段没预算 → 不动商机（confirm.ts 同一个条件）', async () => {
    const { stage: _s, ...x } = FIT;
    const p = await planOf({ ...x, decisionWindow: '明年吧' }, C, none);
    assert.equal(p.find((y) => y.what === '商机'), undefined);
  });
});

describe('diffOf', () => {
  it('列出改了的格子；客户变了单独标出来', () => {
    const d = diffOf({ ...FIT, modelName: 'PowerFlex 3000', companyCode: 'HERON' }, FIT);
    assert.ok(d.lines.some((l) => /型号 PowerFlex 3000 → PowerFlex 2000/.test(l)));
    assert.equal(d.companyChanged, true);
  });
  it('第一版没有上一版 → 空', () => {
    assert.deepEqual(diffOf(null, FIT), { lines: [], companyChanged: false });
  });
  it('从无到有不算「客户变了」', () => {
    assert.equal(diffOf({ ...FIT, companyCode: '' }, FIT).companyChanged, false);
  });
});

const view = (over: Record<string, unknown> = {}) => ({
  sender: 'u1',
  refNo: 128,
  version: 1,
  extracted: FIT,
  companyLabel: 'Alpin（ALPIN）',
  suggestedCompany: null,
  diff: { lines: [], companyChanged: false },
  plan: [{ what: '选型情报', action: '新建', detail: '品类 逆变器' }],
  warn: [],
  questions: [],
  state: { kind: 'countdown', seconds: 60, withdrawUrl: 'https://cap.test/api/a/tok' },
  ...over,
}) as any;

describe('renderReport：状态先行', () => {
  it('倒计时：第 1 行 #N · 待入库，第 2 行状态 + 撤回链接，末尾 @本人', () => {
    const t = renderReport(view()).markdown!.text;
    const lines = t.split('\n');
    assert.equal(lines[0], '#### #128 选型情报 · 待入库');
    assert.match(lines[1]!, /^\*\*状态\*\*：待入库，60 秒后自动写入 CRM。\[撤回\]\(https:\/\/cap\.test\/api\/a\/tok\)$/);
    assert.match(t, /\*\*拟写入 CRM\*\*/);
    assert.match(t, /1\. 选型情报 · 新建 —— 品类 逆变器/);
    assert.match(t, /@u1$/);
  });

  it('🔴 明细再长，撤回链接也在第 2 行、@ 也在末尾', () => {
    const t = renderReport(view({ extracted: { ...FIT, details: '国'.repeat(30_000) } })).markdown!.text;
    assert.match(t.split('\n')[1]!, /\[撤回\]/);
    assert.ok(Buffer.byteLength(t, 'utf8') <= 18_000);
    assert.match(t, /@u1$/);
  });

  it('未入库（soft）：原因 + 两条出路（补一句 / 入库 #N）；不出撤回链接', () => {
    const t = renderReport(view({ state: { kind: 'held', hard: [], soft: ['缺品类'] } })).markdown!.text;
    assert.equal(t.split('\n')[0], '#### #128 选型情报 · 未入库');
    assert.match(t, /\*\*状态\*\*：未入库。原因：缺品类。/);
    assert.match(t, /入库 #128/);
    assert.doesNotMatch(t, /撤回\]/);
    assert.match(t, /整理结果（入库时会写入）/);
  });

  it('🔴 未入库（hard）：不给「入库 #N」这条出路（它越不过 hard）', () => {
    const t = renderReport(view({ state: { kind: 'held', hard: ['客户没对上名单'], soft: [] } })).markdown!.text;
    assert.match(t, /客户没对上名单/);
    assert.doesNotMatch(t, /入库 #128/);
  });

  it('第 2 版：列「本版变更」；客户变了要加一句提醒', () => {
    const t = renderReport(
      view({ version: 2, diff: { lines: ['客户 HERON → ALPIN'], companyChanged: true } }),
    ).markdown!.text;
    assert.match(t, /\*\*本版变更\*\*（第 2 版）：客户 HERON → ALPIN/);
    assert.match(t, /客户变了/);
  });

  it('待回答问题带「30 分钟内直接回答」—— bot 只看得见 @ 它的话', () => {
    const t = renderReport(view({ questions: ['Q4 送样几台？'] })).markdown!.text;
    assert.match(t, /\*\*待回答\*\*：Q4 送样几台？（@我 直接回答，30 分钟内有效）/);
  });

  it('D145：汇报里没有 emoji', () => {
    for (const state of [
      { kind: 'countdown', seconds: 60, withdrawUrl: 'https://x' },
      { kind: 'held', hard: ['a'], soft: ['b'] },
      { kind: 'failed', error: 'e' },
      { kind: 'not_queued', why: 'w' },
    ]) {
      assert.doesNotMatch(renderReport(view({ state })).markdown!.text, /\p{Extended_Pictographic}/u);
    }
  });

  it('修改一条已入库的、没过门槛 → 「修改未入库（CRM 里仍是上一版）」，不说整条未入库', () => {
    const t = renderReport(view({ redo: true, state: { kind: 'held', hard: [], soft: ['x'] } })).markdown!.text;
    assert.equal(t.split('\n')[0], '#### #128 选型情报 · 修改未入库');
    assert.match(t, /这次修改未入库（CRM 里仍是上一版）/);
  });

  it('「已入库」只在入库之后出现 —— 倒计时和未入库都不许说', () => {
    assert.doesNotMatch(renderReport(view()).markdown!.text, /已入库/);
    assert.doesNotMatch(renderReport(view({ state: { kind: 'held', hard: [], soft: ['x'] } })).markdown!.text, /已入库/);
  });
});

describe('renderNotice：群回声', () => {
  it('已入库：新建/更新逐类计数 + 怎么改', () => {
    const t = renderNotice({ kind: 'committed', refNo: 128, created: { 拜访: 1, 选型情报: 1 }, updated: ['商机'] }, 'u1')
      .markdown!.text;
    assert.match(t, /^#### #128 · 已入库/);
    assert.match(t, /新建 拜访 1、选型情报 1；更新 商机/);
    assert.match(t, /@u1$/);
  });
  it('入库失败：明说 CRM 里没写 + 怎么重试', () => {
    const t = renderNotice({ kind: 'commit_failed', refNo: 128, error: 'Twenty 503' }, 'u1').markdown!.text;
    assert.match(t, /写入 CRM 中途失败（Twenty 503）/);
    // commitToTwenty 是一步步写的 —— 不能说「CRM 里没有」，要人先去核
    assert.match(t, /可能已写入一部分/);
    assert.match(t, /入库 #128/);
  });
  it('修改一条已入库的：撤回说的是「这次修改」，CRM 里仍是上一版', () => {
    const t = renderNotice({ kind: 'withdrawn', refNo: 128, via: 'link', redo: true }, 'u1').markdown!.text;
    assert.match(t, /这次修改已撤回，CRM 里仍是上一版/);
  });

  it('已撤回：明说没写 CRM + 两条后续', () => {
    const t = renderNotice({ kind: 'withdrawn', refNo: 128, via: 'link' }, 'u1').markdown!.text;
    assert.match(t, /已撤回，没有写入 CRM/);
    assert.match(t, /入库 #128/);
  });
});

describe('askFor：什么算「待回答的问题」', () => {
  it('agent 自己的追问优先', () => {
    assert.equal(askFor(['Q4 送样几台？'], { hard: ['客户没对上名单'], soft: [] }), 'Q4 送样几台？');
  });
  it('没有追问时，真实的信息缺口算问题', () => {
    assert.equal(askFor([], { hard: ['客户没对上名单'], soft: ['缺品类'] }), '补充：客户没对上名单；缺品类');
  });
  it('🔴 没缺口、没追问 → 不登记（状态说明不是问题，否则下一句无关的话会被吸进这一条）', () => {
    assert.equal(askFor([], { hard: [], soft: [] }), null);
  });
});
