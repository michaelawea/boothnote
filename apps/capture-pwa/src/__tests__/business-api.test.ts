import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ fetch: vi.fn(), locale: 'en' }));
vi.mock('../auth', () => ({ authFetch: state.fetch, applyUser: vi.fn(), getSession: () => ({ user: { locale: state.locale } }) }));
vi.mock('../db', () => ({ db: {} }));

import { cancelProposalItem, confirmProposalItems, ProposalItemsError, withdrawProposalItem } from '../api';

beforeEach(() => { state.fetch.mockReset(); });
describe('independent item write API', () => {
  it('confirmation retains exact IDs and versions without sending unselected business data', async () => {
    state.fetch.mockResolvedValue(new Response('{}', { status: 200 }));
    await confirmProposalItems('staging-a', [{ itemId: 'item-b', revision: 3, companyId: 'company-a', fields: { severity: 'HIGH' } }]);
    const [path, request] = state.fetch.mock.calls[0]!;
    expect(path).toBe('/staging/staging-a/items/confirm');
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body)).toEqual({ items: [{ itemId: 'item-b', revision: 3, companyId: 'company-a', fields: { severity: 'HIGH' } }] });
  });

  it('undo identifies an item and its version rather than the whole staging row', async () => {
    state.fetch.mockResolvedValue(new Response('{}', { status: 200 }));
    await cancelProposalItem('item-b', 3);
    const [path, request] = state.fetch.mock.calls[0]!;
    expect(path).toBe('/proposal-items/item-b/confirm');
    expect(request.method).toBe('DELETE');
    expect(JSON.parse(request.body)).toEqual({ revision: 3 });
  });

  it('proposal withdrawal has its own endpoint and version, distinct from undo or CRM deletion', async () => {
    state.fetch.mockResolvedValue(new Response('{}', { status: 200 }));
    await withdrawProposalItem('item-b', 3);
    const [path, request] = state.fetch.mock.calls[0]!;
    expect(path).toBe('/proposal-items/item-b');
    expect(request.method).toBe('DELETE');
    expect(JSON.parse(request.body)).toEqual({ revision: 3 });
  });

  it('revision conflicts preserve a machine code and show a refresh instruction', async () => {
    state.fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'item_revision_conflict' }), { status: 409 }));
    const failure = await confirmProposalItems('staging-a', [{ itemId: 'item-b', revision: 3 }]).catch((cause) => cause);
    expect(failure).toBeInstanceOf(ProposalItemsError);
    expect(failure).toMatchObject({ code: 'item_revision_conflict', status: 409 });
    expect(failure.message).toBe('The item version or status changed. Refresh and check again.');
    expect(state.fetch).toHaveBeenCalledTimes(1);
  });

  it('server validation messages remain visible, and a missing error body still produces a useful message', async () => {
    state.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'missing_company', message: 'Select a company for item-b.' }), { status: 422 }));
    await expect(confirmProposalItems('staging-a', [{ itemId: 'item-b', revision: 3 }])).rejects.toThrow('Select a company for item-b.');
    state.fetch.mockResolvedValueOnce(new Response('Bad gateway', { status: 502 }));
    await expect(cancelProposalItem('item-b', 3)).rejects.toThrow('Item operation failed (HTTP 502)');
  });
});
