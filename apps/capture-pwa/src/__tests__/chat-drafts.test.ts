// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { chatDraftDatabase, chatDraftKey, deleteChatDraft, loadChatDraft, saveChatDraft, type ChatDraft } from '../chat-drafts';

const draft = (userCode: string, threadId: string | null): ChatDraft => ({ key: chatDraftKey(userCode, threadId), userCode,
  text: `draft:${threadId}`, attachments: [], editing: null, conversationId: 'stable-conversation' });
afterEach(async () => { await chatDraftDatabase.drafts.clear(); });

describe('persistent chat drafts', () => {
  it('isolates accounts, threads and the not-yet-created conversation', async () => {
    await Promise.all([saveChatDraft(draft('A', null)), saveChatDraft(draft('A', 't1')), saveChatDraft(draft('B', 't1'))]);
    expect((await loadChatDraft(chatDraftKey('A', null)))?.text).toBe('draft:null');
    expect((await loadChatDraft(chatDraftKey('A', 't1')))?.text).toBe('draft:t1');
    expect(await loadChatDraft(chatDraftKey('B', 't2'))).toBeUndefined();
  });
  it('keeps attachment bytes and editing identity without persisting dictation audio', async () => {
    const item = { ...draft('A', 't1'), editing: { id: 'original-message', text: 'original' }, transcript: 'dictation',
      attachments: [{ kind: 'file' as const, name: 'x.txt', mime: 'text/plain', size: 3, bytes: new Uint8Array([2, 4, 6]).buffer }] };
    await saveChatDraft(item);
    const saved = await loadChatDraft(item.key);
    expect([...new Uint8Array(saved!.attachments[0].bytes!)]).toEqual([2, 4, 6]);
    expect(saved!.editing?.id).toBe('original-message');
    expect(saved!.transcript).toBe('dictation');
    expect(saved).not.toHaveProperty('audioBlob');
  });
  it('the newest write wins even when updates and subsequent reads overlap', async () => {
    const first = draft('A', null);
    void saveChatDraft({ ...first, text: 'old' });
    void saveChatDraft({ ...first, text: 'new' });
    expect((await loadChatDraft(first.key))?.text).toBe('new');
    await deleteChatDraft(first.key);
    expect(await loadChatDraft(first.key)).toBeUndefined();
  });
});
