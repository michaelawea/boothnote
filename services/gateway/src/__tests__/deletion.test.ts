import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { describe as describePlan, labelOf, plan } from '../deletion.ts';

/**
 * 「删这一条会动 CRM 里的哪几条」（issue #25 · D93）。
 *
 * 这个文件守的是**一条不能出错的判断**：删多了 = 因为删一条拜访而炸掉整条项目线；
 * 删少了 = 静默留下孤儿，而看板上那一行已经没了。
 *
 * 🔴 `twenty_refs` 里混着三种东西，`plan()` 的全部工作就是把它们分开：
 *   ① 这条速记自己建的  ② **复用**别人已有的  ③ 根本不是 id 的（计数 / 时间戳 / 正文）
 */

const row = (o: Partial<Parameters<typeof plan>[0]>) => ({
  status: 'confirmed',
  twenty_refs: null,
  created_records: null,
  ...o,
});

describe('created_records —— 精确清单（D93 之后入库的）', () => {
  it('原样取用，一条不多一条不少', () => {
    const p = plan(
      row({
        created_records: [
          { object: 'visit', id: 'v1', name: '拜访 A' },
          { object: 'opportunity', id: 'o1', name: '商机 B' },
        ],
        // 🔴 refs 里那些复用来的、不是 id 的，在这条路上**根本不参与** ——
        //    `made` 记的就是「这次新建了什么」，复用的从来没进来过
        twenty_refs: { visitId: 'v1', opportunityId: 'o1', projectId: 'SHARED', workItems: '4' },
      }),
    );
    assert.equal(p.source, 'created_records');
    assert.deepEqual(
      p.refs.map((r) => r.id),
      ['v1', 'o1'],
    );
    // 🔴 那个共享项目一个字都没被带上
    assert.ok(!p.refs.some((r) => r.id === 'SHARED'));
  });

  it('🔴 认不出的对象名跳过，不猜 —— 猜出来的是一个不存在的 REST/GraphQL 名字', () => {
    const p = plan(row({ created_records: [{ object: 'unicorn', id: 'x1' }, { object: 'visit', id: 'v1' }] }));
    assert.deepEqual(
      p.refs.map((r) => r.id),
      ['v1'],
    );
  });

  it('这次一条都没新建（纯更新的重录）→ 空计划，不退回老路', () => {
    const p = plan(row({ created_records: [], twenty_refs: {} }));
    assert.equal(p.refs.length, 0);
    assert.equal(p.source, 'created_records');
  });
});

describe('legacy_refs —— 保守白名单（D93 之前入库的）', () => {
  it('四类自己建的照删', () => {
    const p = plan(
      row({
        twenty_refs: {
          visitId: 'v1',
          supportCaseId: 'c1',
          productFitmentId: 'f1',
          projectDocId: 'd1',
        },
      }),
    );
    assert.equal(p.source, 'legacy_refs');
    assert.deepEqual(new Set(p.refs.map((r) => r.object)), new Set(['visit', 'supportCase', 'productFitment', 'projectDoc']));
  });

  it('🔴 复用的商机不删（`opportunityWas` 在场 = 它入库前就存在）', () => {
    const p = plan(row({ twenty_refs: { visitId: 'v1', opportunityId: 'o1', opportunityWas: 'RFQ' } }));
    assert.ok(!p.refs.some((r) => r.object === 'opportunity'));
    assert.equal(p.skipped.length, 1);
    assert.match(p.skipped[0]!.what, /商机/);
  });

  it('🔴 复用的项目不删 —— 删掉一个共享项目 = 炸掉整条项目线', () => {
    const p = plan(row({ twenty_refs: { visitId: 'v1', projectId: 'p1', projectUpdated: 'HAVEL-2026-001' } }));
    assert.ok(!p.refs.some((r) => r.object === 'project'));
    assert.match(p.skipped.map((s) => s.what).join(), /项目/);
  });

  it('🔴 追加到别人已有售后上的那条不删（`supportCaseAppended`）', () => {
    const p = plan(row({ twenty_refs: { supportCaseId: 'c1', supportCaseAppended: 'yes' } }));
    assert.equal(p.refs.length, 0);
    assert.match(p.skipped.map((s) => s.what).join(), /售后/);
  });

  it('没有复用痕迹时，新建的商机和项目照删', () => {
    const p = plan(row({ twenty_refs: { opportunityId: 'o1', projectId: 'p1' } }));
    assert.deepEqual(new Set(p.refs.map((r) => r.object)), new Set(['opportunity', 'project']));
    assert.equal(p.skipped.length, 0);
  });

  it('🔴 `workItems` 是**计数**不是 id —— 不能拿去删，而且要说出来', () => {
    const p = plan(row({ twenty_refs: { visitId: 'v1', workItems: '4' } }));
    assert.deepEqual(
      p.refs.map((r) => r.id),
      ['v1'],
    );
    // 「看不见」和「不存在」要分得开：删不掉的必须报出来
    assert.match(p.skipped.map((s) => s.what).join(), /4 条工作项/);
  });

  it('🔴 其余非 id 的键一个都不能变成删除目标', () => {
    const p = plan(
      row({
        twenty_refs: {
          recommitted: '2026-08-07T11:55:34.944Z',
          projectSkipped: '某某项目（没有编号）',
          annualProduction: '12000',
          intelCompleteness: '23',
          projectCodeGenerated: 'ALPIN-2026-001',
          oppCategoryUnchanged: '重录改了品类…',
          workItemsUpdated: '2',
          followupId: 'v1', // visitId 的别名，不该重复删
        },
      }),
    );
    assert.equal(p.refs.length, 0, `不该有删除目标，却算出了 ${JSON.stringify(p.refs)}`);
  });

  it('refs 整个是空的 → 什么都不删（还没入库的那些，issue #29 的主场景）', () => {
    assert.equal(plan(row({ status: 'ready' })).refs.length, 0);
    assert.equal(plan(row({ status: 'ready' })).source, 'none');
  });
});

describe('describe() —— 放进确认框里的那句话', () => {
  it('同类合并计数，单条不写数字', () => {
    const s = describePlan([
      { object: 'visit', id: 'v1' },
      { object: 'workItem', id: 'w1' },
      { object: 'workItem', id: 'w2' },
    ]);
    assert.equal(s, '拜访 · 2 条工作项');
  });

  it('空清单给空串（调用方据此说「这条没进过 CRM」）', () => {
    assert.equal(describePlan([]), '');
  });

  it('八个对象都有中文名 —— 界面上不该出现 productFitment 这种词', () => {
    for (const o of ['visit', 'productFitment', 'supportCase', 'opportunity', 'project', 'projectDoc', 'workItem', 'intelValue']) {
      assert.match(labelOf(o), /[一-龥]/, `${o} 没有中文名`);
    }
  });
});
