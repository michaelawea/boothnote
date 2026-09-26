import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { codeBase, nextFreeSeq, pickCode, sameProject, seqOf, type CodedRow } from '../projectCode.ts';

/**
 * 项目编号的取号判断（D91）。**零依赖，一行网络请求都不发。**
 *
 * 这一层错一次的代价是不对称的，而且两个方向都很贵：
 *   · 该复用却发了新号 → issue #18 白做：同一个项目的两条对话在看板上仍是两张卡
 *   · 不该复用却复用了 → 入库时 `findProjectByCode` 命中，第二条把第一条 **update 掉** ——
 *     两个项目被静默并成一个，而界面一路绿色
 * 所以下面「不复用」的用例和「复用」的一样重要。
 */

const row = (code: string, category: string | null, name: string | null): CodedRow => ({
  stagingId: `s-${code}`,
  code,
  category,
  name,
});

describe('seqOf —— 编号尾巴上那三位', () => {
  it('认得出自己这个 base 的', () => {
    assert.equal(seqOf('EHG-HAVEL-2026', 'EHG-HAVEL-2026-007'), 7);
    assert.equal(seqOf('EHG-HAVEL-2026', 'ehg-havel-2026-012'), 12, '大小写不算数');
  });

  it('别的 base / 别的年份 / 不是数字 → null', () => {
    assert.equal(seqOf('EHG-HAVEL-2026', 'EHG-HAVEL-2025-003'), null);
    assert.equal(seqOf('EHG-HAVEL-2026', 'KNA-2026-001'), null);
    assert.equal(seqOf('EHG-HAVEL-2026', 'EHG-HAVEL-2026-XYZ'), null);
    assert.equal(seqOf('EHG-HAVEL-2026', null), null);
  });
});

describe('nextFreeSeq —— 下一个没被占的号', () => {
  it('空的从 1 开始', () => {
    assert.equal(nextFreeSeq('KNA-2026', []), 1);
  });

  it('取最大的那个 +1，不是「数一数有几个」', () => {
    // 中间有洞（002 被人改成别的编号了）也不能回头填 —— 填回去就撞上历史
    assert.equal(nextFreeSeq('KNA-2026', ['KNA-2026-001', 'KNA-2026-003']), 4);
  });

  it('🔴 CRM 给的下限说了算 —— staging 里一个都没有也不能回到 1', () => {
    // Twenty 里已经有 007，只看 staging 会发 001，撞上一个真项目
    assert.equal(nextFreeSeq('KNA-2026', [], 8), 8);
    assert.equal(nextFreeSeq('KNA-2026', ['KNA-2026-012'], 8), 13, '两边取大的那个');
  });
});

describe('sameProject —— 这是不是同一个项目', () => {
  const rows = [
    row('EHG-HAVEL-2026-002', 'DCDC_CHARGER', 'Havel 车载充电'),
    row('EHG-HAVEL-2026-001', 'BATTERY', 'Havel CI-Bus 电池项目'),
  ];

  it('品类对上就是同一个（D56：客户 + 品类 = 项目身份）', () => {
    assert.equal(sameProject(rows, { category: 'BATTERY', name: '随便什么名字' })?.code, 'EHG-HAVEL-2026-001');
  });

  it('🔴 品类不同 = 不同项目，名字再像也不并', () => {
    assert.equal(sameProject(rows, { category: 'INVERTER', name: 'Havel CI-Bus 电池项目' }), null);
  });

  it('品类还没抽出来时才退回名字，且大小写/空格/短横线都不算数', () => {
    assert.equal(sameProject(rows, { name: 'havel  ci bus 电池项目' })?.code, 'EHG-HAVEL-2026-001');
    assert.equal(sameProject(rows, { name: 'Havel 逆变器项目' }), null);
  });

  it('两样都没有 → 不复用（宁可开新号，也不猜）', () => {
    assert.equal(sameProject(rows, {}), null);
    assert.equal(sameProject(rows, { category: '  ', name: '' }), null);
  });
});

describe('pickCode —— 三个调用点共用的那份判断', () => {
  const ask = { companyCode: 'EHG-HAVEL', year: 2026, twentyNext: 'EHG-HAVEL-2026-001' };

  it('一条提案都没有 → 从 CRM 给的下限开号', () => {
    assert.deepEqual(pickCode([], ask), { code: 'EHG-HAVEL-2026-001', reused: false });
  });

  it('🔴 同一个项目第二次问，给的是同一个编号（issue #18 全靠这条）', () => {
    const rows = [row('EHG-HAVEL-2026-001', 'BATTERY', 'CI-Bus 电池')];
    assert.deepEqual(pickCode(rows, { ...ask, category: 'BATTERY', name: '另一次对话里的叫法' }), {
      code: 'EHG-HAVEL-2026-001',
      reused: true,
    });
  });

  it('🔴 同一家客户、不同品类 → 新号，绝不复用', () => {
    const rows = [row('EHG-HAVEL-2026-001', 'BATTERY', 'CI-Bus 电池')];
    assert.deepEqual(pickCode(rows, { ...ask, category: 'INVERTER', name: 'CI-Bus 逆变器' }), {
      code: 'EHG-HAVEL-2026-002',
      reused: false,
    });
  });

  it('🔴 别家客户占着的号不影响我 —— 前缀要带那个短横线', () => {
    // 代号 EHG 的客户不能因为 EHG-HAVEL 已经用到 009 就跳到 010
    const rows = [row('EHG-HAVEL-2026-009', 'BATTERY', 'Havel 电池')];
    assert.deepEqual(pickCode(rows, { companyCode: 'EHG', year: 2026, twentyNext: 'EHG-2026-001' }), {
      code: 'EHG-2026-001',
      reused: false,
    });
  });

  it('跨年也复用 —— 2026 立的项目，2027 再提到它还是那个编号', () => {
    const rows = [row('EHG-HAVEL-2026-001', 'BATTERY', 'CI-Bus 电池')];
    const got = pickCode(rows, { companyCode: 'EHG-HAVEL', year: 2027, twentyNext: 'EHG-HAVEL-2027-001', category: 'BATTERY' });
    assert.deepEqual(got, { code: 'EHG-HAVEL-2026-001', reused: true });
  });

  it('新号避开 staging 里已经占住的，哪怕 CRM 还不知道它们', () => {
    const rows = [
      row('EHG-HAVEL-2026-003', 'BATTERY', 'A'),
      row('EHG-HAVEL-2026-002', 'DCDC_CHARGER', 'B'),
    ];
    assert.deepEqual(pickCode(rows, { ...ask, category: 'INVERTER', name: 'C' }), {
      code: 'EHG-HAVEL-2026-004',
      reused: false,
    });
  });
});

describe('codeBase —— 前缀', () => {
  it('客户代号 + 年份，非法字符去掉，不留多余的短横线', () => {
    assert.equal(codeBase('EHG-HAVEL', 2026), 'EHG-HAVEL-2026');
    assert.equal(codeBase('kna', 2026), 'KNA-2026');
    assert.equal(codeBase('A B/C', 2026), 'ABC-2026');
    assert.equal(codeBase('TREVANO-', 2026), 'TREVANO-2026');
  });
});
