import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ProposalItemError,
  sanitizeItemFields,
  summaryProposalItems,
  type ItemStatus,
} from '../proposal-model.ts';

const summarize = (...statuses: ItemStatus[]) => summaryProposalItems(statuses.map((status) => ({ status })));
const invalid = (run: () => unknown) => assert.throws(run,
  (error: unknown) => error instanceof ProposalItemError && error.status === 422);

describe('business item summary', () => {
  it('two battery faults and one inverter fault count as three items, regardless of CRM objects', () => {
    const items = [
      { itemId: 'battery-case-a', status: 'ready' as const, fields: { category: 'BATTERY', summary: '电池充不进电' }, createdRecords: [] },
      { itemId: 'battery-case-b', status: 'confirmed' as const, fields: { category: 'BATTERY', summary: '电池充不进电' },
        createdRecords: [{ object: 'visit', id: 'v1' }, { object: 'supportCase', id: 'c1' }] },
      { status: 'confirmed' as const, fields: { category: 'INVERTER', summary: '逆变器断电' },
        createdRecords: [{ object: 'visit', id: 'v2' }, { object: 'supportCase', id: 'c2' }] },
    ];
    const result = summaryProposalItems(items);
    assert.equal(result.total, 3);
    assert.equal(result.ready, 1);
    assert.equal(result.confirmed, 2);
    assert.equal(result.status, 'partial');
    assert.equal(result.partial, true);
  });
  it('partially committed siblings cannot be summarized as all committed', () => {
    const result = summarize('confirmed', 'ready', 'failed');
    assert.equal(result.status, 'partial');
    assert.equal(result.partial, true);
    assert.equal(result.failed, 1);
  });
  it('an unknown result outranks partial progress and all active work states', () => {
    const result = summarize('confirmed', 'committing', 'confirming', 'unknown');
    assert.equal(result.status, 'unknown');
    assert.equal(result.unknown, 1);
    assert.equal(result.partial, true);
  });
  it('ongoing commits and pending confirmation remain distinguishable', () => {
    assert.equal(summarize('ready', 'confirming').status, 'confirming');
    assert.equal(summarize('confirmed', 'committing', 'confirming').status, 'committing');
  });
  it('withdrawn and superseded siblings do not prevent the active item from being confirmed', () => {
    const result = summarize('confirmed', 'withdrawn', 'superseded');
    assert.equal(result.status, 'confirmed');
    assert.equal(result.partial, false);
    assert.equal(result.total, 3);
    assert.equal(result.withdrawn, 1);
    assert.equal(result.superseded, 1);
  });
  it('an entirely excluded batch is not reported as ready to commit', () => {
    assert.equal(summarize('withdrawn', 'withdrawn').status, 'withdrawn');
    assert.equal(summarize('withdrawn', 'superseded').status, 'withdrawn');
  });
  it('an entirely superseded batch identifies its replacement state', () => {
    assert.equal(summarize('superseded', 'superseded').status, 'superseded');
  });
  it('one case affecting eighteen units remains one case', () => {
    const fields = sanitizeItemFields({ summary: '同一批次电池掉电', affectedUnits: 18 }, 'support');
    assert.equal(fields['affectedUnits'], 18);
    assert.equal(summaryProposalItems([{ status: 'ready' }]).total, 1);
  });
});

describe('item field safety', () => {
  it('accepts supported record types and rejects unsupported record kinds instead of defaulting them', () => {
    for (const type of ['fitment', 'support', 'project', 'followup']) {
      assert.equal(sanitizeItemFields({ summary: 'known record' }, type)['recordType'], type);
    }
    for (const type of ['ticket', 'company', 'supportCase', 'workItem', 'document', '', 'SUPPORT']) {
      invalid(() => sanitizeItemFields({}, type));
    }
  });
  it('keeps accepted domain enums without inventing support data on another record type', () => {
    assert.deepEqual(sanitizeItemFields({ category: 'BATTERY', stage: 'SOP', sourceConfidence: 'CONFIRMED',
      caseStatus: 'RESOLVED', severity: 'HIGH' }, 'fitment'), {
      recordType: 'fitment', category: 'BATTERY', stage: 'SOP', sourceConfidence: 'CONFIRMED',
    });
    assert.deepEqual(sanitizeItemFields({ caseStatus: 'IN_PROGRESS', severity: 'HIGH' }, 'support'), {
      recordType: 'support', caseStatus: 'IN_PROGRESS', severity: 'HIGH',
    });
  });
  it('illegal category, stage, confidence, case status and severity do not reach the writer', () => {
    for (const key of ['category', 'stage', 'sourceConfidence', 'caseStatus', 'severity']) {
      invalid(() => sanitizeItemFields({ [key]: 'INVENTED_VALUE' }, 'support'));
    }
  });
  it('unknown fields, proposed UUID relations and recordType overrides do not pass through', () => {
    const result = sanitizeItemFields({ summary: '  原始事项  ', recordType: 'company',
      companyId: 'untrusted-company-uuid', companyCode: 'UNTRUSTED', supportCaseId: 'untrusted-case-uuid',
      projectId: 'untrusted-project-uuid', supplierId: 'untrusted-supplier-uuid', recordedById: 'untrusted-user-uuid',
      sourceInboxId: 'untrusted-source-uuid', twentyRefs: { caseId: 'foreign-case' }, arbitrary: 'hidden-write' }, 'support');
    assert.deepEqual(result, { summary: '原始事项', recordType: 'support' });
  });
  it('affected units must be a positive integer, not a quantity invented from words', () => {
    for (const affectedUnits of [0, -1, 2.5, '18', '好几台', NaN, Infinity]) {
      invalid(() => sanitizeItemFields({ affectedUnits }, 'support'));
    }
  });
  it('yearly vehicle production and category demand remain distinct', () => {
    const fields = sanitizeItemFields({ annualVehicles: '年产一万二左右', demandQuantity: '电池年需求 20000 件',
      demandBreakdown: '100Ah 30%，150Ah 70%', targetPrice: 'EUR 500/件' }, 'fitment');
    assert.equal(fields['annualVehicles'], '年产一万二左右');
    assert.equal(fields['demandQuantity'], '电池年需求 20000 件');
    assert.equal(fields['demandBreakdown'], '100Ah 30%，150Ah 70%');
    assert.equal(fields['targetPrice'], 'EUR 500/件');
  });
  it('nonpositive or nonnumeric budget does not create a false financial amount', () => {
    for (const budgetEur of [0, -1, NaN, Infinity, '100']) {
      assert.equal(sanitizeItemFields({ budgetEur }, 'project')['budgetEur'], undefined);
    }
    assert.equal(sanitizeItemFields({ budgetEur: 100.6 }, 'project')['budgetEur'], 101);
  });
});

describe('project writer contract and source provenance', () => {
  const rawWorkItem = {
    itemCode: 'TEST-2026-001-01', title: '接口和 Pin 定义', threadType: 'hardware',
    body: '逐条提供接口要求', priority: 'URGENT', ownerRole: '硬件工程团队',
    dueDate: '2026-10-14', customerDueDate: '2026-10-15', itemStatus: 'IN_PROGRESS',
    blockedByCodes: 'TEST-2026-001-02, TEST-2026-001-03', openQuestions: '客户尚未提供连接器型号',
  };
  it('retains the exact work item fields consumed by commitToTwenty', () => {
    const fields = sanitizeItemFields({ workItems: [rawWorkItem] }, 'followup');
    assert.deepEqual(fields['workItems'], [rawWorkItem]);
  });
  it('work item relationship UUIDs cannot bypass server resolution', () => {
    const fields = sanitizeItemFields({ workItems: [{ ...rawWorkItem, companyId: 'foreign-company',
      projectId: 'foreign-project', followupId: 'foreign-visit', blockedById: 'foreign-work-item' }] }, 'project');
    const work = (fields['workItems'] as Array<Record<string, unknown>>)[0]!;
    for (const key of ['companyId', 'projectId', 'followupId', 'blockedById']) assert.equal(work[key], undefined);
  });
  it('invalid work item enums become safe defaults, never illegal values', () => {
    const fields = sanitizeItemFields({ workItems: [{ ...rawWorkItem,
      threadType: 'fake-type', priority: 'fake-priority', itemStatus: 'fake-status' }] }, 'project');
    const work = (fields['workItems'] as Array<Record<string, unknown>>)[0]!;
    assert.equal(work['threadType'], 'other');
    assert.equal(work['priority'], 'MEDIUM');
    assert.equal(work['itemStatus'], 'OPEN');
  });
  it('malformed work item entries yield a controlled validation error', () => {
    invalid(() => sanitizeItemFields({ workItems: [null] }, 'project'));
  });
  it('document content, code, baseline and provenance survive the writer contract', () => {
    const document = { name: '客户规格基线', version: 'v1.0', docCode: 'SPEC-001',
      content: '# 规格\n\n客户确认 12V。未提供波特率。', isBaseline: true, docSource: 'CUSTOMER_ATTACHMENT' };
    assert.deepEqual(sanitizeItemFields({ document }, 'project')['document'], document);
  });
  it('each accepted document source remains explicit', () => {
    for (const docSource of ['CUSTOMER_ATTACHMENT', 'DICTATION', 'AGENT_GENERATED', 'INTERNAL']) {
      const fields = sanitizeItemFields({ document: { name: '来源记录', content: '未经客户书面确认', docSource } }, 'project');
      assert.equal((fields['document'] as Record<string, unknown>)['docSource'], docSource);
    }
  });
  it('an invalid document source is never promoted to customer-provided evidence', () => {
    const fields = sanitizeItemFields({ document: { content: 'AI 整理', docSource: 'CUSTOMER_CONFIRMED_BY_AI' } }, 'project');
    assert.equal((fields['document'] as Record<string, unknown>)['docSource'], 'AGENT_GENERATED');
  });
  it('unverified document attachment and relationship UUIDs do not pass generic field sanitation', () => {
    const fields = sanitizeItemFields({ document: { name: '文档', content: '来源正文', attachmentId: 'foreign-attachment',
      companyId: 'foreign-company', projectId: 'foreign-project' } }, 'project');
    const doc = fields['document'] as Record<string, unknown>;
    for (const key of ['attachmentId', 'companyId', 'projectId']) assert.equal(doc[key], undefined);
  });
  it('project fields used by the writer survive without injected UUID relations', () => {
    const project = { name: '电池项目', projectCode: 'TEST-2026-001', projectStage: 'SOP',
      ownerTeam: 'OE team', primaryProductName: 'Battery-A', plannedSop: '2026-12-01',
      specSummary: '保留规格', openQuestions: '认证待客户提供', budgetEur: 10000, sampleQty: 3 };
    const fields = sanitizeItemFields({ project: { ...project, companyId: 'foreign-company', opportunityId: 'foreign-opportunity' } }, 'project');
    assert.deepEqual(fields['project'], project);
  });
  it('nested project stage is validated rather than forwarded as arbitrary text', () => {
    invalid(() => sanitizeItemFields({ project: { name: '项目', projectStage: 'INVENTED_STAGE' } }, 'project'));
  });
  it('a fractional sample count is never silently rounded to an invented count', () => {
    let fields: Record<string, unknown>;
    try { fields = sanitizeItemFields({ project: { name: '项目', sampleQty: 1.7 } }, 'project'); }
    catch (error) { assert.ok(error instanceof ProposalItemError && error.status === 422); return; }
    assert.equal((fields['project'] as Record<string, unknown>)['sampleQty'], undefined);
  });
  it('invalid project dates do not reach the CRM date field', () => {
    for (const plannedSop of ['明年以后某天', '2026-13-01', '2026-02-30']) {
      let fields: Record<string, unknown>;
      try { fields = sanitizeItemFields({ project: { name: '项目', plannedSop } }, 'project'); }
      catch (error) { assert.ok(error instanceof ProposalItemError && error.status === 422); continue; }
      assert.equal((fields['project'] as Record<string, unknown>)['plannedSop'], undefined);
    }
  });
  it('work item deadlines reject invalid dates without replacing valid sibling fields', () => {
    for (const key of ['dueDate', 'customerDueDate']) {
      let fields: Record<string, unknown>;
      try { fields = sanitizeItemFields({ workItems: [{ ...rawWorkItem, [key]: '2026-02-30' }] }, 'followup'); }
      catch (error) { assert.ok(error instanceof ProposalItemError && error.status === 422); continue; }
      const work = (fields['workItems'] as Array<Record<string, unknown>>)[0]!;
      assert.equal(work[key], undefined);
      assert.equal(work['itemCode'], rawWorkItem.itemCode);
    }
  });
});
