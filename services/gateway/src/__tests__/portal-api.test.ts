import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';

import { env } from '../env.ts';
import { sql } from '../db.ts';
import { portalCodeBase, registerPortal } from '../portal.ts';
import { codeBase, seqOf } from '../projectCode.ts';

/**
 * 订单门户那组接口 `/portal/*` · 集成测试（D139–D142 · docs/portal-projects.md §4）。
 *
 * 跑法：./scripts/test.sh integration（一次性环境，stack 会 export PORTAL_SECRET，Twenty 故意不通）
 *       ./scripts/integration-stack.sh --with-twenty（连本地 Twenty，把真写的那一档也跑了）
 *
 * 三档：
 *   ① 进程内（Fastify inject）：**secret 留空 = 503**。跑着的那个网关 secret 是开着的，
 *      「关着的样子」只能在这里造 —— env.portalSecret 是 getter，翻 process.env 就生效。
 *   ② 真 HTTP、Twenty 不通：鉴权四条 + **Twenty 挂了回 502 twenty_unavailable，不回显原文**。
 *   ③ 真 HTTP、真 Twenty（要本地 Twenty 且 projectUpdate 对象已 provision）：
 *      建类型 → 建项目 → 换阶段 → 记进展 → 409 三种 → 软删。**after() 里逐条 REST DELETE 收干净**
 *      （测试清理是全仓库唯一允许 REST DELETE 的地方 —— §2.38）。
 * 「跳过」和「通过」要分得开，所以每一档 skip 时都点名原因。
 */

const BASE = process.env.GATEWAY_URL ?? `http://localhost:${env.port}`;

// ── 安全闸门：非本地一律拒跑（和另外几个集成测试同一道，同一句咒语才放行）──
const isLocal = (u: string) => /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(u);
for (const [what, url] of [['GATEWAY_URL', BASE], ['SERVER_URL', env.twentyUrl]] as const) {
  if (isLocal(url)) continue;
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  if (process.env.ALLOW_NONLOCAL_TESTS !== host) {
    console.error(`\n🔴 门户集成测试只对本地跑（会在 Twenty 里建类型/项目/进展）。${what}=${url}\n`);
    process.exit(1);
  }
}

const SECRET = process.env.PORTAL_SECRET ?? '';
if (!SECRET) console.error('⏭ PORTAL_SECRET 没配 —— 真 HTTP 那两档 skip（用 ./scripts/test.sh integration 跑）');

// ⚠️ 顶层收尾：portal.ts → projectCode.ts → db.ts 会建连接池；不关的话子进程可能不退出
after(async () => {
  await sql.end({ timeout: 5 });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      'X-Portal-Secret': SECRET,
      'X-Portal-Actor': 'itest-admin',
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
};

/** 直接读 Twenty（校验「真写进去了 / 真是软删」用）。429 退避，**读不到就抛，绝不返回 null**（§2.39）。 */
const twentyFetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${env.twentyUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${env.twentyKey}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
    if (res.status !== 429 || attempt >= 5) return res;
    await res.text().catch(() => undefined);
    console.warn(`  ⏳ Twenty 限流，等 ${2 ** attempt}s 再试：${path}`);
    await sleep(1000 * 2 ** attempt);
  }
};

/**
 * 直接打 Twenty 的 GraphQL。🔴 **GraphQL 的限流不是 429** —— 是 HTTP 200 + `LIMIT_REACHED`
 * （Twenty 源码确认）。第一版只认 429，结果一次限流被这个文件报成「多半是被硬删了」——
 * 一个限流问题伪装成数据问题（§2.39 同一个形状）。所以这里认它、退避，退不过去就如实说是限流。
 */
const twentyGql = async (query: string, variables: Record<string, unknown>): Promise<any> => {
  for (let attempt = 0; ; attempt++) {
    const j: any = await (await twentyFetch('/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) })).json();
    const limited = (j?.errors ?? []).some((e: any) => e?.extensions?.subCode === 'LIMIT_REACHED');
    if (!limited) return j;
    if (attempt >= 5) throw new Error('Twenty GraphQL 一直在限流（LIMIT_REACHED）—— 这不是数据问题，过一分钟再跑');
    console.warn(`  ⏳ Twenty GraphQL 限流，等 ${2 ** attempt}s 再试`);
    await sleep(1000 * 2 ** attempt);
  }
};

// ── 探针：运行时判断，不靠假设 ───────────────────────────────────────
/** 429 算「活着」—— 撞一次限流就把整档 skip 掉，比红更危险。 */
const twentyAlive = await fetch(`${env.twentyUrl}/rest/companies?limit=1`, {
  headers: { Authorization: `Bearer ${env.twentyKey}` },
  signal: AbortSignal.timeout(4000),
})
  .then((r) => r.ok || r.status === 429)
  .catch(() => false);
const objectReady = twentyAlive
  ? await twentyFetch('/rest/metadata/objects?limit=200')
      .then((r) => r.json())
      .then((j: any) => (j?.data?.objects ?? j?.data ?? []).some((o: any) => o?.nameSingular === 'projectUpdate'))
      .catch(() => false)
  : false;
/** 跑着的那个网关：503 = 关着，401 = 开着，404 = 路由根本没注册（那才是真出事）。 */
const gatewayProbe = await fetch(`${BASE}/portal/snapshot`)
  .then((r) => r.status)
  .catch(() => 0);

const NEEDS_ON = SECRET && gatewayProbe === 401 ? {} : { skip: `网关的门户接口没开（探针 ${gatewayProbe}）` };
const NEEDS_TWENTY_DOWN = twentyAlive ? { skip: '这条要 Twenty 不可达（--with-twenty 时跳过）' } : {};
const NEEDS_TWENTY =
  SECRET && gatewayProbe === 401 && objectReady
    ? {}
    : { skip: twentyAlive ? 'Twenty 里还没有 projectUpdate 对象（先跑 provision-twenty.mjs）' : '要真写 Twenty，而这个环境里没有它' };

// ═══════════════════════════════════════════════════════════════════
describe('门户接口 · 开关（进程内，secret 留空的样子）', () => {
  it('🔴 PORTAL_SECRET 留空 = 整组 503 portal_disabled，提示同时指到 .env 和 compose（D66）', async () => {
    const saved = process.env.PORTAL_SECRET;
    process.env.PORTAL_SECRET = ''; // 空串不是 undefined：opt() 不会再退到 .env 文件里去读
    const app = Fastify();
    registerPortal(app);
    try {
      for (const [method, url] of [
        ['GET', '/portal/snapshot'],
        ['POST', '/portal/projects'],
        ['DELETE', `/portal/updates/${randomUUID()}`],
      ] as const) {
        const r = await app.inject({ method, url, headers: { 'x-portal-secret': 'anything' } });
        assert.equal(r.statusCode, 503, `${method} ${url}`);
        const j = r.json();
        assert.equal(j.error, 'portal_disabled');
        assert.match(j.hint, /\.env/);
        assert.match(j.hint, /compose/);
      }
    } finally {
      await app.close();
      if (saved === undefined) delete process.env.PORTAL_SECRET;
      else process.env.PORTAL_SECRET = saved;
    }
  });

  it('secret 配上之后同一组路由就是 401 而不是 503（开关真的是那一个变量）', async () => {
    const saved = process.env.PORTAL_SECRET;
    process.env.PORTAL_SECRET = 'inproc-secret-0123456789';
    const app = Fastify();
    registerPortal(app);
    try {
      const r = await app.inject({ method: 'GET', url: '/portal/snapshot', headers: { 'x-portal-secret': 'wrong' } });
      assert.equal(r.statusCode, 401);
      assert.deepEqual(r.json(), { error: 'bad_secret' });
    } finally {
      await app.close();
      if (saved === undefined) delete process.env.PORTAL_SECRET;
      else process.env.PORTAL_SECRET = saved;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
/**
 * 假 Twenty（进程内）：review 2026-10-01 那几条全是「Twenty 中途失败 / 数据量大 / 一个特定的请求形状」——
 * 真 Twenty 造不出 10 秒超时，也不该往本地库里灌一万条进展。所以这里把 fetch 换成一个内存里的 Twenty
 * （只认网关用到的那几种请求），**一次性环境里也照跑**，不依赖本地 Twenty。
 */
type FaultResult = 'commit-then-timeout' | 'fail' | void;
type Fault = (m: string, path: string, body: any) => FaultResult | Promise<FaultResult>;
const fakeTwenty = () => {
  const SINGULAR: Record<string, string> = {
    companies: 'company', projectTypes: 'projectType', projectTypeStages: 'projectTypeStage',
    projects: 'project', projectUpdates: 'projectUpdate',
  };
  const db: Record<string, any[]> = Object.fromEntries(Object.keys(SINGULAR).map((k) => [k, []]));
  const writes: Array<{ method: string; path: string; body: any }> = [];
  const faults: Fault[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const match = (row: any, filter: string | null) => {
    if (!filter) return true;
    const m = filter.match(/^(\w+)\[(eq|ilike)\]:"?(.*?)"?$/);
    if (!m) throw new Error(`假 Twenty 不认识这个 filter：${filter}`);
    const [, field, op, want] = m as unknown as [string, string, string, string];
    const v = String(row[field!] ?? '');
    if (op === 'eq') return v === want;
    const re = new RegExp(`^${want!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i');
    return re.test(v);
  };
  const handler = async (url: URL, method: string, body: any, noFaults = false): Promise<Response> => {
    const [, rest, plural, id] = url.pathname.split('/');
    if (rest !== 'rest' || !plural || !SINGULAR[plural]) return json(404, { error: `假 Twenty 没有 ${url.pathname}` });
    const singular = SINGULAR[plural]!;
    const cap = singular[0]!.toUpperCase() + singular.slice(1);
    const rows = db[plural]!;
    if (method !== 'GET' && !noFaults) writes.push({ method, path: url.pathname, body });
    for (const f of noFaults ? [] : faults) {
      const r = await f(method, `${url.pathname}${url.search}`, body);
      if (r === 'fail') return json(500, { error: 'boom' });
      if (r === 'commit-then-timeout') {
        await handler(url, method, body, true); // Twenty 提交了……
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); // ……但我们没等到回包
      }
    }
    if (method === 'GET' && !id) {
      const hit = rows.filter((r) => match(r, url.searchParams.get('filter')));
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 60), 200); // 和真 Twenty 一样封顶 200
      const after = url.searchParams.get('starting_after');
      const from = after ? Number(after) + 1 : 0;
      const page = hit.slice(from, from + limit);
      const more = from + limit < hit.length;
      return json(200, { data: { [plural]: page }, pageInfo: { hasNextPage: more, endCursor: more ? String(from + limit - 1) : null } });
    }
    if (method === 'GET') {
      const r = rows.find((x) => x.id === id);
      return r ? json(200, { data: { [singular]: r } }) : json(404, { error: 'not found' });
    }
    if (method === 'POST') {
      for (const k of ['projectCode', 'typeCode', 'clientId'])
        if (body?.[k] && rows.some((r) => r[k] === body[k])) return json(400, { messages: ['A duplicate entry was detected'] });
      const rec = { id: randomUUID(), createdAt: new Date().toISOString(), ...body };
      rows.push(rec);
      return json(201, { data: { [`create${cap}`]: rec } });
    }
    if (method === 'PATCH') {
      const r = rows.find((x) => x.id === id);
      if (!r) return json(404, { error: 'not found' });
      Object.assign(r, body);
      return json(200, { data: { [`update${cap}`]: r } });
    }
    return json(405, {});
  };
  const realFetch = globalThis.fetch;
  const install = () => {
    globalThis.fetch = (async (input: any, init?: any) => {
      const u = String(input?.url ?? input);
      if (!u.startsWith(env.twentyUrl)) return realFetch(input, init);
      const method = String(init?.method ?? 'GET').toUpperCase();
      return handler(new URL(u), method, init?.body ? JSON.parse(String(init.body)) : undefined);
    }) as typeof fetch;
  };
  const restore = () => {
    globalThis.fetch = realFetch;
  };
  const seed = (plural: string, row: Record<string, unknown>) => {
    const rec = { id: randomUUID(), createdAt: new Date().toISOString(), ...row };
    db[plural]!.push(rec);
    return rec as any;
  };
  return { db, writes, faults, install, restore, seed };
};

describe('门户接口 · 假 Twenty（进程内：超时 / 半截写入 / 规模 —— review 2026-10-01）', () => {
  const T = fakeTwenty();
  const app = Fastify();
  let savedSecret: string | undefined;
  const KEY = 'inproc-fake-twenty-secret-0123';
  const H = { 'x-portal-secret': KEY, 'content-type': 'application/json', 'x-portal-actor': 'fake-admin' };
  const inject = async (method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) => {
    const r = await app.inject({ method, url, headers: H, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
    return { status: r.statusCode, json: r.json() as any };
  };
  const S: Record<string, any> = {};

  before(async () => {
    savedSecret = process.env.PORTAL_SECRET;
    process.env.PORTAL_SECRET = KEY;
    registerPortal(app);
    await app.ready();
    T.install();
    S.company = T.seed('companies', { name: 'Istra Mobil', accountCode: 'ISTRA' });
    S.typeA = T.seed('projectTypes', { name: 'Type A', typeCode: 'TYPE-A', isActive: true });
    S.a1 = T.seed('projectTypeStages', { projectTypeId: S.typeA.id, name: 'A1', stageKey: 'a1', stageOrder: 1, isActive: true });
    S.typeB = T.seed('projectTypes', { name: 'Type B', typeCode: 'TYPE-B', isActive: true });
    S.b1 = T.seed('projectTypeStages', { projectTypeId: S.typeB.id, name: 'B1', stageKey: 'b1', stageOrder: 1, isActive: true });
  });
  after(async () => {
    T.restore();
    await app.close();
    if (savedSecret === undefined) delete process.env.PORTAL_SECRET;
    else process.env.PORTAL_SECRET = savedSecret;
  });

  it('🔴 换类型时把旧阶段原样发回来 → 400，项目一格不写（不许落成「类型 B + 类型 A 的阶段」）', async () => {
    const p = T.seed('projects', {
      name: 'Switch me', projectCode: 'MANUAL-SWITCH-1', companyId: S.company.id,
      projectTypeId: S.typeA.id, currentStageId: S.a1.id,
    });
    T.writes.length = 0;
    const r = await inject('PATCH', `/portal/projects/${p.id}`, { projectTypeId: S.typeB.id, currentStageId: S.a1.id });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.match(r.json.detail, /does not belong/);
    assert.deepEqual(T.writes, [], '400 之前就写了 Twenty');
    assert.equal(p.projectTypeId, S.typeA.id);

    // 正路：换类型 + 新类型的阶段 → 200、记一条 stageChange
    const ok = await inject('PATCH', `/portal/projects/${p.id}`, { projectTypeId: S.typeB.id, currentStageId: S.b1.id });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.stageChanged, true);
    assert.equal(ok.json.project.currentStageId, S.b1.id);
  });

  it('🔴 门户的编号自成一条序号（-P），速记那条序号永远算不到它；前缀下翻完所有页', async () => {
    const year = new Date().getUTCFullYear();
    assert.equal(portalCodeBase('ISTRA', year), `ISTRA-P${year}`);
    // 速记那一套（codeBase + seqOf）看门户的编号：不是自己的序号
    assert.equal(seqOf(codeBase('ISTRA', year), `ISTRA-P${year}-001`), null);
    // 一个速记编号 + 250 个门户编号（超过一页 200）：门户该拿 -251，而且不被速记的 -001 带偏
    T.seed('projects', { name: 'capture one', projectCode: `ISTRA-${year}-001`, companyId: S.company.id });
    for (let n = 1; n <= 250; n++)
      T.seed('projects', { name: `old ${n}`, projectCode: `ISTRA-P${year}-${String(n).padStart(3, '0')}`, companyId: S.company.id });
    const r = await inject('POST', '/portal/projects', {
      clientId: randomUUID(), name: 'Code probe', companyId: S.company.id, projectTypeId: S.typeB.id,
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.project.projectCode, `ISTRA-P${year}-251`);
  });

  it('🔴 建项目超时但 Twenty 其实建成了 → 同一个 clientId 重试认领它，不建第二个', async () => {
    const before_ = T.db.projects!.length;
    let armed = true;
    // POST 提交了但超时；紧接着那次「按编号认领」也失败（Twenty 正卡着）→ 第一次只能 502
    T.faults.push((m, path) => {
      if (!armed) return;
      if (m === 'POST' && path.startsWith('/rest/projects')) return 'commit-then-timeout';
      if (m === 'GET' && path.startsWith('/rest/projects?') && path.includes('projectCode%5Beq%5D')) {
        armed = false;
        return 'fail';
      }
    });
    const body = { clientId: randomUUID(), name: 'Timeout probe', companyId: S.company.id, projectTypeId: S.typeB.id, currentStageId: S.b1.id };
    const first = await inject('POST', '/portal/projects', body);
    assert.equal(first.status, 502, JSON.stringify(first.json));
    assert.equal(T.db.projects!.length, before_ + 1, '前提：Twenty 那边确实建成了一个');

    const again = await inject('POST', '/portal/projects', body);
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json.duplicate, true);
    assert.equal(T.db.projects!.length, before_ + 1, '重试又建了一个项目');
    const mine = T.db.projects!.filter((p) => p.name === 'Timeout probe');
    assert.equal(mine.length, 1);
    assert.equal(again.json.project.id, mine[0].id);
    // 第一次没来得及记的 stageChange 补上了，而且只有一条
    const sc = T.db.projectUpdates!.filter((u) => u.projectId === mine[0].id);
    assert.equal(sc.length, 1);
    T.faults.length = 0;
  });

  it('🔴 两个重试同时等着同一个失败的前任 → 只建一个（第二个去等第一个，不是各建各的）', async () => {
    // 第一次的 POST 卡住（门户 8 秒放弃、开始重试），两个重试都在等它；然后它失败（这一次真没建成）
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached = false;
    let armed = true;
    T.faults.push((m, path) => {
      if (armed && m === 'POST' && path.startsWith('/rest/projects')) {
        armed = false;
        reached = true;
        return gate.then(() => 'fail' as const);
      }
    });
    const body = { clientId: randomUUID(), name: 'Concurrent probe', companyId: S.company.id, projectTypeId: S.typeB.id };
    const first = inject('POST', '/portal/projects', body);
    while (!reached) await sleep(1);
    const r1 = inject('POST', '/portal/projects', body);
    const r2 = inject('POST', '/portal/projects', body);
    await sleep(20); // 让两个重试都走到「等前任」那一步
    release();
    assert.equal((await first).status, 502);
    const [a, b] = await Promise.all([r1, r2]);
    T.faults.length = 0;
    assert.deepEqual([a.status, b.status].sort(), [200, 201], JSON.stringify([a.json, b.json]));
    assert.equal(a.json.project.id, b.json.project.id);
    assert.equal(T.db.projects!.filter((p) => p.name === 'Concurrent probe').length, 1, '并发重试各建了一个');
  });

  it('🔴 建类型中途失败：半成品选不到（停用着）；同一张表单重试把它建完，不是 400', async () => {
    let n = 0;
    T.faults.push((m, path) => (m === 'POST' && path.startsWith('/rest/projectTypeStages') && ++n === 2 ? 'fail' : undefined));
    const body = { name: 'Dealer Programme', stages: [{ name: 'Kick-off', nameZh: '启动' }, { name: 'Samples' }, { name: 'Launch' }] };
    const first = await inject('POST', '/portal/project-types', body);
    assert.equal(first.status, 502, JSON.stringify(first.json));
    const half = T.db.projectTypes!.filter((t) => t.name === 'Dealer Programme');
    assert.equal(half.length, 1);
    assert.notEqual(half[0].isActive, true, '半成品是在用的 —— 门户里能选到一个缺阶段的类型');
    T.faults.length = 0;

    const again = await inject('POST', '/portal/project-types', body);
    assert.equal(again.status, 201, JSON.stringify(again.json));
    assert.equal(T.db.projectTypes!.filter((t) => t.name === 'Dealer Programme').length, 1, '建出了第二个同名类型');
    const t = again.json.projectType;
    assert.equal(t.id, half[0].id);
    assert.equal(t.isActive, true);
    assert.deepEqual(
      t.stages.filter((s: any) => s.isActive).map((s: any) => [s.name, s.order]),
      [['Kick-off', 1], ['Samples', 2], ['Launch', 3]],
    );
    assert.equal(t.stages.length, 3, '第一次建出来的 Kick-off 没被认领，又建了一个');

    // 建完之后再来一次 = 真的同名 → 400（原来的语义不变）
    assert.equal((await inject('POST', '/portal/project-types', body)).status, 400);
    // 很久以前停用的同名类型不会被「新建」悄悄复活
    T.seed('projectTypes', { name: 'Retired', typeCode: 'RETIRED', isActive: false, createdAt: '2026-01-01T00:00:00.000Z' });
    assert.equal((await inject('POST', '/portal/project-types', { name: 'Retired', stages: [{ name: 'X' }] })).status, 400);
  });

  it('🔴 快照读到上限 → 502 snapshot_too_large（不混进 twenty_unavailable —— 那个码门户会默默用缓存）', async () => {
    const p = T.db.projects![0];
    for (let i = 0; i < 50 * 200 + 1; i++) T.db.projectUpdates!.push({ id: randomUUID(), projectId: p.id, kind: 'NOTE', name: `n${i}` });
    // 先写一下让快照缓存作废
    await inject('PATCH', `/portal/projects/${p.id}`, { name: p.name });
    const r = await inject('GET', '/portal/snapshot');
    assert.equal(r.status, 502);
    assert.equal(r.json.error, 'snapshot_too_large');
    T.db.projectUpdates!.length = 0;
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('门户接口 · 鉴权（真 HTTP）', () => {
  it('路由真的注册上了：没带 secret 是 401 不是 404', NEEDS_ON, () => {
    assert.equal(gatewayProbe, 401);
  });

  it('🔴 没带 / 带错 secret → 401 bad_secret，而且故意慢（≥ 350ms）', NEEDS_ON, async () => {
    for (const headers of [{ 'X-Portal-Secret': '' }, { 'X-Portal-Secret': `${SECRET}x` }, { 'X-Portal-Secret': SECRET.slice(0, -1) }]) {
      const t0 = Date.now();
      const r = await call('GET', '/portal/snapshot', undefined, headers);
      assert.equal(r.status, 401);
      assert.deepEqual(r.json, { error: 'bad_secret' });
      assert.ok(Date.now() - t0 >= 350, '401 回得太快 —— 逐个试 secret 就很便宜了');
    }
  });

  it('🔴 secret 放进 URL 一律不认（URL 会进日志、历史和截图）', NEEDS_ON, async () => {
    const q = encodeURIComponent(SECRET);
    const res = await fetch(`${BASE}/portal/snapshot?secret=${q}&portalSecret=${q}&x-portal-secret=${q}&PORTAL_SECRET=${q}`);
    assert.equal(res.status, 401);
  });

  it('另一套系统的 secret 头打不开这组（钉钉那把钥匙泄露了也进不来）', NEEDS_ON, async () => {
    const r = await call('GET', '/portal/snapshot', undefined, { 'X-Portal-Secret': '', 'X-Channel-Secret': SECRET, 'X-Admin-Token': SECRET });
    assert.equal(r.status, 401);
  });

  it('/agent/health 报 portal: on', NEEDS_ON, async () => {
    const h = await fetch(`${BASE}/agent/health`).then((r) => r.json() as Promise<any>);
    assert.equal(h.portal, 'on');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('门户接口 · Twenty 不可达', () => {
  const opt = { ...NEEDS_ON, ...NEEDS_TWENTY_DOWN };

  it('🔴 读快照 → 502 twenty_unavailable，**不回显 Twenty 的原文**（门户据此切到缓存）', opt, async () => {
    const r = await call('GET', '/portal/snapshot');
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { error: 'twenty_unavailable' });
  });

  it('写入同样 502（参数合法、轮到问 Twenty 时才失败）', opt, async () => {
    const r = await call('POST', '/portal/projects', {
      clientId: randomUUID(),
      name: 'Unreachable',
      companyId: randomUUID(),
      projectTypeId: randomUUID(),
    });
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { error: 'twenty_unavailable' });
    const d = await call('DELETE', `/portal/updates/${randomUUID()}`);
    assert.equal(d.status, 502);
  });

  it('参数错在问 Twenty 之前就挡掉 → 400 invalid（不是 502）', NEEDS_ON, async () => {
    const r = await call('POST', '/portal/projects', { name: 'x', companyId: 'Acme GmbH' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'invalid');
    assert.match(r.json.detail, /companyId/);
    assert.match(r.json.detail, /clientId/);
    const bad = await call('PATCH', '/portal/projects/not-a-uuid', { name: 'x' });
    assert.equal(bad.status, 400);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('门户接口 · 真写 Twenty（类型 → 项目 → 阶段 → 进展 → 软删）', () => {
  const made = { types: new Set<string>(), projects: new Set<string>(), updates: new Set<string>() };
  const tag = randomUUID().slice(0, 8);
  const S: Record<string, any> = {};

  /** 🔴 收干净：进展 → 项目 → 阶段 → 类型（子在前）。REST DELETE 是硬删 —— 只有这里允许。 */
  after(async () => {
    if (!made.types.size && !made.projects.size) return;
    const del = async (plural: string, id: string) => {
      const r = await twentyFetch(`/rest/${plural}/${id}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 404) console.warn(`  ⚠️ 没删掉 ${plural}/${id}：HTTP ${r.status}`);
    };
    for (const pid of made.projects) {
      const r = await twentyFetch(`/rest/projectUpdates?filter=${encodeURIComponent(`projectId[eq]:${pid}`)}&limit=200`);
      for (const u of ((await r.json()) as any)?.data?.projectUpdates ?? []) made.updates.add(u.id);
    }
    for (const id of made.updates) await del('projectUpdates', id);
    for (const id of made.projects) await del('projects', id);
    for (const tid of made.types) {
      const r = await twentyFetch(`/rest/projectTypeStages?filter=${encodeURIComponent(`projectTypeId[eq]:${tid}`)}&limit=200`);
      for (const s of ((await r.json()) as any)?.data?.projectTypeStages ?? []) await del('projectTypeStages', s.id);
      await del('projectTypes', tid);
    }
  });

  it('快照：五格齐全，客户列表里有带代号和不带代号的', NEEDS_TWENTY, async () => {
    const r = await call('GET', '/portal/snapshot');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json), ['generatedAt', 'companies', 'projectTypes', 'projects', 'updates']);
    assert.ok(r.json.companies.length > 0, '一家客户都没有 —— 本地 Twenty 没导入名单？');
    S.company = r.json.companies.find((c: any) => c.accountCode) ?? r.json.companies[0];
  });

  it('建类型：生成 typeCode，阶段按顺序、全部在用；同名再建 → 400', NEEDS_TWENTY, async () => {
    const r = await call('POST', '/portal/project-types', {
      name: `itest type ${tag}`,
      description: 'integration test',
      stages: [{ name: 'Kick-off', nameZh: '启动' }, { name: 'Samples' }, { name: 'Launch' }],
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const t = r.json.projectType;
    made.types.add(t.id);
    assert.equal(t.typeCode, `ITEST-TYPE-${tag.toUpperCase()}`);
    assert.equal(t.isActive, true);
    assert.deepEqual(t.stages.map((s: any) => [s.name, s.order, s.isActive]), [
      ['Kick-off', 1, true],
      ['Samples', 2, true],
      ['Launch', 3, true],
    ]);
    assert.equal(t.stages[0].nameZh, '启动');
    assert.equal(t.stages[1].stageKey, 'samples');
    S.type = t;
    const dup = await call('POST', '/portal/project-types', { name: `ITEST type ${tag}`, stages: [{ name: 'A' }] });
    assert.equal(dup.status, 400);
  });

  it('🔴 关系只收已存在的 UUID：不存在的客户 → 400（不是 502，也绝不按名字建）', NEEDS_TWENTY, async () => {
    const r = await call('POST', '/portal/projects', {
      clientId: randomUUID(), name: 'Ghost', companyId: randomUUID(), projectTypeId: S.type.id,
    });
    assert.equal(r.status, 400);
    assert.match(r.json.detail, /companyId/);
  });

  it('建项目：编号不为空、状态 active、自动记一条 stageChange（带操作人）', NEEDS_TWENTY, async () => {
    const clientId = randomUUID();
    const r = await call('POST', '/portal/projects', {
      clientId, name: `itest project ${tag}`, companyId: S.company.id, projectTypeId: S.type.id,
      currentStageId: S.type.stages[0].id, targetDate: '2027-03-31', customerSummary: 'Pilot programme',
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const p = r.json.project;
    made.projects.add(p.id);
    assert.ok(p.projectCode && p.projectCode.length > 4, `编号是空的：${p.projectCode}`);
    // 门户自己那条序号（-P）：速记管道永远发不出这种号（review 2026-10-01）
    if (S.company.accountCode)
      assert.match(p.projectCode, new RegExp(`^${S.company.accountCode.toUpperCase()}-P\\d{4}-\\d{3}$`), p.projectCode);
    assert.equal(p.status, 'active');
    assert.equal(p.portalVisible, false);
    assert.equal(p.targetDate, '2027-03-31');
    assert.equal(p.currentStageId, S.type.stages[0].id);
    S.project = p;

    // 同一个 clientId 重放 → 同一个项目，不建第二个
    const again = await call('POST', '/portal/projects', {
      clientId, name: `itest project ${tag}`, companyId: S.company.id, projectTypeId: S.type.id,
    });
    assert.equal(again.status, 200);
    assert.equal(again.json.duplicate, true);
    assert.equal(again.json.project.id, p.id);

    const snap = (await call('GET', '/portal/snapshot')).json;
    const ups = snap.updates.filter((u: any) => u.projectId === p.id);
    assert.equal(ups.length, 1);
    assert.equal(ups[0].kind, 'stageChange');
    assert.equal(ups[0].stageId, S.type.stages[0].id);
    assert.equal(ups[0].customerVisible, true);
    assert.equal(ups[0].authorName, 'itest-admin');
    assert.equal(ups[0].title, 'Stage: Kick-off');
  });

  it('🔴 needs_type：没有当前阶段的项目不能公开（建的时候和改的时候都挡）', NEEDS_TWENTY, async () => {
    const r = await call('POST', '/portal/projects', {
      clientId: randomUUID(), name: `itest nostage ${tag}`, companyId: S.company.id, projectTypeId: S.type.id, portalVisible: true,
    });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'needs_type');

    const ok = await call('POST', '/portal/projects', {
      clientId: randomUUID(), name: `itest nostage ${tag}`, companyId: S.company.id, projectTypeId: S.type.id,
    });
    assert.equal(ok.status, 201);
    made.projects.add(ok.json.project.id);
    assert.equal(ok.json.project.currentStageId, null);
    const pub = await call('PATCH', `/portal/projects/${ok.json.project.id}`, { portalVisible: true });
    assert.equal(pub.status, 409);
    assert.equal(pub.json.error, 'needs_type');
    // 改名不受影响（只在「打开公开」那一下判）
    const rename = await call('PATCH', `/portal/projects/${ok.json.project.id}`, { name: `itest renamed ${tag}` });
    assert.equal(rename.status, 200);
    assert.equal(rename.json.stageChanged, false);
  });

  it('换阶段 + 公开：stageChanged=true，多一条 stageChange；别的类型/不存在的阶段 → 400', NEEDS_TWENTY, async () => {
    const r = await call('PATCH', `/portal/projects/${S.project.id}`, {
      currentStageId: S.type.stages[1].id, portalVisible: true, status: 'onHold',
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.stageChanged, true);
    assert.equal(r.json.project.portalVisible, true);
    assert.equal(r.json.project.status, 'onHold');

    const ghost = await call('PATCH', `/portal/projects/${S.project.id}`, { currentStageId: randomUUID() });
    assert.equal(ghost.status, 400);
    // 换类型不给阶段 → 400
    const t = await call('PATCH', `/portal/projects/${S.project.id}`, { projectTypeId: randomUUID() });
    assert.equal(t.status, 400);
    assert.match(t.json.detail, /currentStageId/);
    // 同一个阶段再发一次 → 不算换阶段
    const same = await call('PATCH', `/portal/projects/${S.project.id}`, { currentStageId: S.type.stages[1].id });
    assert.equal(same.json.stageChanged, false);
  });

  it('记进展：精度 day 存正午 UTC；clientId 重放 → 200 duplicate；布尔给字符串 → 400', NEEDS_TWENTY, async () => {
    const clientId = randomUUID();
    const body = {
      clientId, title: 'Samples shipped', kind: 'milestone', occurredAt: '2026-09-30', datePrecision: 'day',
      stageId: S.type.stages[1].id, initiator: 'Us', recipient: 'Them', summary: 'internal', customerVisible: true,
      customerMessage: 'Your samples are on their way.',
    };
    const r = await call('POST', `/portal/projects/${S.project.id}/updates`, body);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const u = r.json.update;
    made.updates.add(u.id);
    assert.equal(u.occurredAt, '2026-09-30T12:00:00.000Z');
    assert.equal(u.datePrecision, 'day');
    assert.equal(u.kind, 'milestone');
    assert.equal(u.customerVisible, true);
    assert.equal(u.authorName, 'itest-admin');
    S.update = u;

    const again = await call('POST', `/portal/projects/${S.project.id}/updates`, body);
    assert.equal(again.status, 200);
    assert.equal(again.json.duplicate, true);
    assert.equal(again.json.update.id, u.id);

    const bad = await call('POST', `/portal/projects/${S.project.id}/updates`, { ...body, clientId: randomUUID(), customerVisible: 'true' });
    assert.equal(bad.status, 400);
  });

  /**
   * 🔴 回包对了不等于路径对了：第一版里重放的助手 `return reply.send(...)`，而 Fastify 的 reply 是 thenable ——
   * 从 async 函数里 return 它会被展开成 undefined，于是网关「以为没查到」又向 Twenty 建了一次
   * （撞唯一索引、日志里一串 FST_ERR_REP_ALREADY_SENT），门户收到的却是正确的 200。
   * 只有数 Twenty 的 create 次数才看得见 —— 所以在进程内跑同一个路由，给 fetch 装个计数器。
   */
  it('🔴 进展重放：Twenty 那边只建过一次（不是「回包对了」就算对）', NEEDS_TWENTY, async () => {
    const app = Fastify();
    registerPortal(app);
    const realFetch = globalThis.fetch;
    let creates = 0;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input?.url ?? input);
      if (String(init?.method ?? 'GET').toUpperCase() === 'POST' && url.includes('/rest/projectUpdates')) creates++;
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const headers = { 'x-portal-secret': SECRET, 'content-type': 'application/json' };
      const payload = JSON.stringify({ clientId: randomUUID(), title: 'Replay probe', customerVisible: false });
      const url = `/portal/projects/${S.project.id}/updates`;
      const first = await app.inject({ method: 'POST', url, headers, payload });
      assert.equal(first.statusCode, 201, first.body);
      made.updates.add(first.json().update.id);
      const second = await app.inject({ method: 'POST', url, headers, payload });
      assert.equal(second.statusCode, 200, second.body);
      assert.equal(second.json().duplicate, true);
      assert.equal(creates, 1, `重放又向 Twenty 发了 create（一共 ${creates} 次）`);
    } finally {
      globalThis.fetch = realFetch;
      await app.close();
    }
  });

  it('改进展；stageChange 那条只许改三格', NEEDS_TWENTY, async () => {
    const r = await call('PATCH', `/portal/updates/${S.update.id}`, { customerMessage: 'Samples delivered.', result: 'ok' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.update.customerMessage, 'Samples delivered.');
    assert.equal(r.json.update.result, 'ok');

    const snap = (await call('GET', '/portal/snapshot')).json;
    const sc = snap.updates.find((x: any) => x.projectId === S.project.id && x.kind === 'stageChange');
    assert.ok(sc, '找不到 stageChange');
    const no = await call('PATCH', `/portal/updates/${sc.id}`, { title: 'rewrite history' });
    assert.equal(no.status, 400);
    const yes = await call('PATCH', `/portal/updates/${sc.id}`, { customerMessage: 'We are now sampling.' });
    assert.equal(yes.status, 200);
  });

  it('🔴 stage_in_use：删掉项目正停着的阶段 → 409，**一格都不写**', NEEDS_TWENTY, async () => {
    const [a, , c] = S.type.stages;
    const r = await call('PATCH', `/portal/project-types/${S.type.id}`, {
      name: `itest type ${tag} renamed`,
      stages: [{ id: a.id, name: 'Kick-off' }, { id: c.id, name: 'Launch' }],
    });
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.error, 'stage_in_use');
    assert.ok(r.json.projects.some((p: any) => p.id === S.project.id));
    const snap = (await call('GET', '/portal/snapshot')).json;
    const t = snap.projectTypes.find((x: any) => x.id === S.type.id);
    assert.equal(t.name, `itest type ${tag}`, '409 了名字却改了 —— 计划作废时不许写一半');
    assert.deepEqual(t.stages.map((s: any) => s.isActive), [true, true, true]);
  });

  it('改阶段清单：改名 / 新建 / 停用 / 重排一次到位', NEEDS_TWENTY, async () => {
    const [a, b] = S.type.stages;
    const r = await call('PATCH', `/portal/project-types/${S.type.id}`, {
      stages: [{ id: b.id, name: 'Samples' }, { id: a.id, name: 'Start', nameZh: '开始' }, { name: 'Review' }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const st = r.json.projectType.stages;
    const byName = Object.fromEntries(st.map((s: any) => [s.name, s]));
    assert.equal(byName.Samples.order, 1);
    assert.equal(byName.Start.order, 2);
    assert.equal(byName.Start.nameZh, '开始');
    assert.equal(byName.Review.order, 3);
    assert.equal(byName.Review.isActive, true);
    assert.equal(byName.Launch.isActive, false, '漏掉的阶段应当停用，不是删除');
    assert.equal(st.length, 4);
  });

  it('🔴 type_in_use：还有在跑的项目时不能停用类型', NEEDS_TWENTY, async () => {
    const r = await call('PATCH', `/portal/project-types/${S.type.id}`, { isActive: false });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'type_in_use');
  });

  it('🔴 删进展是**软删**：快照里没了，但 Twenty 里恢复得回来（REST DELETE 恢复不回来 —— §2.38）', NEEDS_TWENTY, async () => {
    const r = await call('DELETE', `/portal/updates/${S.update.id}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json, { deleted: true });
    const snap = (await call('GET', '/portal/snapshot')).json;
    assert.ok(!snap.updates.some((u: any) => u.id === S.update.id), '删了还在快照里');
    assert.equal((await call('DELETE', `/portal/updates/${S.update.id}`)).status, 404);

    // 存储层核一次：restore 回得来 = 那一行还在 = 软删（硬删的话这里是 RECORD_NOT_FOUND）
    const j = await twentyGql('mutation($id: UUID!) { restoreProjectUpdate(id: $id) { id deletedAt } }', { id: S.update.id });
    assert.equal(j?.errors, undefined, `restore 失败 —— 多半是被硬删了：${JSON.stringify(j?.errors)}`);
    assert.equal(j?.data?.restoreProjectUpdate?.id, S.update.id);
  });
});
