// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ fetch: vi.fn(), session: { user: { userCode: 'fixture-a' } } }));
vi.mock('../auth', () => ({ authFetch: auth.fetch, getSession: () => auth.session, applyUser: vi.fn() }));
import { syncThreads } from '../api';
import { db } from '../db';
const thread = { id: 'thread-a', title: 'Account A private conversation', company_code: null,
  created_at: '2026-10-03T00:00:00Z', last_message_at: '2026-10-03T00:00:00Z', messages: 1 };
beforeEach(async () => { await db.threads.clear(); auth.fetch.mockReset(); auth.session.user.userCode = 'fixture-a'; });
afterEach(() => { vi.restoreAllMocks(); });

it('offline history is scoped to its original account and excludes legacy unscoped entries', async () => {
  auth.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ items: [thread] })));
  expect(await syncThreads()).toHaveLength(1);
  await db.threads.put({ ...thread, id: 'old-cache', title: 'Legacy unscoped conversation' });
  auth.fetch.mockRejectedValue(new Error('offline'));
  auth.session.user.userCode = 'fixture-b'; expect(await syncThreads()).toEqual([]);
  auth.session.user.userCode = 'fixture-a'; expect((await syncThreads()).map((item) => item.id)).toEqual(['thread-a']);
});

it('a late response after account change remains cached for the request owner and is not returned to the next account', async () => {
  let complete!: (value: Response) => void;
  auth.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; }));
  const waiting = syncThreads();
  auth.session.user.userCode = 'fixture-b';
  complete(new Response(JSON.stringify({ items: [thread] })));
  expect(await waiting).toEqual([]);
  expect(await db.threads.get(thread.id)).toMatchObject({ recordedBy: 'fixture-a' });
  auth.fetch.mockRejectedValue(new Error('offline')); expect(await syncThreads()).toEqual([]);
});

it('a late offline IndexedDB result is not returned after switching accounts', async () => {
  await db.threads.put({ ...thread, recordedBy: 'fixture-a' });
  auth.fetch.mockRejectedValue(new Error('offline'));
  const originalOrderBy = db.threads.orderBy.bind(db.threads);
  let complete!: () => void;
  let reading!: () => void;
  const started = new Promise<void>((resolve) => { reading = resolve; });
  vi.spyOn(db.threads, 'orderBy').mockImplementation((index) => {
    const collection = originalOrderBy(index);
    const originalRead = collection.toArray.bind(collection);
    vi.spyOn(collection, 'toArray').mockImplementation(() => new Dexie.Promise((resolve, reject) => {
      // Keep the real scoped IndexedDB query, but control when it finishes.
      complete = () => { void originalRead().then(resolve, reject); };
      reading();
    }));
    return collection;
  });
  const waiting = syncThreads();
  await started;
  auth.session.user.userCode = 'fixture-b';
  complete();
  expect(await waiting).toEqual([]);
});
