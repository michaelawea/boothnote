import Dexie, { type Table } from 'dexie';
import type { LocalAttachment } from './db';

export type ChatDraft = {
  key: string;
  userCode: string;
  text: string;
  attachments: LocalAttachment[];
  editing: { id: string; text: string } | null;
  /** Stable identity of an offline conversation, not a message id. */
  conversationId: string;
  transcript?: string;
};

// A separate local draft store: no schema migration can hold up the capture outbox.
// D111: dictation audio never goes here; only the transcript and attachment bytes.
const drafts = new Dexie('boothnote-chat-drafts') as Dexie & { drafts: Table<ChatDraft, string> };
drafts.version(1).stores({ drafts: 'key, userCode' });
export const chatDraftKey = (userCode: string, threadId: string | null) => `${userCode}:${threadId ?? 'new'}`;
const writes = new Map<string, Promise<unknown>>();
export const saveChatDraft = (draft: ChatDraft): Promise<void> => {
  const work = (writes.get(draft.key) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => { await drafts.drafts.put(draft); });
  writes.set(draft.key, work);
  void work.finally(() => { if (writes.get(draft.key) === work) writes.delete(draft.key); }).catch(() => {});
  return work;
};
export const loadChatDraft = async (key: string): Promise<ChatDraft | undefined> => {
  await writes.get(key)?.catch(() => {});
  return drafts.drafts.get(key);
};
export const deleteChatDraft = (key: string): Promise<void> => {
  const work = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(() => drafts.drafts.delete(key));
  writes.set(key, work);
  void work.finally(() => { if (writes.get(key) === work) writes.delete(key); }).catch(() => {});
  return work;
};
export const chatDraftDatabase = drafts;
