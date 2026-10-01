import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 二轮对话：这句 @ 接在哪一条上（D146）—— 规则表逐条钉住。纯函数，零依赖。
 *
 * 🔴 判据：分错方向的代价不对称。错并线 = 一句不相干的话改写了一条记录，
 *    而那条记录 60 秒后就进 CRM（D143）。所以每一条「不接」的规则和「接」的一样要钉。
 */
const { decideFollow, commandOf, looksLikeQuestion, companiesMentioned, namesOtherCompany } = await import(
  '../channels/followup.ts'
);
const { isCorrection } = await import('../channels/routing.ts');

const Q = { threadId: 'tq', refNo: 128 };
const R = { threadId: 'tr', refNo: 131 };
const ctx = (over: Partial<Parameters<typeof decideFollow>[1]> = {}) => ({
  openQuestions: [] as Array<{ threadId: string; refNo: number | null }>,
  recent: null,
  mentionsOtherCompany: false,
  hasAttachments: false,
  ...over,
});

describe('命令层：整句才算命令', () => {
  const cases: Array<[string, unknown]> = [
    ['帮助', { cmd: 'help' }],
    ['help', { cmd: 'help' }],
    ['待办', { cmd: 'todo' }],
    ['#128', { cmd: 'resend', refNo: 128 }],
    ['#128。', { cmd: 'resend', refNo: 128 }],
    ['入库 #128', { cmd: 'force', refNo: 128 }],
    ['入库#128', { cmd: 'force', refNo: 128 }],
    ['撤回', { cmd: 'hint' }],
    ['撤回 #128', { cmd: 'hint' }],
    ['确认', { cmd: 'hint' }],
  ];
  for (const [t, want] of cases) it(`「${t}」`, () => assert.deepEqual(commandOf(t), want));

  it('🔴 「确认 Alpin 那条要 3000W」是一句内容，不能被命令层吞掉', () => {
    assert.equal(commandOf('确认 Alpin 那条要 3000W'), null);
    assert.equal(commandOf('入库 #128 其实型号是 2000'), null);
    assert.equal(commandOf('待办事项：给 Alpin 发样'), null);
  });
});

describe('decideFollow：从上往下、命中即停', () => {
  it('① 带 #N → 那一条（哪怕有待回答问题、哪怕是更正词）', () => {
    assert.deepEqual(decideFollow('#131 型号是 2000 的', ctx({ openQuestions: [Q] })), { kind: 'item', via: 'ref', refNo: 131 });
    assert.deepEqual(decideFollow('更正 #131 客户是 Heron', ctx({ recent: R })), { kind: 'item', via: 'ref', refNo: 131 });
  });

  it('① 「#」必须有：「第12条」「12号」不算编号', () => {
    assert.equal(decideFollow('按合同第12条交期延后', ctx()).kind, 'none');
    assert.equal(decideFollow('12号展位的 Alpin', ctx()).kind, 'none');
  });

  it('② 「记：」「问：」开头 → 不接（交给路由器按前缀），哪怕有待回答问题', () => {
    assert.equal(decideFollow('记：Heron 要 200 台锂电', ctx({ openQuestions: [Q] })).kind, 'none');
    assert.equal(decideFollow('问：VLC40 的最大输入电压', ctx({ openQuestions: [Q] })).kind, 'none');
  });

  it('③ 有待回答问题 → 这句就是回答', () => {
    assert.deepEqual(decideFollow('Voltaro 的', ctx({ openQuestions: [Q] })), {
      kind: 'item',
      via: 'answer',
      threadId: 'tq',
      refNo: 128,
    });
  });

  it('③ 🔴 不像回答的不接：像提问 → 交给路由器（真问题该去实验室）', () => {
    for (const t of ['VLC40 最大输入电压是多少？', '他们用的是 Voltaro 吗', '请问 2000W 够不够', 'how much is VLB100'])
      assert.equal(decideFollow(t, ctx({ openQuestions: [Q] })).kind, 'none', t);
  });

  it('③ 🔴 不像回答的不接：点名了别家客户 → 那是新情报', () => {
    assert.equal(decideFollow('Heron 要 200 台锂电', ctx({ openQuestions: [Q], mentionsOtherCompany: true })).kind, 'none');
  });

  it('③ 🔴 不像回答的不接：带图 → 新记录', () => {
    assert.equal(decideFollow('展台照片', ctx({ openQuestions: [Q], hasAttachments: true })).kind, 'none');
  });

  it('④ 更正词开头 + 本人 2 小时内有一条 → 那一条', () => {
    assert.deepEqual(decideFollow('更正：型号是 2000W', ctx({ recent: R })), {
      kind: 'item',
      via: 'correction',
      threadId: 'tr',
      refNo: 131,
    });
  });

  it('④ 更正词但没有最近那一条 → 不接', () => {
    assert.equal(decideFollow('更正：型号是 2000W', ctx()).kind, 'none');
  });

  it('⑤ 🔴 普通新内容不接 —— 有最近一条也不接（Alpin 两分钟后的 Heron 是两条）', () => {
    assert.equal(decideFollow('Heron 想要电池报价', ctx({ recent: R })).kind, 'none');
  });

  it('🔴 ③ 同时有两条在等回答 → 不猜（ambiguous），请人带 #编号', () => {
    const d = decideFollow('200 台', ctx({ openQuestions: [Q, R] }));
    assert.deepEqual(d, { kind: 'ambiguous', refNos: [128, 131] });
  });

  it('④ 更正词说的是刚说的那一条 —— 问题挂在别的条上时，更正优先', () => {
    const d = decideFollow('不对，是 Voltaro', ctx({ openQuestions: [Q], recent: R }));
    assert.equal(d.kind === 'item' && d.via !== 'ref' && d.threadId, 'tr');
  });

  it('同一条上既有问题又在更正 → 照样接到这一条（当回答接）', () => {
    const d = decideFollow('不对，是 Voltaro', ctx({ openQuestions: [R], recent: R }));
    assert.equal(d.kind === 'item' && d.via !== 'ref' && d.threadId, 'tr');
  });
});

describe('looksLikeQuestion', () => {
  it('中文开头词不能用 \\b（汉字两边都是 \\W）—— 「请问X」必须认得出', () => {
    assert.equal(looksLikeQuestion('请问这个型号'), true);
    assert.equal(looksLikeQuestion('多少钱'), true);
  });
  it('回答不是提问', () => {
    for (const t of ['Voltaro 的', '大概 200 台', 'Domatek', '是 2000W', 'isotherm 那家'])
      assert.equal(looksLikeQuestion(t), false, t);
  });
});

describe('isCorrection：复合词不算更正（现在并错了就是 60 秒后自动写进上一条）', () => {
  it('认得住', () => {
    for (const t of ['更正：xx', '不对，是 Rosenfeld', '改成 2000W', '改成2000W', '说错了'])
      assert.equal(isCorrection(t), true, t);
  });
  it('不误中', () => {
    for (const t of ['不对外报价', '不对称的需求', '改成本价格表', '不对劲'])
      assert.equal(isCorrection(t), false, t);
  });
});

describe('namesOtherCompany：「回答」点名了别家客户吗', () => {
  const list = [
    { code: 'KT', name: 'Alpin Tannhof', group: '' },
    { code: 'ALPIN', name: 'Alpin', group: 'Alpin Tannhof' },
    { code: 'ROSENFELD', name: 'Rosenfeld', group: 'Alpin Tannhof' },
    { code: 'HERON', name: 'Heron', group: '' },
  ];
  it('🔴 那一条还没有客户时，点名客户就是在回答（「客户没对上」的硬挡要补得上）', () => {
    assert.equal(namesOtherCompany('是 Heron 的', null, list), false);
  });
  it('点名的就是这一条自己的客户 → 不是别家', () => {
    assert.equal(namesOtherCompany('Alpin 那边说 200 台', 'ALPIN', list), false);
  });
  it('同一个集团（父子 / 兄弟）不算别家', () => {
    assert.equal(namesOtherCompany('Alpin Tannhof 集团采购定的', 'ALPIN', list), false);
    assert.equal(namesOtherCompany('Rosenfeld 也一样', 'ALPIN', list), false);
  });
  it('真点名了别家 → 是', () => {
    assert.equal(namesOtherCompany('Heron 要 200 台锂电', 'ALPIN', list), true);
  });
});

describe('companiesMentioned', () => {
  const list = [
    { code: 'ALPIN', name: 'Alpin Tannhof AG' },
    { code: 'HERON', name: 'Heron' },
    { code: 'EH', name: 'EH' }, // 太短的名字不参与（会误中）
    { code: 'SUN', name: 'Sea Lights' }, // 首词只有 3 个字母 —— 不当别名（「sunlight」「sunday」都会中）
  ];
  it('首词太短（<4）不当别名', () => {
    assert.deepEqual(companiesMentioned('sunday we met them', list), []);
    assert.deepEqual(companiesMentioned('Sea Lights 想要', list), ['SUN']);
  });
  it('全名或第一个词都算，大小写不敏感', () => {
    assert.deepEqual(companiesMentioned('alpin 说要换', list), ['ALPIN']);
    assert.deepEqual(companiesMentioned('HERON 要 200 台', list), ['HERON']);
  });
  it('名字太短不参与', () => {
    assert.deepEqual(companiesMentioned('they said eh', list), []);
  });
});
