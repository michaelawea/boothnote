// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemRecovery, ItemRecoveryOperation } from '../api';
import type { ProposalItemView } from '../proposal-items';

const state = vi.hoisted(() => ({ locale: 'zh', inspect: vi.fn(), reconcile: vi.fn(), confirm: vi.fn() }));
vi.mock('../auth', () => ({ getSession: () => ({ user: { userCode: 'fixture-user', locale: state.locale } }) }));
vi.mock('../api', () => ({
  cachedEnums: async () => null, syncEnums: async () => null,
  confirmProposalItems: state.confirm, cancelProposalItem: vi.fn(), withdrawProposalItem: vi.fn(),
  inspectItemRecovery: state.inspect, reconcileItemRecovery: state.reconcile,
}));
vi.mock('../companies', () => ({ useCompanies: () => [{ id: 'company-a', code: 'EXAMPLE-A', name: 'Example Caravan A' }] }));
vi.mock('../components/CompanyPicker', () => ({ CompanyPicker: () => null }));
import { ProposalItemsCard } from '../components/ProposalItemsCard';

let container: HTMLDivElement;
let root: Root;
const operation = (patch: Partial<ItemRecoveryOperation> = {}): ItemRecoveryOperation => ({
  operationId: 'operation-a', role: 'support:update', state: 'unknown', verdict: 'verified',
  reason: 'request_postcondition_verified', recordType: 'supportCase', recordId: 'case-a',
  expected: { severity: 'HIGH' }, observed: { severity: 'HIGH' }, checkedAt: '2026-10-03T12:00:00Z', ...patch,
});
const report = (patch: Partial<ItemRecovery> = {}): ItemRecovery => ({
  itemId: 'item-a', revision: 1, status: 'unknown', recovered: false,
  operations: [operation()], manualReviewRequired: false, resolvedCount: 0, ...patch,
});
const item = (patch: Partial<ProposalItemView> = {}): ProposalItemView => ({
  itemId: 'item-a', revision: 1, revisionId: 'revision-a-1', stagingId: 'staging-a', recordType: 'support',
  action: 'update', companyId: 'company-a', companyCode: 'EXAMPLE-A', target: { type: 'supportCase', id: 'case-a', companyId: 'company-a' },
  fields: { summary: 'Example incident' }, confidence: {}, evidenceRefs: [], status: 'unknown',
  confirmAfter: null, twentyRefs: null, createdRecords: [], error: null, ...patch,
});
const button = (text: string): HTMLButtonElement | undefined => [...container.querySelectorAll('button')]
  .find((entry) => entry.textContent?.trim() === text);
const click = async (node: HTMLElement) => act(async () => node.click());
const render = async (value = item(), onDone?: () => void) => act(async () =>
  root.render(<ProposalItemsCard stagingId={value.stagingId} items={[value]} onDone={onDone} />));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.locale = 'zh';
  state.inspect.mockReset().mockResolvedValue(report());
  state.reconcile.mockReset().mockResolvedValue(report({ status: 'ready', recovered: true, resolvedCount: 1,
    operations: [operation({ state: 'succeeded' })] }));
  state.confirm.mockReset();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('unknown write recovery card', () => {
  it('reads and previews proof before saving, and recovered items still require a separate confirmation', async () => {
    const onDone = vi.fn();
    await render(item(), onDone);
    expect(state.inspect).not.toHaveBeenCalled();
    expect(button('保存核对结果')).toBeUndefined();
    await click(button('核对写入结果')!);
    expect(state.inspect).toHaveBeenCalledExactlyOnceWith('item-a', 1, expect.any(AbortSignal));
    expect(container.textContent).toContain('已核实 1 · 需人工处理 0 · 读取失败 0');
    expect(container.textContent).not.toContain('本次已保存');
    expect(container.textContent).toContain('已核实 CRM 字段符合本次写入预期。');
    expect(container.textContent).toContain('"severity": "HIGH"');
    expect(state.reconcile).not.toHaveBeenCalled();
    await click(button('保存核对结果')!);
    expect(state.reconcile).toHaveBeenCalledExactlyOnceWith('item-a', 1, expect.any(AbortSignal));
    expect(container.textContent).toContain('已恢复为待确认');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(state.confirm).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
    await render(item({ status: 'ready' }), onDone);
    expect(container.querySelector('[data-item-recovery]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it('a create without stable identity stays paused and does not offer automatic recovery', async () => {
    state.inspect.mockResolvedValue(report({ operations: [operation({ role: 'support:create', verdict: 'needs_manual_review',
      reason: 'create_identity_unproven', recordId: undefined, observed: undefined,
      expected: { requests: [{ method: 'POST', path: '/rest/supportCases', body: { name: 'Example incident' } }] },
    })], manualReviewRequired: true }));
    await render();
    await click(button('核对写入结果')!);
    expect(container.textContent).toContain('新建请求没有可唯一核实的 CRM 记录身份，需要人工核对。');
    expect(container.textContent).toContain('事项继续暂停写入');
    expect(container.textContent).toContain('没有可用的 CRM 读回证据。');
    expect(button('保存核对结果')).toBeUndefined();
    expect(state.reconcile).not.toHaveBeenCalled();
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it('saves a verified subset while clearly retaining unresolved steps and the unknown state', async () => {
    const unresolved = operation({ operationId: 'operation-b', role: 'visit:create', verdict: 'needs_manual_review', reason: 'create_identity_unproven' });
    state.inspect.mockResolvedValue(report({ operations: [operation(), unresolved], manualReviewRequired: true }));
    state.reconcile.mockResolvedValue(report({ operations: [operation({ state: 'succeeded' }), unresolved],
      manualReviewRequired: true, resolvedCount: 1 }));
    await render();
    await click(button('核对写入结果')!);
    await click(button('保存核对结果')!);
    expect(container.textContent).toContain('本次已保存 1 个步骤的核对结果。');
    expect(container.textContent).toContain('仍有步骤需要人工核对，事项继续暂停写入。');
    expect(container.textContent).not.toContain('已恢复为待确认');
    expect(button('保存核对结果')).toBeUndefined();
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it('lookup failures and request failures offer another read check, never a write retry', async () => {
    state.inspect.mockResolvedValueOnce(report({ operations: [operation({ verdict: 'lookup_failed', reason: 'crm_read_failed', observed: undefined })],
      manualReviewRequired: true })).mockRejectedValueOnce(new Error('Gateway unavailable'));
    await render();
    await click(button('核对写入结果')!);
    expect(container.textContent).toContain('读取失败 1');
    expect(button('保存核对结果')).toBeUndefined();
    await click(button('核对写入结果')!);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Gateway unavailable');
    expect(button('核对写入结果')!.disabled).toBe(false);
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it('same-tick double clicks issue one inspection and one save request', async () => {
    let finish!: (value: ItemRecovery) => void;
    state.inspect.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render();
    const inspect = button('核对写入结果')!;
    await act(async () => { inspect.click(); inspect.click(); });
    expect(state.inspect).toHaveBeenCalledTimes(1);
    await act(async () => finish(report()));
    let saveFinish!: (value: ItemRecovery) => void;
    state.reconcile.mockImplementationOnce(() => new Promise((resolve) => { saveFinish = resolve; }));
    const save = button('保存核对结果')!;
    await act(async () => { save.click(); save.click(); });
    expect(state.reconcile).toHaveBeenCalledTimes(1);
    await act(async () => saveFinish(report({ recovered: true, status: 'ready' })));
  });

  it('a late response for an older revision cannot populate or recover the new revision', async () => {
    let finish!: (value: ItemRecovery) => void;
    state.inspect.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const onDone = vi.fn();
    await render(item(), onDone);
    await click(button('核对写入结果')!);
    const oldSignal = state.inspect.mock.calls[0]![2] as AbortSignal;
    await render(item({ revision: 2, revisionId: 'revision-a-2' }), onDone);
    expect(oldSignal.aborted).toBe(true);
    await act(async () => finish(report({ recovered: true, status: 'ready' })));
    expect(container.querySelector('[data-item-recovery]')!.getAttribute('data-item-recovery')).toBe('item-a:2');
    expect(container.textContent).not.toContain('已核实 1');
    expect(container.textContent).not.toContain('已恢复为待确认');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('a save response arriving after a version change cannot report recovery or refresh the new card', async () => {
    let finish!: (value: ItemRecovery) => void;
    state.reconcile.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const onDone = vi.fn();
    await render(item(), onDone);
    await click(button('核对写入结果')!);
    await click(button('保存核对结果')!);
    const oldSignal = state.reconcile.mock.calls[0]![2] as AbortSignal;
    await render(item({ revision: 2, revisionId: 'revision-a-2' }), onDone);
    expect(oldSignal.aborted).toBe(true);
    await act(async () => finish(report({ recovered: true, status: 'ready', resolvedCount: 1 })));
    expect(container.textContent).not.toContain('已恢复为待确认');
    expect(container.textContent).not.toContain('本次已保存');
    expect(onDone).not.toHaveBeenCalled();
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it('a mismatched response is rejected instead of displaying another item’s proof', async () => {
    state.inspect.mockResolvedValue(report({ itemId: 'different-item', operations: [operation({ recordId: 'different-case' })] }));
    await render();
    await click(button('核对写入结果')!);
    expect(container.textContent).toContain('事项版本或状态已变化');
    expect(container.textContent).not.toContain('different-case');
    expect(button('保存核对结果')).toBeUndefined();
  });

  it('a save conflict remains visible and cannot be mistaken for successful recovery', async () => {
    state.reconcile.mockRejectedValue(new Error('The proposal changed. Refresh and check again.'));
    const onDone = vi.fn();
    await render(item(), onDone);
    await click(button('核对写入结果')!);
    await click(button('保存核对结果')!);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('The proposal changed.');
    expect(container.textContent).not.toContain('已恢复为待确认');
    expect(state.confirm).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('English accounts see translated controls, verdicts and manual-review reasons', async () => {
    state.locale = 'en';
    state.inspect.mockResolvedValue(report({ operations: [operation({ verdict: 'needs_manual_review', reason: 'create_identity_unproven' })],
      manualReviewRequired: true }));
    await render();
    await click(button('Check write result')!);
    const panel = container.querySelector('[data-item-recovery]')!;
    expect(panel.textContent).toContain('Needs manual review');
    expect(panel.textContent).toContain('no uniquely verifiable CRM record identity');
    expect(panel.textContent).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
