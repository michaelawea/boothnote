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
// 服务器认领会话只更换存储 key。旧 render 排队的保存仍属于原 conversation。
const movedKeys = new Map<string, Map<string, string>>();
const enqueueWrite = (keys: string[], write: () => Promise<void>): Promise<void> => {
  const pending = keys.map((key) => writes.get(key)?.catch(() => {}));
  const work = Promise.all(pending).then(write);
  for (const key of keys) writes.set(key, work);
  void work.finally(() => {
    for (const key of keys) if (writes.get(key) === work) writes.delete(key);
  }).catch(() => {});
  return work;
};
export const saveChatDraft = (draft: ChatDraft): Promise<void> => {
  const key = movedKeys.get(draft.key)?.get(draft.conversationId) ?? draft.key;
  return enqueueWrite([...new Set([draft.key, key])], async () => {
    // 迁移失败时保留来源；迁移期间排队的保存也不能覆盖冲突的目标。
    // 迁移前排队的保存仍写来源，迁移会等它完成后搬走；不能提前改写目标。
    const destination = key === draft.key ? draft.key
      : movedKeys.get(draft.key)?.get(draft.conversationId) ?? draft.key;
    await drafts.transaction('rw', drafts.drafts, async () => {
      if (key !== draft.key) {
        const existing = await drafts.drafts.get(destination);
        if (existing && (existing.userCode !== draft.userCode || existing.conversationId !== draft.conversationId)) {
          throw new Error('The draft belongs to another conversation');
        }
      }
      await drafts.drafts.put({ ...draft, key: destination });
    });
  });
};
export const loadChatDraft = async (key: string): Promise<ChatDraft | undefined> => {
  await writes.get(key)?.catch(() => {});
  return drafts.drafts.get(key);
};
export const deleteChatDraft = (key: string): Promise<void> => {
  return enqueueWrite([key], async () => { await drafts.drafts.delete(key); });
};
/** 先保存目标再删除来源，两个 key 的已有及迟到保存都排在同一队列中。 */
export const moveChatDraft = ({ fromKey, toKey, userCode, conversationId }: {
  fromKey: string; toKey: string; userCode: string; conversationId: string;
}): Promise<void> => {
  if (fromKey === toKey) return Promise.resolve();
  if (!fromKey.startsWith(`${userCode}:`) || !toKey.startsWith(`${userCode}:`)) {
    return Promise.reject(new Error('Cannot move a draft between accounts'));
  }
  const moves = movedKeys.get(fromKey) ?? new Map<string, string>();
  movedKeys.set(fromKey, moves);
  if (moves.get(conversationId) === toKey) {
    return (writes.get(toKey) ?? Promise.resolve()).then(() => {});
  }
  if (moves.has(conversationId)) return Promise.reject(new Error('The conversation already has a server thread'));
  const work = enqueueWrite([fromKey, toKey], async () => {
    await drafts.transaction('rw', drafts.drafts, async () => {
      const source = await drafts.drafts.get(fromKey);
      const target = await drafts.drafts.get(toKey);
      if (source && (source.userCode !== userCode || source.conversationId !== conversationId)) {
        throw new Error('The draft belongs to another conversation');
      }
      if (target && (target.userCode !== userCode || target.conversationId !== conversationId)) {
        throw new Error('The target draft belongs to another conversation');
      }
      if (source) await drafts.drafts.put({ ...source, key: toKey });
      await drafts.drafts.delete(fromKey);
    });
  });
  // 下一次新会话复用 new key 时，其新 conversationId 不会命中这个映射。
  moves.set(conversationId, toKey);
  void work.catch(() => {
    if (moves.get(conversationId) === toKey) moves.delete(conversationId);
  });
  return work;
};
export const chatDraftDatabase = drafts;
