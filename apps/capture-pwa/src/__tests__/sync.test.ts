import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 纯类型导入，编译后完全消失 —— 不会在桩就位之前把 db.ts 拉起来
import type { LocalSurvey, Note } from '../db';

/**
 * 离线补传 —— **三段解耦的第一段**（T81）。
 *
 * 「速记 → 本地 IndexedDB（不依赖 Agent）→ 网关 `inbox`（不依赖 Twenty）」这一段里，
 * `sync.ts` 是唯一的搬运工。它错了的后果不是「界面不好看」，是**展会现场录的话丢了**——
 * 而这是全项目唯一不可再生的资产。
 *
 * 🔴 **在这个文件之前，`sync.ts`（385 行）和 `db.ts`（376 行）一条测试都没有。**
 *    PWA 侧原有的 7 个测试全是纯函数（容器协商、附件准入、退避判据、分组、更新闸门），
 *    而 T8②「断网落 IndexedDB + 回网补传」——**展会的主场景**——既没有真机确认，
 *    也没有任何自动化覆盖。
 *
 * ── 为什么用真的 IndexedDB，而不是把 `./db` 整个 mock 掉 ─────────────
 *
 * mock 掉 `db` 只能验「调用顺序对不对」，验不了「东西是不是真的落住了」。
 * 而这条链路上出过的事故全在后者：`.where(x)` 的 x 没进索引 → Dexie 抛异常 →
 * 调用点吞掉 → **界面完全正常，数据永远推不上去**（`db.ts` 里记着这个错犯过四次）。
 * 所以这里用 `fake-indexeddb` 跑真的 Dexie：唯一的 devDependency，纯 JS，能进 CI。
 *
 * 网络那一侧全部换成可控的桩（`XMLHttpRequest` / `fetch`）——
 * 集成层的「真 HTTP」在网关那边（`services/gateway/src/__tests__/api.test.ts`），
 * 这里要验的是**本地这一半在网络怎么抖的情况下会不会弄丢东西**。
 */

// ══════════════════════════════════════════════════════════════════
//  桩 —— 必须在被测模块加载之前就位，所以用顶层 await 控制顺序
// ══════════════════════════════════════════════════════════════════

const SESSION = {
  token: 'test-token',
  user: { userCode: 'tester', displayName: '测试', role: 'staff' as const },
};

const ls = new Map<string, string>();
// auth.ts 在模块加载那一刻就 `load()` 一次 —— 先把登录态放进去
ls.set('boothnote-session', JSON.stringify(SESSION));
vi.stubGlobal('localStorage', {
  getItem: (k: string) => ls.get(k) ?? null,
  setItem: (k: string, v: string) => void ls.set(k, String(v)),
  removeItem: (k: string) => void ls.delete(k),
});

const nav = { onLine: true };
vi.stubGlobal('navigator', nav);

/** 一次上传请求，测试里逐条断言发出去的到底是什么。 */
type Sent = {
  url: string;
  payload: Record<string, any>;
  fields: string[];
  /** 每个文件字段发出去的字节数 —— issue #53 那次发出去的是 0 */
  sizes: Record<string, number>;
  /** XHR 上设的超时 */
  timeout: number;
};
const sent: Sent[] = [];

type XhrReply = { status: number; text?: string } | { fail: 'network' | 'timeout' };
let onUpload: (req: Sent) => XhrReply | Promise<XhrReply> = () => ({
  status: 201,
  text: JSON.stringify({ inboxId: 'srv-1' }),
});

class FakeXHR {
  upload = { onprogress: null as null | ((e: any) => void) };
  onload: null | (() => void) = null;
  onerror: null | (() => void) = null;
  ontimeout: null | (() => void) = null;
  onabort: null | (() => void) = null;
  status = 0;
  responseText = '';
  timeout = 0;
  private url = '';

  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  send(body: FormData) {
    const req: Sent = {
      url: this.url,
      payload: JSON.parse(String(body.get('payload'))),
      // fieldname 就是附件的类型（photo / image / file）+ audio —— 自描述，不靠数组顺序
      fields: [...body.keys()].filter((k) => k !== 'payload'),
      sizes: Object.fromEntries(
        [...body.entries()]
          .filter(([k, v]) => k !== 'payload' && v instanceof Blob)
          .map(([k, v]) => [k, (v as Blob).size]),
      ),
      timeout: this.timeout,
    };
    sent.push(req);
    void (async () => {
      this.upload.onprogress?.({ loaded: 1, total: 2, lengthComputable: true });
      const r = await onUpload(req);
      if ('fail' in r) {
        (r.fail === 'timeout' ? this.ontimeout : this.onerror)?.();
        return;
      }
      this.status = r.status;
      this.responseText = r.text ?? '';
      this.onload?.();
    })();
  }
}
vi.stubGlobal('XMLHttpRequest', FakeXHR);

let onFetch: (url: string, init?: RequestInit) => { status: number; body?: unknown } = () => ({
  status: 200,
  body: {},
});
const fetched: string[] = [];
vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
  fetched.push(String(url));
  const r = onFetch(String(url), init);
  return new Response(JSON.stringify(r.body ?? {}), {
    status: r.status,
    headers: { 'content-type': 'application/json' },
  });
});

/**
 * IndexedDB 的桩。
 *
 * ⚠️ 用带类型的主入口逐个装，**不用 `fake-indexeddb/auto`** ——
 *    那个子路径在包的 `exports` 里没有 `types` 一项，`tsc -b` 会 TS7016 报错，
 *    而类型检查是 `./scripts/test.sh` 的第一档。装的东西和 `/auto` 完全一样。
 */
const fakeIdb = await import('fake-indexeddb');
for (const [name, impl] of Object.entries({
  indexedDB: fakeIdb.indexedDB,
  IDBCursor: fakeIdb.IDBCursor,
  IDBCursorWithValue: fakeIdb.IDBCursorWithValue,
  IDBDatabase: fakeIdb.IDBDatabase,
  IDBFactory: fakeIdb.IDBFactory,
  IDBIndex: fakeIdb.IDBIndex,
  IDBKeyRange: fakeIdb.IDBKeyRange,
  IDBObjectStore: fakeIdb.IDBObjectStore,
  IDBOpenDBRequest: fakeIdb.IDBOpenDBRequest,
  IDBRequest: fakeIdb.IDBRequest,
  IDBTransaction: fakeIdb.IDBTransaction,
  IDBVersionChangeEvent: fakeIdb.IDBVersionChangeEvent,
})) {
  vi.stubGlobal(name, impl);
}

const { db } = await import('../db');
const { login } = await import('../auth');
const { flush, flushEdits, flushSurveys, pullInbox, resetStuckUploads } = await import('../sync');

// ══════════════════════════════════════════════════════════════════
//  夹具
// ══════════════════════════════════════════════════════════════════

type NoteInit = Partial<Note> & { id: string };
const addNote = (n: NoteInit) =>
  db.notes.add({
    text: '在 Havel 聊了电池',
    createdAt: 1_700_000_000_000,
    recordedBy: 'tester',
    visitLabel: 'CS2026',
    sync: 'queued',
    attempts: 0,
    ...n,
  } as Note);

const audio = () => new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'audio/webm' });
const got = (id: string) => db.notes.get(id) as Promise<Note>;

/** 401 会当场清掉登录态（撤权立即生效）—— 每个用例开始前都重新登录一次。 */
const restoreSession = async () => {
  onFetch = () => ({ status: 200, body: SESSION });
  await login('tester', 'pw');
};

/** 等到条件成立 —— Dexie 的每次读写都是若干个微任务，一个 tick 等不到。 */
const waitFor = async (cond: () => boolean, label = '条件') => {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`等不到：${label}`);
};

beforeEach(async () => {
  await db.notes.clear();
  sent.length = 0;
  nav.onLine = true;
  onUpload = () => ({ status: 201, text: JSON.stringify({ inboxId: 'srv-1' }) });
  await restoreSession();
  // ⚠️ 清空放在登录之后 —— 登录本身也走 fetch，不清的话
  //    「离线时一个请求都不发」那类断言会被自己的夹具打假
  fetched.length = 0;
});

afterEach(() => {
  onFetch = () => ({ status: 200, body: {} });
});

// ══════════════════════════════════════════════════════════════════
//  ① 断网 → 落库 → 回网补传
// ══════════════════════════════════════════════════════════════════
describe('① 断网 → 落库 → 回网补传（展会的主场景）', () => {
  it('🔴 离线时一个请求都不发，而那条话原地好好待着', async () => {
    nav.onLine = false;
    await addNote({ id: 'a1', audioBlob: audio() });

    await flush();

    expect(sent).toHaveLength(0);
    const n = await got('a1');
    expect(n.sync).toBe('queued');
    expect(n.attempts).toBe(0); // 离线不算一次失败，否则断网十分钟就烧完重试预算
    expect(n.audioBlob).toBeTruthy();
  });

  it('回网之后补传上去 —— 只发一次，回执落回本地', async () => {
    nav.onLine = false;
    await addNote({ id: 'a2', audioBlob: audio() });
    await flush();

    nav.onLine = true;
    onUpload = () => ({
      status: 201,
      text: JSON.stringify({ inboxId: 'srv-a2', threadId: 'th-9', stagingId: 'st-9' }),
    });
    await flush();

    expect(sent).toHaveLength(1);
    const n = await got('a2');
    expect(n.sync).toBe('synced');
    expect(n.remoteId).toBe('srv-a2');
    expect(n.threadId).toBe('th-9');
    expect(n.stagingId).toBe('st-9');
  });

  it('🔴 幂等键是本地那个 id —— 服务端靠它挡重复（§4.2 第6条）', async () => {
    await addNote({ id: 'a3-uuid', companyCode: 'HMG-HAVEL' });
    await flush();

    expect(sent[0].payload.clientId).toBe('a3-uuid');
    expect(sent[0].payload.companyCode).toBe('HMG-HAVEL');
    // 已经 synced 的不会被再传一次（`shouldUpload` 的第一条）
    await flush();
    expect(sent).toHaveLength(1);
  });

  it('🔴 传成功才丢音频和附件，文本永远留着', async () => {
    await addNote({
      id: 'a4',
      audioBlob: audio(),
      audioMime: 'audio/webm',
      attachments: [
        { kind: 'photo', name: '展台.jpg', mime: 'image/jpeg', size: 3, bytes: new Uint8Array([1, 2, 3]).buffer },
      ],
    });

    await flush();

    const n = await got('a4');
    expect(n.sync).toBe('synced');
    expect(n.audioBlob).toBeFalsy();
    expect(n.attachments).toBeFalsy();
    expect(n.text).toBe('在 Havel 聊了电池'); // 文本不省这点空间
  });

  it('🔴 附件按字节发：发出去的 Blob 大小 = 存的字节数（issue #53：iPhone 发出去的是 0 字节）', async () => {
    await addNote({
      id: 'a4b',
      attachments: [
        { kind: 'photo', name: '展台.jpg', mime: 'image/jpeg', size: 7, bytes: new Uint8Array(7).buffer },
      ],
    });

    await flush();

    expect(sent[0].sizes.photo).toBe(7);
  });

  it('上传成功后，服务端回的附件清单留在 remoteAttachments —— 原件丢了，📎 不能跟着没', async () => {
    onUpload = () => ({
      status: 201,
      text: JSON.stringify({
        inboxId: 'srv-4c',
        attachments: [{ id: 'att-1', kind: 'photo', name: '展台.jpg', mime: 'image/jpeg', bytes: 7 }],
      }),
    });
    await addNote({
      id: 'a4c',
      attachments: [
        { kind: 'photo', name: '展台.jpg', mime: 'image/jpeg', size: 7, bytes: new Uint8Array(7).buffer },
      ],
    });

    await flush();

    const n = await got('a4c');
    expect(n.attachments).toBeFalsy();
    expect(n.remoteAttachments).toEqual([
      { id: 'att-1', kind: 'photo', name: '展台.jpg', mime: 'image/jpeg', size: 7 },
    ]);
  });

  it('老网关只回数量时，remoteAttachments 留空而不是塞进一个数字', async () => {
    onUpload = () => ({ status: 201, text: JSON.stringify({ inboxId: 'srv-4d', attachments: 1 }) });
    await addNote({
      id: 'a4d',
      attachments: [{ kind: 'file', name: 'a.pdf', mime: 'application/pdf', size: 1, bytes: new ArrayBuffer(1) }],
    });
    await flush();
    expect((await got('a4d')).remoteAttachments).toBeUndefined();
  });

  it('2026-09-02 之前存的 File 附件照样会被发出去（能不能读是浏览器的事）', async () => {
    await addNote({
      id: 'a4e',
      attachments: [{ kind: 'image', name: 'old.png', mime: 'image/png', size: 2, blob: new Blob(['ab']) }],
    });
    await flush();
    expect(sent[0].fields).toEqual(['image']);
    expect(sent[0].sizes.image).toBe(2);
  });

  it('超时跟着体积走：一句话 90 秒，一张 4 MB 的图给得更多（issue #53 B1）', async () => {
    await addNote({ id: 'a4f' });
    await addNote({
      id: 'a4g',
      createdAt: 1_700_000_000_001,
      attachments: [
        { kind: 'photo', name: 'big.jpg', mime: 'image/jpeg', size: 4 << 20, bytes: new ArrayBuffer(8) },
      ],
    });
    await flush();
    const plain = sent.find((s) => s.payload.clientId === 'a4f')!;
    const withImg = sent.find((s) => s.payload.clientId === 'a4g')!;
    expect(plain.timeout).toBe(90_000);
    expect(withImg.timeout).toBeGreaterThan(90_000 + 100_000);
  });

  it('附件的 fieldname 就是它的类型 —— 自描述，不靠数组顺序对齐', async () => {
    await addNote({
      id: 'a5',
      audioBlob: audio(),
      attachments: [
        { kind: 'photo', name: 'p.jpg', mime: 'image/jpeg', size: 1, bytes: new ArrayBuffer(1) },
        { kind: 'file', name: 'spec.pdf', mime: 'application/pdf', size: 1, bytes: new ArrayBuffer(1) },
      ],
    });

    await flush();

    expect(sent[0].fields).toEqual(['audio', 'photo', 'file']);
  });

  it('D31：速记不自动跑 agent —— toAgent 默认是 false，不是 null 也不是缺省', async () => {
    await addNote({ id: 'a6' });
    await addNote({ id: 'a7', toAgent: true });
    await flush();

    expect(sent.find((s) => s.payload.clientId === 'a6')!.payload.toAgent).toBe(false);
    expect(sent.find((s) => s.payload.clientId === 'a7')!.payload.toAgent).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  ② 传失败之后，不可再生的那份还在
// ══════════════════════════════════════════════════════════════════
describe('② 传失败之后，不可再生的那份还在', () => {
  it('🔴 传失败时音频一个字节都不能少 —— 展会 10 天说过的话不可再生', async () => {
    await addNote({ id: 'b1', audioBlob: audio() });
    onUpload = () => ({ fail: 'network' });

    await flush();

    const n = await got('b1');
    expect(n.sync).toBe('failed');
    expect(await n.audioBlob!.arrayBuffer().then((b) => b.byteLength)).toBe(5);
  });

  it('失败会计次并记下原因，下一轮还会再试', async () => {
    await addNote({ id: 'b2' });
    onUpload = () => ({ status: 500, text: '' });

    await flush();
    expect((await got('b2')).attempts).toBe(1);
    expect((await got('b2')).lastError).toContain('500');

    await flush();
    expect((await got('b2')).attempts).toBe(2);
    expect(sent).toHaveLength(2);
  });

  it('超时和网络错误都当失败处理（挂住的上传不能把队列堵死）', async () => {
    await addNote({ id: 'b3' });
    onUpload = () => ({ fail: 'timeout' });

    await flush();

    expect((await got('b3')).sync).toBe('failed');
    expect((await got('b3')).attempts).toBe(1);
  });

  it('攒够 8 次之后不再自动传', async () => {
    await addNote({ id: 'b4', sync: 'failed', attempts: 8 });
    onUpload = () => ({ status: 500 });

    await flush();

    expect(sent).toHaveLength(0);
    expect((await got('b4')).attempts).toBe(8);
  });

  it('🔴 人手动点了就一定要试一次，而且把次数清零', async () => {
    await addNote({ id: 'b5', sync: 'failed', attempts: 8 });

    await flush({ manual: true });

    expect(sent).toHaveLength(1);
    const n = await got('b5');
    expect(n.sync).toBe('synced');
    // 清零是必须的：不清的话这次成功了，下一条又从第 8 次开始
    expect(n.attempts).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  ③ 登录失效 —— 最容易被当成普通失败的一种
// ══════════════════════════════════════════════════════════════════
describe('③ 登录失效不许烧掉重试预算', () => {
  it('🔴 401 → 保持 queued 且**不计次数**，重新登录后还能补传', async () => {
    await addNote({ id: 'c1', audioBlob: audio() });
    onUpload = () => ({ status: 401 });

    await flush();

    const n = await got('c1');
    expect(n.sync).toBe('queued'); // 不是 failed
    expect(n.attempts).toBe(0); // 当成普通失败的话，8 次很快烧完，那时数据还在本地却再也传不上去
    expect(n.audioBlob).toBeTruthy();

    // 重新登录之后照常传得上去
    await restoreSession();
    onUpload = () => ({ status: 201, text: JSON.stringify({ inboxId: 'srv-c1' }) });
    await flush();
    expect((await got('c1')).sync).toBe('synced');
  });

  it('🔴 401 之后当场停下，不把后面的一起烧掉', async () => {
    await addNote({ id: 'c2', createdAt: 1 });
    await addNote({ id: 'c3', createdAt: 2 });
    await addNote({ id: 'c4', createdAt: 3 });
    onUpload = () => ({ status: 401 });

    await flush();

    expect(sent).toHaveLength(1); // 后面两条根本没发出去
    expect((await got('c3')).attempts).toBe(0);
    expect((await got('c4')).attempts).toBe(0);
  });

  it('没登录时整个队列原地等着 —— 不发请求也不计次数', async () => {
    await addNote({ id: 'c5' });
    const { logout } = await import('../auth');
    logout();

    await flush();

    expect(sent).toHaveLength(0);
    expect((await got('c5')).attempts).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  ④ 卡在「正在传」的必须能被捡回来
// ══════════════════════════════════════════════════════════════════
describe('④ 卡在 syncing 的那条不能凭空消失', () => {
  it('🔴 启动时把上次中断的掰回 queued', async () => {
    await addNote({ id: 'd1', sync: 'syncing' });
    await addNote({ id: 'd2', sync: 'synced' });

    const n = await resetStuckUploads();

    expect(n).toBe(1);
    expect((await got('d1')).sync).toBe('queued');
    expect((await got('d2')).sync).toBe('synced');
  });

  it('🔴 flush 自己也捞 syncing —— 否则它既不会被重传也不会被显示', async () => {
    await addNote({ id: 'd3', sync: 'syncing' });

    await flush();

    expect(sent).toHaveLength(1);
    expect((await got('d3')).sync).toBe('synced');
  });
});

// ══════════════════════════════════════════════════════════════════
//  ⑤ 队列不重入
// ══════════════════════════════════════════════════════════════════
describe('⑤ 同一条不会被两轮 flush 同时传', () => {
  it('🔴 上一轮还在飞的时候，第二轮直接让路', async () => {
    await addNote({ id: 'e1' });

    let release!: (r: XhrReply) => void;
    onUpload = () => new Promise<XhrReply>((r) => (release = r));

    const first = flush();
    await waitFor(() => sent.length === 1, '第一轮把请求发出去'); // 此刻它正挂在网络上
    await flush(); // 第二轮：running 还是 true，应当直接返回

    release({ status: 201, text: JSON.stringify({ inboxId: 'srv-e1' }) });
    await first;

    expect(sent).toHaveLength(1);
    expect((await got('e1')).sync).toBe('synced');
  });
});

// ══════════════════════════════════════════════════════════════════
//  ⑥ 改正文走自己那条细线
// ══════════════════════════════════════════════════════════════════
describe('⑥ 改正文和上传是两条线，绝不能并成一条', () => {
  it('editedAt 比 editSyncedAt 新就推一次，成功后前进', async () => {
    await addNote({
      id: 'f1',
      sync: 'synced',
      remoteId: 'srv-f1',
      editedText: '是 Rosenfeld 不是 Rozenfalt',
      editedAt: 2_000,
      editSyncedAt: 1_000,
    });
    let body: any;
    onFetch = (_u, init) => {
      body = JSON.parse(String(init?.body));
      return { status: 200, body: { ok: true } };
    };

    await flushEdits();

    expect(body.text).toBe('是 Rosenfeld 不是 Rozenfalt');
    expect((await got('f1')).editSyncedAt).toBeGreaterThan(2_000);
  });

  it('🔴 改一条已经 synced 的速记，绝不能把它打回 queued 重传一次', async () => {
    await addNote({
      id: 'f2',
      sync: 'synced',
      remoteId: 'srv-f2',
      editedText: '改过了',
      editedAt: 2_000,
    });
    onFetch = () => ({ status: 200, body: { ok: true } });

    await flushEdits();

    // 音频在上传成功那一刻就从本地删了 —— 重传的结果会是
    // 「一条没有音频的记录覆盖掉一条有音频的记录」
    expect((await got('f2')).sync).toBe('synced');
    expect(sent).toHaveLength(0);
  });

  it('还没上传的不推 —— 没有 remoteId 就谈不上改服务端那份', async () => {
    await addNote({ id: 'f3', editedText: '改了', editedAt: 2_000 });
    onFetch = () => ({ status: 200, body: { ok: true } });

    await flushEdits();

    expect(fetched).toHaveLength(0);
  });

  it('🔴 已经入库的必须说出来，而且存中文原文不存译文（D80 判据②）', async () => {
    await addNote({ id: 'f4', sync: 'synced', remoteId: 'srv-f4', editedText: '改了', editedAt: 2_000 });
    onFetch = () => ({ status: 409, body: {} });

    await flushEdits();

    const n = await got('f4');
    // 人改完看到「已保存」而 CRM 里还是错的 —— 他不会再改第二次
    expect(n.lastError).toContain('已经入库');
    // 进 IndexedDB 的是数据不是显示：不能因为界面语言而不同
    expect(n.lastError).not.toMatch(/[A-Za-z]{4,}/);
  });

  it('网络不通就原地等下一轮 —— 不计次数、不放弃、editSyncedAt 不动', async () => {
    await addNote({
      id: 'f5',
      sync: 'synced',
      remoteId: 'srv-f5',
      editedText: '改了',
      editedAt: 2_000,
      editSyncedAt: 1_000,
    });
    onFetch = () => {
      throw new Error('boom');
    };

    await flushEdits();

    expect((await got('f5')).editSyncedAt).toBe(1_000);
  });
});

// ══════════════════════════════════════════════════════════════════
//  ⑦ 下行合并：本地更新的那份说了算
// ══════════════════════════════════════════════════════════════════
describe('⑦ 拉回来的东西不许盖掉本地更新的那份', () => {
  const remote = (over: Record<string, any> = {}) => ({
    id: 'srv-x',
    client_id: 'x1',
    text: '服务端那份',
    created_at: '2026-08-07T10:00:00.000Z',
    device_created_at: '2026-08-07T10:00:00.000Z',
    visit_label: 'CS2026',
    status: 'ready',
    ...over,
  });

  it('服务端有、本地没有 → 插入并标 synced（换台设备登录就靠这条）', async () => {
    onFetch = () => ({ status: 200, body: { items: [remote()] } });

    const added = await pullInbox();

    expect(added).toBe(1);
    const n = await got('x1');
    expect(n.sync).toBe('synced');
    expect(n.remoteId).toBe('srv-x');
    expect(n.recordedBy).toBe('tester');
  });

  it('🔴 换台手机：GET /inbox 的附件清单落进 remoteAttachments —— 否则那台上图片根本不存在（issue #53）', async () => {
    onFetch = () => ({
      status: 200,
      body: {
        items: [
          remote({
            attachments: [{ id: 'att-9', kind: 'photo', name: 'booth.jpg', mime: 'image/jpeg', bytes: 512 }],
          }),
        ],
      },
    });

    await pullInbox();

    expect((await got('x1')).remoteAttachments).toEqual([
      { id: 'att-9', kind: 'photo', name: 'booth.jpg', mime: 'image/jpeg', size: 512 },
    ]);
  });

  it('本地已 synced 但没有清单的（老版本传的），拉一次就补上', async () => {
    await addNote({ id: 'x1', sync: 'synced', remoteId: 'srv-x' });
    onFetch = () => ({
      status: 200,
      body: {
        items: [remote({ attachments: [{ id: 'att-9', kind: 'file', name: 'a.pdf', mime: 'application/pdf', bytes: 1 }] })],
      },
    });

    await pullInbox();

    expect((await got('x1')).remoteAttachments?.map((a) => a.id)).toEqual(['att-9']);
  });

  it('🔴 本地还在队列里的，一个字都不碰 —— 本地那份更新，正等着上传', async () => {
    await addNote({ id: 'x1', text: '我刚录的', sync: 'queued' });
    const before = await got('x1');
    // 服务端这份带齐了所有「会被回填」的派生字段 —— 有守卫时它们一个都进不来
    onFetch = () => ({
      status: 200,
      body: {
        items: [
          remote({
            text: '服务端那份',
            transcript: '听出来的',
            title: '一句话标题',
            company_code: 'HMG-HAVEL',
            staging_id: 'st-1',
            thread_id: 'th-1',
            status: 'ready',
          }),
        ],
      },
    });

    await pullInbox();

    /**
     * 🔴 断言整行相等，不是只看正文。
     *
     * 这条一开始写成「`text` / `sync` / `remoteId` 三样没变」—— 而那三样
     * 走另一条分支时**本来就不会被改**，于是把守卫整个删掉，测试照样绿
     * （2026-08-10 变异测试抓到的，这是个为了错误的理由而通过的用例）。
     * 「一个字都不碰」就得按字面断言。
     */
    expect(await got('x1')).toEqual(before);
  });

  it('两边都有、本地已 synced → 补转录，但正文一个字不动', async () => {
    await addNote({ id: 'x1', text: '', sync: 'synced', remoteId: 'srv-x' });
    onFetch = () => ({
      status: 200,
      body: { items: [remote({ transcript: '听出来的那段', title: '一句话标题' })] },
    });

    await pullInbox();

    const n = await got('x1');
    expect(n.transcript).toBe('听出来的那段'); // 机器听的
    expect(n.text).toBe(''); // 人打的 —— 两层不合并
    expect(n.title).toBe('一句话标题');
  });

  it('🔴 本地有还没推上去的修改 → 不覆盖 editedText（人刚敲的不能凭空消失）', async () => {
    await addNote({
      id: 'x1',
      sync: 'synced',
      remoteId: 'srv-x',
      editedText: '我刚改的',
      editedAt: 5_000,
      editSyncedAt: 1_000, // 脏：还没推上去
    });
    onFetch = () => ({ status: 200, body: { items: [remote({ edited_text: '别的设备改的' })] } });

    await pullInbox();

    expect((await got('x1')).editedText).toBe('我刚改的');
  });

  it('本地干净时，别的设备改过的正文拉得回来', async () => {
    await addNote({
      id: 'x1',
      sync: 'synced',
      remoteId: 'srv-x',
      editedText: '老的',
      editedAt: 1_000,
      editSyncedAt: 1_000,
    });
    onFetch = () => ({ status: 200, body: { items: [remote({ edited_text: '别的设备改的' })] } });

    await pullInbox();

    expect((await got('x1')).editedText).toBe('别的设备改的');
  });

  it('🔴 服务端处理状态每次都覆盖 —— 重试成功之后那行红字必须能擦掉', async () => {
    await addNote({
      id: 'x1',
      sync: 'synced',
      remoteId: 'srv-x',
      stagingStatus: 'failed',
      stagingError: '转写失败',
    });
    onFetch = () => ({ status: 200, body: { items: [remote({ status: 'ready', error: null })] } });

    await pullInbox();

    const n = await got('x1');
    expect(n.stagingStatus).toBe('ready');
    expect(n.stagingError).toBeUndefined();
  });

  it('🔴 账号切成英文之后，落进 IndexedDB 的占位符仍是中文（D80 判据②）', async () => {
    // 真的把这个账号切成英文 —— `locale()` 读的就是登录态里的 user.locale
    onFetch = () => ({ status: 200, body: { ...SESSION, user: { ...SESSION.user, locale: 'en' } } });
    await login('tester', 'pw');
    const { t, locale } = await import('../i18n');
    expect(locale()).toBe('en'); // 前提成立：界面这会儿确实是英文
    expect(t('速记')).toBe('Capture');

    onFetch = () => ({ status: 200, body: { items: [remote({ text: null, transcript: null })] } });
    await pullInbox();

    /**
     * 🔴 这一格之后可能被 `saveNoteText` 推到**只增不改**的 `inbox`。
     * 过了 `t()` 的话，同一条语音速记在英文账号下存成英文、中文账号下存成中文 ——
     * 一个界面设置就把不可再生的原文写脏了。
     * 判据：数据路径存规范形式（中文），只有渲染那一层才翻译。
     */
    expect((await got('x1')).text).toBe('（语音，待转写）');
  });

  it('离线时什么都不做，本地那份照常能用', async () => {
    await addNote({ id: 'x1', text: '本地的' });
    nav.onLine = false;

    expect(await pullInbox()).toBe(0);
    expect(fetched).toHaveLength(0);
    expect((await got('x1')).text).toBe('本地的');
  });
});

// ══════════════════════════════════════════════════════════════════
//  ⑧ 2C 问卷的上传队列（D138）—— 和速记同一套规矩
// ══════════════════════════════════════════════════════════════════

describe('⑧ 2C 问卷：离线落库 → 回网补传，失败不丢、登录失效不烧次数', () => {
  const addSurvey = (x: Partial<LocalSurvey> & { id: string }) =>
    db.surveys.add({
      surveyKey: 'vdl2026',
      answers: { equipment: ['solar'], appliances: { fridge: 'have' } },
      contact: { name: 'Jean Dupont', phone: '0612345678' },
      consentAt: '2026-09-27T10:00:00.000Z',
      createdAt: 1_700_000_000_000,
      recordedBy: 'tester',
      sync: 'queued',
      attempts: 0,
      ...x,
    } as LocalSurvey);
  const gotS = (id: string) => db.surveys.get(id) as Promise<LocalSurvey>;
  const bodies: Array<Record<string, any>> = [];

  beforeEach(async () => {
    await db.surveys.clear();
    bodies.length = 0;
  });
  /** 只拦 /surveys，别的请求照旧 200 */
  const gateway = (status: number) => {
    onFetch = (url, init) => {
      if (url.endsWith('/surveys')) bodies.push(JSON.parse(String(init?.body)));
      return { status, body: status < 300 ? { id: 'srv', status: 'pending' } : { error: 'x' } };
    };
  };

  it('离线时一个请求都不发，也不计次数', async () => {
    await addSurvey({ id: 's1' });
    nav.onLine = false;
    await flushSurveys();
    expect(fetched).toHaveLength(0);
    expect(await gotS('s1')).toMatchObject({ sync: 'queued', attempts: 0 });
  });

  it('传成功：标 synced，**本地的联系方式清掉**，答案留着；发出去的就是那一份', async () => {
    await addSurvey({ id: 's1' });
    gateway(201);
    await flushSurveys();

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      clientId: 's1', // 幂等键 = 本地 id
      surveyKey: 'vdl2026',
      answers: { equipment: ['solar'], appliances: { fridge: 'have' } },
      contact: { name: 'Jean Dupont', phone: '0612345678' },
      consentAt: '2026-09-27T10:00:00.000Z',
      createdAt: 1_700_000_000_000,
    });
    const s = await gotS('s1');
    expect(s.sync).toBe('synced');
    expect(s.contact).toBeUndefined();
    expect(s.answers).toEqual({ equipment: ['solar'], appliances: { fridge: 'have' } });
  });

  it('重复交（网关回 200 duplicate）也算成功', async () => {
    await addSurvey({ id: 's1' });
    gateway(200);
    await flushSurveys();
    expect((await gotS('s1')).sync).toBe('synced');
  });

  it('🔴 网关回 500：只加次数，答案和联系方式一个字不动', async () => {
    await addSurvey({ id: 's1' });
    const before = await gotS('s1');
    gateway(500);
    await flushSurveys();

    const after = await gotS('s1');
    expect(after).toMatchObject({ sync: 'failed', attempts: 1 });
    expect(after.answers).toEqual(before.answers);
    expect(after.contact).toEqual(before.contact);
    expect(after.lastError).toContain('500');
  });

  it('🔴 401：保持 queued、不计次数，后面的也不再试', async () => {
    await addSurvey({ id: 's1', createdAt: 1 });
    await addSurvey({ id: 's2', createdAt: 2 });
    gateway(401);
    await flushSurveys();

    expect(bodies).toHaveLength(1);
    expect(await gotS('s1')).toMatchObject({ sync: 'queued', attempts: 0 });
    expect(await gotS('s2')).toMatchObject({ sync: 'queued', attempts: 0 });
  });

  it('卡在 syncing 的问卷启动时掰回 queued —— 否则它既不重传也不进「待传 N」', async () => {
    await addSurvey({ id: 's1', sync: 'syncing' });
    expect(await resetStuckUploads()).toBe(1);
    expect((await gotS('s1')).sync).toBe('queued');
  });

  it('攒够 8 次失败后自动不再试，人点了照样试一次', async () => {
    await addSurvey({ id: 's1', sync: 'failed', attempts: 8 });
    gateway(201);
    await flushSurveys();
    expect(bodies).toHaveLength(0);
    await flushSurveys({ manual: true });
    expect(bodies).toHaveLength(1);
    expect((await gotS('s1')).sync).toBe('synced');
  });
});
