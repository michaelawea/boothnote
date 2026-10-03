import { describe, expect, it } from 'vitest';
import { localMessage, projectMessages } from '../message-projection';
import type { Note } from '../db';
import type { ThreadMessage } from '../api';

const note = (id: string, extra: Partial<Note> = {}): Note => ({ id, text: 'Same text', createdAt: 1,
  recordedBy: 'A', visitLabel: '', sync: 'queued', attempts: 0, toAgent: true, ...extra });
const server = (id: string, clientId: string | null, inboxId: string, role: ThreadMessage['role'] = 'user'): ThreadMessage =>
  ({ ...localMessage(note(id)), id, client_id: clientId, inbox_id: inboxId, role });

describe('durable chat identity projection', () => {
  it('history before upload receipt has exactly one user message and the same UI identity', () => {
    const local = note('client-1');
    const before = projectMessages([], [local]);
    const after = projectMessages([server('message-1', local.id, 'inbox-1')], [local]);
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(after[0].key).toBe(before[0].key);
    expect(after[0].message.id).toBe('message-1');
  });
  it('a late durable receipt reconciles older servers without client_id', () => {
    const result = projectMessages([server('message-1', null, 'inbox-1')], [note('client-1', { remoteId: 'inbox-1' })]);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('client:client-1');
  });
  it('intentional identical text and an agent sharing the inbox all remain visible', () => {
    const result = projectMessages([server('m1', 'c1', 'i1'), server('a1', null, 'i1', 'agent')], [note('c1'), note('c2')]);
    expect(result.map((entry) => entry.key)).toEqual(['client:c1', 'message:a1', 'client:c2']);
  });
  it('repeated server snapshots cannot duplicate a logical message', () => {
    const one = server('m1', 'c1', 'i1');
    expect(projectMessages([one, { ...one }], [note('c1')])).toHaveLength(1);
  });
  it('a persisted failed upload survives refresh with bytes and error available', () => {
    const bytes = new Uint8Array([1, 3, 5]).buffer;
    const queued = note('c1', { sync: 'failed', lastError: 'Network error', attachments: [{ kind: 'file', name: 'field.txt', mime: 'text/plain', size: 3, bytes }] });
    const [entry] = projectMessages([], [queued]);
    expect(entry.message.attachments[0].name).toBe('field.txt');
    expect(entry.note?.attachments?.[0].bytes).toBe(bytes);
    expect(entry.note?.lastError).toBe('Network error');
  });
  it('acknowledged attachments use the server reference while snapshot is catching up', () => {
    const [entry] = projectMessages([], [note('c1', { sync: 'synced', remoteId: 'i1', remoteAttachments: [{ id: 'a1', name: 'photo.jpg', kind: 'photo', mime: 'image/jpeg', size: 2 }] })]);
    expect(entry.message.attachments[0].id).toBe('a1');
  });
});
