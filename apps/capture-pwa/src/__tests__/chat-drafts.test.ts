// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { chatDraftDatabase, chatDraftKey, deleteChatDraft, loadChatDraft, moveChatDraft, saveChatDraft, type ChatDraft } from '../chat-drafts';

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
  it('moves pending saves atomically and redirects late saves only for that conversation', async () => {
    const first = { ...draft('A', null), conversationId: crypto.randomUUID(), text: 'before acknowledgement' };
    const targetKey = chatDraftKey('A', 'assigned');
    void saveChatDraft(first);
    const moved = moveChatDraft({ fromKey: first.key, toKey: targetKey, userCode: 'A', conversationId: first.conversationId });
    void saveChatDraft({ ...first, text: 'typed during migration', transcript: 'dictation', editing: { id: 'message', text: 'original' },
      attachments: [{ kind: 'file', name: 'draft.txt', mime: 'text/plain', size: 2, bytes: new Uint8Array([4, 5]).buffer }] });
    await moved;
    const saved = await loadChatDraft(targetKey);
    expect(saved?.text).toBe('typed during migration'); expect(saved?.editing?.id).toBe('message');
    expect(saved?.transcript).toBe('dictation'); expect([...new Uint8Array(saved!.attachments[0].bytes!)]).toEqual([4, 5]);
    expect(await loadChatDraft(first.key)).toBeUndefined();
    const next = { ...first, conversationId: crypto.randomUUID(), text: 'another conversation' };
    await saveChatDraft(next);
    // 重复回执和老 render 的保存，均不可覆盖新会话的 new key。
    await moveChatDraft({ fromKey: first.key, toKey: targetKey, userCode: 'A', conversationId: first.conversationId });
    await saveChatDraft({ ...first, text: 'late old render' });
    expect((await loadChatDraft(first.key))?.text).toBe('another conversation');
    expect((await loadChatDraft(targetKey))?.text).toBe('late old render');
  });
  it('refuses a move across accounts without deleting either draft', async () => {
    const source = { ...draft('A', null), conversationId: crypto.randomUUID() };
    await saveChatDraft(source); await saveChatDraft(draft('B', 'assigned'));
    await expect(moveChatDraft({ fromKey: source.key, toKey: chatDraftKey('B', 'assigned'), userCode: 'A',
      conversationId: source.conversationId })).rejects.toThrow('between accounts');
    expect(await loadChatDraft(source.key)).toEqual(source);
    expect((await loadChatDraft(chatDraftKey('B', 'assigned')))?.userCode).toBe('B');
  });
  it('preserves both drafts if the destination belongs to another conversation', async () => {
    const source = { ...draft('A', null), conversationId: crypto.randomUUID() };
    const target = { ...draft('A', 'taken'), conversationId: crypto.randomUUID() };
    await saveChatDraft(source); await saveChatDraft(target);
    const failedMove = moveChatDraft({ fromKey: source.key, toKey: target.key, userCode: 'A', conversationId: source.conversationId });
    // 保存已在迁移结果揭晓前排队，不能错误地写到另一会话的目标上。
    const queuedSave = saveChatDraft({ ...source, text: 'still in original conversation' });
    await expect(failedMove).rejects.toThrow('another conversation');
    await queuedSave;
    expect((await loadChatDraft(source.key))?.text).toBe('still in original conversation');
    expect(await loadChatDraft(target.key)).toEqual(target);
  });
  it('keeps a queued source save at its source until the destination has been checked', async () => {
    const source = { ...draft('A', null), conversationId: crypto.randomUUID(), text: 'queued source' };
    const target = { ...draft('A', 'already-owned'), conversationId: crypto.randomUUID(), text: 'keep target' };
    await saveChatDraft(target);
    const queuedSave = saveChatDraft(source);
    const failedMove = moveChatDraft({ fromKey: source.key, toKey: target.key, userCode: 'A',
      conversationId: source.conversationId });
    await queuedSave;
    await expect(failedMove).rejects.toThrow('another conversation');
    expect(await loadChatDraft(source.key)).toEqual(source);
    expect(await loadChatDraft(target.key)).toEqual(target);
  });
});
