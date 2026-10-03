import { describe, expect, it } from 'vitest';
import { itemRevisionKey, proposalItemCounts, selectedItemPayload, type ProposalItemView } from '../proposal-items';

const item = (id: string, patch: Partial<ProposalItemView> = {}): ProposalItemView => ({
  itemId: id, revisionId: `${id}-r1`, revision: 1, stagingId: 'staging', recordType: 'support', action: 'create',
  companyId: 'company-a', companyCode: 'EXAMPLE-A', target: null, fields: { summary: 'Same symptom' },
  confidence: {}, evidenceRefs: [], status: 'ready', confirmAfter: null, twentyRefs: null, createdRecords: null, error: null, ...patch,
});

describe('proposal selection boundary', () => {
  it('independent incidents with matching descriptions remain separate selection entries', () => {
    const items = [item('a'), item('b')];
    expect(selectedItemPayload(items, new Set(items.map(itemRevisionKey)), {})).toHaveLength(2);
  });
  it('only a selected current version with a known company is eligible', () => {
    const items = [item('a', { revision: 2 }), item('b', { companyId: null }), item('c', { status: 'unknown' }), item('d', { status: 'confirmed' })];
    expect(selectedItemPayload(items, new Set(['a:1', 'b:1', 'c:1', 'd:1']), {})).toEqual([]);
  });
  it('bound target company wins over a local company choice and only deliberate edits are sent', () => {
    const bound = item('a', { action: 'append', target: { type: 'supportCase', id: 'case-a', companyId: 'company-a' } });
    const payload = selectedItemPayload([bound], new Set(['a:1']), {
      'a:1': { company: { id: 'company-b', code: 'EXAMPLE-B', name: 'Example Caravan B', group: '', type: 'OEM' }, fields: { severity: 'HIGH' } },
    });
    expect(payload).toEqual([{ itemId: 'a', revision: 1, companyId: 'company-a', fields: { severity: 'HIGH' } }]);
  });
  it('reports successful, ambiguous and failed items independently', () => {
    expect(proposalItemCounts([item('a', { status: 'confirmed' }), item('b', { status: 'unknown' }), item('c', { status: 'failed' })]))
      .toEqual({ total: 3, confirmed: 1, ready: 0, working: 0, failed: 1, unknown: 1, inactive: 0 });
  });
});
