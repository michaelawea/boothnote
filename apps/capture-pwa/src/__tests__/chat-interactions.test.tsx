// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadMessage } from '../api';

const api = vi.hoisted(() => ({ fetchThread: vi.fn(), createThread: vi.fn(), syncThreads: vi.fn(), abortThread: vi.fn(),
  fetchSupersedePreview: vi.fn(), deleteThread: vi.fn(), restoreThread: vi.fn(), downloadAttachment: vi.fn(), transcribeAudio: vi.fn() }));
const sync = vi.hoisted(() => ({ flush: vi.fn(), enqueueQuestionAnswer: vi.fn() }));
const image = vi.hoisted(() => ({ readForUpload: vi.fn() }));
const recorder = vi.hoisted(() => ({ startRecording: vi.fn() }));
const identity = vi.hoisted(() => ({ userCode: 'tester' }));
vi.mock('../api', () => api);
vi.mock('../sync', () => ({ ...sync, onSyncChange: () => () => {}, uploadProgress: () => undefined }));
vi.mock('../image', () => image);
vi.mock('../recorder', () => recorder);
vi.mock('../auth', () => ({ useSession: () => ({ user: { userCode: identity.userCode, locale: 'zh', role: 'staff' } }),
  getSession: () => ({ user: { userCode: identity.userCode, locale: 'zh', role: 'staff' } }) }));
vi.mock('../companies', () => ({ useCompanies: () => [] }));
vi.mock('../components/ReviewCard', () => ({ ReviewCard: ({ stagingId }: { stagingId: string }) => <div data-review-card={stagingId}>business card</div> }));

import { ChatSheet } from '../pages/Chat';
import { db, type Note } from '../db';
import { chatDraftDatabase, chatDraftKey, saveChatDraft } from '../chat-drafts';
import * as chatDrafts from '../chat-drafts';
import { localMessage } from '../message-projection';

let container: HTMLDivElement;
let root: Root;
const note = (id: string, threadId?: string): Note => ({ id, text: `text:${id}`, createdAt: 1, recordedBy: 'tester',
  visitLabel: '', sync: 'queued', attempts: 0, toAgent: true, threadId });
const snapshot = (messages: ThreadMessage[] = []) => ({ messages, running: null, deletedAt: null });
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
const mount = async (id: string | null = 't1', ui: 'current' | 'development' = 'current', onClose = () => {}) => {
  await act(async () => root.render(<ChatSheet initialThreadId={id} ui={ui} onClose={onClose} />));
  await settle();
};
const input = async (value: string) => act(async () => {
  const el = document.querySelector('textarea')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
const click = (el: HTMLElement) => act(async () => el.click());

beforeEach(async () => {
  identity.userCode = 'tester';
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} });
  await db.notes.clear(); await chatDraftDatabase.drafts.clear();
  Object.values(api).forEach((fn) => fn.mockReset());
  api.fetchThread.mockResolvedValue(snapshot()); api.createThread.mockResolvedValue('created-thread');
  api.syncThreads.mockResolvedValue([]); api.abortThread.mockResolvedValue(1); api.fetchSupersedePreview.mockResolvedValue(null);
  sync.flush.mockReset().mockResolvedValue(undefined); sync.enqueueQuestionAnswer.mockReset();
  image.readForUpload.mockReset(); recorder.startRecording.mockReset();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { vi.useRealTimers(); await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('full chat controller race and draft regressions', () => {
  it.each(['current', 'development'] as const)('keeps every reply but mounts one live business card for a staging in %s', async (ui) => {
    const common = { ...localMessage(note('c1', 't1')), role: 'agent' as const, client_id: null, inbox_id: 'i1', staging_id: 's1', status: 'ready' };
    api.fetchThread.mockResolvedValue(snapshot([
      { ...common, id: 'first', text: 'first reply' },
      { ...common, id: 'latest', text: 'latest reply' },
      { ...common, id: 'late-stale', text: 'stale reply', superseded_by: 'replacement', supersede_reason: 'stale_reply' },
    ]));
    await mount('t1', ui);
    expect(document.querySelectorAll('[data-chat-message]')).toHaveLength(3);
    expect(document.querySelectorAll('[data-review-card="s1"]')).toHaveLength(1);
    expect(document.querySelector('[data-chat-message="message:latest"] [data-review-card]')).not.toBeNull();
  });
  it.each(['current', 'development'] as const)('first-send double click persists one intent in %s view', async (ui) => {
    let finish!: () => void;
    const add = db.notes.add.bind(db.notes);
    vi.spyOn(db.notes, 'add').mockImplementation((record) => new Dexie.Promise<string>((resolve, reject) => {
      finish = () => { void add(record).then(resolve, reject); };
    }));
    await mount(null, ui); await input('first intent');
    const send = document.querySelector('[aria-label="发送"]') as HTMLButtonElement;
    await act(async () => { send.click(); send.click(); });
    expect(api.createThread).not.toHaveBeenCalled();
    expect(sync.flush).not.toHaveBeenCalled();
    expect(await db.notes.count()).toBe(0);
    await act(async () => { finish(); }); await settle();
    const notes = await db.notes.toArray();
    expect(notes).toHaveLength(1); expect(notes[0].text).toBe('first intent');
    expect(notes[0].clientThreadId).toMatch(/^[\da-f-]{36}$/i);
  });
  it.each(['current', 'development'] as const)('can close after durable enqueue while uploads are slow in %s', async (ui) => {
    let finish!: () => void;
    sync.flush.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const onClose = vi.fn();
    await mount('t1', ui, onClose); await input('durable message');
    await click(document.querySelector('[aria-label="发送"]') as HTMLElement); await settle();
    expect(await db.notes.count()).toBe(1);
    await input('next draft');
    await click(document.querySelector('[aria-label="关闭"]') as HTMLElement);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 230)); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect((await chatDraftDatabase.drafts.get(chatDraftKey('tester', 't1')))?.text).toBe('next draft');
    finish();
  });
  it.each(['current', 'development'] as const)('can send again and switch history before a slow upload finishes in %s', async (ui) => {
    const complete: (() => void)[] = [];
    sync.flush.mockImplementation(() => new Promise<void>((resolve) => { complete.push(resolve); }));
    api.syncThreads.mockResolvedValue([{ id: 't2', title: 'Second thread', last_message_at: new Date().toISOString(), messages: 0 }]);
    await mount('t1', ui); await input('first');
    await click(document.querySelector('[aria-label="发送"]') as HTMLElement); await settle();
    await input('second'); await click(document.querySelector('[aria-label="发送"]') as HTMLElement); await settle();
    expect((await db.notes.toArray()).map((n) => n.text).sort()).toEqual(['first', 'second']);
    await click(button('历史')); await click([...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Second thread'))!); await settle();
    expect(api.fetchThread).toHaveBeenCalledWith('t2');
    await input('second thread draft');
    await act(async () => { complete.forEach((resolve) => resolve()); }); await settle();
    expect(document.querySelector('textarea')!.value).toBe('second thread draft');
    expect(document.body.textContent).not.toContain('first');
  });
  it.each(['current', 'development'] as const)('does not await createThread and preserves input added during local enqueue in %s', async (ui) => {
    api.createThread.mockImplementation(() => new Promise(() => {}));
    let finish!: () => void;
    const add = db.notes.add.bind(db.notes);
    vi.spyOn(db.notes, 'add').mockImplementation((record) => new Dexie.Promise<string>((resolve, reject) => {
      finish = () => { void add(record).then(resolve, reject); };
    }));
    await mount(null, ui); await input('first snapshot');
    await click(document.querySelector('[aria-label="发送"]') as HTMLElement);
    await input('next input while IndexedDB commits');
    image.readForUpload.mockResolvedValue({ name: 'next.txt', size: 3, mime: 'text/plain', bytes: new Uint8Array([1, 2, 3]).buffer });
    const upload = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(upload, 'files', { value: [new File(['abc'], 'next.txt', { type: 'text/plain' })], configurable: true });
    await act(async () => upload.dispatchEvent(new Event('change', { bubbles: true }))); await settle();
    await act(async () => { finish(); }); await settle();
    expect(api.createThread).not.toHaveBeenCalled();
    expect(sync.flush).toHaveBeenCalledTimes(1);
    const saved = (await db.notes.toArray())[0];
    expect(saved.text).toBe('first snapshot'); expect(saved.attachments).toBeUndefined();
    expect(document.querySelector('textarea')!.value).toBe('next input while IndexedDB commits');
    expect(document.body.textContent).toContain('next.txt');
  });
  it.each(['current', 'development'] as const)('keeps a new identical draft typed while the previous intent is enqueued in %s', async (ui) => {
    let finish!: () => void;
    const add = db.notes.add.bind(db.notes);
    vi.spyOn(db.notes, 'add').mockImplementation((record) => new Dexie.Promise<string>((resolve, reject) => {
      finish = () => { void add(record).then(resolve, reject); };
    }));
    await mount('t1', ui); await input('intentional repeat');
    await click(document.querySelector('[aria-label="发送"]') as HTMLElement);
    await input(''); await input('intentional repeat');
    await act(async () => { finish(); }); await settle();
    expect(document.querySelector('textarea')!.value).toBe('intentional repeat');
    expect((await db.notes.toArray()).map((n) => n.text)).toEqual(['intentional repeat']);
  });
  it('slow polling has at most one request in flight', async () => {
    let tick!: () => void;
    vi.spyOn(window, 'setInterval').mockImplementation((callback, ms) => {
      if (ms === 1200) tick = callback as () => void;
      return 123 as unknown as ReturnType<typeof setInterval>;
    });
    let finish!: (value: ReturnType<typeof snapshot>) => void;
    api.fetchThread.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await mount();
    await act(async () => { tick(); tick(); tick(); });
    expect(api.fetchThread).toHaveBeenCalledTimes(1);
    await act(async () => { finish(snapshot()); });
    await act(async () => { tick(); });
    expect(api.fetchThread).toHaveBeenCalledTimes(2);
  });
  it('offline consecutive identical sends keep distinct clientIds in one persistent conversation', async () => {
    api.createThread.mockResolvedValue(null);
    await mount(null);
    await input('intentional repeat'); await click(document.querySelector('[aria-label="发送"]') as HTMLElement); await settle();
    await input('intentional repeat'); await click(document.querySelector('[aria-label="发送"]') as HTMLElement); await settle();
    const notes = await db.notes.toArray();
    expect(notes).toHaveLength(2);
    expect(notes[0].id).not.toBe(notes[1].id);
    expect(notes[0].clientThreadId).toBe(notes[1].clientThreadId);
    const saved = await chatDraftDatabase.drafts.get(chatDraftKey('tester', null));
    expect(saved?.conversationId).toBe(notes[0].clientThreadId);
    expect(saved?.text).toBe('');
    expect(document.querySelectorAll('[data-chat-message]')).toHaveLength(2);
  });
  it.each(['current', 'development'] as const)('keeps the next draft and pending attachment when an offline thread is assigned in %s', async (ui) => {
    await mount(null, ui); await input('first offline message');
    await click(document.querySelector('[aria-label="发送"]') as HTMLElement); await settle();
    const first = (await db.notes.toArray())[0];
    await input('next message still being composed');
    let finishFile!: (value: unknown) => void;
    image.readForUpload.mockImplementation(() => new Promise((resolve) => { finishFile = resolve; }));
    const upload = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(upload, 'files', { value: [new File(['abc'], 'next.txt', { type: 'text/plain' })], configurable: true });
    await act(async () => upload.dispatchEvent(new Event('change', { bubbles: true })));
    await act(async () => { await db.notes.update(first.id, { threadId: 'assigned-thread', sync: 'synced', remoteId: 'inbox-first' }); });
    await settle(); await settle();
    expect(api.fetchThread).toHaveBeenCalledWith('assigned-thread');
    await act(async () => { finishFile({ name: 'next.txt', size: 3, mime: 'text/plain', bytes: new Uint8Array([1, 2, 3]).buffer }); });
    await settle();
    // 相同服务器回执再次出现，不应再迁移或重载输入栏。
    await act(async () => { await db.notes.update(first.id, { remoteId: 'inbox-first' }); }); await settle();
    expect(document.querySelector('textarea')!.value).toBe('next message still being composed');
    expect(document.body.textContent).toContain('next.txt');
    const saved = await chatDraftDatabase.drafts.get(chatDraftKey('tester', 'assigned-thread'));
    expect(saved?.text).toBe('next message still being composed');
    expect([...new Uint8Array(saved!.attachments[0].bytes!)]).toEqual([1, 2, 3]);
    expect(saved?.conversationId).toBe(first.clientThreadId);
    expect(await chatDraftDatabase.drafts.get(chatDraftKey('tester', null))).toBeUndefined();
    await act(async () => root.unmount()); root = createRoot(container);
    await mount('assigned-thread', ui);
    expect(document.querySelector('textarea')!.value).toBe('next message still being composed');
    expect(document.body.textContent).toContain('next.txt');
  });
  it.each(['current', 'development'] as const)('keeps editing and dictation state on identity adoption, then opens a genuinely new draft in %s', async (ui) => {
    const clientThreadId = crypto.randomUUID();
    await saveChatDraft({ key: chatDraftKey('tester', null), userCode: 'tester', conversationId: clientThreadId,
      text: 'unfinished correction', attachments: [], editing: { id: 'original-message', text: 'original' }, transcript: 'dictation text' });
    await db.notes.add({ ...note('first'), clientThreadId });
    api.syncThreads.mockResolvedValue([{ id: 'assigned-thread', title: 'Assigned conversation', last_message_at: new Date().toISOString(), messages: 1 }]);
    await mount(null, ui);
    await act(async () => { await db.notes.update('first', { threadId: 'assigned-thread', sync: 'synced', remoteId: 'inbox-first' }); });
    await settle(); await settle();
    expect(document.querySelector('textarea')!.value).toBe('unfinished correction');
    expect(document.body.textContent).toContain('正在改这一句');
    const saved = await chatDraftDatabase.drafts.get(chatDraftKey('tester', 'assigned-thread'));
    expect(saved?.editing?.id).toBe('original-message'); expect(saved?.transcript).toBe('dictation text');
    await click(button('历史')); await click(button('新对话')); await settle();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 190)); });
    expect(document.querySelector('textarea')!.value).toBe('');
    expect(document.body.textContent).not.toContain('正在改这一句');
    await input('a genuinely new draft');
    await click(button('历史')); await click([...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Assigned conversation'))!); await settle();
    expect(document.querySelector('textarea')!.value).toBe('unfinished correction');
    expect(document.body.textContent).toContain('正在改这一句');
    expect((await chatDraftDatabase.drafts.get(chatDraftKey('tester', null)))?.text).toBe('a genuinely new draft');
  });
  it.each(['current', 'development'] as const)('ignores a late identity adoption after switching accounts in %s', async (ui) => {
    let finish!: () => void;
    const move = chatDrafts.moveChatDraft;
    vi.spyOn(chatDrafts, 'moveChatDraft').mockImplementation((request) => {
      const pending = move(request);
      return new Promise<void>((resolve, reject) => { finish = () => { void pending.then(resolve, reject); }; });
    });
    await mount(null, ui); await input('account A message');
    await click(document.querySelector('[aria-label="发送"]') as HTMLElement); await settle();
    const first = (await db.notes.toArray())[0];
    await input('account A next draft');
    await act(async () => { await db.notes.update(first.id, { threadId: 'account-A-thread', sync: 'synced' }); }); await settle();
    const finishA = finish;
    const otherConversation = crypto.randomUUID();
    await saveChatDraft({ key: chatDraftKey('other', null), userCode: 'other', conversationId: otherConversation,
      text: 'account B draft', attachments: [], editing: null });
    await db.notes.add({ ...note('other-note'), recordedBy: 'other', clientThreadId: otherConversation });
    identity.userCode = 'other';
    await act(async () => root.render(<ChatSheet initialThreadId={null} ui={ui} onClose={() => {}} />)); await settle();
    await act(async () => { await db.notes.update('other-note', { threadId: 'account-B-thread', sync: 'synced' }); }); await settle();
    await act(async () => { finishA(); }); await settle();
    expect(api.fetchThread).not.toHaveBeenCalledWith('account-A-thread');
    expect(document.querySelector('textarea')!.value).toBe('account B draft');
    expect(document.body.textContent).not.toContain('account A message');
    expect((await chatDraftDatabase.drafts.get(chatDraftKey('tester', 'account-A-thread')))?.text).toBe('account A next draft');
    await act(async () => { finish(); }); await settle();
    expect(api.fetchThread).toHaveBeenCalledWith('account-B-thread');
    expect(document.querySelector('textarea')!.value).toBe('account B draft');
  });
  it.each(['current', 'development'] as const)('keeps late identity adoption with its old conversation after switching history in %s', async (ui) => {
    let finish!: () => void;
    const move = chatDrafts.moveChatDraft;
    vi.spyOn(chatDrafts, 'moveChatDraft').mockImplementation((request) => {
      const pending = move(request);
      return new Promise<void>((resolve, reject) => { finish = () => { void pending.then(resolve, reject); }; });
    });
    api.syncThreads.mockResolvedValue([{ id: 't2', title: 'Second thread', last_message_at: new Date().toISOString(), messages: 0 }]);
    await mount(null, ui); await input('first');
    await click(document.querySelector('[aria-label="发送"]') as HTMLElement); await settle();
    const first = (await db.notes.toArray())[0];
    await input('first conversation draft');
    await act(async () => { await db.notes.update(first.id, { threadId: 'assigned-first-thread', sync: 'synced' }); }); await settle();
    await click(button('历史')); await click([...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Second thread'))!); await settle();
    await input('second conversation draft');
    await act(async () => { finish(); }); await settle();
    expect(api.fetchThread).toHaveBeenCalledWith('t2');
    expect(api.fetchThread).not.toHaveBeenCalledWith('assigned-first-thread');
    expect(document.querySelector('textarea')!.value).toBe('second conversation draft');
    expect((await chatDraftDatabase.drafts.get(chatDraftKey('tester', 'assigned-first-thread')))?.text).toBe('first conversation draft');
  });
  it('attachment reading cannot cross threads, and prepared bytes stay with their draft', async () => {
    let finish!: (file: unknown) => void;
    image.readForUpload.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    api.syncThreads.mockResolvedValue([{ id: 't2', title: 'Second thread', last_message_at: new Date().toISOString(), messages: 0 }]);
    await mount();
    const upload = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(upload, 'files', { value: [new File(['abc'], 'field.txt', { type: 'text/plain' })], configurable: true });
    await act(async () => upload.dispatchEvent(new Event('change', { bubbles: true })));
    await click(button('历史')); await click([...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Second thread'))!);
    expect(api.fetchThread).not.toHaveBeenCalledWith('t2');
    expect((document.querySelector('[aria-label="发送"]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finish({ name: 'field.txt', size: 3, mime: 'text/plain', bytes: new Uint8Array([1, 2, 3]).buffer }); });
    await settle();
    await click([...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Second thread'))!); await settle();
    const saved = await chatDraftDatabase.drafts.get(chatDraftKey('tester', 't1'));
    expect([...new Uint8Array(saved!.attachments[0].bytes!)]).toEqual([1, 2, 3]);
    expect(document.body.textContent).not.toContain('field.txt');
  });
  it('a pending microphone permission is single-flight and cannot switch the recording to another thread', async () => {
    let finish!: (handle: unknown) => void;
    recorder.startRecording.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    api.syncThreads.mockResolvedValue([{ id: 't2', title: 'Second thread', last_message_at: new Date().toISOString(), messages: 0 }]);
    await mount();
    const record = document.querySelector('[aria-label="录音"]') as HTMLButtonElement;
    await act(async () => { record.click(); record.click(); });
    expect(recorder.startRecording).toHaveBeenCalledTimes(1);
    await click(button('历史')); await click([...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Second thread'))!);
    expect(api.fetchThread).not.toHaveBeenCalledWith('t2');
    const handle = { cancel: vi.fn(), stop: vi.fn(), onInterrupt: vi.fn() };
    await act(async () => { finish(handle); });
    expect(handle.onInterrupt).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    expect(handle.cancel).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });
  it('stop double click sends one abort and preserves server running until a snapshot proves completion', async () => {
    let complete!: (value: number) => void;
    api.abortThread.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    api.fetchThread.mockResolvedValue({ messages: [], running: { stage: 'working', steps: 1, max_steps: 8, trace: [] }, deletedAt: null });
    await mount();
    const stop = document.querySelector('[aria-label="停止"]') as HTMLButtonElement;
    await act(async () => { stop.click(); stop.click(); });
    expect(api.abortThread).toHaveBeenCalledTimes(1);
    await act(async () => { complete(1); });
    expect(document.body.textContent).toContain('正在思考');
    expect((document.querySelector('[aria-label="停止"]') as HTMLButtonElement).disabled).toBe(true);
  });
  it('switching history drops a late previous-thread snapshot and preserves each draft', async () => {
    let finish!: (value: ReturnType<typeof snapshot>) => void;
    api.fetchThread.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    api.syncThreads.mockResolvedValue([{ id: 't2', title: 'Second thread', last_message_at: new Date().toISOString(), messages: 0 }]);
    await mount(); await input('draft in first');
    await click(button('历史')); await click([...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Second thread'))!); await settle();
    await input('draft in second');
    await act(async () => { finish(snapshot([{ ...localMessage(note('old', 't1')), id: 'old-server' }])); });
    expect(document.body.textContent).not.toContain('text:old');
    expect((await chatDraftDatabase.drafts.get(chatDraftKey('tester', 't1')))?.text).toBe('draft in first');
    expect((await chatDraftDatabase.drafts.get(chatDraftKey('tester', 't2')))?.text).toBe('draft in second');
  });
  it('a background flush receipt is observed without relying on send() to read it', async () => {
    let tick!: () => void;
    vi.spyOn(window, 'setInterval').mockImplementation((callback, ms) => {
      if (ms === 1200) tick = callback as () => void;
      return 123 as unknown as ReturnType<typeof setInterval>;
    });
    await db.notes.add(note('c1', 't1')); await mount();
    expect(document.querySelectorAll('[data-chat-message]')).toHaveLength(1);
    const server = { ...localMessage(note('c1', 't1')), id: 'server-c1', inbox_id: 'inbox-c1' };
    api.fetchThread.mockResolvedValue(snapshot([server]));
    await act(async () => { await db.notes.update('c1', { remoteId: 'inbox-c1', sync: 'synced' }); });
    await settle();
    await act(async () => { tick(); });
    expect(document.querySelectorAll('[data-chat-message]')).toHaveLength(1);
    expect(document.querySelector('[data-chat-message="client:c1"]')).not.toBeNull();
  });
  it('cancelled CRM edit preview cannot reopen or submit when its response arrives late', async () => {
    const user = { ...localMessage(note('c1', 't1')), id: 'user-server', inbox_id: 'inbox-c1' };
    api.fetchThread.mockResolvedValue(snapshot([user]));
    let finish!: (value: unknown) => void;
    api.fetchSupersedePreview.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await mount();
    const bubble = document.querySelector('.bubble')!.parentElement!;
    await act(async () => bubble.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    await click(button('编辑')); await input('correction'); await click(document.querySelector('[aria-label="发送"]') as HTMLElement);
    await click(button('先不改'));
    await act(async () => { finish({ rewriting: [{ object: 'supportCase', label: 'case', name: 'old case' }], messages: 1, source: 'created_records', otherCommitted: 0 }); });
    expect(button('改写并重发')).toBeUndefined();
    expect(await db.notes.count()).toBe(0); expect(sync.flush).not.toHaveBeenCalled();
  });
  it('restores an editing draft after remount and keeps its server message identity', async () => {
    await saveChatDraft({ key: chatDraftKey('tester', 't1'), userCode: 'tester', text: 'unfinished correction',
      attachments: [], editing: { id: 'old-server', text: 'original' }, conversationId: 'draft-conversation' });
    await mount();
    expect(document.querySelector('textarea')!.value).toBe('unfinished correction');
    expect(document.body.textContent).toContain('正在改这一句');
    await click(document.querySelector('[aria-label="发送"]') as HTMLElement); await settle();
    expect((await db.notes.toArray())[0].supersedesMessageId).toBe('old-server');
  });
});
