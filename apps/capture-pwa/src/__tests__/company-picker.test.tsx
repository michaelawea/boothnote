// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Company } from '../db';

const state = vi.hoisted(() => ({ locale: 'zh', items: [] as Company[], search: vi.fn(), create: vi.fn() }));
vi.mock('../companies', () => ({ useCompanies: () => state.items }));
vi.mock('../auth', () => ({ getSession: () => ({ user: { locale: state.locale } }) }));
vi.mock('../api', () => ({
  searchCompanies: state.search, createCompany: state.create,
  DuplicateError: class extends Error {
    constructor(public candidates: Array<Company & { score: number }>) { super('possible_duplicate'); }
  },
}));

import { CompanyPicker } from '../components/CompanyPicker';
import { DuplicateError } from '../api';

const suggestion = { name: 'Example Caravan', country: 'France', accountType: 'DEALER' };
const saved: Company = { id: 'new-id', code: 'EXAMPLE', name: suggestion.name, group: '', type: 'DEALER' };
let container: HTMLDivElement;
let root: Root;
let onPick: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.locale = 'zh';
  state.items = [];
  state.search.mockReset().mockResolvedValue([]);
  state.create.mockReset().mockResolvedValue(saved);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  onPick = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = async (fields: unknown = suggestion) => {
  await act(async () => root.render(<CompanyPicker onPick={onPick} suggested={suggestion.name} suggestedFields={fields} />));
};
const button = (text: string) => [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === text)!;
const click = async (node: HTMLElement) => act(async () => node.click());
const setInput = async (node: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const selectCountry = async (value: string) => {
  await act(async () => {
    const select = container.querySelector('select')!;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
const openSuggestion = async () => click(container.querySelector('[data-suggest]')!);

describe('点击建议建客与受控国家', () => {
  it('点击一次建议就预填；搜索词不能覆盖所选建议，不自动保存', async () => {
    await render();
    await setInput(container.querySelector('input')!, 'Other search');
    await openSuggestion();
    expect(container.querySelector('input')!.value).toBe(suggestion.name);
    expect(container.querySelector('select')!.value).toBe('FR');
    expect(button('dealer').dataset.on).toBe('true');
    expect(state.create).not.toHaveBeenCalled();
    expect(state.search).not.toHaveBeenCalled();
    expect(container.textContent).not.toMatch(/经销商|分销商/);
  });

  it('未知国家和类型留空；国家没有手输入口，未选时不能保存', async () => {
    await render({ ...suggestion, country: 'NotARealCountry', accountType: 'OTHER' });
    await openSuggestion();
    expect(container.querySelectorAll('input')).toHaveLength(1);
    expect(container.querySelector('select')!.required).toBe(true);
    expect(container.querySelector('select')!.value).toBe('');
    expect(button('dealer').dataset.on).toBe('false');
    expect(button('查重并新建').disabled).toBe(true);
    await click(button('dealer'));
    expect(button('查重并新建').disabled).toBe(true);
    await selectCountry('DE');
    expect(button('查重并新建').disabled).toBe(false);
  });

  it('预填可修改，后台更新建议不会覆盖已编辑的表单', async () => {
    await render();
    await openSuggestion();
    await setInput(container.querySelector('input')!, 'Edited Caravan');
    await selectCountry('IT');
    await render({ ...suggestion, country: 'Germany' });
    expect(container.querySelector('input')!.value).toBe('Edited Caravan');
    expect(container.querySelector('select')!.value).toBe('IT');
    await click(button('查重并新建'));
    expect(state.create).toHaveBeenCalledExactlyOnceWith({ name: 'Edited Caravan', country: 'IT', accountType: 'DEALER', confirmedUnique: false });
    expect(onPick).toHaveBeenCalledExactlyOnceWith(saved);
  });

  it('相似候选必须经人选择，选择已有客户不新建', async () => {
    const existing = { ...saved, id: 'existing-id', score: 0.9 };
    state.search.mockResolvedValue([existing]);
    await render();
    await openSuggestion();
    await click(button('查重并新建'));
    expect(state.create).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
    await click(container.querySelector('button.card')!);
    expect(onPick).toHaveBeenCalledExactlyOnceWith(existing);
    expect(state.create).not.toHaveBeenCalled();
  });

  it('新建后自动选中并显示客户，残留搜索词和旧缓存不能把它藏掉', async () => {
    const Picker = () => {
      const [value, setValue] = useState<Company | null>(null);
      return <CompanyPicker value={value} onPick={setValue} suggested={suggestion.name} suggestedFields={suggestion} />;
    };
    await act(async () => root.render(<Picker />));
    await setInput(container.querySelector('input')!, 'Other search');
    await openSuggestion();
    await click(button('查重并新建'));
    expect(state.items).toHaveLength(0);
    expect(container.querySelector('input')!.value).toBe('Other search');
    expect(button(saved.name).dataset.on).toBe('true');
    expect(container.querySelector('[data-suggest]')).toBeNull();
    await setInput(container.querySelector('input')!, '');
    expect(button(saved.name).dataset.on).toBe('true');
  });

  it('服务端查重也不能绕过：409 后先显示候选，确认才再提交', async () => {
    const existing = { ...saved, id: 'existing-id', score: 0.9 };
    state.create.mockRejectedValueOnce(new DuplicateError([existing]));
    await render();
    await openSuggestion();
    await click(button('查重并新建'));
    expect(onPick).not.toHaveBeenCalled();
    expect(container.textContent).toContain('是不是这几家里的一家');
    await click(button('都不是，新建'));
    expect(state.create.mock.calls[1]![0].confirmedUnique).toBe(true);
    expect(onPick).toHaveBeenCalledExactlyOnceWith(saved);
  });

  it('查重网络失败后显示错误且允许重试，不永远卡在 busy', async () => {
    state.search.mockRejectedValueOnce(new Error('Network unavailable'));
    await render();
    await openSuggestion();
    await click(button('查重并新建'));
    expect(container.textContent).toContain('Network unavailable');
    expect(button('查重并新建').disabled).toBe(false);
    expect(state.create).not.toHaveBeenCalled();
  });

  it('英文界面使用相同的国家值及渠道身份', async () => {
    state.locale = 'en';
    await render();
    await openSuggestion();
    expect(container.querySelector('select')!.value).toBe('FR');
    expect(container.querySelector('option[value="FR"]')!.textContent).toBe('France');
    expect(button('dealer').dataset.on).toBe('true');
    expect(container.textContent).toContain('New account');
  });
});
