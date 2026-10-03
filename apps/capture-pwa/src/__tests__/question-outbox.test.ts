// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), upload: vi.fn(), session: { user: { userCode: 'fixture-a' } } }));
vi.mock('../auth', () => ({
  authFetch: mocks.fetch, authUpload: mocks.upload, getSession: () => mocks.session,
  onAuthChange: () => () => {}, AuthError: class AuthError extends Error {},
}));
import { db } from '../db';
import { enqueueQuestionAnswer, flush } from '../sync';

const answer = {
  threadId: '11111111-1111-4111-8111-111111111111',
  questionId: '22222222-2222-4222-8222-222222222222',
  expectedRevision: 'revision-fingerprint', optionId: 'selected-handle', displayText: 'Append to selected case',
};
beforeEach(async () => {
  await db.notes.clear(); mocks.fetch.mockReset(); mocks.upload.mockReset();
  mocks.session.user.userCode = 'fixture-a';
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

describe('structured answer outbox', () => {
  it('captures offline and retries with the same client ID and binding, without ordinary inbox upload', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    const note = await enqueueQuestionAnswer(answer);
    await flush();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect((await db.notes.get(note.id))?.questionAnswer).toMatchObject({ expectedRevision: answer.expectedRevision, optionId: answer.optionId });
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    mocks.fetch.mockResolvedValueOnce(new Response('{"error":"temporarily_unavailable"}', { status: 503 }));
    await flush();
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ inboxId: 'receipt', threadId: answer.threadId, stagingId: 'proposal' }), { status: 201 }));
    await flush();
    const payloads = mocks.fetch.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(payloads.map((payload) => payload.clientId)).toEqual([note.id, note.id]);
    expect(payloads.every((payload) => payload.optionId === answer.optionId && payload.expectedRevision === answer.expectedRevision)).toBe(true);
    expect(mocks.fetch.mock.calls[0][0]).toContain(`/questions/${answer.questionId}/answers`);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(await db.notes.get(note.id)).toMatchObject({ sync: 'synced', remoteId: 'receipt', text: answer.displayText });
  });

  it('preserves a stale answer but blocks automatic and manual replay of its rejected binding', async () => {
    const note = await enqueueQuestionAnswer(answer);
    mocks.fetch.mockResolvedValue(new Response('{"error":"question_stale"}', { status: 409 }));
    await flush(); await flush(); await flush({ manual: true });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(await db.notes.get(note.id)).toMatchObject({ sync: 'failed', answerBlocked: true,
      lastError: 'question_stale', text: answer.displayText, questionAnswer: { optionId: answer.optionId } });
  });

  it('does not upload a previous account’s queued answer after another account signs in', async () => {
    const note = await enqueueQuestionAnswer(answer);
    mocks.session.user.userCode = 'fixture-b'; await flush();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect((await db.notes.get(note.id))?.sync).toBe('queued');
  });

  it('keeps the original answer queued if the account changes during the IndexedDB upload transition', async () => {
    const note = await enqueueQuestionAnswer(answer);
    const changeAccount = (changes: Object) => {
      const update = changes as { sync?: string };
      if (update.sync === 'syncing') mocks.session.user.userCode = 'fixture-b';
    };
    db.notes.hook('updating', changeAccount);
    try {
      await flush();
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(await db.notes.get(note.id)).toMatchObject({ sync: 'queued', attempts: 0, recordedBy: 'fixture-a' });
    } finally { db.notes.hook('updating').unsubscribe(changeAccount); }
  });
});
