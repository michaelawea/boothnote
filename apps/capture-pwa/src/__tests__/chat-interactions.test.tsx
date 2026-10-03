// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadMessage } from '../api';

const api = vi.hoisted(() => ({ fetchThread: vi.fn(), createThread: vi.fn(), syncThreads: vi.fn(), abortThread: vi.fn(),
  fetchSupersedePreview: vi.fn(), deleteThread: vi.fn(), restoreThread: vi.fn(), downloadAttachment: vi.fn(), transcribeAudio: vi.fn() }));
const sync = vi.hoisted(() => ({ flush: vi.fn(), enqueueQuestionAnswer: vi.fn() }));
const image = vi.hoisted(() => ({ readForUpload: vi.fn() }));
const recorder = vi.hoisted(() => ({ startRecording: vi.fn() }));
vi.mock('../api', () => api);
vi.mock('../sync', () => ({ ...sync, onSyncChange: () => () => {}, uploadProgress: () => undefined }));
vi.mock('../image', () => image);
vi.mock('../recorder', () => recorder);
vi.mock('../auth', () => ({ useSession: () => ({ user: { userCode: 'tester', locale: 'zh', role: 'staff' } }),
  getSession: () => ({ user: { userCode: 'tester', locale: 'zh', role: 'staff' } }) }));
vi.mock('../companies', () => ({ useCompanies: () => [] }));
vi.mock('../components/ReviewCard', () => ({ ReviewCard: ({ stagingId }: { stagingId: string }) => <div data-review-card={stagingId}>business card</div> }));

import { ChatSheet } from '../pages/Chat';
import { db, type Note } from '../db';
import { chatDraftDatabase, chatDraftKey, saveChatDraft } from '../chat-drafts';
import { localMessage } from '../message-projection';

let container: HTMLDivElement;
let root: Root;
const note = (id: string, threadId?: string): Note => ({ id, text: `text:${id}`, createdAt: 1, recordedBy: 'tester',
  visitLabel: '', sync: 'queued', attempts: 0, toAgent: true, threadId });
const snapshot = (messages: ThreadMessage[] = []) => ({ messages, running: null, deletedAt: null });
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
const mount = async (id: string | null = 't1', ui: 'current' | 'development' = 'current') => {
  await act(async () => root.render(<ChatSheet initialThreadId={id} ui={ui} onClose={() => {}} />));
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
    let finish!: (id: string) => void;
    api.createThread.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    await mount(null, ui); await input('first intent');
    const send = document.querySelector('[aria-label="发送"]') as HTMLButtonElement;
    await act(async () => { send.click(); send.click(); });
    expect(api.createThread).toHaveBeenCalledTimes(1);
    expect(api.createThread.mock.calls[0][1]).toMatch(/^[\da-f-]{36}$/i);
    await act(async () => { finish('created-thread'); }); await settle();
    const notes = await db.notes.toArray();
    expect(notes).toHaveLength(1); expect(notes[0].text).toBe('first intent');
    expect(notes[0].clientThreadId).toBe(api.createThread.mock.calls[0][1]);
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
