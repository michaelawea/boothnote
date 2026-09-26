import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { heuristicTitle, makeTitle } from '../title.ts';

/**
 * 标题的兜底（issue #15）。
 *
 * 🔴 **为什么值得给一个装饰功能写测试**：`heuristicTitle` 是最后一道。
 * 模型没配、超时、返回了看不懂的东西 —— 全部落到它身上。
 * 它要是也会出错（抛异常、返回 undefined），那条录音的卡片上就什么都没有，
 * 而人只会觉得「这个功能坏了」，不会知道是因为模型那次没答上来。
 */
describe('标题兜底：heuristicTitle', () => {
  it('没内容就不编一个 —— 空字符串进，空字符串出', () => {
    assert.equal(heuristicTitle(''), '');
    assert.equal(heuristicTitle('   \n  '), '');
    // @ts-expect-error 故意传脏东西：兜底的那一层不能自己抛
    assert.equal(heuristicTitle(null), '');
  });

  it('只取第一句 —— 后面说了什么不该挤进标题', () => {
    assert.equal(
      heuristicTitle('他们想换供应商。现在用的是 Voltaro，明年招标。'),
      '他们想换供应商',
    );
  });

  it('英文句号也算句末', () => {
    assert.equal(heuristicTitle('They want to switch. Currently Voltaro.', 40), 'They want to switch');
  });

  it('🔴 版本号后面的点不能当句号剥掉 —— 「v1.0」不是「v1」', () => {
    assert.equal(heuristicTitle('客户给了规格书 v1.0'), '客户给了规格书 v1.0');
  });

  it('markdown 记号剥掉 —— 「## 车辆与合同」不该带着井号进标题', () => {
    assert.equal(heuristicTitle('## 车辆与合同'), '车辆与合同');
    assert.equal(heuristicTitle('**紧急**：电池不充电'), '紧急：电池不充电');
  });

  it('超长截断并明确标出来', () => {
    const t = heuristicTitle('这是一段很长很长的现场速记内容需要被截断处理掉多余的部分', 10);
    assert.equal(t, '这是一段很长很长的现…');
    assert.ok(t.endsWith('…'), '截断了就要看得出来是截断的');
    assert.equal(t.length, 11, '10 个字 + 一个省略号');
  });

  it('句末标点不留在标题里', () => {
    assert.equal(heuristicTitle('电池不充电！'), '电池不充电');
    assert.equal(heuristicTitle('要换供应商吗？'), '要换供应商吗');
  });

  it('一整句没有标点时整句就是标题（够短的话）', () => {
    assert.equal(heuristicTitle('Alpin 明年换逆变器'), 'Alpin 明年换逆变器');
  });
});

describe('makeTitle', () => {
  /**
   * 🔴 **短句不该烧一次模型调用。**
   *
   * 一天几十条速记，其中大半是「明天去 Alpin」这种一句话 ——
   * 它自己就是标题，再花一次往返去「概括」它没有任何收益。
   * 这条断言同时保证了这个测试**不发网络请求**（CI 上没有真的 key）。
   */
  it('短到本身就是标题的，直接用，不调模型', async () => {
    assert.equal(await makeTitle('明天去 Alpin'), '明天去 Alpin');
  });

  it('没内容就不调模型，也不编标题', async () => {
    assert.equal(await makeTitle(''), '');
  });
});
