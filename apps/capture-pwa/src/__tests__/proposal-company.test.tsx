// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProposalItemView } from '../proposal-items';

const state = vi.hoisted(() => ({ create: vi.fn(), search: vi.fn(), confirm: vi.fn() }));
vi.mock('../auth', () => ({ getSession: () => ({ user: { locale: 'zh' } }) }));
vi.mock('../companies', () => ({ useCompanies: () => [] }));
vi.mock('../api', () => ({
  cachedEnums: async () => null, syncEnums: async () => null,
  confirmProposalItems: state.confirm, cancelProposalItem: vi.fn(), withdrawProposalItem: vi.fn(),
  inspectItemRecovery: vi.fn(), reconcileItemRecovery: vi.fn(),
  createCompany: state.create, searchCompanies: state.search,
  DuplicateError: class extends Error { constructor(public candidates: unknown[]) { super('possible_duplicate'); } },
}));
import { ProposalItemsCard } from '../components/ProposalItemsCard';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.create.mockReset().mockResolvedValue({ id: 'created-company', code: 'EXAMPLE-NEW', name: 'Example Caravan New', type: 'DEALER', group: '' });
  state.search.mockReset().mockResolvedValue([]);
  state.confirm.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const item = (id: string, name: string, hints: unknown): ProposalItemView => ({
  itemId: id, revisionId: `${id}-revision`, revision: 1, stagingId: 'staging', recordType: 'support', action: 'create',
  companyId: null, companyCode: null, target: null,
  fields: { summary: `${name} battery complaint`, suggested_company: name, suggestedCompanyFields: hints },
  confidence: {}, evidenceRefs: [], status: 'ready', confirmAfter: null, twentyRefs: null, createdRecords: [], error: null,
});
const button = (parent: ParentNode, text: string): HTMLButtonElement => [...parent.querySelectorAll('button')]
  .find((node) => node.textContent?.trim() === text)!;
const click = async (node: HTMLElement) => act(async () => node.click());

describe('per-item new-account suggestions reuse the controlled creation form', () => {
  it('one click prefills the selected item’s hints; saving remains explicit and confirmation uses its returned UUID', async () => {
    const name = 'Example Caravan New';
    await act(async () => root.render(<ProposalItemsCard stagingId="staging" items={[item('new', name, {
      name, country: 'France', accountType: 'DEALER',
    })]} />));
    await click(container.querySelector('[data-suggest]')!);
    expect(container.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!.value).toBe(name);
    expect(container.querySelector('select')!.value).toBe('FR');
    expect(button(container, 'dealer').dataset.on).toBe('true');
    expect(state.create).not.toHaveBeenCalled();
    expect(state.confirm).not.toHaveBeenCalled();
    await click(button(container, '查重并新建'));
    expect(state.create).toHaveBeenCalledExactlyOnceWith({ name, country: 'FR', accountType: 'DEALER', confirmedUnique: false });
    await click(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await click(button(container, '确认选中的 1 个事项'));
    expect(state.confirm).toHaveBeenCalledExactlyOnceWith('staging', [{ itemId: 'new', revision: 1, companyId: 'created-company' }]);
  });

  it('suggestions from two companies do not share form hints, and an invalid country cannot be submitted', async () => {
    await act(async () => root.render(<ProposalItemsCard stagingId="staging" items={[
      item('first', 'Example Caravan A', { name: 'Example Caravan A', country: 'Germany', accountType: 'OEM' }),
      item('second', 'Example Caravan B', { name: 'Example Caravan B', country: 'Invented country', accountType: 'DISTRIBUTOR' }),
    ]} />));
    const first = container.querySelector('[data-proposal-item="first"]')!;
    const second = container.querySelector('[data-proposal-item="second"]')!;
    await click(second.querySelector('[data-suggest]')!);
    expect(second.querySelector('input:not([type="checkbox"])')!.getAttribute('value')).toBe('Example Caravan B');
    expect(second.querySelector('select')!.value).toBe('');
    expect(second.querySelector('select')!.required).toBe(true);
    expect(button(second, 'distributor').dataset.on).toBe('true');
    expect(button(second, '查重并新建').disabled).toBe(true);
    expect(first.querySelector('select')).toBeNull();
    expect(first.querySelector('[data-suggest]')!.textContent).toContain('Example Caravan A');
    expect(container.textContent).not.toMatch(/经销商|分销商/);
    expect(state.create).not.toHaveBeenCalled();
  });
});
