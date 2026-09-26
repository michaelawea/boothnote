import { describe, expect, it } from 'vitest';

import { buildGroups, identityOf, projectCodeOf } from '../pages/Board';
import type { Company, RecordRow } from '../db';

/**
 * 看板按项目聚合（issue #18 · D92）。
 *
 * 🔴 **这里测的是那条硬约束：分组键是编号，不是名字。**
 * §4.2 第 3 条不是预防性条款 —— 销售那份 Excel 已经因为用名字做关联键而散架了
 * （品牌名单交集 32/61，集团名三份交集为 0）。所以下面既测「同一个编号必须并成一张卡」，
 * 也测「名字一样但编号不同的绝不并」。
 */

const companies: Company[] = [
  { id: 'u-havel', code: 'EHG-HAVEL', name: 'Havel' },
  { id: 'u-alpin', code: 'KNA', name: 'Alpin Tannhof' },
] as unknown as Company[];

let seq = 0;
const rec = (over: Partial<RecordRow> & { at: string }): RecordRow =>
  ({
    id: `r${++seq}`,
    inbox_id: `i${seq}`,
    thread_id: null,
    status: 'ready',
    title: null,
    text: null,
    extracted: {},
    confidence: null,
    confirmed_fields: null,
    twenty_refs: null,
    confirm_after: null,
    partial: null,
    suggested_company: null,
    error: null,
    resolved_company_id: null,
    company_code: null,
    audio_seconds: null,
    visit_label: null,
    captured_at: over.at,
    updated_at: over.at,
    supersedes: 0,
    attachments: 0,
    ...over,
  }) as RecordRow;

/** 一条带项目提案的记录。 */
const proj = (o: {
  at: string;
  code?: string | null;
  name?: string;
  company?: string;
  category?: string;
  status?: string;
}) =>
  rec({
    at: o.at,
    status: o.status ?? 'ready',
    company_code: o.company ?? 'EHG-HAVEL',
    extracted: {
      companyCode: o.company ?? 'EHG-HAVEL',
      category: o.category ?? 'BATTERY',
      project: { projectCode: o.code ?? null, name: o.name ?? 'CI-Bus 电池项目' },
    },
  });

describe('projectCodeOf —— 编号从哪读', () => {
  it('人改的 > agent 提的', () => {
    const r = rec({
      at: '2026-08-07T09:00:00Z',
      extracted: { project: { projectCode: 'EHG-HAVEL-2026-001' } },
      confirmed_fields: { projectCode: 'EHG-HAVEL-2026-009' },
    });
    expect(projectCodeOf(r)).toBe('EHG-HAVEL-2026-009');
  });

  it('🔴 D91 之前入库的老记录靠回执认出来 —— 它的 extracted 里没有编号', () => {
    const r = rec({
      at: '2026-08-01T09:00:00Z',
      status: 'confirmed',
      extracted: { project: { name: 'CI-Bus 电池项目' } },
      twenty_refs: { projectCodeGenerated: 'EHG-HAVEL-2026-001' },
    });
    expect(projectCodeOf(r)).toBe('EHG-HAVEL-2026-001');
  });

  it('大小写不算数 —— CRM 里 abc-001 和 ABC-001 是同一个项目', () => {
    expect(projectCodeOf(rec({ at: 'x', extracted: { projectCode: 'ehg-havel-2026-001' } }))).toBe(
      'EHG-HAVEL-2026-001',
    );
  });

  it('没有就是没有', () => {
    expect(projectCodeOf(rec({ at: 'x' }))).toBe(null);
    expect(projectCodeOf(rec({ at: 'x', extracted: { project: { projectCode: '  ' } } }))).toBe(null);
  });
});

describe('identityOf —— D56 的项目身份', () => {
  it('客户代号 + 品类', () => {
    expect(identityOf(proj({ at: 'x' }), companies)).toBe('EHG-HAVEL|BATTERY');
  });

  it('缺一个就定不了 —— 不猜', () => {
    expect(identityOf(rec({ at: 'x', company_code: 'KNA' }), companies)).toBe(null);
    expect(identityOf(rec({ at: 'x', extracted: { category: 'BATTERY' } }), companies)).toBe(null);
  });
});

describe('buildGroups —— 按项目', () => {
  const g = (rows: RecordRow[]) => buildGroups(rows, 'project', companies, null);

  it('🔴 同一个编号的两条对话只占一张卡（issue #18 的验收第一条）', () => {
    const rows = [
      proj({ at: '2026-08-07T15:00:00Z', code: 'EHG-HAVEL-2026-001', name: 'CI-Bus 时间线补充' }),
      proj({ at: '2026-08-07T09:00:00Z', code: 'EHG-HAVEL-2026-001', name: 'CI-Bus 电池项目' }),
    ];
    const out = g(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.projectCode).toBe('EHG-HAVEL-2026-001');
    expect(out[0]!.rows).toHaveLength(2);
  });

  it('🔴 名字一模一样但编号不同 → 两张卡。**键是编号不是名字**', () => {
    const rows = [
      proj({ at: '2026-08-07T15:00:00Z', code: 'KNA-2026-001', name: '电池项目', company: 'KNA' }),
      proj({ at: '2026-08-07T09:00:00Z', code: 'EHG-HAVEL-2026-001', name: '电池项目' }),
    ];
    expect(g(rows).map((x) => x.projectCode).sort()).toEqual(['EHG-HAVEL-2026-001', 'KNA-2026-001']);
  });

  it('🔴 编号一样但名字不同 → 一张卡（「Istra 电池项目」和「Istra 锂电项目」是同一个）', () => {
    const rows = [
      proj({ at: '2026-08-07T15:00:00Z', code: 'EHG-HAVEL-2026-001', name: 'Havel 锂电项目' }),
      proj({ at: '2026-08-07T09:00:00Z', code: 'EHG-HAVEL-2026-001', name: 'Havel 电池项目' }),
    ];
    const out = g(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe('Havel 锂电项目'); // 最新那条的叫法，但键没变
  });

  it('同一个 D56 身份下有人拿到了编号 → 没编号的那几条也进同一张卡', () => {
    const rows = [
      proj({ at: '2026-08-07T15:00:00Z', code: 'EHG-HAVEL-2026-001' }),
      // 同一家客户、同一个品类，但这条压根没走 propose_project
      rec({
        at: '2026-08-07T09:00:00Z',
        company_code: 'EHG-HAVEL',
        extracted: { companyCode: 'EHG-HAVEL', category: 'BATTERY' },
      }),
    ];
    const out = g(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.projectCode).toBe('EHG-HAVEL-2026-001');
    expect(out[0]!.rows).toHaveLength(2);
  });

  it('🔴 没有项目编号的（选型/售后）行为不变 —— 仍按 D76 的「客户代号|品类」分', () => {
    const rows = [
      rec({
        at: '2026-08-07T15:00:00Z',
        company_code: 'KNA',
        extracted: { companyCode: 'KNA', category: 'INVERTER' },
      }),
      rec({
        at: '2026-08-07T09:00:00Z',
        company_code: 'EHG-HAVEL',
        extracted: { companyCode: 'EHG-HAVEL', category: 'BATTERY' },
      }),
    ];
    const out = g(rows);
    expect(out).toHaveLength(2);
    expect(out.every((x) => x.projectCode === null)).toBe(true);
    expect(out.map((x) => x.key)).toEqual(['p:KNA|INVERTER', 'p:EHG-HAVEL|BATTERY']);
  });

  it('客户或品类缺一个 → 「未归入项目」，而且永远沉底', () => {
    const rows = [
      rec({ at: '2026-08-05T09:00:00Z' }), // 什么都没有 —— 最老的一条
      proj({ at: '2026-08-07T09:00:00Z', code: 'EHG-HAVEL-2026-001' }),
    ];
    const out = g(rows);
    expect(out.map((x) => x.key)).toEqual(['p:#EHG-HAVEL-2026-001', 'p:~none']);
  });

  it('组的先后按各自最新那条排', () => {
    const rows = [
      proj({ at: '2026-08-07T15:00:00Z', code: 'KNA-2026-001', company: 'KNA' }),
      proj({ at: '2026-08-07T12:00:00Z', code: 'EHG-HAVEL-2026-001' }),
      proj({ at: '2026-08-06T08:00:00Z', code: 'KNA-2026-001', company: 'KNA' }),
    ];
    expect(g(rows).map((x) => x.projectCode)).toEqual(['KNA-2026-001', 'EHG-HAVEL-2026-001']);
  });
});

describe('buildGroups —— 另外两种分组一个字没改', () => {
  it('按时间还是一天一组', () => {
    const rows = [proj({ at: '2026-08-07T15:00:00Z', code: 'X-1' }), proj({ at: '2026-08-06T15:00:00Z', code: 'X-1' })];
    const out = buildGroups(rows, 'time', companies, null);
    expect(out.map((x) => x.key)).toEqual(['t:2026-08-07', 't:2026-08-06']);
    expect(out.every((x) => x.projectCode === null)).toBe(true);
  });

  it('按客户还是一家一组 —— 编号不参与', () => {
    const rows = [
      proj({ at: '2026-08-07T15:00:00Z', code: 'EHG-HAVEL-2026-001', category: 'BATTERY' }),
      proj({ at: '2026-08-07T12:00:00Z', code: 'EHG-HAVEL-2026-002', category: 'INVERTER' }),
    ];
    const out = buildGroups(rows, 'company', companies, null);
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toBe('c:EHG-HAVEL');
  });
});
