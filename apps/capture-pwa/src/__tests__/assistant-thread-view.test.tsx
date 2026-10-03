// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AssistantThreadView from '../components/AssistantThreadView';
import { localMessage, projectMessages, type ChatEntry } from '../message-projection';
import type { Note } from '../db';

let container: HTMLDivElement;
let root: Root;
let send: ReturnType<typeof vi.fn>;
let cancel: ReturnType<typeof vi.fn>;
let dispatch: ((text: string) => void) | null;
const ready = (next: typeof dispatch) => { dispatch = next; };
const note: Note = { id: 'c1', text: 'user message', createdAt: 1, recordedBy: 'A', visitLabel: '', sync: 'queued', attempts: 0 };
const renderMessage = (entry: ChatEntry): ReactNode => <div data-business-message={entry.key}>
  {entry.message.text}<button data-business-card={entry.message.staging_id ?? undefined}>confirm</button>
</div>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  send = vi.fn().mockResolvedValue(undefined); cancel = vi.fn().mockResolvedValue(undefined); dispatch = null;
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = async (entries: ChatEntry[], running = false) => act(async () => root.render(
  <AssistantThreadView entries={entries} running={running} onSend={send} onCancel={cancel} renderMessage={renderMessage} onReady={ready}>
    <div data-worklog="live">working</div>
  </AssistantThreadView>));

describe('published assistant-ui runtime with complete host message renderer', () => {
  it('renders business cards and never executes a model, confirm or stop merely from a snapshot', async () => {
    const message = { ...localMessage(note), id: 'agent-1', role: 'agent' as const, client_id: null, staging_id: 'proposal-1', text: 'agent result' };
    await render(projectMessages([message], []));
    expect(container.querySelector('[data-business-card="proposal-1"]')).not.toBeNull();
    expect(send).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
  });
  it('running creates no extra empty assistant bubble and allows current host send semantics', async () => {
    await render(projectMessages([], [note]), true);
    expect(container.querySelectorAll('[data-business-message]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-worklog]')).toHaveLength(1);
    await act(async () => dispatch!('continue input'));
    expect(send).toHaveBeenCalledExactlyOnceWith('continue input');
  });
  it('a server receipt preserves the wrapper and replaces optimistic content exactly once', async () => {
    await render(projectMessages([], [note]));
    const before = container.querySelector('[data-message-id="client:c1"]');
    await render(projectMessages([{ ...localMessage(note), id: 'server-1', inbox_id: 'inbox-1' }], [note]));
    expect(container.querySelectorAll('[data-business-message]')).toHaveLength(1);
    expect(container.querySelector('[data-message-id="client:c1"]')).toBe(before);
  });
});
