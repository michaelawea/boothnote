import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { timelineBody } from '../twenty.ts';

/**
 * Timeline 事件的载荷（D61）。**零依赖，不发任何请求。**
 *
 * 这一层测的是「Twenty 前端认不认」——它的判据是我们读它的 bundle 读出来的，
 * 不是文档里写的，所以每一条都是一个**具体的渲染失败**：
 *   · 名字前缀不对 → 事件被当成普通事件，反查不到对象元数据，chip 渲染不出来
 *   · 少了 linkedRecordId / linkedObjectMetadataId → `f6()` 为假，同上
 *   · target 外键名拼错一个字母 → 事件存进去了，但**任何页面都看不见它**
 *
 * 最后那条是最危险的：写入成功、日志干净、CRM 里什么都没有 ——
 * 正是 维护者 2026-08-03 截图里那种「白的」。
 */

const META = '951db3f9-41a2-45f5-a983-de5a0bf69a8f';

describe('timeline 载荷', () => {
  it('名字是 linked-<对象>.created —— 前端靠这个前缀反查对象元数据', () => {
    const b = timelineBody('visit', META, 'v1', '拜访', { company: 'c1' });
    assert.equal(b.name, 'linked-visit.created');
  });

  it('chip 要的三样一个都不能少', () => {
    const b = timelineBody('projectDoc', META, 'd1', '需求规格 v0.1', { project: 'p1' });
    assert.equal(b.linkedRecordId, 'd1');
    assert.equal(b.linkedRecordCachedName, '需求规格 v0.1');
    assert.equal(b.linkedObjectMetadataId, META);
  });

  it('target 外键名要和 Twenty 的字段名逐字一致（驼峰不能塌）', () => {
    const b = timelineBody('workItem', META, 'w1', 'T-04', {
      company: 'c1',
      contributor: 'u1',
      project: 'p1',
      supportCase: 's1',
      productFitment: 'pf1',
    });
    assert.equal(b.targetCompanyId, 'c1');
    assert.equal(b.targetContributorId, 'u1');
    assert.equal(b.targetProjectId, 'p1');
    // 这两个是最容易写成 targetSupportcaseId / targetProductfitmentId 的
    assert.equal(b.targetSupportCaseId, 's1');
    assert.equal(b.targetProductFitmentId, 'pf1');
  });

  it('空的 target 不出现在载荷里 —— 传 null 会被 Twenty 当成「解除关联」', () => {
    const b = timelineBody('visit', META, 'v1', '拜访', {
      company: 'c1',
      contributor: null,
      project: undefined,
    });
    assert.equal(b.targetCompanyId, 'c1');
    assert.ok(!('targetContributorId' in b));
    assert.ok(!('targetProjectId' in b));
  });

  it('名字是当时的快照，超长截断 —— 它叫 Cached 就是这个意思', () => {
    const b = timelineBody('project', META, 'p1', 'x'.repeat(500), { company: 'c1' });
    assert.equal(String(b.linkedRecordCachedName).length, 200);
  });

  it('happensAt 可以指定；不指定就是现在', () => {
    const b = timelineBody('visit', META, 'v1', '拜访', { company: 'c1' }, '2026-08-28T09:00:00.000Z');
    assert.equal(b.happensAt, '2026-08-28T09:00:00.000Z');
    const now = timelineBody('visit', META, 'v1', '拜访', { company: 'c1' });
    assert.ok(!Number.isNaN(Date.parse(String(now.happensAt))));
  });
});
