// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuestionSnapshot } from '../../../../shared/agent-questions.mjs';
import type { ProposalItemView } from '../proposal-items';

const state = vi.hoisted(() => ({ locale: 'zh', confirm: vi.fn(), cancel: vi.fn(), withdraw: vi.fn() }));
vi.mock('../auth', () => ({ getSession: () => ({ user: { locale: state.locale } }) }));
vi.mock('../api', () => ({
  confirmProposalItems: state.confirm, cancelProposalItem: state.cancel, withdrawProposalItem: state.withdraw,
  cachedEnums: async () => null, syncEnums: async () => null,
}));
vi.mock('../companies', () => ({ useCompanies: () => [
  { id: 'company-a', code: 'EXAMPLE-A', name: 'Example Caravan A', group: '', type: 'OEM' },
  { id: 'company-b', code: 'EXAMPLE-B', name: 'Example Caravan B', group: '', type: 'OEM' },
] }));
vi.mock('../components/CompanyPicker', () => ({ CompanyPicker: ({ onPick }: { onPick: (company: unknown) => void }) =>
  <button type="button" onClick={() => onPick({ id: 'company-b', code: 'EXAMPLE-B', name: 'Example Caravan B' })}>Pick Example B</button> }));

import { QuestionCard } from '../components/QuestionCard';
import { ProposalItemsCard } from '../components/ProposalItemsCard';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.locale = 'zh';
  state.confirm.mockReset().mockResolvedValue(undefined);
  state.cancel.mockReset().mockResolvedValue(undefined);
  state.withdraw.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const button = (label: string): HTMLButtonElement => [...container.querySelectorAll('button')]
  .find((node) => node.textContent?.trim() === label)!;
const click = async (node: HTMLElement) => act(async () => node.click());
const question: QuestionSnapshot = {
  questionId: 'question-1', question: 'Append to the existing battery case?', kind: 'target',
  expectedRevision: 'proposal-fingerprint-1', status: 'pending', recommendedOptionId: 'append',
  choices: [
    { optionId: 'append', label: 'Use existing case', action: 'append', target: {
      type: 'supportCase', id: 'case-1', companyId: 'company-a', action: 'append', code: 'CASE-A',
    } },
    { optionId: 'create', label: 'Create separate case', action: 'create' },
    { optionId: 'clarify', label: 'Need more context', action: 'clarify' },
  ],
};
const item = (id: string, patch: Partial<ProposalItemView> = {}): ProposalItemView => ({
  itemId: id, revisionId: `revision-${id}-1`, revision: 1, stagingId: 'staging-1', recordType: 'support',
  action: 'create', companyId: 'company-a', companyCode: 'EXAMPLE-A', target: null,
  fields: { summary: 'Battery complaint', details: 'The same symptom can describe distinct incidents.' },
  confidence: {}, evidenceRefs: [], status: 'ready', confirmAfter: null, twentyRefs: null,
  createdRecords: null, error: null, ...patch,
});

describe('structured question card', () => {
  it('a recommendation does not submit; a click binds the exact option and proposal token', async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    const onLegacyAnswer = vi.fn();
    await act(async () => root.render(<QuestionCard question={question} onAnswer={onAnswer} onLegacyAnswer={onLegacyAnswer} />));
    expect(onAnswer).not.toHaveBeenCalled();
    await click(container.querySelector('[data-question-option="append"]')!);
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ questionId: 'question-1', expectedRevision: 'proposal-fingerprint-1',
      optionId: 'append', displayText: 'Use existing case' });
    expect(onLegacyAnswer).not.toHaveBeenCalled();
    expect(container.textContent).toContain('回答已保存在本机，等待同步。');
    expect(container.textContent).not.toContain('已回答：');
    expect([...container.querySelectorAll('button')].every((node) => node.disabled)).toBe(true);
  });

  it('two immediate clicks create one local answer and a save error permits a deliberate retry', async () => {
    let reject!: (cause: Error) => void;
    const onAnswer = vi.fn().mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }))
      .mockResolvedValue(undefined);
    await act(async () => root.render(<QuestionCard question={question} onAnswer={onAnswer} />));
    const option = container.querySelector<HTMLButtonElement>('[data-question-option="create"]')!;
    await act(async () => { option.click(); option.click(); });
    expect(onAnswer).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error('Local storage unavailable')));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Local storage unavailable');
    expect(option.disabled).toBe(false);
    await click(option);
    expect(onAnswer).toHaveBeenCalledTimes(2);
  });

  it('clarification collects text without treating its option as a confirmed target', async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(<QuestionCard question={question} onAnswer={onAnswer} />));
    await click(container.querySelector('[data-question-option="clarify"]')!);
    expect(onAnswer).not.toHaveBeenCalled();
    expect(button('提交回答').disabled).toBe(true);
    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'A separate vehicle');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('提交回答'));
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ questionId: 'question-1', expectedRevision: 'proposal-fingerprint-1',
      optionId: 'clarify', text: 'A separate vehicle', displayText: 'A separate vehicle' });
  });

  it.each(['answered', 'stale', 'expired'] as const)('%s questions cannot be answered again', async (status) => {
    const onAnswer = vi.fn();
    await act(async () => root.render(<QuestionCard question={{ ...question, status, selectedOptionId: 'append' }} onAnswer={onAnswer} />));
    expect([...container.querySelectorAll('button')].every((node) => node.disabled)).toBe(true);
    await click(container.querySelector('button')!);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('legacy text options keep their existing continuation path', async () => {
    const legacy = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(<QuestionCard question={{ question: 'Which category?', options: ['Battery'] }} onLegacyAnswer={legacy} />));
    await click(button('Battery'));
    expect(legacy).toHaveBeenCalledExactlyOnceWith('Battery');
  });

  it('live answer receipts survive a card remount and appear in the current account language', async () => {
    state.locale = 'en';
    const onAnswer = vi.fn();
    await act(async () => root.render(<QuestionCard question={question} onAnswer={onAnswer} localAnswerState="queued" />));
    expect(container.textContent).toContain('Answer saved on this device, waiting to sync.');
    expect([...container.querySelectorAll('button')].every((node) => node.disabled)).toBe(true);
  });

  it('a rejected queued answer reports failure instead of promising another automatic sync', async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(<QuestionCard question={question} onAnswer={onAnswer} />));
    await click(container.querySelector('[data-question-option="append"]')!);
    await act(async () => root.render(<QuestionCard question={question} onAnswer={onAnswer}
      localAnswerState="failed" localAnswerError="question_stale" />));
    expect(container.textContent).toContain('回答未同步');
    expect(container.textContent).not.toContain('等待同步');
    expect(container.textContent).toContain('question_stale');
    expect([...container.querySelectorAll('button')].every((node) => node.disabled)).toBe(true);
  });
});

describe('independent proposal items card', () => {
  it('equal symptom text retains separate items, and confirmation sends only the checked item', async () => {
    await act(async () => root.render(<ProposalItemsCard stagingId="staging-1" items={[item('first'), item('second')]} />));
    expect(container.querySelectorAll('[data-proposal-item]')).toHaveLength(2);
    expect(button('确认选中的 0 个事项').disabled).toBe(true);
    await click(container.querySelector('input')!);
    await click(button('确认选中的 1 个事项'));
    expect(state.confirm).toHaveBeenCalledExactlyOnceWith('staging-1', [{ itemId: 'first', revision: 1, companyId: 'company-a' }]);
    expect(container.querySelector<HTMLButtonElement>('[data-proposal-item="first"] input')?.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('[data-proposal-item="second"] input')?.disabled).toBe(false);
  });

  it('a newer revision never inherits selection or local field decisions from the old version', async () => {
    await act(async () => root.render(<ProposalItemsCard stagingId="staging-1" items={[item('first')]} />));
    await click(container.querySelector('input')!);
    await act(async () => root.render(<ProposalItemsCard stagingId="staging-1" items={[item('first', { revision: 2, revisionId: 'revision-first-2' })]} />));
    expect(container.querySelector<HTMLInputElement>('input')!.checked).toBe(false);
    expect(button('确认选中的 0 个事项').disabled).toBe(true);
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it('requires an explicit existing company and submits its ID, rather than a company name', async () => {
    await act(async () => root.render(<ProposalItemsCard stagingId="staging-1" items={[item('first', { companyId: null, companyCode: null })]} />));
    expect(container.querySelector<HTMLInputElement>('input')!.disabled).toBe(true);
    await click(button('Pick Example B'));
    await click(container.querySelector('input')!);
    await click(button('确认选中的 1 个事项'));
    expect(state.confirm).toHaveBeenCalledExactlyOnceWith('staging-1', [{ itemId: 'first', revision: 1, companyId: 'company-b' }]);
  });

  it('partial successes and unknown outcomes remain distinct; an unknown item offers no retry', async () => {
    await act(async () => root.render(<ProposalItemsCard stagingId="staging-1" items={[
      item('done', { status: 'confirmed', twentyRefs: { supportCase: 'case-a' } }),
      item('failed', { status: 'failed', error: 'Validation failed' }),
      item('uncertain', { status: 'unknown', error: 'Remote write timeout' }),
    ]} />));
    expect(container.textContent).toContain('已入库 1');
    expect(container.textContent).toContain('失败 1');
    expect(container.textContent).toContain('结果不明 1');
    expect(container.querySelector<HTMLInputElement>('[data-proposal-item="done"] input')!.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('[data-proposal-item="failed"] input')!.disabled).toBe(false);
    expect(container.querySelector<HTMLInputElement>('[data-proposal-item="uncertain"] input')!.disabled).toBe(true);
    expect(container.querySelectorAll('[data-proposal-item="uncertain"] button')).toHaveLength(0);
  });

  it('cancels one exact revision without cancelling other queued items', async () => {
    const queued = { status: 'confirming' as const, confirmAfter: new Date(Date.now() + 30_000).toISOString() };
    await act(async () => root.render(<ProposalItemsCard stagingId="staging-1" items={[item('first', queued), item('second', queued)]} />));
    await click(container.querySelector('[data-proposal-item="second"] button')!);
    expect(state.cancel).toHaveBeenCalledExactlyOnceWith('second', 1);
    expect(container.querySelector('[data-proposal-item="first"] button')).not.toBeNull();
    expect(container.querySelector('[data-proposal-item="second"] button')).toBeNull();
  });

  it('an expired undo window disables its action and does not claim the item is committed', async () => {
    await act(async () => root.render(<ProposalItemsCard stagingId="staging-1" items={[item('first', {
      status: 'confirming', confirmAfter: new Date(Date.now() - 1000).toISOString(),
    })]} />));
    expect(button('撤销此事项').disabled).toBe(true);
    expect(container.querySelector('[data-proposal-item="first"]')!.textContent).toContain('正在写入 CRM…');
    expect(container.querySelector('[data-proposal-item="first"]')!.textContent).not.toContain('已入库');
  });

  it('a confirmed queue that later fails permits retry of only that item', async () => {
    await act(async () => root.render(<ProposalItemsCard stagingId="staging-1" items={[item('first')]} />));
    await click(container.querySelector('input')!);
    await click(button('确认选中的 1 个事项'));
    await act(async () => root.render(<ProposalItemsCard stagingId="staging-1" items={[item('first', { status: 'failed', error: 'Known validation failure' })]} />));
    expect(container.querySelector<HTMLInputElement>('input')!.disabled).toBe(false);
    await click(container.querySelector('input')!);
    await click(button('确认选中的 1 个事项'));
    expect(state.confirm).toHaveBeenCalledTimes(2);
  });

  it('withdraws only an explicitly accepted ready proposal version, keeping CRM writes separate', async () => {
    const prompt = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await act(async () => root.render(<ProposalItemsCard stagingId="staging-1" items={[item('first')]} />));
    await click(button('撤回这版提案'));
    expect(state.withdraw).not.toHaveBeenCalled();
    await click(button('撤回这版提案'));
    expect(prompt).toHaveBeenLastCalledWith('撤回当前提案版本？已写入的记录会保留。');
    expect(state.withdraw).toHaveBeenCalledExactlyOnceWith('first', 1);
    expect(state.cancel).not.toHaveBeenCalled();
    expect(state.confirm).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('input')!.disabled).toBe(true);
    expect(container.querySelector('[data-proposal-item="first"]')!.textContent).toContain('已撤回');
    prompt.mockRestore();
  });

  it('renders all nested project tasks as business fields without flattening to one task', async () => {
    await act(async () => root.render(<ProposalItemsCard stagingId="staging-1" items={[item('first', { recordType: 'project', fields: {
      project: { name: 'Example project', projectCode: 'PROJECT-A' },
      workItems: [{ title: 'Check battery', body: 'First task details' }, { title: 'Check inverter', body: 'Second task details' }],
    } })]} />));
    expect(container.textContent).toContain('Example project');
    expect(container.textContent).toContain('Check battery');
    expect(container.textContent).toContain('First task details');
    expect(container.textContent).toContain('Check inverter');
    expect(container.textContent).toContain('Second task details');
    expect(container.textContent).not.toContain('"workItems"');
  });

  it('keeps each incident’s evidence attached to that specific item', async () => {
    await act(async () => root.render(<ProposalItemsCard stagingId="staging-1" items={[
      item('first', { evidenceRefs: [{ messageId: 'source-first', quote: 'The first vehicle failed.' }] }),
      item('second', { evidenceRefs: [{ attachmentId: 'source-second-photo', quote: 'The second vehicle has the same symptom.' }] }),
    ]} />));
    const first = container.querySelector('[data-proposal-item="first"]')!;
    const second = container.querySelector('[data-proposal-item="second"]')!;
    expect(first.textContent).toContain('The first vehicle failed.');
    expect(first.textContent).not.toContain('The second vehicle');
    expect(second.textContent).toContain('The second vehicle has the same symptom.');
    expect(second.textContent).toContain('source-second-photo');
  });
});
