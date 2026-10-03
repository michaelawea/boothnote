import type { ThreadMessage } from './api';
import type { Note } from './db';

export type ChatEntry = { key: string; message: ThreadMessage; note?: Note };

export const localMessage = (note: Note): ThreadMessage => ({
  id: `local-${note.id}`, role: 'user', text: note.text, client_id: note.id,
  inbox_id: note.remoteId ?? null, meta: {}, created_at: new Date(note.createdAt).toISOString(),
  superseded_by: null, supersede_reason: null, staging_id: null, status: null,
  extracted: null, confidence: null, partial: null, suggested_company: null,
  confirm_after: null, twenty_refs: null, agent_trace: null, agent_steps: null,
  run_stop_reason: null, run_duration_ms: null, staging_error: null, confirmed_fields: null,
  attachments: note.attachments?.map((a) => ({ id: '', name: a.name, kind: a.kind, bytes: a.size, parsed: null, chars: 0 }))
    ?? note.remoteAttachments?.map((a) => ({ id: a.id, name: a.name, kind: a.kind, bytes: a.size, parsed: null, chars: 0 })) ?? [],
});

/** Identity reconciliation; equal text is never a reason to remove a message. */
export const projectMessages = (messages: ThreadMessage[], notes: Note[]): ChatEntry[] => {
  const localByInbox = new Map(notes.filter((n) => n.remoteId).map((n) => [n.remoteId!, n]));
  const acknowledgedClients = new Set(messages.filter((m) => m.role === 'user' && m.client_id).map((m) => m.client_id!));
  const acknowledgedInboxes = new Set(messages.filter((m) => m.role === 'user' && m.inbox_id).map((m) => m.inbox_id!));
  const result: ChatEntry[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const note = message.role === 'user' && message.inbox_id ? localByInbox.get(message.inbox_id) : undefined;
    const clientId = message.role === 'user' ? message.client_id ?? note?.id : null;
    const key = clientId ? `client:${clientId}` : `message:${message.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ key, message, note });
  }
  for (const note of [...notes].sort((a, b) => a.createdAt - b.createdAt)) {
    if (acknowledgedClients.has(note.id) || (note.remoteId && acknowledgedInboxes.has(note.remoteId))) continue;
    const key = `client:${note.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ key, message: localMessage(note), note });
  }
  return result;
};
