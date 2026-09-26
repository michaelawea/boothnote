import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { sql } from '../db.ts';
import { claimDue, resumeConfirming } from '../confirm.ts';
// T99：网关被硬杀之后的收尸。和上面两个一样直接调模块 —— 它没有端点，只在启动时跑
import { reapStaleRuns, __setRunsCreated } from '../../agent/src/index.ts';
// 「Twenty 连不上就一个号都不发」那条：直接调模块，不经 HTTP（它没有自己的端点）
import { reserveProjectCode } from '../projectCode.ts';
import { hashPassword } from '../auth.ts';
import { env } from '../env.ts';
// 只给「编号已属于另一个项目」那条用例造前置数据（NEEDS_TWENTY）
import { createProject } from '../twenty.ts';

/**
 * 网关集成测试 —— 打真实的 HTTP + 真实的库。
 *
 * 🔴 **只对本地跑。** 它会建/删账号和 inbox 记录，绝不能对着生产执行。
 *    生产用只读的 `scripts/smoke.sh`。
 *
 *   前提：网关在 http://localhost:4000 跑着（npm run dev），boothnote 库已迁移。
 *   跑法：node --test src/__tests__/            （或 scripts/test.sh）
 */

const BASE = process.env.GATEWAY_URL ?? `http://localhost:${env.port}`;

// ── 安全闸门：非本地一律拒跑 ────────────────────────────────────────
//
// 🔴 **绕过它必须把目标主机名原样写出来，`=1` 不再管用**（2026-08-10 收紧）。
//
//    维护者：「无论我是在生产服务器，还是本地开发环境中跑测试代码，
//    都不会在我的数据库里面写一堆 crap」。
//
//    原来是 `ALLOW_NONLOCAL_TESTS=1`。一个写进 shell profile / CI 变量里的 `1`
//    会在**你完全没想起它**的那天放行生产 —— 而这套用例会建账号、发几十条速记、
//    往 CRM 里写真记录。开关要贵到「只能对着当下这一个目标临时打开」：
//
//        ALLOW_NONLOCAL_TESTS=staging.example.com:4000 node --test …
//
//    换个目标就得重写一次，忘在环境里的那个值对新目标无效。
const isLocal = (u: string) => /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(u);
if (!isLocal(BASE) || !/@(localhost|127\.0\.0\.1)[:/]/.test(env.databaseUrl)) {
  const target = (() => {
    try {
      return new URL(BASE).host;
    } catch {
      return BASE;
    }
  })();
  if (process.env.ALLOW_NONLOCAL_TESTS !== target) {
    console.error(`
🔴 集成测试只对本地跑（会建账号、发速记、往 CRM 写真记录）。
   GATEWAY_URL      = ${BASE}
   APP_DATABASE_URL = ${env.databaseUrl.replace(/:\/\/[^@]*@/, '://***@')}

   生产环境请用只读的 scripts/smoke.sh。
   本地想跑又不想弄脏自己的库：./scripts/test.sh integration（一次性环境，跑完什么都不留）
   真要对 ${target} 跑：ALLOW_NONLOCAL_TESTS=${target}（把主机名写出来，'1' 不管用）
`);
    process.exit(1);
  }
  console.error(`\n⚠️  非本地目标 ${target} 已被显式放行 —— 这一轮会在那边留下测试数据。\n`);
}

// ── 一次性测试账号，用完删掉 ────────────────────────────────────────
const SUFFIX = randomUUID().slice(0, 8);
const ADMIN = { code: `t-admin-${SUFFIX}`, pass: `pw-${randomUUID()}` };
const PLAIN = { code: `t-user-${SUFFIX}`, pass: `pw-${randomUUID()}` };
const created: string[] = [];

/**
 * 测试在 Twenty 里建出来的客户，跑完删掉。
 *
 * 🔴 **这是全仓库唯一一处删 Twenty 记录的代码，而且只许留在测试里。**
 * 应用代码里不存在删除路径（D48），别把这几行搬进 `src/`。
 *
 * 为什么非删不可：渠道链的测试要真的建三家公司才能验 `soldVia`，
 * 不删的话**每跑一次 CI，56 家客户名单就永久多三家** ——
 * 展会现场那个下拉框里混进十几个 `ZZ DEALER a1b2c3d4`，
 * 和当初漏了一堆 `is_active=true` 的测试账号是同一个形状的错。
 */
const createdCompanies: string[] = [];

/**
 * ── Twenty 在不在？────────────────────────────────────────────────
 *
 * 🔴 **CI 里没有 Twenty，这不是缺陷，是刻意的。**
 * 它要 4 个容器（server / worker / postgres / redis）跑三五分钟才起得来，
 * 而且要一个**只有 维护者 能生成**的 API key（CLAUDE.md 的硬规则）。
 * 所以 CI 只起 Postgres + 网关，`TWENTY_API_KEY` 是个占位串。
 *
 * 于是要真写 Twenty 的那些断言在 CI 里必然 `fetch failed`。
 * 2026-08-03 第一次把它们推上去，CI 当场红了 —— 而它们在本地是绿的。
 *
 * 处理方式是 **`skip` 而不是 `return`**：
 *   · `return` = 静默通过。测试数从 67 变 62 没人会注意到，
 *     于是「渠道链在 Twenty 里真的挂上了」这条断言事实上消失了。
 *   · `skip` = node:test 的汇总里明确写着 `skipped 5`，
 *     跑完还有一行大字提醒「这些只有本地 test.sh all 才覆盖得到」。
 *
 * 这条判据仓库里已经写过一次（§5 第 3 条）：
 * **一个在某个环境里永远红的检查，很快就会被人无视，那时它连线上也保不住了。**
 */
/**
 * ══════════════════════════════════════════════════════════════════
 *  读 Twenty —— **带 429 退避重试**（§2.39 · T79）
 *
 *  🔴 **Twenty 的限流是 100 次 / 60 秒，而这套集成测试稳定地把它跑满。**
 *
 *  一轮 `test.sh all` 里，光网关自己入库就要跑十几次往返（D59 项目链 +
 *  D61 timeline + D62 完整度重算），再加上这些用例回读断言 ——
 *  2026-08-10 用探针量到的原话：
 *
 *      [PROBE] twenty() 429 /rest/productFitments/… ::
 *        {"statusCode":429,"messages":["Limit reached (100 tokens per 60000 ms)"]}
 *
 *  原来这里是 `return res.ok ? data : null` —— **一行把「我读不到」变成了「它是空的」**，
 *  于是断言拿到 `undefined`，报出来的却是一句完全指错方向的话：
 *  「🔴 原文丢了 —— 信息不该消失」。同一份未改动的代码连跑三次是 98/96/95，
 *  而失败集合每次不一样，因为撞上限流的是哪几个请求纯看时序。
 *
 *  代价很具体：2026-08-10 排查一次**根本不存在的**回归花了近一小时 ——
 *  先怀疑自己改坏了，stash 来 stash 去跑了六轮才发现基线也一样红。
 *
 *  🔴 **这和 `acea35c` 修 `data-guard.mjs` 的是同一个 bug，只是漏了这一处。**
 *     那次的原话：「Twenty 限流是 100 次/60 秒，而 `get()` 没有退避重试
 *     （**仓库里其他每一处都有**）」。这里就是那个「其他每一处」漏掉的一处。
 *
 *  两条都要做，缺一条这个 bug 就会以另一种形状回来：
 *    ① **撞限流就等一会儿再试**（下面这个函数）
 *    ② **等不到就抛，绝不返回 null**（见 `twenty()`）——
 *       返回 null 才是那句误导性断言的成因，退避只是让它更少发生。
 * ══════════════════════════════════════════════════════════════════ */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const twentyFetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
  /*
   * 1s → 2s → 4s → 8s → 16s，最多 5 次退避（累计 31 秒）。
   * 🔴 **比网关那边（0.5s 起步）更有耐心是刻意的**：限流窗口是 60 秒，
   *    而测试撞上它时往往是**整个窗口的额度已经被这一轮自己用光了** ——
   *    退得太快只是把同一堵墙再撞五次。31 秒足够让令牌桶回一批。
   */
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${env.twentyUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${env.twentyKey}`, ...(init.headers ?? {}) },
    });
    if (res.status !== 429 || attempt >= 5) return res;
    // ⚠️ 丢掉之前先把 body 读干净 —— undici 不消费就不放连接，
    //    而这里正要睡最多 16 秒，攒几个就把连接池坐满了
    await res.text().catch(() => undefined);
    // 对面说了等多久就等多久；没说才用退避（Twenty 这个版本不发 Retry-After，留着以防它哪天发）
    const after = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt;
    /**
     * 🔴 **退避要出声。** 悄悄重试会把「额度天天跑满」这件事永久藏起来 ——
     * 那时这套测试的时长会慢慢变长，而没有任何地方说得出为什么。
     * 一行就够：撞了几次、等多久。频繁出现就说明该减少回读次数了。
     */
    console.warn(`  ⏳ Twenty 限流，等 ${wait / 1000}s 再试（第 ${attempt + 1} 次）：${path}`);
    await sleep(wait);
  }
};

/**
 * ⚠️ 429 **不算「Twenty 不可达」** —— 它恰恰证明 Twenty 活着。
 *
 * 不区分的话，探针撞一次限流就把**全部**要真写 CRM 的用例 skip 掉，
 * 而输出是一句轻飘飘的「Twenty 不可达」+ 一片绿 ——
 * 「跳过了」和「通过了」在退出码上完全一样，这比红更危险。
 */
const twentyProbe = await fetch(`${env.twentyUrl}/rest/companies?limit=1`, {
  headers: { Authorization: `Bearer ${env.twentyKey}` },
  signal: AbortSignal.timeout(4000),
})
  .then((r) => r.ok || r.status === 429)
  .catch(() => false);

/** 传给 `it()` 的第二个参数。Twenty 不在就跳过，并说清楚为什么。 */
const NEEDS_TWENTY = twentyProbe
  ? {}
  : { skip: '要真写 Twenty，而这个环境里没有它（CI 只起 Postgres + 网关）' };

if (!twentyProbe) {
  console.log(
    '\n\x1b[33m⚠️  Twenty 不可达 —— 要真写 CRM 的断言会被 skip。\x1b[0m\n' +
      '   本地跑 `./scripts/test.sh all`（Twenty 开着）才覆盖得到那一层。\n',
  );
}

/**
 * agent 是关着的吗（`AGENT_ENABLED=0` 起的网关）。
 *
 * 「agent 停机不影响采集」那条（六必之三）只有在这种网关上才验得到，
 * 而 CI 里 agent 是开着的。和 `twentyProbe` 一样在这里探一次，
 * 探不到就让那条用例**显式 skip** —— 不是静默 return。
 */
const agentOff = await fetch(`${BASE}/agent/health`, { signal: AbortSignal.timeout(4000) })
  .then((r) => r.json() as Promise<{ enabled?: boolean }>)
  .then((j) => j.enabled === false)
  .catch(() => false);

/**
 * ⚠️ 还要 Twenty 通：`loop.ts` 在判断 `agentEnabled` **之前**先去 Twenty
 * 取品牌名单（转写的关键词偏置要用，而转写在 agent 之外）。Twenty 连不上就先炸在那儿。
 */
const NEEDS_AGENT_OFF =
  agentOff && twentyProbe
    ? {}
    : {
        skip: agentOff
          ? '要 Twenty 通（agent 之前的转写预处理要从它取品牌名单）'
          : 'agent 开着 —— 这条只在 AGENT_ENABLED=0 起的网关上有意义',
      };

const req = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
};

const loginAs = async (u: { code: string; pass: string }) => {
  const r = await req('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userCode: u.code, password: u.pass }),
  });
  assert.equal(r.status, 200, `登录 ${u.code} 失败：${JSON.stringify(r.json)}`);
  return r.json as { token: string; user: any };
};

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * 发一条速记。
 *
 * ⚠️ 定义放在这里（helper 区）而不是「六个必须有的」那一节前面：
 * `it()` 的回调是文件加载完之后才跑的，所以放在后面**碰巧**也能用 ——
 * 但那是在靠 TDZ 的时序，读的人看不出来。
 */
const post = async (
  token: string,
  payload: Record<string, unknown>,
  files: Array<[string, Blob, string]> = [],
) => {
  const f = new FormData();
  // 大多数用例只关心「落库了没有」，走 AI 那条路会真的烧模型（一条几分钱）。
  // 要测对话/agent 的用例自己传 toAgent: true。
  f.append('payload', JSON.stringify(payload));
  for (const [field, blob, name] of files) f.append(field, blob, name);
  return req('/inbox', { method: 'POST', headers: auth(token), body: f });
};

before(async () => {
  const up = await req('/health');
  assert.equal(up.status, 200, `网关没跑起来（${BASE}）。先 npm run dev。`);

  for (const [u, role] of [
    [ADMIN, 'admin'],
    [PLAIN, 'user'],
  ] as const) {
    await sql`insert into app_user (user_code, display_name, password_hash, role)
              values (${u.code}, ${u.code}, ${await hashPassword(u.pass)}, ${role})`;
    created.push(u.code);
  }
});

after(async () => {
  // 🔴 测试账号**删不掉**：`inbox` 只增不改（§4.2 第2条 + 触发器），
  //    而 `inbox.user_id` 有外键指向账号 —— 删账号必然被 FK 挡下。
  //    原来这里是 `delete ... .catch(() => {})`，错误被静默吞掉，
  //    结果**每跑一次就漏一个 is_active=true 的 admin 账号**（实测漏了 3 个）。
  //    正确做法与生产一致：停用 + token_version+1，让已签发的 token 立即失效。
  for (const code of created) {
    const [row] = await sql`
      update app_user set is_active = false, token_version = token_version + 1
      where user_code = ${code} returning user_code`;
    if (!row) console.warn(`  ⚠️ 清理失败：账号 ${code} 没找到`);
  }

  // 建出来的测试客户删掉（见上面 createdCompanies 的注释）。
  // 删不掉就**大声说**，别静默 —— 静默的清理失败正是当初漏账号的原因。
  for (const id of createdCompanies) {
    // ⚠️ 走带退避的那个 —— 清理跑在一轮测试的**末尾**，正是限流额度最紧的时刻（§2.39）。
    //    撞上 429 就删不掉，而这些测试客户会留在客户名单里污染下一轮的查重。
    const res = await twentyFetch(`/rest/companies/${id}`, { method: 'DELETE' }).catch(
      (e) => ({ ok: false, status: 0, statusText: String(e) }) as Response,
    );
    if (!res.ok) {
      console.warn(
        `  ⚠️ 测试客户 ${id} 没删掉（${res.status}）—— 它会留在客户名单里，手动删一下`,
      );
    }
  }
  await sql.end();
});

// ═══════════════════════════════════════════════════════════════════
describe('鉴权', () => {
  it('/health 不需要 token', async () => {
    assert.equal((await req('/health')).status, 200);
  });

  it('没 token 取 /companies → 401', async () => {
    assert.equal((await req('/companies')).status, 401);
  });

  it('伪造 token → 401', async () => {
    const r = await req('/me', { headers: auth('eyJhbGciOiJIUzI1NiJ9.fake.sig') });
    assert.equal(r.status, 401);
  });

  it('🔴 不存在的用户与错密码返回**完全相同**的错误（不泄漏账号是否存在）', async () => {
    const a = await req('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userCode: `nobody-${SUFFIX}`, password: 'x' }),
    });
    const b = await req('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userCode: ADMIN.code, password: 'wrong' }),
    });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.deepEqual(a.json, b.json);
  });

  it('登录成功返回的 user 与契约 §2 对齐', async () => {
    const { user } = await loginAs(ADMIN);
    // boardUrl 只发给 canSeeBoard 的人，所以它在 admin 这里**必须**出现（见下面那条测试）
    assert.deepEqual(Object.keys(user).sort(), [
      'boardUrl',
      'canManageUsers',
      'canSeeBoard',
      'displayName',
      // D80：界面语言跟账号走。它在这张清单里，是因为 PWA 靠它决定
      // 显示哪种语言 —— 少了它前端只能猜（或者去读浏览器语言，而那是错的）。
      'locale',
      'role',
      'userCode',
    ]);
  });

  it('角色只分叉两次（D35②，不是 RBAC 矩阵）', async () => {
    const a = await loginAs(ADMIN);
    const p = await loginAs(PLAIN);
    assert.equal(a.user.canSeeBoard, true);
    assert.equal(a.user.canManageUsers, true);
    assert.equal(p.user.canSeeBoard, false);
    assert.equal(p.user.canManageUsers, false);
  });

  it('🔴 撤权立即生效，不用等 90 天 token 过期（D35⑤）', async () => {
    const { token } = await loginAs(PLAIN);
    assert.equal((await req('/me', { headers: auth(token) })).status, 200);

    await sql`update app_user set is_active = false where user_code = ${PLAIN.code}`;
    assert.equal(
      (await req('/me', { headers: auth(token) })).status,
      401,
      '角色/状态写进了 token？那就撤不掉权了',
    );

    await sql`update app_user set is_active = true where user_code = ${PLAIN.code}`;
  });

  it('token_version +1 让已签发的 token 全部失效', async () => {
    const { token } = await loginAs(PLAIN);
    await sql`update app_user set token_version = token_version + 1 where user_code = ${PLAIN.code}`;
    assert.equal((await req('/me', { headers: auth(token) })).status, 401);
  });
});

describe('inbox 上行', () => {
  it('落库并返回 201', async () => {
    const { token } = await loginAs(ADMIN);
    const form = new FormData();
    form.append(
      'payload',
      JSON.stringify({
        clientId: randomUUID(),
        companyCode: null, // D28 修订：录入时可空
        text: '集成测试：Istra 说要换锂电，现在用 Voltaro',
        visitLabel: 'test',
        createdAt: Date.now(),
      }),
    );
    const r = await req('/inbox', { method: 'POST', headers: auth(token), body: form });
    assert.equal(r.status, 201);
    assert.ok(r.json.inboxId && r.json.stagingId);
    assert.equal(r.json.duplicate, false);
  });

  it('🔴 幂等：同一 clientId 重传不产生重复（§4.2 第6条）', async () => {
    const { token } = await loginAs(ADMIN);
    const clientId = randomUUID();
    const send = () => {
      const f = new FormData();
      f.append('payload', JSON.stringify({ clientId, text: '重传测试', createdAt: Date.now() }));
      return req('/inbox', { method: 'POST', headers: auth(token), body: f });
    };
    const first = await send();
    const again = await send();
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.equal(again.json.duplicate, true);
    assert.equal(again.json.inboxId, first.json.inboxId, '重传建出了新记录 —— 断网重传会造重复');
  });

  it('缺 clientId → 400', async () => {
    const { token } = await loginAs(ADMIN);
    const f = new FormData();
    f.append('payload', JSON.stringify({ text: '没有幂等键' }));
    assert.equal((await req('/inbox', { method: 'POST', headers: auth(token), body: f })).status, 400);
  });
});

/**
 * 改一条速记的正文（issue #15 · #16，2026-08-05）。
 *
 * 这一组要守的性质只有一条，但它是这个项目的地基：
 * 🔴 **人怎么改，`inbox` 那一行都一个字不动。**
 */
describe('改速记正文', () => {
  /** 建一条速记，返回它的 inboxId。 */
  const makeNote = async (token: string, text: string) => {
    const f = new FormData();
    f.append('payload', JSON.stringify({ clientId: randomUUID(), text, createdAt: Date.now() }));
    const r = await req('/inbox', { method: 'POST', headers: auth(token), body: f });
    return r.json.inboxId as string;
  };

  it('改了之后 /inbox 能读到 edited_text', async () => {
    const { token } = await loginAs(ADMIN);
    const id = await makeNote(token, '集成测试：Rozenfelt 想换逆变器');

    const r = await req(`/inbox/${id}/text`, {
      method: 'PATCH',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '集成测试：Rosenfeld 想换逆变器' }),
    });
    assert.equal(r.status, 200);

    const list = await req('/inbox?limit=500', { headers: auth(token) });
    const row = list.json.items.find((x: any) => x.id === id);
    assert.equal(row.edited_text, '集成测试：Rosenfeld 想换逆变器');
  });

  it('🔴 原话一个字都没被改掉 —— inbox.text 还是最初那句', async () => {
    const { token } = await loginAs(ADMIN);
    const original = '集成测试：原话必须留着 Rozenfelt';
    const id = await makeNote(token, original);
    await req(`/inbox/${id}/text`, {
      method: 'PATCH',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '改过的内容' }),
    });

    const [row] = await sql<Array<{ text: string }>>`select text from inbox where id = ${id}`;
    assert.equal(
      row!.text,
      original,
      '改动落到 inbox 上了 —— 展会说过的话是唯一不可再生的资产（§4.2 第2条）',
    );
  });

  it('🔴 改不了别人的（作用域在服务端）', async () => {
    const a = await loginAs(ADMIN);
    const id = await makeNote(a.token, '集成测试：admin 的速记');
    const p = await loginAs(PLAIN);
    const r = await req(`/inbox/${id}/text`, {
      method: 'PATCH',
      headers: { ...auth(p.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '我改别人的' }),
    });
    assert.equal(r.status, 404, '能改别人的速记 —— 作用域没在服务端拦住');
  });

  it('🔴 已经入库的拒绝修改（409），而不是假装成功', async () => {
    const { token } = await loginAs(ADMIN);
    const id = await makeNote(token, '集成测试：已入库不给改');
    // 直接把 staging 推到 confirmed —— 不走真入库，这条测的是端点的判断
    await sql`update staging set status = 'confirmed' where inbox_id = ${id}`;

    const r = await req(`/inbox/${id}/text`, {
      method: 'PATCH',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '来不及了' }),
    });
    assert.equal(
      r.status,
      409,
      '返回了成功 —— 人会以为改上了，而 CRM 里还是旧的，他不会再改第二次',
    );
  });

  it('text 不是字符串 → 400', async () => {
    const { token } = await loginAs(ADMIN);
    const id = await makeNote(token, '集成测试：参数校验');
    const r = await req(`/inbox/${id}/text`, {
      method: 'PATCH',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 42 }),
    });
    assert.equal(r.status, 400);
  });

  it('没 token → 401', async () => {
    assert.equal(
      (
        await req(`/inbox/${randomUUID()}/text`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'x' }),
        })
      ).status,
      401,
    );
  });
});

describe('只转写端点（issue #15）', () => {
  it('没 token → 401', async () => {
    assert.equal((await req('/transcribe', { method: 'POST', body: new FormData() })).status, 401);
  });

  it('没带音频 → 400', async () => {
    const { token } = await loginAs(ADMIN);
    const r = await req('/transcribe', { method: 'POST', headers: auth(token), body: new FormData() });
    assert.equal(r.status, 400);
  });

  it('🔴 它不建任何记录 —— 放弃的录音不该在服务端留下东西', async () => {
    const { token } = await loginAs(ADMIN);
    const [before] = await sql<Array<{ n: string }>>`select count(*)::text as n from inbox`;
    const f = new FormData();
    f.append('audio', new Blob([new Uint8Array([0, 1, 2])], { type: 'audio/webm' }), 'clip.webm');
    // 真去转写会失败（这三个字节不是音频）—— 无所谓，测的是「有没有多出一行」
    await req('/transcribe', { method: 'POST', headers: auth(token), body: f });
    const [after] = await sql<Array<{ n: string }>>`select count(*)::text as n from inbox`;
    assert.equal(after!.n, before!.n, '只转写却建了 inbox 行 —— 录了没发的会变成删不掉的空记录');
  });
});

describe('作用域在服务端（质疑三 / D35）', () => {
  it('GET /inbox 只返回自己的', async () => {
    const a = await loginAs(ADMIN);
    const f = new FormData();
    f.append('payload', JSON.stringify({ clientId: randomUUID(), text: 'admin 的', createdAt: Date.now() }));
    await req('/inbox', { method: 'POST', headers: auth(a.token), body: f });

    const p = await loginAs(PLAIN);
    const mine = await req('/inbox', { headers: auth(p.token) });
    assert.equal(mine.status, 200);
    assert.equal(
      mine.json.items.some((x: any) => x.text === 'admin 的'),
      false,
      '看到了别人的速记 —— 作用域没在服务端拦住',
    );
  });

  it('🔴 user 角色传 scope=all 也只拿到自己的（不看前端传什么）', async () => {
    const p = await loginAs(PLAIN);
    const r = await req('/staging?scope=all', { headers: auth(p.token) });
    assert.equal(r.status, 200);
    assert.equal(r.json.scope, 'own', 'scope=all 被前端说了算 —— 开一下开发者工具就全看见了');
  });

  /**
   * 🔴 **这条 2026-08-07 反过来了**（D76②）。
   *
   * 原来它断言的是「admin 传 scope=all 才真的是 all」。维护者 那天定的是
   * 「无论是 admin 还是其他任何权限，你都只能访问自己写的内容」，
   * 于是 `scope` 参数整个从端点上删掉了 —— 现在这条守的是**它没被加回来**。
   */
  it('🔴 admin 传 scope=all 也只拿到自己的（D76②：这个参数已经不存在了）', async () => {
    const p = await loginAs(PLAIN);
    const his = await post(p.token, {
      clientId: randomUUID(), text: 'user 记的，admin 不该看见', createdAt: Date.now(),
    });
    assert.equal(his.status, 201);

    const a = await loginAs(ADMIN);
    const r = await req('/staging?scope=all', { headers: auth(a.token) });
    assert.equal(r.status, 200);
    assert.equal(r.json.scope, 'own');
    assert.equal(
      r.json.items.some((x: any) => x.id === his.json.stagingId),
      false,
      '🔴 admin 传 scope=all 翻出了别人的待确认队列 —— D76② 被推翻了',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
//  我的记录表格 /records（D76 · 看板改版）
// ═══════════════════════════════════════════════════════════════════
describe('我的记录表格 /records（D76）', () => {
  it('🔴 user 角色 → 403，不是空列表（D76①）', async () => {
    const p = await loginAs(PLAIN);
    const r = await req('/records', { headers: auth(p.token) });
    assert.equal(r.status, 403, 'user 能拉到这张表 —— 这一屏对他应该是整个关闭的');
    // 空列表和 403 必须分得开：给空列表的话，一个新同事第一次打开
    // 会以为自己录的东西丢了，而真正的原因是他没有权限
    assert.equal(r.json.error, 'board_forbidden');
  });

  it('🔴 admin 也只拿到自己的（D76①：谁都只能看自己写的）', async () => {
    const p = await loginAs(PLAIN);
    const his = await post(p.token, {
      clientId: randomUUID(), text: 'user 记的', createdAt: Date.now(),
    });

    const a = await loginAs(ADMIN);
    const mine = await post(a.token, {
      clientId: randomUUID(), text: 'admin 记的', createdAt: Date.now(),
    });

    const r = await req('/records', { headers: auth(a.token) });
    assert.equal(r.status, 200);
    assert.equal(r.json.scope, 'own');
    assert.ok(
      r.json.items.some((x: any) => x.id === mine.json.stagingId),
      'admin 连自己的都看不到 —— 那是查询写错了',
    );
    assert.equal(
      r.json.items.some((x: any) => x.id === his.json.stagingId),
      false,
      '🔴 admin 看到了别人的记录 —— D76① 没落到服务端',
    );
  });

  /**
   * 🔴 这条是这张表存在的理由。
   *
   * 老的 `/staging?status=ready` 只回答「还有什么没确认」，
   * 一条**录了但 AI 还没碰过 / 整理失败**的记录在人这边彻底不存在。
   * 「界面绿色、东西没进去」是这个仓库最贵的那类 bug，而这张表是它的解药。
   */
  it('🔴 不按状态过滤 —— 刚落库还没整理的（pending）也必须在表里', async () => {
    const a = await loginAs(ADMIN);
    const fresh = await post(a.token, {
      clientId: randomUUID(), text: '刚记的，AI 还没碰过', createdAt: Date.now(),
    });
    const r = await req('/records', { headers: auth(a.token) });
    const row = r.json.items.find((x: any) => x.id === fresh.json.stagingId);
    assert.ok(row, '🔴 pending 的行没出现在表里 —— 那它对人来说就是不存在的');
    assert.equal(row.status, 'pending');
  });

  it('正文取三层里最靠下那层（人改定的 > 机器听的 > 人打的）', async () => {
    const a = await loginAs(ADMIN);
    const r0 = await post(a.token, {
      clientId: randomUUID(), text: '原话：Rozenfelt', createdAt: Date.now(),
    });
    const patch = await req(`/inbox/${r0.json.inboxId}/text`, {
      method: 'PATCH',
      headers: { ...auth(a.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '改定：Rosenfeld' }),
    });
    assert.equal(patch.status, 200);

    const r = await req('/records', { headers: auth(a.token) });
    const row = r.json.items.find((x: any) => x.id === r0.json.stagingId);
    assert.equal(row.text, '改定：Rosenfeld', '表格显示的是原话 —— 人改过的那一版没被取到');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  确认与附件也只认自己的（D76① —— 原来这两处对 canSeeBoard 是开的）
// ═══════════════════════════════════════════════════════════════════
describe('确认与附件也只认自己的（D76①）', () => {
  it('🔴 admin 确认不了别人录的记录 → 404', async () => {
    const p = await loginAs(PLAIN);
    const his = await post(p.token, {
      clientId: randomUUID(), text: 'user 的，admin 不该能确认', createdAt: Date.now(),
    });

    const a = await loginAs(ADMIN);
    const r = await req(`/staging/${his.json.stagingId}/confirm`, {
      method: 'POST',
      headers: { ...auth(a.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId: randomUUID() }),
    });
    assert.equal(
      r.status,
      404,
      '🔴 admin 能确认别人录的 —— loadOwned 里 canSeeBoard 那条口子被加回来了',
    );
  });

  it('🔴 admin 下载不了别人的附件 → 404（本人取得到）', async () => {
    const p = await loginAs(PLAIN);
    const his = await post(
      p.token,
      { clientId: randomUUID(), text: '带附件', createdAt: Date.now() },
      [['file', new Blob(['hello'], { type: 'text/plain' }), 'note.txt']],
    );
    assert.equal(his.json.attachments, 1);
    const [att] = await sql<Array<{ id: string }>>`
      select id from attachment where inbox_id = ${his.json.inboxId}`;
    assert.ok(att, '附件没落库，后面两条断言就没有意义了');

    const a = await loginAs(ADMIN);
    assert.equal(
      (await req(`/attachments/${att.id}/file`, { headers: auth(a.token) })).status,
      404,
      '🔴 admin 能下载同事拍的照片',
    );
    // 🔴 本人这一条不能省：少了它，上面那个 404 可能只是「文件本来就取不到」，
    //    那这条测试就在守一个假的边界
    assert.equal(
      (await req(`/attachments/${att.id}/file`, { headers: auth(p.token) })).status,
      200,
      '本人也取不到自己的附件 —— 那上面那条 404 什么都没证明',
    );
  });
});

describe('原文不可变在数据库层（§4.2 第2条）', () => {
  it('🔴 直接 UPDATE inbox 被触发器拒绝', async () => {
    const { token } = await loginAs(ADMIN);
    const f = new FormData();
    f.append('payload', JSON.stringify({ clientId: randomUUID(), text: '原文', createdAt: Date.now() }));
    const { json } = await req('/inbox', { method: 'POST', headers: auth(token), body: f });

    await assert.rejects(
      () => sql`update inbox set text = '被改了' where id = ${json.inboxId}`,
      /只增不改/,
      'inbox 能被 UPDATE —— §4.2 第2条只是纸面约定了',
    );
  });

  it('🔴 直接 DELETE inbox 也被拒绝', async () => {
    const { token } = await loginAs(ADMIN);
    const f = new FormData();
    f.append('payload', JSON.stringify({ clientId: randomUUID(), text: '删不掉', createdAt: Date.now() }));
    const { json } = await req('/inbox', { method: 'POST', headers: auth(token), body: f });

    await assert.rejects(() => sql`delete from inbox where id = ${json.inboxId}`, /只增不改/);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  六个必须有的测试（实施计划 §5）—— 只能写六个的话就写这六个
// ═══════════════════════════════════════════════════════════════════

describe('① 续写不 UPDATE inbox（六必之一）', () => {
  it('🔴 同一条对话的第二句是**新的一行**，原行一个字节都没变', async () => {
    const { token } = await loginAs(ADMIN);

    const first = await post(token, {
      clientId: randomUUID(), text: '第一句：Alpin 想换逆变器', createdAt: Date.now(), toAgent: true,
    });
    assert.equal(first.status, 201);
    const threadId = first.json.threadId as string;
    assert.ok(threadId, '第一句没有开出 thread —— 续写就无从谈起');

    // 原行的完整快照。续写之后逐字段比对 —— 不是只看 text。
    const [before] = await sql`select * from inbox where id = ${first.json.inboxId}`;
    const countRows = async () =>
      Number(
        (
          await sql<Array<{ count: string }>>`
            select count(*)::text from inbox where thread_id = ${threadId}`
        )[0]?.count ?? 0,
      );
    const n0 = await countRows();

    const second = await post(token, {
      clientId: randomUUID(),
      threadId,
      text: '第二句：他们年产 12000 台',
      createdAt: Date.now(),
    });
    assert.equal(second.status, 201);
    assert.equal(second.json.threadId, threadId, '续写开出了新对话 —— 上下文就断了');
    assert.notEqual(second.json.inboxId, first.json.inboxId);

    const [after] = await sql`select * from inbox where id = ${first.json.inboxId}`;
    assert.deepEqual(after, before, '🔴 原文被改动了 —— 触发器没挡住，或者代码走了 UPDATE');

    assert.equal(await countRows(), n0 + 1, '续写应该是 +1 行，不是改一行');
  });

  it('别人的 threadId 传过来会被忽略（作用域在服务端）', async () => {
    const a = await loginAs(ADMIN);
    const mine = await post(a.token, {
      clientId: randomUUID(), text: 'admin 开的对话', createdAt: Date.now(), toAgent: true,
    });

    const p = await loginAs(PLAIN);
    const r = await post(p.token, {
      clientId: randomUUID(),
      threadId: mine.json.threadId,
      text: '想插进别人的对话',
      createdAt: Date.now(),
    });
    assert.equal(r.status, 201);
    assert.notEqual(r.json.threadId, mine.json.threadId, '🔴 能写进别人的对话');
  });
});

describe('③ agent 停机不影响采集（六必之三）', () => {
  it('🔴 上行不等 agent —— 201 立刻回来，原文已经在库里', async () => {
    const { token } = await loginAs(ADMIN);
    const t0 = Date.now();
    const r = await post(token, { clientId: randomUUID(), text: '停机测试', createdAt: Date.now() });
    const ms = Date.now() - t0;

    assert.equal(r.status, 201);
    // 转写 + 抽取动辄十几秒。如果上行在等它们，这里必然超时 ——
    // 而展馆里那意味着「按了保存转圈半天」，人就不录了。
    assert.ok(ms < 3000, `上行花了 ${ms}ms —— 它在等 agent`);

    const [row] = await sql`select id from inbox where id = ${r.json.inboxId}`;
    assert.ok(row, '原文没落库');
  });

  it('agent 健康接口能看出它开着还是关着', async () => {
    const h = await req('/agent/health');
    assert.equal(h.status, 200);
    assert.equal(typeof h.json.enabled, 'boolean');
    assert.equal(typeof h.json.queued, 'number');
  });

  /**
   * 🔴 **这一条在 2026-08-10 之前从没被执行过。**
   *
   * 它原来是上面那条里的一个 `if (h.json.enabled === false)` 分支 ——
   * 而 CI **从不设** `AGENT_ENABLED=0`，所以那个分支永远是假。
   * 第一次按 `scripts/test.sh` 自己的建议（`AGENT_ENABLED=0 npm run dev`）跑，
   * 它当场红了两次，两个原因都是真的：
   *
   *   ① 它发的是**纯速记**，而纯速记按 D31 根本不进 agent 队列 ——
   *      「agent 已关闭」那条分支住在 `loop.ts` 里，压根到不了。
   *      它会一直停在 `pending`（那是它正常的休息状态）。→ 加 `toAgent: true`。
   *   ② 改完之后停在 `failed`（`fetch failed`）：`loop.ts` 在
   *      `if (!env.agentEnabled)` **之前**要先 `listCompanies()`/`listSuppliers()`
   *      去 Twenty 取品牌名单 —— 那是**转写**的关键词偏置要用的（转写在 agent 之外，
   *      关掉 agent 也照转）。Twenty 连不上就先炸在这儿。
   *      所以这条用例的真实前置是「agent 关着 **且** Twenty 通」。
   *
   * 拆成独立的 `it()` + 显式 skip，而不是 `if` 里静默略过 ——
   * 判据同本文件开头 `NEEDS_TWENTY` 那段：**`return` 是静默通过，
   * 测试数悄悄少一条没人会注意到；`skip` 会写在汇总里。**
   */
  it('agent 停机时采集照常：staging 落 ready 并写明原因', NEEDS_AGENT_OFF, async () => {
    const { token } = await loginAs(ADMIN);
    const r = await post(token, {
      clientId: randomUUID(),
      text: 'agent 关着也要能录',
      createdAt: Date.now(),
      toAgent: true, // 不带这个的话按 D31 它根本不进 agent 队列
    });
    assert.equal(r.status, 201);
    await new Promise((res) => setTimeout(res, 1500));
    const [st] = await sql<Array<{ status: string; error: string | null }>>`
      select status, error from staging where inbox_id = ${r.json.inboxId}`;
    assert.equal(st?.status, 'ready', `停在 ${st?.status}：${st?.error ?? ''}`);
    assert.match(st?.error ?? '', /agent 已关闭/);
  });
});

describe('④ 旧形状仍然可用（六必之四）', () => {
  it('🔴 网关升了、手机还是旧 PWA —— 不带 threadId / 附件也必须能传', async () => {
    const { token } = await loginAs(ADMIN);
    // 逐字复刻 2026-07-31 那版 sync.ts 发出来的 payload，一个字段不多
    const r = await post(token, {
      clientId: randomUUID(),
      companyCode: null,
      text: '旧版 PWA 发上来的',
      recordedBy: ADMIN.code,
      visitLabel: 'Caravan Salon 2026',
      createdAt: Date.now(),
      audioSeconds: null,
    });
    assert.equal(r.status, 201);
    assert.ok(r.json.inboxId && r.json.stagingId);
  });

  it('旧版的 GET /inbox 字段一个没少', async () => {
    const { token } = await loginAs(ADMIN);
    const r = await req('/inbox?limit=1', { headers: auth(token) });
    assert.equal(r.status, 200);
    const it = r.json.items[0];
    if (it) {
      for (const k of ['id', 'client_id', 'company_code', 'text', 'status', 'transcript', 'extracted'])
        assert.ok(k in it, `少了字段 ${k} —— 旧版 PWA 会静默出错`);
    }
  });
});

describe('⑤ 新建客户的强制查重（六必之五）', () => {
  it('三样必填，缺一个 422（名字 / 国家 / 类型）', async () => {
    const { token } = await loginAs(ADMIN);
    const r = await req('/companies', {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '只填了名字' }),
    });
    assert.equal(r.status, 422);
    assert.deepEqual(r.json.missing.sort(), ['accountType', 'country']);
  });

  it('🔴 名字撞上已有客户 → 409 + 候选，**不建**', async () => {
    const { token } = await loginAs(ADMIN);
    const list = await req('/companies', { headers: auth(token) });
    const sample = list.json.items?.[0];
    if (!sample) return; // Twenty 里还没导客户，跳过

    // 故意用「去掉变音符 + 全大写」这种真实发生过的写法
    const messy = String(sample.name).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
    const r = await req('/companies', {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: messy, country: 'Germany', accountType: 'OEM_BRAND' }),
    });
    assert.equal(r.status, 409, `「${messy}」没被认出是「${sample.name}」—— 库里会多一家重复客户`);
    assert.ok(r.json.candidates?.length);
  });

  it('查重接口对听错的写法也有效', NEEDS_TWENTY, async () => {
    const { token } = await loginAs(ADMIN);
    const r = await req('/companies/search?q=Rozenfelt', { headers: auth(token) });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.items));
  });
});

describe('⑥ boardUrl 由服务端按 role 决定（六必之六）', () => {
  it('🔴 user 角色的 /me 里**根本没有** boardUrl 这个字段', async () => {
    const p = await loginAs(PLAIN);
    const r = await req('/me', { headers: auth(p.token) });
    assert.equal(r.status, 200);
    assert.equal(
      'boardUrl' in r.json.user,
      false,
      '🔴 发给了 user —— 前端藏起来等于没藏，改一行 JS 就看到了',
    );
  });

  it('admin 拿得到', async () => {
    const a = await loginAs(ADMIN);
    const r = await req('/me', { headers: auth(a.token) });
    assert.ok(r.json.user.boardUrl, 'admin 也没拿到 —— 看板页会变成死胡同');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  新增端点
// ═══════════════════════════════════════════════════════════════════
describe('附件', () => {
  it('三种 kind 都能上传，落 attachment 表', async () => {
    const { token } = await loginAs(ADMIN);
    const r = await post(
      token,
      { clientId: randomUUID(), text: '带附件', createdAt: Date.now() },
      [
        ['photo', new Blob(['fake-jpeg']), 'stand.jpg'],
        ['file', new Blob(['brand,qty\nAlpin,1200\n']), 'spec.csv'],
      ],
    );
    assert.equal(r.status, 201);
    assert.equal(r.json.attachments, 2);

    const rows = await sql<Array<{ kind: string; filename: string }>>`
      select kind, filename from attachment where inbox_id = ${r.json.inboxId} order by kind`;
    assert.deepEqual(rows.map((x) => x.kind), ['file', 'photo']);
  });

  it('🔴 附件原件也是只增不改（和原文同一条纪律）', async () => {
    const { token } = await loginAs(ADMIN);
    const r = await post(token, { clientId: randomUUID(), text: 'x', createdAt: Date.now() }, [
      ['image', new Blob(['png']), 'a.png'],
    ]);
    const [a] = await sql<Array<{ id: string }>>`select id from attachment where inbox_id = ${r.json.inboxId}`;
    await assert.rejects(() => sql`update attachment set filename = 'hacked' where id = ${a!.id}`, /只增不改/);
    await assert.rejects(() => sql`delete from attachment where id = ${a!.id}`, /只增不改/);
  });

  it('不认识的 fieldname 被忽略，不会把整个请求卡住', async () => {
    const { token } = await loginAs(ADMIN);
    const r = await post(token, { clientId: randomUUID(), text: 'y', createdAt: Date.now() }, [
      ['whatever', new Blob(['?']), 'x.bin'],
    ]);
    assert.equal(r.status, 201);
    assert.equal(r.json.attachments, 0);
  });
});

describe('对话', () => {
  it('GET /threads 只返回自己的', async () => {
    const a = await loginAs(ADMIN);
    await post(a.token, { clientId: randomUUID(), text: 'admin 的对话', createdAt: Date.now(), toAgent: true });

    const p = await loginAs(PLAIN);
    const r = await req('/threads', { headers: auth(p.token) });
    assert.equal(r.status, 200);
    assert.equal(r.json.items.some((t: any) => t.title === 'admin 的对话'), false);
  });

  it('读别人的对话 → 404（不是 403 —— 不确认它存在）', async () => {
    const a = await loginAs(ADMIN);
    const mine = await post(a.token, { clientId: randomUUID(), text: '私密', createdAt: Date.now(), toAgent: true });
    const p = await loginAs(PLAIN);
    assert.equal((await req(`/threads/${mine.json.threadId}`, { headers: auth(p.token) })).status, 404);
  });

  it('🔴 对话消息也只增不改', async () => {
    const a = await loginAs(ADMIN);
    const r = await post(a.token, { clientId: randomUUID(), text: '说过的话', createdAt: Date.now(), toAgent: true });
    const [m] = await sql<Array<{ id: string }>>`
      select id from thread_message where thread_id = ${r.json.threadId} limit 1`;
    if (m) {
      await assert.rejects(() => sql`update thread_message set text = '改了' where id = ${m.id}`, /只增不改/);
    }
  });
});

/**
 * ══════════════════════════════════════════════════════════════════
 *  改口跨越「已入库」：把记录的所有权带过去（D108 · issue #37）
 *
 *  🔴 这一族守的是 #37 那个生产事故的形状：同一条选型情报改了一次口，
 *  **CRM 里两版并存**（Movara · PowerFlex 3000W 和 2000W 各一条）。
 *  根因是改口只让**还没入库**的提案退场，已入库的一个都不碰 ——
 *  于是这一轮照常新建一份。
 *
 *  ⚠️ 真正的「原地改写」要写 Twenty，那几条挂 `NEEDS_TWENTY`。
 *     这里能不碰 Twenty 就验到的是**交接本身**：`replaces` 写没写、
 *     写的是不是最近那一版、老那一行有没有被提前收走（**不能**）。
 * ══════════════════════════════════════════════════════════════════ */
describe('改口继承记录所有权 · 交接那一半（D108 · issue #37）', () => {
  /**
   * 造一条「已经入库」的速记：走真的 `POST /inbox` 落库，再手动挂进对话、标成
   * `confirmed` 并给它一份 refs（相当于它在 CRM 里建过一条拜访）。
   *
   * ⚠️ **上行时故意不带 `threadId`**：带了就会走 agent（`index.ts:642`
   *    「带了 threadId = 续写 = 进 agent」），而一次性环境里 agent 连不上 Twenty，
   *    失败收尾那一句 `update staging set status='failed'` 会**把这里设的
   *    `confirmed` 覆盖掉** —— 于是这条用例时快时慢地红，而根因和它要测的东西无关。
   *    对话关系直接插 `thread_message`（只增不改挡的是 UPDATE/DELETE，INSERT 是正路）。
   *
   * `ageSeconds` 让「谁更近」可判定，不靠两次写入之间的毫秒差（§2.42：
   * 一条要靠运气才成立的断言等于没有断言）。
   */
  const committedNote = async (token: string, threadId: string, text: string, ageSeconds = 0) => {
    const r = await post(token, { clientId: randomUUID(), text, createdAt: Date.now() });
    const inboxId = r.json.inboxId as string;
    const stagingId = r.json.stagingId as string;
    const [msg] = await sql<Array<{ id: string }>>`
      insert into thread_message (thread_id, role, text, inbox_id, created_at)
      values (${threadId}, 'user', ${text}, ${inboxId}, now() - ${`${ageSeconds} seconds`}::interval)
      returning id`;
    const fakeVisit = randomUUID();
    await sql`
      update staging
      set status = 'confirmed',
          confirm_payload = ${sql.json({ companyId: 'c0000000-0000-0000-0000-000000000001' } as never)},
          twenty_refs = ${sql.json({ visitId: fakeVisit } as never)},
          created_records = ${sql.json([{ object: 'visit', id: fakeVisit, name: text }] as never)},
          updated_at = now() - ${`${ageSeconds} seconds`}::interval
      where id = ${stagingId}`;
    return { inboxId, stagingId, messageId: msg!.id, visitId: fakeVisit };
  };

  it('🔴 改口盖住一版已入库的 → 新 staging 记下 replaces，老那一行**照旧拥有**记录', async () => {
    const { token } = await loginAs(ADMIN);
    const t = await req('/threads', {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `改口-${SUFFIX}` }),
    });
    const threadId = t.json.id as string;
    const first = await committedNote(token, threadId, 'Movara 逆变器用 PowerFlex 3000W');

    const second = await post(token, {
      clientId: randomUUID(),
      text: 'Movara 逆变器用 PowerFlex 2000W',
      createdAt: Date.now(),
      threadId,
      supersedesMessageId: first.messageId,
    });
    assert.equal(second.status, 201);

    // 回包必须说出来：会改写哪几条（以前这里一个字都没有）
    assert.equal(second.json.rewriting.length, 1);
    assert.equal(second.json.rewriting[0].object, 'visit');
    assert.equal(second.json.otherCommitted, 0);

    const [next] = await sql<Array<{ replaces: any }>>`
      select replaces from staging where id = ${second.json.stagingId}`;
    assert.equal(next!.replaces.stagingId, first.stagingId, 'replaces 没指向上一版');
    assert.equal(next!.replaces.refs.visitId, first.visitId, '继承过来的 refs 不对');

    /**
     * 🔴 **这一条是整个设计的支点**：交接的意向记在改口那一刻，
     * 所有权的转移发生在**提交成功**那一刻。改口之后这一轮可能永远不会被确认 ——
     * 那时老那一版仍然有效、仍然拥有 CRM 里那几条。提前收走 = 制造孤儿记录。
     */
    const [old] = await sql<Array<{ status: string; refs: any; created: any; superseded_by: string }>>`
      select status, twenty_refs as refs, created_records as created, superseded_by
      from staging where id = ${first.stagingId}`;
    assert.equal(old!.status, 'confirmed', '老那一行被提前改状态了 —— 那几条记录会变成孤儿');
    assert.equal(old!.refs.visitId, first.visitId, '老那一行的 refs 被提前收走了');
    assert.equal(old!.created.length, 1, '老那一行的 created_records 被提前收走了');
    assert.equal(old!.superseded_by, second.json.stagingId, '没标出「这一版不再是活的那一条」');
  });

  it('🔴 只继承**最近**那一版，其余的一个字不动而且如实报出来', async () => {
    const { token } = await loginAs(ADMIN);
    const t = await req('/threads', {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `两版-${SUFFIX}` }),
    });
    const threadId = t.json.id as string;
    // 显式给出「谁更早」，不靠两次写入之间的毫秒差
    const older = await committedNote(token, threadId, '第一版：3000W', 120);
    const newer = await committedNote(token, threadId, '第二版：2500W', 60);

    // 往回改**最早**那一条 —— 两版都会被盖住
    const third = await post(token, {
      clientId: randomUUID(),
      text: '第三版：2000W',
      createdAt: Date.now(),
      threadId,
      supersedesMessageId: older.messageId,
    });
    assert.equal(third.json.otherCommitted, 1, '另一版已入库的没有被报出来');

    const [next] = await sql<Array<{ replaces: any }>>`
      select replaces from staging where id = ${third.json.stagingId}`;
    assert.equal(next!.replaces.stagingId, newer.stagingId, '继承的不是最近那一版');

    // 没被继承的那一版**一个字不动**（它仍然拥有自己的记录）
    const [untouched] = await sql<Array<{ refs: any }>>`
      select twenty_refs as refs from staging where id = ${older.stagingId}`;
    assert.equal(untouched!.refs.visitId, older.visitId);
  });

  it('上一轮还没入库时不继承任何东西（最常见的情况，界面不该打扰人）', async () => {
    const { token } = await loginAs(ADMIN);
    const t = await req('/threads', {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `没入库-${SUFFIX}` }),
    });
    const threadId = t.json.id as string;
    const first = await post(token, {
      clientId: randomUUID(),
      text: '还没确认的一版',
      createdAt: Date.now(),
      threadId,
    });
    const [msg] = await sql<Array<{ id: string }>>`
      select id from thread_message where inbox_id = ${first.json.inboxId} limit 1`;
    await sql`update staging set status = 'ready' where id = ${first.json.stagingId}`;

    const second = await post(token, {
      clientId: randomUUID(),
      text: '改口的一版',
      createdAt: Date.now(),
      threadId,
      supersedesMessageId: msg!.id,
      });
    assert.deepEqual(second.json.rewriting, []);
    const [next] = await sql<Array<{ replaces: any }>>`
      select replaces from staging where id = ${second.json.stagingId}`;
    assert.equal(next!.replaces, null);
    // 老那一版照旧退场（issue #14 的边界没变）
    const [old] = await sql<Array<{ status: string }>>`
      select status from staging where id = ${first.json.stagingId}`;
    assert.equal(old!.status, 'superseded');
  });

  it('预览端点和真正执行**说的是同一件事**（共用 scopeOf）', async () => {
    const { token } = await loginAs(ADMIN);
    const t = await req('/threads', {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `预览-${SUFFIX}` }),
    });
    const threadId = t.json.id as string;
    const first = await committedNote(token, threadId, '预览用的那一版');

    const preview = await req(
      `/threads/${threadId}/supersede-preview?messageId=${first.messageId}`,
      { headers: auth(token) },
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.json.rewriting.length, 1);
    assert.equal(preview.json.rewriting[0].label, '拜访');

    const sent = await post(token, {
      clientId: randomUUID(),
      text: '真发出去的那一版',
      createdAt: Date.now(),
      threadId,
      supersedesMessageId: first.messageId,
    });
    // 🔴 卡片上说的和实际做的必须一致 —— 分两份实现的话总有一天会分叉（D93 的判据）
    assert.deepEqual(
      sent.json.rewriting.map((r: any) => r.object),
      preview.json.rewriting.map((r: any) => r.object),
    );
  });

  it('预览：没登录 → 401 · 别人的消息 → 404 · 不给 messageId → 400', async () => {
    const { token } = await loginAs(ADMIN);
    const t = await req('/threads', {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `预览闸门-${SUFFIX}` }),
    });
    const threadId = t.json.id as string;
    assert.equal(
      (await req(`/threads/${threadId}/supersede-preview?messageId=${randomUUID()}`)).status,
      401,
    );
    assert.equal(
      (await req(`/threads/${threadId}/supersede-preview`, { headers: auth(token) })).status,
      400,
    );
    assert.equal(
      (
        await req(`/threads/${threadId}/supersede-preview?messageId=${randomUUID()}`, {
          headers: auth(token),
        })
      ).status,
      404,
    );
  });
});

/**
 * ══════════════════════════════════════════════════════════════════
 *  删对话历史（D102 · issue #33）
 *
 *  这一族守的是**这一刀切在哪**：删掉的只是「它出现在我的历史列表里」。
 *  消息一个字不动（`thread_message` 有只增不改的触发器，真删会撞上它），
 *  速记那条原话不动，CRM 里那几条也不动 —— 三个面各有各的删除。
 *
 *  🔴 其中两条是**没有它就会静默出事**的：
 *    · 删掉的对话仍然能按 id 打开（回 404 的话，看板那一行的「去对话里看」
 *      会落到一屏空白，而人什么提示都拿不到）
 *    · 删掉之后「发给 AI」要**新开一条**，不能接着往那条已经看不见的里写
 * ══════════════════════════════════════════════════════════════════ */
describe('删对话历史 DELETE /threads/:id（D102 · issue #33）', () => {
  /** 建一条空对话（不烧模型 —— 这一族要的只是一条 thread 行）。 */
  const newThread = async (token: string, title: string) => {
    const r = await req('/threads', {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    assert.equal(r.status, 201);
    return r.json.id as string;
  };

  it('没登录 → 401', async () => {
    assert.equal((await req(`/threads/${randomUUID()}`, { method: 'DELETE' })).status, 401);
  });

  it('🔴 别人的对话 → 404（不是 403 —— 和这一族其余端点一致，不确认它存在）', async () => {
    const a = await loginAs(ADMIN);
    const id = await newThread(a.token, `别人的-${SUFFIX}`);
    const p = await loginAs(PLAIN);
    assert.equal((await req(`/threads/${id}`, { method: 'DELETE', headers: auth(p.token) })).status, 404);
    // 而且真的没被删掉 —— 404 之后它还在自己的列表里
    const list = await req('/threads', { headers: auth(a.token) });
    assert.equal(list.json.items.some((t: any) => t.id === id), true);
  });

  it('删掉之后从历史列表里消失，撤销之后回来', async () => {
    const a = await loginAs(ADMIN);
    const id = await newThread(a.token, `要删的-${SUFFIX}`);

    const d = await req(`/threads/${id}`, { method: 'DELETE', headers: auth(a.token) });
    assert.equal(d.status, 200);
    assert.equal(d.json.deleted, true);

    const after = await req('/threads', { headers: auth(a.token) });
    assert.equal(after.json.items.some((t: any) => t.id === id), false, '删掉的还在列表里');

    const r = await req(`/threads/${id}/restore`, { method: 'POST', headers: auth(a.token) });
    assert.equal(r.status, 200);
    const back = await req('/threads', { headers: auth(a.token) });
    assert.equal(back.json.items.some((t: any) => t.id === id), true, '撤销之后没回来');
  });

  it('再删一次是幂等的（alreadyDeleted），不报错也不改时间戳', async () => {
    const a = await loginAs(ADMIN);
    const id = await newThread(a.token, `删两次-${SUFFIX}`);
    const first = await req(`/threads/${id}`, { method: 'DELETE', headers: auth(a.token) });
    const second = await req(`/threads/${id}`, { method: 'DELETE', headers: auth(a.token) });
    assert.equal(second.status, 200);
    assert.equal(second.json.alreadyDeleted, true);
    assert.equal(second.json.deletedAt, first.json.deletedAt);
  });

  it('🔴 删掉的对话仍然打得开，只多一格 deleted_at —— 回 404 的话看板那条链接会落到一屏空白', async () => {
    const a = await loginAs(ADMIN);
    const id = await newThread(a.token, `还能看-${SUFFIX}`);
    await req(`/threads/${id}`, { method: 'DELETE', headers: auth(a.token) });

    const g = await req(`/threads/${id}`, { headers: auth(a.token) });
    assert.equal(g.status, 200);
    assert.ok(g.json.thread.deleted_at, 'deleted_at 没带回去，界面打不出那条横幅');
  });

  it('🔴 消息一个字都没删 —— 删的是「它出现在列表里」，不是那些话', async () => {
    const a = await loginAs(ADMIN);
    const id = await newThread(a.token, `留着话-${SUFFIX}`);
    await sql`insert into thread_message (thread_id, role, text) values (${id}, 'user', '展会上说过的一句话')`;

    await req(`/threads/${id}`, { method: 'DELETE', headers: auth(a.token) });

    const [left] = await sql<Array<{ n: number }>>`
      select count(*)::int as n from thread_message where thread_id = ${id}`;
    assert.equal(left!.n, 1, '删对话把消息也带走了 —— 展会 10 天说过的话是唯一不可再生的资产');
    const g = await req(`/threads/${id}`, { headers: auth(a.token) });
    assert.equal(g.json.messages.length, 1);
  });

  it('🔴 删掉之后「发给 AI」新开一条，不会接着往看不见的那条里写', async () => {
    const a = await loginAs(ADMIN);
    // 一条**不进 agent** 的速记（D31），再手动把它挂到一条对话上 —— 不烧模型
    const s = await post(a.token, { clientId: randomUUID(), text: '挂在对话上的速记', createdAt: Date.now() });
    const id = await newThread(a.token, `会被删的-${SUFFIX}`);
    await sql`update staging set thread_id = ${id} where inbox_id = ${s.json.inboxId}`;

    await req(`/threads/${id}`, { method: 'DELETE', headers: auth(a.token) });

    // 「这条速记发给过哪几条对话」里不该再有它 —— 否则那道 double check（D95）
    // 会把人指进一条他自己刚删掉的对话，而且「已经发过了」这个结论也不再成立
    const th = await req(`/inbox/${s.json.inboxId}/threads`, { headers: auth(a.token) });
    assert.equal(th.status, 200);
    assert.equal(th.json.items.some((t: any) => t.id === id), false, '删掉的对话还出现在 double check 里');
  });

  it('撤销一条没删过的对话是无害的（幂等）', async () => {
    const a = await loginAs(ADMIN);
    const id = await newThread(a.token, `没删过-${SUFFIX}`);
    const r = await req(`/threads/${id}/restore`, { method: 'POST', headers: auth(a.token) });
    assert.equal(r.status, 200);
    assert.equal(r.json.restored, true);
  });

  it('🔴 正在跑的那一轮不许删 → 409，而且真的没删掉', async () => {
    const a = await loginAs(ADMIN);
    const id = await newThread(a.token, `正在跑-${SUFFIX}`);
    const s = await post(a.token, { clientId: randomUUID(), text: '正在跑的那条', createdAt: Date.now() });
    // 直接造一条 running 的 agent_run —— 真让 agent 跑起来要烧一次模型，
    // 而这条用例要验的只是「有 running 就拒绝」这一个判断
    await sql`insert into agent_run (inbox_id, thread_id, status, steps)
              values (${s.json.inboxId}, ${id}, 'running', 1)`;

    const d = await req(`/threads/${id}`, { method: 'DELETE', headers: auth(a.token) });
    assert.equal(d.status, 409);
    assert.equal(d.json.error, 'running');

    const list = await req('/threads', { headers: auth(a.token) });
    assert.equal(list.json.items.some((t: any) => t.id === id), true, '409 了却还是把它删掉了');

    // 收尾：跑完之后就能删了（`status` 有 check 约束：running/ok/partial/failed）
    await sql`update agent_run set status = 'ok' where thread_id = ${id}`;
    assert.equal((await req(`/threads/${id}`, { method: 'DELETE', headers: auth(a.token) })).status, 200);
  });
});

/**
 * 🐛 回归：**点一次确认，CRM 里写了两份**（issue #1，2026-08-04 生产实测）
 *
 * 拜访 2 条、选型情报 2 条，同名同客户、时间戳同一秒。商机没重复 ——
 * 因为 D56 的「同一家+同一品类」幂等挡住了；没有自然键的对象就实打实写两份。
 *
 * 根因是心跳「先 select 再提交」，而 commitToTwenty() 直到最后一行才改 status，
 * 中间十几次 Twenty 往返；setInterval 不管上一轮跑没跑完，1 秒后再选中同一行。
 *
 * ⚠️ **这条测试不需要 Twenty**，测的是认领语句本身：
 * 同一行被并发认领两次，只能有一次拿到。真跑一遍 commit 反而测不出来 ——
 * 本地 commit 快得来不及被第二轮撞上（那正是它在本地一直没暴露的原因）。
 */
describe('🔴 提交心跳的认领锁：同一行只能被认领一次（issue #1）', () => {
  it('两轮心跳同时到点，最多只有一轮拿得到那一行', async () => {
    const { token } = await loginAs(ADMIN);
    const r = await post(token, { clientId: randomUUID(), text: `认领锁 ${SUFFIX}`, createdAt: Date.now() });
    const sid = r.json.stagingId as string;
    const company = (await req('/companies', { headers: auth(token) })).json.items?.[0];
    if (!company) return;

    // 直接摆成「已到点的待提交」——不经过 5 秒等待。
    // ⚠️ 给一个**真的** companyId：跑着的网关那一轮心跳也会来抢这一行，
    //    抢到了就真提交，给假 id 会在日志里留一串 FK 报错，掩盖真问题。
    await sql`update staging set status = 'confirming', confirm_after = now() - interval '1 second',
              confirm_payload = ${sql.json({ companyId: company.id } as never)} where id = ${sid}`;

    const [a, b] = await Promise.all([claimDue(), claimDue()]);
    const mine = [...a, ...b].filter((x) => x.id === sid).length;

    /**
     * 断言的是**不变式**而不是「我一定抢到」：本地跑着的网关心跳也在抢同一行，
     * 抢走了我这边就是 0 —— 那也对，因为「至多一次」仍然成立。
     * 旧实现（select 而不是 update…returning）下这里必然是 2。
     */
    assert.ok(
      mine <= 1,
      `🔴 同一行被认领了 ${mine} 次 —— 每多一次就是 CRM 里多一份拜访、多一条情报`,
    );

    const [after] = await sql<Array<{ status: string }>>`select status from staging where id = ${sid}`;
    assert.notEqual(
      after?.status,
      'confirming',
      '🔴 认领之后还停在 confirming —— 下一轮心跳会再选中它',
    );
  });

  it('🔴 正在写 CRM 的记录再收到一次确认 → pending，不能重开一个 5 秒窗口', async () => {
    const { token } = await loginAs(ADMIN);
    const r = await post(token, { clientId: randomUUID(), text: `二次确认 ${SUFFIX}`, createdAt: Date.now() });
    const sid = r.json.stagingId as string;
    const company = (await req('/companies', { headers: auth(token) })).json.items?.[0];
    if (!company) return;

    await sql`update staging set status = 'committing' where id = ${sid}`;

    // 手滑双击 / PWA 重试 / 两个人同时点，都会走到这里
    const again = await req(`/staging/${sid}/confirm`, {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId: company.id }),
    });
    assert.equal(again.status, 200);
    assert.equal(again.json.pending, true, '🔴 没被挡住');

    const [st] = await sql<Array<{ status: string }>>`select status from staging where id = ${sid}`;
    assert.equal(
      st?.status,
      'committing',
      '🔴 状态被改回 confirming 了 —— 心跳会再认领一次，于是再写一份（issue #1 的第二条路径）',
    );

    await sql`update staging set status = 'ready', confirm_after = null where id = ${sid}`;
  });
});

describe('确认入库：5 秒延迟提交（D48）', () => {
  it('不给 companyId → 422（D28 修订的闸门）', async () => {
    const { token } = await loginAs(ADMIN);
    const r = await post(token, { clientId: randomUUID(), text: '待确认', createdAt: Date.now() });
    const c = await req(`/staging/${r.json.stagingId}/confirm`, {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(c.status, 422);
    assert.equal(c.json.error, 'company_required');
  });

  it('🔴 排队之后可以撤销，而且撤销时 Twenty 里从来没写过', async () => {
    const { token } = await loginAs(ADMIN);
    const list = await req('/companies', { headers: auth(token) });
    const company = list.json.items?.[0];
    if (!company) return; // 没导客户就没法测这条

    const r = await post(token, { clientId: randomUUID(), text: '延迟提交测试', createdAt: Date.now() });
    const c = await req(`/staging/${r.json.stagingId}/confirm`, {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId: company.id }),
    });
    assert.equal(c.status, 200);
    assert.equal(c.json.queued, true);
    assert.ok(c.json.undoMs >= 1000);

    const [mid] = await sql<Array<{ status: string; twenty_refs: unknown }>>`
      select status, twenty_refs from staging where id = ${r.json.stagingId}`;
    assert.equal(mid?.status, 'confirming');
    assert.equal(mid?.twenty_refs, null, '还没到点就写 Twenty 了 —— 撤销就成了删记录');

    const undo = await req(`/staging/${r.json.stagingId}/confirm`, {
      method: 'DELETE',
      headers: auth(token),
    });
    assert.equal(undo.status, 200);
    assert.equal(undo.json.cancelled, true);

    const [after] = await sql<Array<{ status: string; twenty_refs: unknown }>>`
      select status, twenty_refs from staging where id = ${r.json.stagingId}`;
    assert.equal(after?.status, 'ready');
    assert.equal(after?.twenty_refs, null, '🔴 撤销之后 Twenty 里居然有记录');
  });

  it('别人的 staging 确认不了 → 404', async () => {
    const a = await loginAs(ADMIN);
    const r = await post(a.token, { clientId: randomUUID(), text: '别人的', createdAt: Date.now() });
    const p = await loginAs(PLAIN);
    const c = await req(`/staging/${r.json.stagingId}/confirm`, {
      method: 'POST',
      headers: { ...auth(p.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId: randomUUID() }),
    });
    assert.equal(c.status, 404);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  🐛 回归：agent 的消息必须能 join 到它的 staging
// ═══════════════════════════════════════════════════════════════════
describe('对话里的核对卡挂得上（2026-08-03 回归）', () => {
  it('🔴 agent 消息带 inbox_id，否则前端永远拿不到 staging_id → 核对卡不出现', async () => {
    const { token } = await loginAs(ADMIN);
    const r = await post(token, { clientId: randomUUID(), text: '核对卡回归测试', createdAt: Date.now(), toAgent: true });

    // 手工插一条 agent 消息，模拟 loop.ts 跑完之后那一步（不依赖真的调模型）
    await sql`
      insert into thread_message (thread_id, role, text, inbox_id, meta)
      values (${r.json.threadId}, 'agent', ${'已整理，核对一下。'}, ${r.json.inboxId},
              ${sql.json({ stagingId: r.json.stagingId } as never)})`;

    const t = await req(`/threads/${r.json.threadId}`, { headers: auth(token) });
    assert.equal(t.status, 200);
    const agentMsg = t.json.messages.find((m: any) => m.role === 'agent');
    assert.ok(agentMsg, '没找到 agent 消息');
    assert.ok(
      agentMsg.staging_id,
      '🔴 staging_id 是空的 —— 那条 left join 落空了，核对卡永远不会出现',
    );
    assert.equal(agentMsg.staging_id, r.json.stagingId);
    // 界面靠 status==='ready' 决定渲不渲染卡片，这个字段也必须带回来
    assert.ok('status' in agentMsg);
  });

  it('正在跑的那一轮会通过 running 带回来（进度条的数据源）', NEEDS_TWENTY, async () => {
    const { token } = await loginAs(ADMIN);
    const r = await post(token, { clientId: randomUUID(), text: '进度回归测试', createdAt: Date.now(), toAgent: true });

    await sql`
      insert into agent_run (inbox_id, thread_id, status, stage, steps, max_steps)
      values (${r.json.inboxId}, ${r.json.threadId}, 'running', ${'查客户'}, 3, 8)`;

    const t = await req(`/threads/${r.json.threadId}`, { headers: auth(token) });
    assert.ok(t.json.running, '🔴 running 是空的 —— 界面上就只剩一个转圈');
    assert.equal(t.json.running.stage, '查客户');
    assert.equal(t.json.running.steps, 3);
    assert.equal(t.json.running.max_steps, 8);

    // 跑完之后就不该再回来了，否则界面永远转圈
    await sql`update agent_run set status = 'ok' where inbox_id = ${r.json.inboxId}`;
    const t2 = await req(`/threads/${r.json.threadId}`, { headers: auth(token) });
    assert.equal(t2.json.running, null);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  D31：速记与 agent 分开 —— 抽取是显式触发
// ═══════════════════════════════════════════════════════════════════
describe('速记不自动跑 agent（D31）', () => {
  it('🔴 纯速记：不开对话、不进 agent 队列', async () => {
    const { token } = await loginAs(ADMIN);
    const r = await post(token, { clientId: randomUUID(), text: '只是记一笔', createdAt: Date.now() });
    assert.equal(r.status, 201);
    assert.equal(r.json.toAgent, false);
    assert.equal(r.json.threadId, null, '🔴 纯速记开了一条对话 —— AI 的历史会被没人看的对话塞满');

    await new Promise((res) => setTimeout(res, 600));
    const [st] = await sql<Array<{ status: string }>>`
      select status from staging where inbox_id = ${r.json.inboxId}`;
    assert.equal(st?.status, 'pending', '🔴 没人要求就跑了 agent —— 那是白烧模型');
  });

  it('AI 那一屏发出来的（toAgent）才开对话', async () => {
    const { token } = await loginAs(ADMIN);
    const r = await post(token, {
      clientId: randomUUID(), text: '这条要 AI 整理', createdAt: Date.now(), toAgent: true,
    });
    assert.equal(r.json.toAgent, true);
    assert.ok(r.json.threadId);
  });

  it('「一键发给 AI」能把落库后的速记补送进去', async () => {
    const { token } = await loginAs(ADMIN);
    const r = await post(token, { clientId: randomUUID(), text: '事后再交给 AI', createdAt: Date.now() });
    assert.equal(r.json.threadId, null);

    const s1 = await req(`/inbox/${r.json.inboxId}/agent`, { method: 'POST', headers: auth(token) });
    assert.equal(s1.status, 200);
    assert.ok(s1.json.threadId, '补送之后应该有一条对话了');

    // 那条对话里要能看到人说的那句话，否则 agent 读 thread 是空的
    const t = await req(`/threads/${s1.json.threadId}`, { headers: auth(token) });
    assert.equal(t.json.messages.some((m: any) => m.text === '事后再交给 AI'), true);
  });

  it('补送是幂等的 —— 连按两下不会烧两次模型', async () => {
    const { token } = await loginAs(ADMIN);
    const r = await post(token, { clientId: randomUUID(), text: '连按两下', createdAt: Date.now() });
    const a = await req(`/inbox/${r.json.inboxId}/agent`, { method: 'POST', headers: auth(token) });
    const b = await req(`/inbox/${r.json.inboxId}/agent`, { method: 'POST', headers: auth(token) });
    assert.equal(a.json.threadId, b.json.threadId, '第二次又开了一条新对话');
  });

  it('别人的速记补送不了 → 404', async () => {
    const a = await loginAs(ADMIN);
    const r = await post(a.token, { clientId: randomUUID(), text: '别人的速记', createdAt: Date.now() });
    const p = await loginAs(PLAIN);
    assert.equal(
      (await req(`/inbox/${r.json.inboxId}/agent`, { method: 'POST', headers: auth(p.token) })).status,
      404,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
//  售后 vs 选型 · 附件回显 · 确认状态（2026-08-03 实测逼出来的一批）
// ═══════════════════════════════════════════════════════════════════
describe('对话里看得见附件和确认状态', () => {
  it('🔴 附件跟着消息回来 —— 不然人在对话里根本看不到自己传了什么', async () => {
    const { token } = await loginAs(ADMIN);
    const r = await post(
      token,
      { clientId: randomUUID(), text: '带一份文档', createdAt: Date.now(), toAgent: true },
      [['file', new Blob(['brand,qty\nAlpin,1\n']), '报告.csv']],
    );
    const t = await req(`/threads/${r.json.threadId}`, { headers: auth(token) });
    const withAtt = t.json.messages.find((m: any) => (m.attachments ?? []).length);
    assert.ok(withAtt, '🔴 没有一条消息带附件 —— 传上去了但对话里看不见');
    assert.equal(withAtt.attachments[0].name, '报告.csv');
    assert.ok('parsed' in withAtt.attachments[0], '要能看出它读没读开');
  });

  it('🔴 确认之后 status 和 confirm_after 都要回来 —— 卡片靠它们显示倒计时', async () => {
    const { token } = await loginAs(ADMIN);
    const list = await req('/companies', { headers: auth(token) });
    const company = list.json.items?.[0];
    if (!company) return;

    const r = await post(token, {
      clientId: randomUUID(), text: '确认状态回归', createdAt: Date.now(), toAgent: true,
    });
    await req(`/staging/${r.json.stagingId}/confirm`, {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId: company.id }),
    });

    const t = await req(`/threads/${r.json.threadId}`, { headers: auth(token) });
    const m = t.json.messages.find((x: any) => x.staging_id === r.json.stagingId);
    assert.ok(m, '找不到那条消息');
    assert.equal(m.status, 'confirming');
    assert.ok(
      m.confirm_after,
      '🔴 confirm_after 没回来 —— 倒计时只能靠组件内存 state，一次轮询重渲染就没了',
    );
    await req(`/staging/${r.json.stagingId}/confirm`, { method: 'DELETE', headers: auth(token) });
  });

  it('附件能取回原件（Twenty 没有文件上传接口，这是唯一的路径）', async () => {
    const { token } = await loginAs(ADMIN);
    const r = await post(token, { clientId: randomUUID(), text: 'x', createdAt: Date.now() }, [
      ['file', new Blob(['hello world']), '原件.txt'],
    ]);
    const [a] = await sql<Array<{ id: string }>>`
      select id from attachment where inbox_id = ${r.json.inboxId}`;
    const res = await fetch(`${BASE}/attachments/${a!.id}/file`, { headers: auth(token) });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'hello world');
    // 中文/德文文件名不做 RFC 5987 编码的话，下载下来是乱码
    assert.match(res.headers.get('content-disposition') ?? '', /filename\*=UTF-8''/);
  });

  it('别人的附件取不到 → 404', async () => {
    const a = await loginAs(ADMIN);
    const r = await post(a.token, { clientId: randomUUID(), text: 'y', createdAt: Date.now() }, [
      ['file', new Blob(['secret']), 's.txt'],
    ]);
    const [att] = await sql<Array<{ id: string }>>`
      select id from attachment where inbox_id = ${r.json.inboxId}`;
    const p = await loginAs(PLAIN);
    const res = await fetch(`${BASE}/attachments/${att!.id}/file`, { headers: auth(p.token) });
    assert.equal(res.status, 404);
  });
});

describe('售后问题 vs 选型情报（D25）', () => {
  it('recordType=support 时写的是 supportCase，不是 productFitment', async () => {
    const { token } = await loginAs(ADMIN);
    const list = await req('/companies', { headers: auth(token) });
    const company = list.json.items?.[0];
    if (!company) return;

    const r = await post(token, { clientId: randomUUID(), text: '售后分流测试', createdAt: Date.now() });
    // 直接写 staging，不依赖模型（这条测的是入库那一层的分流）
    await sql`update staging set status = 'ready', extracted = ${sql.json({
      recordType: 'support', summary: '集成测试用的售后', caseStatus: 'NEW', severity: 'LOW',
      category: 'BATTERY',
    } as never)} where id = ${r.json.stagingId}`;

    await req(`/staging/${r.json.stagingId}/confirm`, {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId: company.id }),
    });
    // 等心跳把它提交掉（延迟窗口 5 秒 + 一点余量）
    await new Promise((res) => setTimeout(res, 7000));

    const [st] = await sql<Array<{ status: string; twenty_refs: any; error: string | null }>>`
      select status, twenty_refs, error from staging where id = ${r.json.stagingId}`;
    assert.equal(st?.status, 'confirmed', `没入库成功：${st?.error}`);
    assert.ok(
      st!.twenty_refs?.supportCaseId,
      '🔴 写成了别的 —— 「记录一下这个售后问题」会落进产品选型情报里，人去售后里找是空的',
    );
    assert.equal(
      st!.twenty_refs?.productFitmentId,
      undefined,
      '同一条不该既是售后又是选型 —— 那是两条方向相反的生命周期（D25）',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
//  使用手册许诺过的东西，逐条对着 CRM 验（2026-08-03）
//
//  这一组测的不是「代码跑不跑」，是**「手册上写的那句话是不是真的」**。
//  `产品使用手册.pptx` 是给 jonas 和 lena 看的 —— 上面写了而做不到的每一句，
//  展会当天都会变成一次「说好的功能呢」。
// ═══════════════════════════════════════════════════════════════════
describe('手册 P8：哪一格不对，点「改一下」', () => {
  it('人改过的那一格进 CRM，而 extracted 里原来读出的**不变**', NEEDS_TWENTY, async () => {
    const { token } = await loginAs(ADMIN);
    const company = (await req('/companies', { headers: auth(token) })).json.items?.[0];
    if (!company) return;

    const sid = await readyStaging(token, {
      recordType: 'support',
      summary: '改一格回归',
      caseStatus: 'NEW',
      severity: 'LOW',
    });
    const { refs } = await confirmAndWait(token, sid, {
      companyId: company.id,
      fields: { caseStatus: 'WAITING_CUSTOMER', severity: 'CRITICAL' },
    });
    assert.ok(refs?.supportCaseId, '没入库');

    const sc = (await twenty(`/rest/supportCases/${refs.supportCaseId}`))?.supportCase;
    assert.equal(sc?.caseStatus, 'WAITING_CUSTOMER', '🔴 人改的那一格没进 CRM');
    assert.equal(sc?.severity, 'CRITICAL');

    // 🔴 原文与「当时读出了什么」必须原封不动 ——
    // 手册 P8 的原话是「改的只是卡片，原话一个字不动」
    const [st] = await sql<Array<{ extracted: any }>>`select extracted from staging where id = ${sid}`;
    assert.equal(st!.extracted.caseStatus, 'NEW', '🔴 改一格把 extracted 也改了 —— 那是篡改历史');
    assert.equal(st!.extracted.severity, 'LOW');
  });

  it('🔴 前端传个非法值必须 422，不能悄悄当成「没改」', NEEDS_TWENTY, async () => {
    const { token } = await loginAs(ADMIN);
    const company = (await req('/companies', { headers: auth(token) })).json.items?.[0];
    if (!company) return;
    const sid = await readyStaging(token, { recordType: 'fitment', category: 'BATTERY' });
    const r = await req(`/staging/${sid}/confirm`, {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId: company.id, fields: { stage: '我瞎编的' } }),
    });
    assert.equal(r.status, 422, `非法值被收下了：${JSON.stringify(r.json)}`);
    assert.equal(r.json.error, 'bad_field_value');
  });
});

/**
 * 回 Twenty 里核一条记录。**读不到就抛，绝不返回 null**（§2.39 · T79）。
 *
 * 🔴 这个 `throw` 比上面那个退避重试更重要。
 *
 * 原来这里写的是 `res.ok ? data : null`，于是每一个调用点都长成
 * `(await twenty(...))?.productFitment` —— 读失败和「字段是空的」**产出同一个
 * `undefined`**，而断言只能报出后者那句话：「🔴 原文丢了 —— 信息不该消失」。
 * 于是一个限流问题伪装成了一个数据问题，整整一小时。
 *
 * 抛出去之后，同一个故障会自己报出名字：
 *   `Twenty 读不到 /rest/productFitments/… → 429（重试 5 次后仍被限流）`
 *
 * ⚠️ **404 也抛。** 这十二个调用点没有一个是在「查一条可能不存在的记录」——
 *    每一个都是刚写进去、紧接着回读来核对的。那种情况下 404 是**真事故**
 *    （记录没建成），必须红得响亮，而不是变成一句「字段是空的」。
 */
const twenty = async (path: string) => {
  const res = await twentyFetch(path);
  if (!res.ok) {
    const hint = res.status === 429 ? '（重试 5 次后仍被限流，见 §2.39）' : '';
    throw new Error(
      `Twenty 读不到 ${path} → ${res.status}${hint}：${(await res.text()).slice(0, 200)}`,
    );
  }
  return ((await res.json()) as any)?.data;
};

/** 造一条 ready 的 staging，绕开模型（这些用例测的是入库那一层）。 */
const readyStaging = async (token: string, extracted: Record<string, unknown>) => {
  const r = await post(token, { clientId: randomUUID(), text: '手册验证', createdAt: Date.now() });
  await sql`update staging set status = 'ready', extracted = ${sql.json(extracted as never)}
            where id = ${r.json.stagingId}`;
  return r.json.stagingId as string;
};

/** 确认并等心跳把它写进 Twenty。返回 twenty_refs。 */
const confirmAndWait = async (token: string, stagingId: string, body: Record<string, unknown>) => {
  const r = await req(`/staging/${stagingId}/confirm`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status !== 200) return { status: r.status, json: r.json, refs: null as any };
  // 40 × 900ms = 36 秒。commit 现在要跑十几次 Twenty 往返
  // （D59 项目链 + D61 timeline + D62 完整度，外加 429 退避），
  // 并发跑测试时还要在心跳里排队 —— 原来的 12.6 秒不够了（2026-08-04 实测）。
  for (let i = 0; i < 40; i++) {
    await new Promise((res) => setTimeout(res, 900));
    const [st] = await sql<Array<{ status: string; twenty_refs: any; error: string | null }>>`
      select status, twenty_refs, error from staging where id = ${stagingId}`;
    if (st?.status === 'confirmed') return { status: 200, json: r.json, refs: st.twenty_refs };
    if (st?.status === 'ready' && st.error) throw new Error(`入库失败：${st.error}`);
  }
  throw new Error('等超时了 —— 心跳没把它提交掉');
};

// ═══════════════════════════════════════════════════════════════════
//  🐛 回归：改口跨越已入库 —— CRM 里**不许出现第二条**（issue #37 · D108）
//
//  生产实测（2026-08-11）：Movara 的逆变器 08-06 记成 PowerFlex 3000W 并入库，
//  08-11 在同一条对话里用「编辑」改成 2000W 重新入库 ——
//  **看板上两条都在**。而人的意思是「上一句作废，现在是 2000W」。
//
//  这一组就是那个场景，真写本地 Twenty、真回读：改完之后
//  **fitment 的 id 和第一轮是同一个**，而且那一家的 fitment 只有一条。
// ═══════════════════════════════════════════════════════════════════
describe('🔴 改口跨越已入库：原地改写，不是第二条（issue #37）', () => {
  it('同一条 fitment 被改写，id 不变，CRM 里没有多出来的那一条', NEEDS_TWENTY, async () => {
    const { token } = await loginAs(ADMIN);
    const company = (await req('/companies', { headers: auth(token) })).json.items?.[0];
    if (!company) return;

    // ── 第一轮：真的入库一条选型情报 ──────────────────────────────
    const first = await post(token, {
      clientId: randomUUID(),
      text: `#37 第一版 ${SUFFIX}：逆变器用 PowerFlex 3000W`,
      createdAt: Date.now(),
    });
    await sql`update staging set status = 'ready', extracted = ${sql.json({
      recordType: 'fitment',
      category: 'INVERTER',
      supplierName: 'Voltaro',
      modelName: `PowerFlex 3000W ${SUFFIX}`,
      summary: '#37 第一版',
      sourceConfidence: 'CONFIRMED',
    } as never)} where id = ${first.json.stagingId}`;
    const r1 = await confirmAndWait(token, first.json.stagingId, { companyId: company.id });
    assert.ok(r1.refs?.productFitmentId, '第一轮没建成选型情报');

    // 把它挂进一条对话（上行时不带 threadId，免得进 agent 队列）
    const t = await req('/threads', {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `#37-${SUFFIX}` }),
    });
    const threadId = t.json.id as string;
    const [msg] = await sql<Array<{ id: string }>>`
      insert into thread_message (thread_id, role, text, inbox_id)
      values (${threadId}, 'user', '第一版', ${first.json.inboxId}) returning id`;

    // ── 第二轮：改口 ────────────────────────────────────────────
    const second = await post(token, {
      clientId: randomUUID(),
      text: `#37 改口 ${SUFFIX}：说错了，是 PowerFlex 2000W`,
      createdAt: Date.now(),
      threadId,
      supersedesMessageId: msg!.id,
    });
    assert.equal(second.json.rewriting.length > 0, true, '回包没说会改写哪几条');

    await sql`update staging set status = 'ready', extracted = ${sql.json({
      recordType: 'fitment',
      category: 'INVERTER',
      supplierName: 'Voltaro',
      modelName: `PowerFlex 2000W ${SUFFIX}`,
      summary: '#37 改口',
      sourceConfidence: 'CONFIRMED',
    } as never)} where id = ${second.json.stagingId}`;
    const r2 = await confirmAndWait(token, second.json.stagingId, { companyId: company.id });

    /**
     * 🔴 **这一条就是整个 issue #37**：改口之后 CRM 里那条选型情报
     * 必须还是**同一条**（被改写），而不是旁边多出来一条。
     */
    assert.equal(
      r2.refs?.productFitmentId,
      r1.refs.productFitmentId,
      '🔴 改口又建了一条新的选型情报 —— CRM 里两版并存，issue #37 原样复发',
    );
    assert.equal(r2.refs?.visitId, r1.refs.visitId, '🔴 拜访也被重建了一条');

    // 回读 Twenty：型号真的变成了新的那个
    const pf = (await twenty(`/rest/productFitments/${r2.refs.productFitmentId}`))?.productFitment;
    assert.match(String(pf?.modelName ?? ''), /2000W/, '记录没被改写（还是老型号）');

    // 所有权真的转移了：老那一行交出 refs，状态变 superseded，审计留在 commit_history
    const [old] = await sql<Array<{ status: string; refs: any; created: any; hist: any[] }>>`
      select status, twenty_refs as refs, created_records as created, commit_history as hist
      from staging where id = ${first.json.stagingId}`;
    assert.equal(old!.status, 'superseded');
    assert.equal(old!.refs, null, '🔴 老那一行还拿着 refs —— 从看板删它会删掉现在归新那一行管的记录');
    assert.equal((old!.created ?? []).length, 0);
    assert.ok(
      old!.hist.some((h) => h.movedTo === second.json.stagingId),
      '交接没留审计 —— 三个月后没人答得出这几条记录为什么换了主人',
    );
  });

  /**
   * 🔴 **改口顺便把客户也改了**（Alpin → Rosenfeld 这种，维护者 2026-08-11
   * 拍板「这种问题，确实还必须开这一条路」）。
   *
   * update 路径**改不了客户**：`updateProductFitment` / `updateVisit` 的 patch 里
   * 根本没有 `companyId` —— 把一条记录从一家挪到另一家等于改写它的归属（D28 的闸门）。
   * 所以这条路只能是：**继承来的那几条软删掉 + 按新客户建新的**，
   * 而且软删掉的要记进老那一行的 `record_deleted_refs`（现成的撤销端点认它）。
   */
  it('改口换了客户 → 旧的软删（可撤销）+ 按新客户重建，不是原地改写', NEEDS_TWENTY, async () => {
    const { token } = await loginAs(ADMIN);
    const list = (await req('/companies', { headers: auth(token) })).json.items ?? [];
    const [a, b] = list;
    if (!a || !b) return;

    const first = await post(token, {
      clientId: randomUUID(),
      text: `#37 换客户 第一版 ${SUFFIX}`,
      createdAt: Date.now(),
    });
    await sql`update staging set status = 'ready', extracted = ${sql.json({
      recordType: 'fitment',
      category: 'BATTERY',
      supplierName: 'Voltaro',
      modelName: `换客户前 ${SUFFIX}`,
      summary: '#37 换客户 第一版',
    } as never)} where id = ${first.json.stagingId}`;
    const r1 = await confirmAndWait(token, first.json.stagingId, { companyId: a.id });
    assert.ok(r1.refs?.productFitmentId);

    const t = await req('/threads', {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `#37换客户-${SUFFIX}` }),
    });
    const [msg] = await sql<Array<{ id: string }>>`
      insert into thread_message (thread_id, role, text, inbox_id)
      values (${t.json.id}, 'user', '第一版', ${first.json.inboxId}) returning id`;

    const second = await post(token, {
      clientId: randomUUID(),
      text: `#37 换客户 改口 ${SUFFIX}：说错了，不是这家`,
      createdAt: Date.now(),
      threadId: t.json.id,
      supersedesMessageId: msg!.id,
    });
    await sql`update staging set status = 'ready', extracted = ${sql.json({
      recordType: 'fitment',
      category: 'BATTERY',
      supplierName: 'Voltaro',
      modelName: `换客户后 ${SUFFIX}`,
      summary: '#37 换客户 改口',
    } as never)} where id = ${second.json.stagingId}`;
    const r2 = await confirmAndWait(token, second.json.stagingId, { companyId: b.id });

    assert.notEqual(
      r2.refs?.productFitmentId,
      r1.refs.productFitmentId,
      '🔴 客户变了却还在原地改写 —— 那条记录会留在错的客户名下',
    );

    /**
     * 旧的那条**软删**了（GraphQL `delete{Object}`，不是 `destroy`，§2.38）。
     * ⚠️ 软删之后 REST 读它是 404，而 `twenty()` 读不到就抛（D98：绝不返回 null）——
     *    所以这里断言它**抛 404**，再用下面的撤销证明它只是软删（记录还在）。
     */
    await assert.rejects(
      () => twenty(`/rest/productFitments/${r1.refs.productFitmentId}`),
      /404/,
      '🔴 旧客户名下那条还在（没软删）',
    );

    // 删掉的原样记在老那一行上 —— 现成的「撤销看板删除」端点靠它把记录捞回来
    const [old] = await sql<Array<{ deleted_at: string | null; deleted_refs: any; status: string }>>`
      select record_deleted_at as deleted_at, record_deleted_refs as deleted_refs, status
      from staging where id = ${first.json.stagingId}`;
    assert.ok(old!.deleted_at, '没记下「这一版的记录被删了」');
    assert.ok(
      (old!.deleted_refs ?? []).some((r: any) => r.id === r1.refs.productFitmentId),
      '🔴 删掉的那几条没进 record_deleted_refs —— 撤销时找不回它们',
    );
    assert.equal(old!.status, 'superseded');

    // 撤销回得来（软删的全部意义）
    const undo = await req(`/staging/${first.json.stagingId}/record/restore`, {
      method: 'POST',
      headers: auth(token),
    });
    assert.equal(undo.status, 200, JSON.stringify(undo.json));
    const back = await twenty(`/rest/productFitments/${r1.refs.productFitmentId}`);
    assert.ok(back?.productFitment, '🔴 撤销之后旧记录没回来 —— 那就不是软删');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  🐛 回归：入库之后 CRM 里绝不能是一片空白（2026-08-03 维护者 实测）
//
//  他的原话：「最近一次的那个问题，你录入在哪里了？我这里都完全没看到」。
//  当时发生的事：名单里查不到那家客户 → 模型回了一句「暂不能提交结构化记录」
//  → `propose_fields` 一次没调 → `extracted={}` → 确认入库产出**一条空白 Visit**。
//  一份 1931 字的技术文档，在 CRM 里一个字都看不到。
// ═══════════════════════════════════════════════════════════════════
describe('🔴 CRM 里永远不会出现一条空白记录', () => {
  it('agent 什么都没抽出来（extracted={}）时，原话照样进 CRM', NEEDS_TWENTY, async () => {
    const { token } = await loginAs(ADMIN);
    const company = (await req('/companies', { headers: auth(token) })).json.items?.[0];
    if (!company) return;

    const SAID = `原话必须进 CRM ${SUFFIX}`;
    const r = await post(token, { clientId: randomUUID(), text: SAID, createdAt: Date.now() });
    // extracted 明确置空 —— 就是他遇到的那个形态
    await sql`update staging set status = 'ready', extracted = '{}'::jsonb
              where id = ${r.json.stagingId}`;

    const { refs } = await confirmAndWait(token, r.json.stagingId, { companyId: company.id });
    assert.ok(refs?.visitId, '没入库');
    const v = (await twenty(`/rest/visits/${refs.visitId}`))?.visit;
    const summary = String(v?.visitSummary ?? '');
    assert.notEqual(
      summary,
      '',
      '🔴 产出了一条空白拜访记录 —— 人在 CRM 里什么都看不到，而原话只剩在数据库里',
    );
    assert.match(summary, new RegExp(SUFFIX), '🔴 正文里没有原话');
  });

  it('只有附件、一个字都没说时，附件名也要进 CRM', NEEDS_TWENTY, async () => {
    const { token } = await loginAs(ADMIN);
    const company = (await req('/companies', { headers: auth(token) })).json.items?.[0];
    if (!company) return;

    const r = await post(
      token,
      { clientId: randomUUID(), text: null, createdAt: Date.now() },
      [['file', new Blob([new TextEncoder().encode('x')]), `只有附件-${SUFFIX}.txt`]],
    );
    await sql`update staging set status = 'ready', extracted = '{}'::jsonb
              where id = ${r.json.stagingId}`;
    const { refs } = await confirmAndWait(token, r.json.stagingId, { companyId: company.id });
    const v = (await twenty(`/rest/visits/${refs.visitId}`))?.visit;
    assert.match(
      String(v?.visitSummary ?? ''),
      new RegExp(SUFFIX),
      '🔴 传了文件、确认了，而 CRM 里一点痕迹都没有',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
//  🐛 回归：客户页 / 录入人页的 Timeline 不能是白的（D61）
//
//  维护者 2026-08-03 截图：「提交人的 timeline 这里怎么都是白的？」
//  查下来不是坏了 —— Twenty **只给记录自己写事件**（`visit.created` 挂在那条
//  Visit 上），不会在它关联到的客户、录入人、项目身上留下任何痕迹。
//  于是最该有履历的两个页面恰好一片空白。
//
//  这条测试盯的失败形态很特别：**写入全部成功、日志全绿、页面上什么都没有。**
//  只有把 target 外键读回来才看得见。
// ═══════════════════════════════════════════════════════════════════
describe('🔴 入库之后，客户和录入人的 Timeline 上要看得见这一条（D61）', () => {
  it('一条速记入库 → 客户页和录入人页各多一条 linked-visit.created', NEEDS_TWENTY, async () => {
    const { token } = await loginAs(ADMIN);
    const company = (await req('/companies', { headers: auth(token) })).json.items?.[0];
    if (!company) return;

    const sid = await readyStaging(token, {
      recordType: 'fitment',
      category: 'BATTERY',
      summary: `timeline 回归 ${SUFFIX}`,
    });
    const { refs } = await confirmAndWait(token, sid, { companyId: company.id });
    assert.ok(refs?.visitId, '没入库');

    /**
     * 🔴 **按 `linkedRecordId` 直接查我刚建的那一条，不要去数总数。**
     *
     * 这条断言原来写的是「客户的 timeline 比之前多了」，2026-08-04 连栽两次：
     *   · `?depth=1` 的嵌套关系**封顶 60 条**，那家客户实际有 131 条 → 60 vs 60
     *   · 换成 `?limit=200` 之后又变成 200 vs 200
     * 数一个只增不减的集合，早晚会撞上某个上限，而**产品完全正常**。
     * 判据：**断言你刚刚造出来的那一条，不要断言总量。**
     */
    const mine = ((await twenty(
      `/rest/timelineActivities?limit=10&filter=${encodeURIComponent(`linkedRecordId[eq]:${refs.visitId}`)}`,
    ))?.timelineActivities ?? []) as any[];

    assert.ok(mine.length > 0, '🔴 入库了，但没在任何人的 Timeline 上留痕');
    const ev = mine[0];
    assert.equal(
      ev?.name,
      'linked-visit.created',
      '🔴 名字前缀不是 linked- —— Twenty 前端反查不到对象元数据，那个可点的 chip 渲染不出来',
    );
    assert.ok(
      ev?.linkedObjectMetadataId,
      '🔴 少了 linkedObjectMetadataId —— 前端的 isDefined 判据为假，整行不渲染',
    );
    assert.equal(
      ev?.targetCompanyId,
      company.id,
      '🔴 事件没挂到客户身上 —— 客户页翻不出这家的履历',
    );
    assert.ok(
      ev?.targetContributorId,
      '🔴 事件没挂到录入人身上 —— 「这个人记了什么」还是白的（他截图问的就是这个）',
    );
  });
});

describe('手册 P25：A/B 场景那五个字段真的进 CRM 了（T39）', () => {
  /**
   * ⚠️ **这一条偶发地红，单独跑必绿。** 别追 —— 已经查过了。
   *
   * `node --test` 会并发跑各个 describe，而 D56 规定「同一家 + 同一品类 = 同一条商机」。
   * 好几条用例都拿 `/companies` 的**第一家**做被试，于是两条并发的用例
   * 可能落在同一家客户上，后一条把前一条刚拿到的那条商机改掉或替掉。
   *
   * 不修的理由：修法要么给每条用例配一家专属客户（那就等于每跑一次多几家假客户，
   * 正是 §2.19④ 那个「屎山」），要么串行跑整个文件（一轮从 90 秒变几分钟）。
   * 两个代价都比这条偶发大。**在 CI 里它是 skip 的**（没有 Twenty），所以不会挡住 push。
   */
  it('在位品牌 · 阶段 · 决策窗口 都有落点', NEEDS_TWENTY, async () => {
    const { token } = await loginAs(ADMIN);
    const company = (await req('/companies', { headers: auth(token) })).json.items?.[0];
    if (!company) return;

    const sid = await readyStaging(token, {
      recordType: 'fitment',
      category: 'INVERTER',
      supplierName: 'Voltaro',
      modelName: 'PowerFlex-II',
      stage: 'CONTACTED',
      decisionWindow: '2026 Q4 前定供应商',
      summary: 'T39 回归',
      sourceConfidence: 'CONFIRMED',
      // D59 给商机加的四个字段，一直没被写过（issue #4）
      demandQuantity: '年需求量 20,000 台',
      demandBreakdown: '100Ah 约 30%、150Ah 约 70%',
      targetPrice: '约 EUR 500/台',
      ownerTeam: '欧洲 OE 销售团队',
    });
    const { refs } = await confirmAndWait(token, sid, { companyId: company.id });
    assert.ok(refs?.productFitmentId, '没建选型情报');

    const pf = (await twenty(`/rest/productFitments/${refs.productFitmentId}?depth=1`))
      ?.productFitment;
    assert.equal(pf?.confidence, 'CONFIRMED', '🔴 可信度还是写死的 —— 传闻降不下来（手册 P18）');

    // 阶段挂 Opportunity（D24），不挂在选型情报上
    assert.ok(refs?.opportunityId, '🔴 有 stage 却没有项目 —— 阶段无处落脚，机会地图排不出来');
    const opp = (await twenty(`/rest/opportunities/${refs.opportunityId}`))?.opportunity;
    assert.equal(opp?.stage, 'CONTACTED');
    assert.equal(opp?.category, 'INVERTER');
    assert.equal(
      opp?.nextDecisionWindow?.slice(0, 10),
      '2026-12-31',
      '🔴 「2026 Q4」没转成日期 —— 按决策窗口排的视图会是空的',
    );

    /**
     * 🐛 回归 issue #4：D59 加了四个字段，**四个都没接到 confirm.ts 上**。
     * 抽到了、核对卡摘要里显示了、CRM 里是空的 —— 和把信息丢弃没有区别。
     * 这一组断言的意义是：以后再加字段，漏接会当场红。
     */
    assert.equal(opp?.ownerTeam, '欧洲 OE 销售团队', '🔴 负责团队没写进 CRM（issue #4）');
    assert.match(String(opp?.annualDemand ?? ''), /20,000/, '🔴 年需求量没写进 CRM');
    assert.match(String(opp?.demandBreakdown ?? ''), /30%/, '🔴 需求占比没写进 CRM');
    assert.match(String(opp?.targetPrice ?? ''), /500/, '🔴 价格接受度没写进 CRM');
  });

  it('🔴 同一家同一品类推的是**同一条**项目（D56），不是又开一条', NEEDS_TWENTY, async () => {
    const { token } = await loginAs(ADMIN);
    const company = (await req('/companies', { headers: auth(token) })).json.items?.[0];
    if (!company) return;

    const first = await confirmAndWait(
      token,
      await readyStaging(token, { recordType: 'fitment', category: 'SOLAR_PANEL', stage: 'CONTACTED' }),
      { companyId: company.id },
    );
    const second = await confirmAndWait(
      token,
      await readyStaging(token, { recordType: 'fitment', category: 'SOLAR_PANEL', stage: 'RFQ_QUOTE' }),
      { companyId: company.id },
    );
    assert.ok(first.refs?.opportunityId && second.refs?.opportunityId);
    assert.equal(
      second.refs.opportunityId,
      first.refs.opportunityId,
      '🔴 每次新建的话「阶段」就没有意义了 —— 一家客户会有一串阶段各异的同品类项目',
    );
    assert.equal(second.refs.opportunityWas, 'CONTACTED', '没留下「从哪一格推过来的」');

    const opp = (await twenty(`/rest/opportunities/${second.refs.opportunityId}`))?.opportunity;
    assert.equal(opp?.stage, 'RFQ_QUOTE', '阶段没推上去');
  });

  it('在位品牌对不上受控名单时**说出来**，绝不新建 supplier（D23a）', NEEDS_TWENTY, async () => {
    const { token } = await loginAs(ADMIN);
    const company = (await req('/companies', { headers: auth(token) })).json.items?.[0];
    if (!company) return;
    const bogus = `不存在的牌子-${SUFFIX}`;

    const before = (await twenty('/rest/suppliers?limit=200'))?.suppliers?.length ?? 0;
    const sid = await readyStaging(token, {
      recordType: 'fitment',
      category: 'BATTERY',
      supplierName: bogus,
    });

    // 核对卡靠这个字段提示人（否则就是「安静的失败」：卡片上写着品牌、CRM 里是空的）
    const t = await req(
      `/staging/${sid}/targets?companyId=${company.id}&supplierName=${encodeURIComponent(bogus)}`,
      { headers: auth(token) },
    );
    assert.equal(t.json.supplierUnmatched, bogus, '🔴 对不上却不提示 —— 人会以为它进去了');

    const { refs } = await confirmAndWait(token, sid, { companyId: company.id });
    const pf = (await twenty(`/rest/productFitments/${refs.productFitmentId}?depth=1`))
      ?.productFitment;
    assert.equal(pf?.supplier ?? null, null, '品牌字段该是空的');
    assert.match(String(pf?.sourceNote ?? ''), new RegExp(bogus), '🔴 原文丢了 —— 信息不该消失');

    const after = (await twenty('/rest/suppliers?limit=200'))?.suppliers?.length ?? 0;
    assert.equal(after, before, '🔴 自动新建了 supplier —— D23a 破了，聚合会永久失效');
  });
});

describe('手册 P23：三天后的进展接在同一条售后上', () => {
  it('人点了「接在这条上」→ 追加，不新建；前一次的内容还在', NEEDS_TWENTY, async () => {
    const { token } = await loginAs(ADMIN);
    const company = (await req('/companies', { headers: auth(token) })).json.items?.[0];
    if (!company) return;

    const first = await confirmAndWait(
      token,
      await readyStaging(token, {
        recordType: 'support',
        summary: `P23 回归 ${SUFFIX}`,
        caseStatus: 'NEW',
        severity: 'HIGH',
        details: '第一次报的：一带空调就断，报 E-04。',
        deliveryBatch: '2025-03 批次',
        affectedUnits: 7,
      }),
      { companyId: company.id },
    );
    assert.ok(first.refs?.supportCaseId);

    // 手册 P22「台数留给你填」+ P25 脚注承认过的两格，现在是真字段了
    const sc0 = (await twenty(`/rest/supportCases/${first.refs.supportCaseId}`))?.supportCase;
    assert.equal(sc0?.deliveryBatch, '2025-03 批次');
    assert.equal(sc0?.affectedUnits, 7);

    const second = await confirmAndWait(
      token,
      await readyStaging(token, {
        recordType: 'support',
        summary: '三天后有进展',
        caseStatus: 'IN_PROGRESS',
        severity: 'HIGH',
        details: '换了固件，复现率下降。',
      }),
      { companyId: company.id, supportCaseId: first.refs.supportCaseId },
    );
    assert.equal(second.refs?.supportCaseId, first.refs.supportCaseId, '🔴 又建了一条');
    assert.equal(second.refs?.supportCaseAppended, 'yes');

    const sc = (await twenty(`/rest/supportCases/${first.refs.supportCaseId}`))?.supportCase;
    const md = String(sc?.issueDescription?.markdown ?? '');
    assert.match(md, /### 进展/, '进展没接上去');
    assert.match(md, /E-04/, '🔴 前一次的内容被覆盖了 —— 售后记录一半的价值在时间线上');
    assert.equal(sc?.caseStatus, 'IN_PROGRESS', '状态没往前走');
    assert.ok(sc?.firstResponseAt, '首次响应时间没补上');
  });

  it('targets 列出这家没关掉的售后，让人自己点（D57）', NEEDS_TWENTY, async () => {
    const { token } = await loginAs(ADMIN);
    const company = (await req('/companies', { headers: auth(token) })).json.items?.[0];
    if (!company) return;
    const sid = await readyStaging(token, { recordType: 'support', summary: 'targets 回归' });
    const t = await req(`/staging/${sid}/targets?companyId=${company.id}`, { headers: auth(token) });
    assert.equal(t.status, 200);
    assert.ok(Array.isArray(t.json.openCases));
    // 上一条用例刚建过一条 HIGH 的，这里至少能看见它
    assert.ok(
      t.json.openCases.some((c: any) => String(c.name).includes(SUFFIX)),
      '🔴 没关掉的售后没列出来 —— 人就只能每次新开一条',
    );
    assert.ok(t.json.openCases.every((c: any) => c.statusLabel), '状态没给中文，人看到的是 NEW');
  });

  it('🔴 已解决 / 已关闭的不在候选里 —— 那些是结束了的', NEEDS_TWENTY, async () => {
    const { token } = await loginAs(ADMIN);
    const company = (await req('/companies', { headers: auth(token) })).json.items?.[0];
    if (!company) return;
    const closed = await confirmAndWait(
      token,
      await readyStaging(token, {
        recordType: 'support',
        summary: `已关的 ${SUFFIX}`,
        caseStatus: 'CLOSED',
      }),
      { companyId: company.id },
    );
    const sid = await readyStaging(token, { recordType: 'support', summary: 'x' });
    const t = await req(`/staging/${sid}/targets?companyId=${company.id}`, { headers: auth(token) });
    assert.equal(
      t.json.openCases.some((c: any) => c.id === closed.refs?.supportCaseId),
      false,
      '关掉的又冒出来了 —— 人会把新问题接到一个已经结案的记录上',
    );
  });
});

/**
 * 界面语言（D83）—— `app_user.locale` 唯一的写入口。
 *
 * 这一组盯的是三件容易只做一半的事：
 *   ① 真落库（不是只在这次响应里变一下）
 *   ② `/enums` 跟着变（不然核对卡上是半中半英）
 *   ③ 认不出来的值一律挡掉（这个值会被拼进 agent 的 prompt）
 */
describe('界面语言（D83）：PATCH /me', () => {
  const setLocale = async (token: string, locale: unknown) =>
    req('/me', {
      method: 'PATCH',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale }),
    });

  after(async () => {
    // 别把测试账号留在英文上 —— 后面的用例读 /enums 时会莫名其妙
    const { token } = await loginAs(PLAIN);
    await setLocale(token, 'zh');
  });

  it('改成 en → 200，而且**真的落库**（重新 GET /me 还是 en）', async () => {
    const { token } = await loginAs(PLAIN);
    const w = await setLocale(token, 'en');
    assert.equal(w.status, 200, JSON.stringify(w.json));
    assert.equal(w.json.user.locale, 'en');

    const r = await req('/me', { headers: auth(token) });
    assert.equal(r.json.user.locale, 'en', '🔴 只有响应变了，库里没写 —— 换台设备就打回中文');
  });

  it('🔴 语言一变，/enums 的标签跟着变 —— 否则核对卡上半中半英', async () => {
    const { token } = await loginAs(PLAIN);
    await setLocale(token, 'zh');
    const zh = await req('/enums', { headers: auth(token) });
    await setLocale(token, 'en');
    const en = await req('/enums', { headers: auth(token) });

    assert.equal(zh.json.locale, 'zh');
    assert.equal(en.json.locale, 'en');
    const label = (r: any, v: string) => r.json.stage.find((o: any) => o.value === v)?.label;
    assert.ok(label(zh, 'NOT_CONTACTED'), 'stage 里没有 NOT_CONTACTED');
    assert.notEqual(
      label(en, 'NOT_CONTACTED'),
      label(zh, 'NOT_CONTACTED'),
      '🔴 语言改了但标签没跟着换 —— 界面语言和内容语言分了叉',
    );
  });

  it('🔴 认不出来的值一律 400 —— 它会被拼进 agent 的 prompt，让模型自己发挥', async () => {
    const { token } = await loginAs(PLAIN);
    for (const bad of ['de', 'ZH', 'zh-CN', '', null, 1, undefined]) {
      const r = await setLocale(token, bad);
      assert.equal(r.status, 400, `🔴 ${JSON.stringify(bad)} 被放行了`);
    }
  });

  it('没 token → 401（和其余写接口一样）', async () => {
    const r = await req('/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: 'en' }),
    });
    assert.equal(r.status, 401);
  });

  it('🔴 改语言不动 token_version —— 换个语言不该把自己踢下线', async () => {
    const { token } = await loginAs(PLAIN);
    assert.equal((await setLocale(token, 'en')).status, 200);
    assert.equal(
      (await setLocale(token, 'zh')).status,
      200,
      '🔴 第二次就 401 了 —— 说明第一次把自己的 token 作废了',
    );
    assert.equal((await req('/me', { headers: auth(token) })).status, 200);
  });

  it('🔴 只能改自己的 —— 端点上没有别人的位置', async () => {
    const { token } = await loginAs(PLAIN);
    const admin = await loginAs(ADMIN);
    // 就算把别人的代号塞进 body，改的也只能是自己
    const w = await req('/me', {
      method: 'PATCH',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: 'en', userCode: ADMIN.code }),
    });
    assert.equal(w.status, 200);
    assert.equal(w.json.user.userCode, PLAIN.code);
    const a = await req('/me', { headers: auth(admin.token) });
    assert.equal(a.json.user.locale, 'zh', '🔴 别人的语言被改掉了');
  });
});

describe('手册 P8 的枚举中文：/enums 与白名单同源', () => {
  it('每个枚举值都有人话标签 —— 界面上不该出现 SAMPLE_TESTING', async () => {
    const { token } = await loginAs(ADMIN);
    const r = await req('/enums', { headers: auth(token) });
    assert.equal(r.status, 200);
    /**
     * 标签和值相同是**允许的，但必须在这张表里**。
     *
     * `SOP` 是行业术语，德国人和中国人都说 SOP，翻译反而看不懂 ——
     * `twenty-schema.mjs` 里写的也是 `yn('sop','SOP')`。
     * 但「允许相同」不能是默认行为：缺标签时代码会 fallback 到值本身，
     * 于是漏掉一个标签和「这个值本来就不翻译」长得一模一样。
     * 想加新的例外就往这里加一行 —— 那一下是有意识的。
     */
    const SAME_ON_PURPOSE = new Set(['SOP']);
    for (const key of ['recordType', 'category', 'stage', 'caseStatus', 'severity', 'confidence']) {
      const list = r.json[key];
      assert.ok(Array.isArray(list) && list.length, `${key} 是空的`);
      for (const o of list) {
        assert.ok(o.value && o.label, `${key} 里有项缺 value/label`);
        if (SAME_ON_PURPOSE.has(o.value)) continue;
        assert.notEqual(o.label, o.value, `🔴 ${key}.${o.value} 没有人话标签`);
      }
    }
  });

  /**
   * 🔴 **2026-08-07（D78）之后这条比的是「中文那一半」，不再是整串。**
   *
   * `twenty-schema.mjs` 的标签改成了双语 `"English 中文"`（Twenty 的元数据里
   * 一个 label 只能有一个值，没有 translations 那种东西 —— 实测过）。
   * 而手机上没必要显示两遍，所以 `enums.ts` 仍然只有中文。
   *
   * 于是约定从「逐字一致」收窄成「**中文那一半逐字一致**」：
   * 手机上选的是「样品/台架测试」，CRM 里那一格写的是「Sample Testing 样品/台架测试」——
   * 人一眼就能认出是同一个。而如果哪天有人只改一边的中文，这条还是会红。
   *
   * ⚠️ 英文那一半目前**没有第二处副本**（只存在于 schema 里），所以没什么可对的。
   * PWA 出英文版时（T57）`enums.ts` 会同时持有中英两份，那时这条测试要扩成对两半。
   */
  it('🔴 标签的中文部分必须和 twenty-schema.mjs 逐字一致 —— 否则手机和 CRM 显示不同的词', async () => {
    const { token } = await loginAs(ADMIN);
    const r = await req('/enums', { headers: auth(token) });
    // 直接 import 那个 .mjs —— 它是 Twenty 侧 schema 的真相源，没有类型声明，
    // 所以这里显式 any。**这条测试的全部意义就是不信任任何一边的副本。**
    const schema = (await import('../../../../scripts/twenty-schema.mjs' as string)) as any;

    /**
     * 判据：**网关的标签必须是 schema 标签的后缀。**
     *
     * schema 只是在前面多了英文 —— `"Sample Testing 样品/台架测试"` 之于 `"样品/台架测试"`。
     * 完全相等也算（`"SOP"`，以及 `"RFQ / 报价"` 这种本来就混着英文、
     * D78 那轮没再动它的）。
     *
     * ⚠️ 一开始我写的是「按第一个中文字切开再比」——
     * 那在**本来就混着英文**的标签上当场失效：`"RFQ / 报价"` 被切成 `"报价"`。
     * 后缀这条规则不需要知道哪部分是哪种语言，所以不会有这个问题。
     */
    const pairs: Array<[string, Array<{ value: string; label: string }>]> = [
      ['stage', schema.OPPORTUNITY_STAGES],
      ['category', schema.PRODUCT_CATEGORIES],
    ];
    for (const [key, theirs] of pairs) {
      // twenty-schema 里写的是 camelCase，Twenty 会规范成 UPPER_SNAKE
      const upper = (v: string) => v.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
      const mine = new Map(r.json[key].map((o: any) => [o.value, o.label]));
      for (const t of theirs) {
        const ours = String(mine.get(upper(t.value)) ?? '');
        assert.ok(
          ours && t.label.endsWith(ours),
          `🔴 ${key}.${t.value}：网关说「${ours}」，而 schema 说「${t.label}」—— ` +
            '前者必须是后者的后缀（schema 只多一段英文前缀）',
        );
      }
    }
  });
});

describe('手册 P19：情报页看得见已填的值，传闻带标', () => {
  it('/gaps 把已知的也返回，并标出哪些是传闻', async () => {
    const { token } = await loginAs(ADMIN);
    const company = (await req('/companies', { headers: auth(token) })).json.items?.[0];
    if (!company) return;
    const r = await req(`/gaps/${company.code}`, { headers: auth(token) });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.known), '🔴 只回「还缺什么」—— 传闻那条带不了标');
    for (const k of r.json.known) {
      assert.equal(typeof k.isRumor, 'boolean');
      assert.ok('sourceName' in k, '缺「听谁说的」—— 手册 P18 要求留痕');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
//  渠道链（D54）：distributor → dealer → end-user
// ═══════════════════════════════════════════════════════════════════
describe('渠道链 —— 客户的客户的客户', () => {
  /** 这几家是这一轮建出来的，测完停在 Twenty 里（Twenty 不删记录，和 inbox 同理）。 */
  const made: Array<{ id: string; role: string; name: string }> = [];

  it('resolve：名单里没有的照实说没有，并给出候选', NEEDS_TWENTY, async () => {
    const { token } = await loginAs(ADMIN);
    const r = await req('/chain/resolve', {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain: [
          { name: `ZZ 分销 ${SUFFIX}`, role: 'DISTRIBUTOR' },
          { name: `ZZ 经销 ${SUFFIX}`, role: 'DEALER' },
          { name: `ZZ 终端 ${SUFFIX}`, role: 'END_USER' },
        ],
      }),
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.levels.length, 3);
    for (const l of r.json.levels) {
      assert.equal(l.matched, null, `🔴 ${l.name} 不该匹配到任何人 —— 名字里带随机后缀`);
      assert.ok(Array.isArray(l.candidates), '没给候选的话人只能干瞪眼');
    }
  });

  it('link：建出来的链在 Twenty 里 soldVia 真的挂上了', NEEDS_TWENTY, async () => {
    const { token } = await loginAs(ADMIN);
    const roles = ['DISTRIBUTOR', 'DEALER', 'END_USER'] as const;
    for (const role of roles) {
      const c = await req('/companies', {
        method: 'POST',
        headers: { ...auth(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `ZZ ${role} ${SUFFIX}`,
          country: 'Germany',
          accountType: role,
          confirmedUnique: true,
        }),
      });
      assert.equal(c.status, 201, `建 ${role} 失败：${JSON.stringify(c.json)}`);
      made.push({ id: c.json.id, role, name: c.json.name });
      createdCompanies.push(c.json.id); // 跑完 after() 会删掉
    }

    const lk = await req('/chain/link', {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ levels: made.map((m) => ({ companyId: m.id })) }),
    });
    assert.equal(lk.status, 200, JSON.stringify(lk.json));
    assert.equal(lk.json.linked, 2, '三级链应该建两条边');

    // 🔴 去 Twenty 里核 —— 不是核我们自己的返回值。
    // `soldVia` 和 `parentCompany` 是两根不同的轴（D19 vs D54），
    // 写错字段名两棵树会一起烂掉，而返回值 200 是看不出来的。
    for (let i = 1; i < made.length; i++) {
      // ⚠️ 走 `twenty()` 而不是裸 fetch —— 它带 429 退避且读不到会抛（§2.39）。
      //    这两条断言正是被限流打红最多的那一对：裸 fetch 连 res.ok 都没看，
      //    429 的报文被 `?.data?.company` 一路吞成 undefined。
      const c = (await twenty(`/rest/companies/${made[i]!.id}?depth=1`))?.company;
      assert.equal(
        c?.soldVia?.id,
        made[i - 1]!.id,
        `🔴 ${made[i]!.role} 的上游没挂上 —— 「这家经销商下面有几个终端客户」会永远算错`,
      );
      assert.equal(
        c?.parentCompany?.id ?? null,
        null,
        '🔴 渠道链写进了集团树 —— 集团归属会被渠道关系污染',
      );
    }
  });

  it('🔴 顺序反了必须拒绝，而且一条边都不能建', NEEDS_TWENTY, async () => {
    const { token } = await loginAs(ADMIN);
    if (made.length < 3) return;
    const bad = await req('/chain/link', {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ levels: [...made].reverse().map((m) => ({ companyId: m.id })) }),
    });
    assert.equal(bad.status, 422, `反着来的链被接受了：${JSON.stringify(bad.json)}`);
    assert.equal(bad.json.error, 'bad_order');

    // 拒绝之后原来的链必须原封不动 —— 半截写入比不写更糟
    const c = (await twenty(`/rest/companies/${made[2]!.id}?depth=1`))?.company;
    assert.equal(c?.soldVia?.id, made[1]!.id, '🔴 422 之前已经改了一部分 —— 校验必须在写入之前');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  🐛 回归：正文里同一句客户链不能出现三遍（2026-08-03 实测）
// ═══════════════════════════════════════════════════════════════════
describe('入库正文不重复拼客户链', () => {
  it('details 里已经写了客户链，就不再补一遍', NEEDS_TWENTY, async () => {
    const { token } = await loginAs(ADMIN);
    const company = (await req('/companies', { headers: auth(token) })).json.items?.[0];
    if (!company) return;

    const CHAIN = 'A 分销 → B 经销 → C 终端';
    const r = await post(token, { clientId: randomUUID(), text: '客户链去重', createdAt: Date.now() });
    await sql`update staging set status = 'ready', extracted = ${sql.json({
      recordType: 'support',
      summary: '去重测试',
      caseStatus: 'NEW',
      severity: 'LOW',
      customerChain: CHAIN,
      details: `## 客户链\n${CHAIN}\n\n## 现象\n没有现象，这是测试。`,
    } as never)} where id = ${r.json.stagingId}`;

    await req(`/staging/${r.json.stagingId}/confirm`, {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId: company.id }),
    });
    await new Promise((res) => setTimeout(res, 7000));

    const [st] = await sql<Array<{ twenty_refs: any; error: string | null }>>`
      select twenty_refs, error from staging where id = ${r.json.stagingId}`;
    const caseId = st?.twenty_refs?.supportCaseId;
    assert.ok(caseId, `没入库：${st?.error}`);

    const md: string =
      (await twenty(`/rest/supportCases/${caseId}`))?.supportCase?.issueDescription?.markdown ?? '';
    const times = md.split(CHAIN).length - 1;
    assert.equal(times, 1, `🔴 客户链在正文里出现了 ${times} 遍 —— 人会以为记重了`);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  🐛 回归：我们的枚举必须是 Twenty 真实选项的子集
// ═══════════════════════════════════════════════════════════════════
describe('枚举白名单和 Twenty 对得上（2026-08-03 回归）', () => {
  it('🔴 accountType 的每一个值 Twenty 都认', NEEDS_TWENTY, async () => {
    const { token } = await loginAs(ADMIN);
    // 拿 Twenty 的真实选项 —— 不是拿我们自己那份去对我们自己那份
    const res = await twentyFetch('/rest/metadata/objects');
    /**
     * ⚠️ **限流不能当成「Twenty 没跑」**（§2.39）。
     *
     * 这里原来是一句光秃秃的 `if (!res.ok) return`，于是撞上 429 时这条用例
     * **静默变绿** —— 而它守的是「我们的枚举白名单和 Twenty 认的对不对得上」，
     * 对不上的后果是入库时整片 422。一条会假装通过的守卫比没有守卫更糟。
     */
    if (res.status === 429) {
      assert.fail('被 Twenty 限流，这条枚举对账没跑成 —— 不当成通过（见 §2.39）');
    }
    if (!res.ok) return; // Twenty 真没跑就跳过，别把这条变成噪声
    const j = (await res.json()) as any;
    const company = (j?.data?.objects ?? j?.data ?? []).find((o: any) => o.nameSingular === 'company');
    const real: string[] = (company?.fields ?? [])
      .find((f: any) => f.name === 'accountType')
      ?.options?.map((o: any) => o.value) ?? [];
    if (!real.length) return;

    const ours = (await req('/companies', { headers: auth(token) })).json.accountTypes as string[];
    const bogus = ours.filter((t) => !real.includes(t));
    assert.deepEqual(
      bogus,
      [],
      `🔴 这些值 Twenty 根本不认：${bogus.join(', ')}。\n` +
        `   界面上选得到、一提交就 500 —— 人会以为是自己填错了。\n` +
        `   Twenty 实际支持：${real.join(', ')}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
//  手动叫停 agent（D89 · issue #22）
//
//  维护者：「跑起来的 agent 必须能手动叫停。这是其他 agent / chatbot 的基础配置。」
//  在这之前从前端到后端一条中止路径都没有 —— 发出去只能等它跑完或撞上限
//  （8 步 / 120 秒，带附件再 +6 步 +60 秒），最坏干等三分钟。
//
//  ⚠️ 这里**不测「真的把一轮跑到一半停掉」** —— 那要精确卡在模型往返中间，
//     在集成层是必然抖的。那一件由 `agent/src/__tests__/abort.test.ts` 用 faux
//     模型确定性地测（stopReason=aborted · 不发请求 · trace 保留）。
//     这一档只守端点自己那三件：**作用域、鉴权、和「没停成要如实说」**。
// ═══════════════════════════════════════════════════════════════════
describe('叫停端点 POST /threads/:id/abort（D89）', () => {
  it('没 token → 401', async () => {
    const r = await req(`/threads/${randomUUID()}/abort`, { method: 'POST' });
    assert.equal(r.status, 401);
  });

  it('🔴 别人的对话 → 404（和 GET /threads/:id 一致，不确认它存在）', async () => {
    const a = await loginAs(ADMIN);
    const t = await req('/threads', {
      method: 'POST',
      headers: { ...auth(a.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `别人的 ${SUFFIX}` }),
    });
    const p = await loginAs(PLAIN);
    const r = await req(`/threads/${t.json.id}/abort`, { method: 'POST', headers: auth(p.token) });
    assert.equal(r.status, 404, '🔴 能停别人的对话 —— 作用域漏了（D76①）');
  });

  it('不存在的对话 → 404', async () => {
    const { token } = await loginAs(ADMIN);
    const r = await req(`/threads/${randomUUID()}/abort`, { method: 'POST', headers: auth(token) });
    assert.equal(r.status, 404);
  });

  it('🔴 没有在跑的那一轮 → 200 且 stopped=0（不许假装停成了）', async () => {
    const { token } = await loginAs(ADMIN);
    const t = await req('/threads', {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `空对话 ${SUFFIX}` }),
    });
    const r = await req(`/threads/${t.json.id}/abort`, { method: 'POST', headers: auth(token) });
    assert.equal(r.status, 200);
    assert.equal(
      r.json.stopped,
      0,
      '🔴 什么都没停却回了个非 0 —— 界面会显示「已停止」而它还在跑',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
//  消息编辑与重发（D90 · issue #23）
//
//  🔴 这一档存在的全部理由是 issue 里那两条硬约束：
//     ② 编辑**不能**改写 inbox / thread_message 原来那行（§4.2 第 2 条）
//     ③ 重发时上一轮的 staging 要标 superseded，不能留两份都是「有效」的
//        —— 两张都能按的核对卡 = CRM 里两份记录（拜访/选型情报/售后没有自然键）
// ═══════════════════════════════════════════════════════════════════
describe('消息编辑与重发（D90 · issue #23）', () => {
  /** 等这条 staging 走到一个稳定态。agent 关着时是瞬间的；开着时最多等 100 秒。 */
  const settle = async (stagingId: string) => {
    for (let i = 0; i < 100; i++) {
      const [st] = await sql<Array<{ status: string }>>`
        select status from staging where id = ${stagingId}`;
      if (st && ['ready', 'failed', 'superseded', 'confirmed'].includes(st.status)) return st.status;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('这条 staging 一直没落定 —— agent 卡住了？');
  };

  /** 建一条对话，发第一句，等它落定。返回对话、第一条消息、第一条 staging。 */
  const firstRound = async (token: string, text: string) => {
    const t = await req('/threads', {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: text.slice(0, 20) }),
    });
    const threadId = t.json.id as string;
    const r1 = await post(token, {
      clientId: randomUUID(),
      text,
      createdAt: Date.now(),
      threadId,
    });
    await settle(r1.json.stagingId);
    const g = await req(`/threads/${threadId}`, { headers: auth(token) });
    const msg = (g.json.messages as any[]).find((m) => m.role === 'user' && m.text === text);
    assert.ok(msg, '第一句没进对话');
    return { threadId, messageId: msg.id as string, stagingId: r1.json.stagingId as string };
  };

  it('🔴 改口重发**不改写**原来那行 —— 老消息一个字没动，新的是新一行', async () => {
    const { token } = await loginAs(ADMIN);
    const SAID = `原话说错了 ${SUFFIX}`;
    const { threadId, messageId } = await firstRound(token, SAID);

    const FIXED = `改过之后的话 ${SUFFIX}`;
    const r2 = await post(token, {
      clientId: randomUUID(),
      text: FIXED,
      createdAt: Date.now(),
      threadId,
      supersedesMessageId: messageId,
    });
    assert.equal(r2.status, 201);
    assert.equal(r2.json.supersedeFailed, false);
    assert.ok((r2.json.superseded ?? 0) >= 1, '一条都没取代 —— 那这次改口等于没发生');

    // ① 原来那行**一个字没动**（§4.2 第 2 条）
    const [old] = await sql<Array<{ text: string }>>`
      select text from thread_message where id = ${messageId}`;
    assert.equal(old?.text, SAID, '🔴 老消息被改写了 —— thread_message 只增不改');

    // ② 新的是**新一行**，两条同时在库里
    const [cnt] = await sql<Array<{ n: number }>>`
      select count(*)::int as n from thread_message
      where thread_id = ${threadId} and role = 'user'`;
    assert.ok((cnt?.n ?? 0) >= 2, '新那句没变成新一行');

    // ③ 取代关系记在派生表上，reason 分得出「主动改的」和「连带的」
    const [rel] = await sql<Array<{ reason: string; superseded_by: string }>>`
      select reason, superseded_by from message_supersede where message_id = ${messageId}`;
    assert.equal(rel?.reason, 'edited');

    // ④ 界面拿得到 —— 取代 ≠ 删除，那条照样返回，只是带着 superseded_by
    const g = await req(`/threads/${threadId}`, { headers: auth(token) });
    const shown = (g.json.messages as any[]).find((m) => m.id === messageId);
    assert.ok(shown, '🔴 被取代的那条从接口里消失了 —— 「看不见」和「不存在」必须分得开');
    assert.equal(shown.text, SAID);
    assert.ok(shown.superseded_by, '🔴 界面无从知道这条已经被改口取代了');
  });

  it('🔴 重发时上一轮的 staging 一起标 superseded —— 不留两份都有效的', async () => {
    const { token } = await loginAs(ADMIN);
    const { threadId, messageId, stagingId } = await firstRound(token, `上一轮 ${SUFFIX}`);

    await post(token, {
      clientId: randomUUID(),
      text: `这一轮 ${SUFFIX}`,
      createdAt: Date.now(),
      threadId,
      supersedesMessageId: messageId,
    });

    const [st] = await sql<Array<{ status: string; superseded_by: string | null }>>`
      select status, superseded_by from staging where id = ${stagingId}`;
    assert.equal(
      st?.status,
      'superseded',
      '🔴 上一轮还是活的 —— 同一条对话会有两张都能按的核对卡，两张都按就是 CRM 里两份记录',
    );
    assert.ok(st?.superseded_by, '被谁取代的要留下来 —— 下次有人怀疑数据丢了，这一列就是答案');
  });

  it('🔴 已经入库的那一版不许被这次改口动掉（同 issue #14 的边界）', async () => {
    const { token } = await loginAs(ADMIN);
    const { threadId, messageId, stagingId } = await firstRound(token, `已入库的 ${SUFFIX}`);
    // 直接摆成 confirmed —— 这一条测的是边界，不需要真跑一次入库
    await sql`update staging set status = 'confirmed' where id = ${stagingId}`;

    await post(token, {
      clientId: randomUUID(),
      text: `改口 ${SUFFIX}`,
      createdAt: Date.now(),
      threadId,
      supersedesMessageId: messageId,
    });

    const [st] = await sql<Array<{ status: string }>>`
      select status from staging where id = ${stagingId}`;
    assert.equal(
      st?.status,
      'confirmed',
      '🔴 东西已经在 Twenty 里了，改这里没有意义 —— 要改走 D75 的重录',
    );
  });

  it('🔴 取代别人的消息 → 不生效，而且如实说出来（不静默）', async () => {
    const a = await loginAs(ADMIN);
    const { messageId } = await firstRound(a.token, `admin 的话 ${SUFFIX}`);

    const p = await loginAs(PLAIN);
    const t = await req('/threads', {
      method: 'POST',
      headers: { ...auth(p.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `别人的对话 ${SUFFIX}` }),
    });
    const r = await post(p.token, {
      clientId: randomUUID(),
      text: `想改别人的 ${SUFFIX}`,
      createdAt: Date.now(),
      threadId: t.json.id,
      supersedesMessageId: messageId,
    });

    assert.equal(r.status, 201, '这一句本身是他真说过的话，不该被打回去');
    assert.equal(r.json.supersedeFailed, true, '🔴 静默失败 —— 人会以为老的那条被撤回了');
    const [rel] = await sql`select 1 from message_supersede where message_id = ${messageId}`;
    assert.equal(rel, undefined, '🔴 别人的消息被取代掉了 —— 作用域漏了');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  入库之后修改重录 POST /staging/:id/reconfirm（D75 · T83）
//
//  🔴 **这个端点此前一条集成测试都没有**，而它是全系统唯一会去**改已经在 CRM
//     里的记录**的路径：按 `twenty_refs` 存下的 id 逐条 PATCH。
//
//  它的核心承诺只有一句：**绝不新建第二份**。
//  系统里没有删除路径（D48），所以「替代」如果实现成「新建一条」，
//  结果是 CRM 里两条并存、旧的那条永远删不掉 —— 而界面上一路绿色。
//  在这一节出现之前，这句承诺**没有任何机械检查**。
//
//  下面前两组只需要一条 `confirmed` 的 staging 行，不碰 Twenty，CI 里照跑。
//  真的 PATCH 那一组要真 CRM，标 NEEDS_TWENTY。
// ═══════════════════════════════════════════════════════════════════

const reconfirm = (token: string, sid: string, fields: Record<string, unknown>) =>
  req(`/staging/${sid}/reconfirm`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });

/**
 * 造一条**已入库**的 staging —— 重录的前置状态。
 *
 * ⚠️ 直接写库而不是真跑一遍 confirm：那要真 Twenty + 30 秒心跳，
 *    而下面那些用例要验的闸门**全都在写 Twenty 之前就返回了**。
 *    真往返那条留给最后一组（NEEDS_TWENTY）。
 */
const confirmedStaging = async (
  token: string,
  opts: {
    extracted?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    refs?: Record<string, string>;
  } = {},
) => {
  const r = await post(token, { clientId: randomUUID(), text: '重录回归', createdAt: Date.now() });
  const sid = r.json.stagingId as string;
  const [own] = await sql<Array<{ id: string }>>`
    select i.user_id as id from inbox i join staging s on s.inbox_id = i.id where s.id = ${sid}`;
  await sql`
    update staging set status = 'confirmed',
      extracted = ${sql.json((opts.extracted ?? { recordType: 'support', caseStatus: 'NEW' }) as never)},
      confirm_payload = ${sql.json({ companyId: randomUUID(), ...(opts.payload ?? {}) } as never)},
      confirm_by = ${own!.id},
      twenty_refs = ${sql.json((opts.refs ?? { supportCaseId: randomUUID(), visitId: randomUUID() }) as never)},
      commit_history = '[]'::jsonb, error = null
    where id = ${sid}`;
  return sid;
};

const readStaging = async (sid: string) => {
  const [st] = await sql<
    Array<{
      status: string;
      confirm_payload: any;
      twenty_refs: any;
      commit_history: any[];
      error: string | null;
    }>
  >`select status, confirm_payload, twenty_refs, commit_history, error
    from staging where id = ${sid}`;
  return st!;
};

describe('重录的门槛：拒绝要说清楚为什么，静默吞掉最糟', () => {
  it('没 token → 401', async () => {
    const r = await req(`/staging/${randomUUID()}/reconfirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { severity: 'LOW' } }),
    });
    assert.equal(r.status, 401);
  });

  it('🔴 别人的 → 404（和其余端点一致，不确认它存在）', async () => {
    const { token } = await loginAs(ADMIN);
    const p = await loginAs(PLAIN);
    const sid = await confirmedStaging(p.token);

    const r = await reconfirm(token, sid, { severity: 'LOW' });

    assert.equal(r.status, 404, '🔴 admin 也不能碰别人写的（D76①）');
  });

  it('不存在的 → 404', async () => {
    const { token } = await loginAs(ADMIN);
    const r = await reconfirm(token, randomUUID(), { severity: 'LOW' });
    assert.equal(r.status, 404);
  });

  it('🔴 还没入库的 → 409，而且不能悄悄给它排一次队', async () => {
    const { token } = await loginAs(ADMIN);
    const sid = await readyStaging(token, { recordType: 'support' });

    const r = await reconfirm(token, sid, { severity: 'CRITICAL' });

    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'not_confirmed');
    // 首次确认只走对话页（D76）—— 这条路不能变成第二个入口
    assert.equal((await readStaging(sid)).status, 'ready', '🔴 拒绝了却已经排了队');
  });

  it('🔴 正在写 CRM 的那一刻也拒绝 —— 改动会和提交赛跑', async () => {
    const { token } = await loginAs(ADMIN);
    const sid = await confirmedStaging(token);
    await sql`update staging set status = 'committing' where id = ${sid}`;

    const r = await reconfirm(token, sid, { severity: 'CRITICAL' });

    assert.equal(r.status, 409);
    assert.equal((await readStaging(sid)).status, 'committing');
  });

  it('🔴 记录类型锁：显式 422，不能靠白名单默默放行', async () => {
    const { token } = await loginAs(ADMIN);
    const sid = await confirmedStaging(token);

    const r = await reconfirm(token, sid, { recordType: 'fitment', severity: 'LOW' });

    // recordType **在** KEEPERS 里 —— 不显式拦的话它会一路通过，
    // 然后把这条记录落到另一张表上，而旧的那条还在（没有删除路径）
    assert.equal(r.status, 422);
    assert.equal(r.json.error, 'record_type_locked');
    assert.match(r.json.message ?? '', /类型/);
    assert.equal((await readStaging(sid)).status, 'confirmed');
  });

  it('🔴 客户归属锁：companyId / companyCode 都要明说，不能静默丢弃', async () => {
    const { token } = await loginAs(ADMIN);
    const sid = await confirmedStaging(token);

    for (const key of ['companyId', 'companyCode']) {
      const r = await reconfirm(token, sid, { [key]: randomUUID(), severity: 'LOW' });
      // 这两个键**不在** KEEPERS 里，会被静默丢弃 ——
      // 那样人会看到「已重新入库」，而 CRM 里挂的还是原来那家客户
      assert.equal(r.status, 422, `${key} 被静默吞掉了`);
      assert.equal(r.json.error, 'company_locked');
    }
    assert.equal((await readStaging(sid)).status, 'confirmed');
  });

  it('🔴 非法枚举值 → 422 并指出是哪一个（不能当成「没改」）', async () => {
    const { token } = await loginAs(ADMIN);
    const sid = await confirmedStaging(token);

    // 会拒的是 keeper 认不出时**回 null** 的那几个：category / stage /
    // sourceConfidence / projectCode。悄悄当成「没改」入库的话，人看到「已重新入库」，
    // 而 CRM 里躺着的还是他刚刚亲手改掉的那个值。
    const r = await reconfirm(token, sid, { stage: '我瞎编的' });

    assert.equal(r.status, 422);
    assert.equal(r.json.error, 'bad_field_value');
    assert.ok(
      (r.json.rejected ?? []).some((s: string) => s.startsWith('stage=')),
      `没说是哪一格：${JSON.stringify(r.json)}`,
    );
    assert.equal((await readStaging(sid)).status, 'confirmed');
  });

  it('⚠️ 有安全默认的那几格不会被拒 —— 而重录时它会盖掉 CRM 里原来的值', async () => {
    const { token } = await loginAs(ADMIN);
    const sid = await confirmedStaging(token, { payload: { fields: { severity: 'CRITICAL' } } });

    const r = await reconfirm(token, sid, { severity: '我瞎编的' });

    /**
     * `keepSeverity` / `keepCaseStatus` 认不出时回的是**安全默认**（`MEDIUM` / `NEW`）
     * 而不是 null，所以它们永远走不到 `bad_field_value`（既定行为，
     * `agent.test.ts` 有同款断言）。`recordType` 是第三个，但它在上面被显式拦掉了。
     *
     * ⚠️ 把这条边界钉下来，是因为它在两条路上的含义不一样：
     * **首次确认**时这只是「填了个保守值」；**重录**时它是拿默认值
     * **覆盖掉 CRM 里原来那个正确的值**（这里 CRITICAL → MEDIUM）。
     * 界面上只给合法选项，所以现在够不着；但这一格的行为不该是个意外。
     */
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await readStaging(sid)).confirm_payload.fields.severity, 'MEDIUM');

    await req(`/staging/${sid}/confirm`, { method: 'DELETE', headers: auth(token) });
  });

  it('🔴 一个可改的键都没有 → 422，不能回 200 让人以为改成了', async () => {
    const { token } = await loginAs(ADMIN);
    const sid = await confirmedStaging(token);

    for (const fields of [{}, { text: '这个键不在白名单里' }]) {
      const r = await reconfirm(token, sid, fields);
      assert.equal(r.status, 422, JSON.stringify(fields));
      assert.equal(r.json.error, 'nothing_changed');
    }
  });
});

describe('重录的排队与审计：改了什么、原来是什么，三个月后查得回', () => {
  it('🔴 合法改动 → 排进同一条提交管线（recommit=true），不另起一条', async () => {
    const { token } = await loginAs(ADMIN);
    const sid = await confirmedStaging(token, { payload: { fields: { severity: 'LOW' } } });

    const r = await reconfirm(token, sid, { severity: 'CRITICAL', caseStatus: 'RESOLVED' });

    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.json.commitAt, '没给倒计时的时间点，卡片就没法显示撤销窗');
    const st = await readStaging(sid);
    assert.equal(st.status, 'confirming', '🔴 没进同一条心跳管线（issue #1：提交路径只能有一条）');
    assert.equal(st.confirm_payload.recommit, true, '🔴 没标 recommit —— commit 会走新建分支');
    assert.equal(st.confirm_payload.fields.severity, 'CRITICAL');
    assert.equal(st.confirm_payload.fields.caseStatus, 'RESOLVED');

    await req(`/staging/${sid}/confirm`, { method: 'DELETE', headers: auth(token) });
  });

  it('🔴 twenty_refs 一个字都不动 —— 那是「要 PATCH 哪几条」的唯一线索', async () => {
    const { token } = await loginAs(ADMIN);
    const refs = { supportCaseId: randomUUID(), visitId: randomUUID(), workItems: '3' };
    const sid = await confirmedStaging(token, { refs });

    await reconfirm(token, sid, { severity: 'CRITICAL' });

    assert.deepEqual((await readStaging(sid)).twenty_refs, refs, '🔴 refs 被动过 —— 那几条记录就再也找不回来了');
    await req(`/staging/${sid}/confirm`, { method: 'DELETE', headers: auth(token) });
  });

  it('🔴 上一次的字段和 refs 推进 commit_history（撤销时靠它弹回）', async () => {
    const { token } = await loginAs(ADMIN);
    const refs = { supportCaseId: randomUUID() };
    const sid = await confirmedStaging(token, { payload: { fields: { severity: 'LOW' } }, refs });

    await reconfirm(token, sid, { severity: 'CRITICAL' });

    const hist = (await readStaging(sid)).commit_history;
    assert.equal(hist.length, 1);
    assert.equal(hist[0].fields.severity, 'LOW', '🔴 没留下「原来是什么」');
    assert.deepEqual(hist[0].refs, refs);
    assert.ok(hist[0].at && hist[0].by, '审计条目缺时间或人');

    await req(`/staging/${sid}/confirm`, { method: 'DELETE', headers: auth(token) });
  });

  it('🔴 payload 是合并不是替换 —— 归属和「接在哪条售后上」必须留着', async () => {
    const { token } = await loginAs(ADMIN);
    const companyId = randomUUID();
    const supportCaseId = randomUUID();
    const sid = await confirmedStaging(token, {
      payload: { companyId, supportCaseId, fields: { severity: 'LOW', caseStatus: 'NEW' } },
    });

    await reconfirm(token, sid, { severity: 'CRITICAL' });

    const p = (await readStaging(sid)).confirm_payload;
    // 改归属那条路被锁死了（company_locked）—— 这里再把它弄丢，等于绕过那把锁
    assert.equal(p.companyId, companyId, '🔴 客户归属在合并时丢了');
    assert.equal(p.supportCaseId, supportCaseId, '🔴 「接在这条售后上」丢了 —— 会另开一条');
    assert.equal(p.fields.caseStatus, 'NEW', '🔴 这次没改的那一格被抹掉了');
    assert.equal(p.fields.severity, 'CRITICAL');

    await req(`/staging/${sid}/confirm`, { method: 'DELETE', headers: auth(token) });
  });

  it('🔴 撤销一次重录 → 回 confirmed 而不是 ready（回 ready 会让人再确认出第二份）', async () => {
    const { token } = await loginAs(ADMIN);
    const refs = { supportCaseId: randomUUID() };
    const sid = await confirmedStaging(token, { payload: { fields: { severity: 'LOW' } }, refs });
    await reconfirm(token, sid, { severity: 'CRITICAL' });

    const d = await req(`/staging/${sid}/confirm`, { method: 'DELETE', headers: auth(token) });

    assert.equal(d.status, 200);
    const st = await readStaging(sid);
    assert.equal(st.status, 'confirmed', '🔴 记录明明还在 CRM 里，回 ready 等于请人再建一份');
    assert.equal(st.confirm_payload.severity, undefined);
    assert.equal(st.confirm_payload.fields.severity, 'LOW', '🔴 字段没弹回上一次的样子');
    assert.equal(st.confirm_payload.recommit, undefined, '🔴 还挂着 recommit 标记');
    assert.deepEqual(st.commit_history, [], '🔴 审计条目没弹出来 —— 下次撤销会弹到更早的一条');
    assert.deepEqual(st.twenty_refs, refs);
  });
});

describe('重录真的是 PATCH 而不是新建（D75 的那句承诺）', () => {
  /** 等心跳把这一次重录写完。和 confirmAndWait 同样的节奏，但不重新发起确认。 */
  const waitRecommitted = async (sid: string) => {
    for (let i = 0; i < 40; i++) {
      await new Promise((res) => setTimeout(res, 900));
      const st = await readStaging(sid);
      if (st.error) throw new Error(`重录失败：${st.error}`);
      if (st.status === 'confirmed') return st;
    }
    throw new Error('等超时了 —— 心跳没把这次重录提交掉');
  };

  it('🔴 refs 里的 UUID 一个都没变，而 CRM 里的值真的改了', NEEDS_TWENTY, async () => {
    const { token } = await loginAs(ADMIN);
    const company = (await req('/companies', { headers: auth(token) })).json.items?.[0];
    if (!company) return;

    const sid = await readyStaging(token, {
      recordType: 'support',
      summary: '重录回归',
      caseStatus: 'NEW',
      severity: 'LOW',
    });
    const { refs } = await confirmAndWait(token, sid, { companyId: company.id });
    assert.ok(refs?.supportCaseId, '前置没入库');
    const before = { ...refs };

    const r = await reconfirm(token, sid, { caseStatus: 'RESOLVED', severity: 'CRITICAL' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const st = await waitRecommitted(sid);

    // ① 同一条记录 —— 没有删除路径，新建一份就是永久多一条
    assert.equal(st.twenty_refs.supportCaseId, before.supportCaseId, '🔴 重录新建了第二条售后');
    assert.equal(st.twenty_refs.visitId, before.visitId, '🔴 重录新建了第二条拜访');

    // ② 而且 PATCH 真的发出去了 —— refs 没变但值也没变的话，等于什么都没做
    const sc = (await twenty(`/rest/supportCases/${before.supportCaseId}`))?.supportCase;
    assert.equal(sc?.caseStatus, 'RESOLVED', '🔴 refs 没变，但 CRM 里还是旧值');
    assert.equal(sc?.severity, 'CRITICAL');
  });

  it('🔴 编号已属于另一个项目 → 409，而且一个字都没排队', NEEDS_TWENTY, async () => {
    const { token } = await loginAs(ADMIN);
    const company = (await req('/companies', { headers: auth(token) })).json.items?.[0];
    if (!company) return;

    const code = `ZZTEST-${SUFFIX.toUpperCase()}-001`;
    const otherId = await createProject({
      projectCode: code,
      name: `别家的项目 ${SUFFIX}`,
      companyId: company.id,
    } as never);
    try {
      // 这条记录上一次入库时挂的是**另一个** projectId
      const sid = await confirmedStaging(token, {
        refs: { projectId: randomUUID(), supportCaseId: randomUUID() },
      });

      const r = await reconfirm(token, sid, { projectCode: code });

      assert.equal(r.status, 409, JSON.stringify(r.json));
      assert.equal(r.json.error, 'code_conflict');
      assert.match(r.json.message ?? '', /别家的项目/, '要说清楚是被谁占了，否则人不知道换成什么');
      const st = await readStaging(sid);
      assert.equal(st.status, 'confirmed', '🔴 说了冲突却已经排了队');
      assert.deepEqual(st.commit_history, []);
    } finally {
      // 这是全仓库第二处删 Twenty 记录的代码，同样只许留在测试里（见 createdCompanies）
      const del = await fetch(`${env.twentyUrl}/rest/projects/${otherId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${env.twentyKey}` },
      }).catch(() => ({ ok: false, status: 0 }) as Response);
      if (!del.ok) console.warn(`  ⚠️ 测试项目 ${otherId}（${code}）没删掉 —— 手动删一下`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
//  管理控制台 /admin/*（D35 / D66 · T85）
//
//  🔴 **这六条路由此前一条测试都没有**，而它们是全系统唯一**建账号**的路径 ——
//     密码在这里生成、`token_version` 在这里 +1（撤权立即生效）、
//     Twenty 里的 `contributor` 投影也在这里建。
//
//  D66 那次事故就出在这一带：`.env` 里 `ADMIN_TOKEN` 写得好好的、preflight 报绿，
//  而 docker-compose 根本没把它传进容器 —— 于是控制台整个 503，
//  而**那条正确的安全默认在当时没有任何测试证明它是有意的**。
//
//  ⚠️ 这一组对网关的配置有要求，所以用运行时探针分档（同 NEEDS_TWENTY 的做法）：
//     `ADMIN_TOKEN` 设了 → 测全部；没设 → 只测「留空 = 整个关掉」那一条。
// ═══════════════════════════════════════════════════════════════════

/** 集成测试用的管理台 token。隔离栈（scripts/integration-stack.sh）会设成这个值。 */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';

const adminProbe = await fetch(`${BASE}/admin/users`, { signal: AbortSignal.timeout(4000) })
  .then((r) => r.status)
  .catch(() => 0);
/** 503 = 网关进程里 ADMIN_TOKEN 是空的（控制台整个关掉，D66 的那条安全默认）。 */
const adminOn = adminProbe === 401;

const NEEDS_ADMIN = adminOn
  ? ADMIN_TOKEN
    ? {}
    : { skip: '网关开着管理台，但测试进程不知道 ADMIN_TOKEN —— 用 scripts/integration-stack.sh 跑' }
  : { skip: `管理台是关的（探针回 ${adminProbe}）—— 这一档要 ADMIN_TOKEN 非空的网关` };
const NEEDS_ADMIN_OFF = adminOn
  ? { skip: '管理台开着 —— 「留空=关掉」那条只在 ADMIN_TOKEN 为空的网关上验得到' }
  : {};

const adm = (extra: Record<string, string> = {}) => ({ 'X-Admin-Token': ADMIN_TOKEN, ...extra });
const adminUsers = () => req('/admin/users', { headers: adm() });

describe('管理台的门（D35 / D66）', () => {
  it('页面本身不要 token —— 它只是个壳，数据全靠下面的接口', async () => {
    const r = await fetch(`${BASE}/admin`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/html/);
    // 后台页永远不该被边缘缓存，也不该被搜索引擎收
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(r.headers.get('x-robots-tag') ?? '', /noindex/);
  });

  it('🔴 留空 = 整个关掉（503），而且提示要同时指到 .env 和 compose', NEEDS_ADMIN_OFF, async () => {
    const r = await req('/admin/users', { headers: { 'X-Admin-Token': 'anything-at-all' } });
    assert.equal(r.status, 503);
    assert.equal(r.json.error, 'admin_disabled');
    // D66：人会盯着一个**正确的** .env 反复怀疑自己，提示必须说出第二处
    assert.match(r.json.hint ?? '', /compose/);
  });

  it('没 token → 401', NEEDS_ADMIN, async () => {
    const r = await req('/admin/users');
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'bad_token');
  });

  it('错 token → 401（且不泄漏正确的长度之外的任何东西）', NEEDS_ADMIN, async () => {
    const r = await req('/admin/users', { headers: { 'X-Admin-Token': 'x'.repeat(ADMIN_TOKEN.length) } });
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'bad_token');
  });

  it('🔴 token 只认请求头 —— 放进 URL 一律不生效', NEEDS_ADMIN, async () => {
    // URL 会落进 Caddy 访问日志、Cloudflare 日志、浏览器历史和任何一次截图
    for (const q of [`?token=${ADMIN_TOKEN}`, `?adminToken=${ADMIN_TOKEN}`, `?X-Admin-Token=${ADMIN_TOKEN}`]) {
      const r = await req(`/admin/users${q}`);
      assert.equal(r.status, 401, `${q} 居然放行了`);
    }
  });

  it('对的 token → 200，列表带 note_count', NEEDS_ADMIN, async () => {
    const r = await adminUsers();
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.items));
    const me = r.json.items.find((u: any) => u.user_code === ADMIN.code);
    assert.ok(me, '测试账号不在列表里');
    assert.equal(typeof me.note_count, 'number');
    assert.equal(me.is_active, true);
    // 🔴 列表里绝不能出现口令相关的任何一格
    assert.equal(me.password_hash, undefined);
    assert.equal(me.password, undefined);
  });
});

describe('建账号：密码只出现一次（D35④/⑤）', () => {
  const mk = (over: Record<string, unknown> = {}) => ({
    userCode: `t-adm-${SUFFIX}-${Math.random().toString(36).slice(2, 7)}`,
    displayName: '集成测试建的',
    role: 'user',
    ...over,
  });
  const create = (body: Record<string, unknown>) =>
    req('/admin/users', {
      method: 'POST',
      headers: adm({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });

  it('🔴 201 带回密码，而且那是唯一一次能看到它', NEEDS_ADMIN, async () => {
    const body = mk();
    const r = await create(body);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    created.push(body.userCode as string);
    assert.ok(r.json.password?.length >= 12, `服务端生成的密码太短：${r.json.password?.length}`);

    // 之后再也拿不到 —— 列表里连一个带 password 的键都不许有
    const list = await adminUsers();
    const row = list.json.items.find((u: any) => u.user_code === body.userCode);
    assert.ok(row, '建出来的账号不在列表里');
    assert.equal(JSON.stringify(row).includes(r.json.password), false, '🔴 密码从列表里漏出来了');
  });

  it('🔴 建出来就能用那个密码登录（端到端，不是只写了一行库）', NEEDS_ADMIN, async () => {
    const body = mk();
    const r = await create(body);
    created.push(body.userCode as string);

    const login = await req('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userCode: body.userCode, password: r.json.password }),
    });
    assert.equal(login.status, 200, JSON.stringify(login.json));
    assert.equal(login.json.user.userCode, body.userCode);
    assert.equal(login.json.user.role, 'user');
    // D35②：只分叉两次 —— user 角色没有看板
    assert.equal(login.json.user.boardUrl, undefined);
  });

  it('重名 → 409，而且不动原来那个账号', NEEDS_ADMIN, async () => {
    const body = mk();
    await create(body);
    created.push(body.userCode as string);

    const again = await create({ ...body, displayName: '另一个人' });
    assert.equal(again.status, 409);
    assert.equal(again.json.error, 'exists');
    const list = await adminUsers();
    const row = list.json.items.find((u: any) => u.user_code === body.userCode);
    assert.equal(row.display_name, '集成测试建的', '🔴 重名请求把原来那个改掉了');
  });

  it('四条校验各回各的错，不是笼统一句 400', NEEDS_ADMIN, async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ userCode: 'A大写不行' }, 'bad_user_code'],
      [{ userCode: 'x' }, 'bad_user_code'], // 至少 2 位
      [{ displayName: '' }, 'missing_display_name'],
      [{ role: '总管' }, 'bad_role'],
      [{ password: '1234567' }, 'weak_password'], // 至少 8 位
    ];
    for (const [over, want] of cases) {
      const r = await create(mk(over));
      assert.equal(r.status, 400, `${want} 没拦住：${JSON.stringify(r.json)}`);
      assert.equal(r.json.error, want);
    }
  });
});

describe('停用 / 启用 / 真删（「删除」在这里就是停用）', () => {
  const mkUser = async () => {
    const code = `t-adm-${SUFFIX}-${Math.random().toString(36).slice(2, 7)}`;
    const r = await req('/admin/users', {
      method: 'POST',
      headers: adm({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ userCode: code, displayName: '停用测试', role: 'staff' }),
    });
    created.push(code);
    return { code, password: r.json.password as string };
  };

  it('🔴 停用让**已经签发的 token 当场失效**（D35⑤，不用等 90 天）', NEEDS_ADMIN, async () => {
    const u = await mkUser();
    const { token } = await loginAs({ code: u.code, pass: u.password });
    assert.equal((await req('/me', { headers: auth(token) })).status, 200, '前置：这个 token 本来是好的');

    const d = await req(`/admin/users/${u.code}/deactivate`, { method: 'POST', headers: adm() });
    assert.equal(d.status, 200);

    assert.equal((await req('/me', { headers: auth(token) })).status, 401, '🔴 停用之后老 token 还能用');
    const relogin = await req('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userCode: u.code, password: u.password }),
    });
    assert.equal(relogin.status, 401, '🔴 停用之后还能重新登录');
  });

  it('启用之后密码没变 —— 还是原来那个（接口自己也这么说）', NEEDS_ADMIN, async () => {
    const u = await mkUser();
    await req(`/admin/users/${u.code}/deactivate`, { method: 'POST', headers: adm() });

    const a = await req(`/admin/users/${u.code}/activate`, { method: 'POST', headers: adm() });
    assert.equal(a.status, 200);
    assert.match(a.json.note ?? '', /密码/);

    const login = await req('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userCode: u.code, password: u.password }),
    });
    assert.equal(login.status, 200, '启用之后原密码登不上了');
  });

  it('不存在的账号 → 404（三个端点一致）', NEEDS_ADMIN, async () => {
    const ghost = `t-adm-${SUFFIX}-nobody`;
    for (const [path, method] of [
      [`/admin/users/${ghost}/deactivate`, 'POST'],
      [`/admin/users/${ghost}/activate`, 'POST'],
      [`/admin/users/${ghost}`, 'DELETE'],
    ] as const) {
      const r = await req(path, { method, headers: adm() });
      assert.equal(r.status, 404, `${method} ${path}`);
    }
  });

  it('🔴 名下有速记的账号删不掉（409）—— 删了会连他录过的话一起没', NEEDS_ADMIN, async () => {
    const u = await mkUser();
    const { token } = await loginAs({ code: u.code, pass: u.password });
    await post(token, { clientId: randomUUID(), text: '他真说过的一句话', createdAt: Date.now() });

    const d = await req(`/admin/users/${u.code}`, { method: 'DELETE', headers: adm() });

    assert.equal(d.status, 409);
    assert.equal(d.json.error, 'has_notes');
    assert.ok(d.json.noteCount >= 1);
    assert.match(d.json.hint ?? '', /停用/, '要指出正确的做法，不是只说不行');
    // 账号还在，速记也还在
    assert.ok((await adminUsers()).json.items.some((x: any) => x.user_code === u.code));
  });

  it('一条速记都没有的才真删得掉', NEEDS_ADMIN, async () => {
    const u = await mkUser();

    const d = await req(`/admin/users/${u.code}`, { method: 'DELETE', headers: adm() });

    assert.equal(d.status, 200, JSON.stringify(d.json));
    assert.equal((await adminUsers()).json.items.some((x: any) => x.user_code === u.code), false);
  });

  it('note_count 是真数出来的', NEEDS_ADMIN, async () => {
    const u = await mkUser();
    const { token } = await loginAs({ code: u.code, pass: u.password });
    for (let i = 0; i < 2; i++) {
      await post(token, { clientId: randomUUID(), text: `第 ${i} 条`, createdAt: Date.now() });
    }
    const row = (await adminUsers()).json.items.find((x: any) => x.user_code === u.code);
    assert.equal(row.note_count, 2);
  });
});

/**
 * ⚠️ **这一组必须排在所有 /admin 用例的最后。**
 *
 * 锁是**按 IP 记在内存里**的（`admin.ts` 的 `fails` Map），跑完这一条之后
 * 本机 IP 会被锁 15 分钟 —— 后面任何 /admin 请求都会拿到 429。
 *
 * 也正因为如此，它在**一次性网关**上才跑得干净（进程一换，Map 就空了）——
 * 这是 `scripts/integration-stack.sh` 存在的又一个理由。
 * 对着自己长期开着的 dev 网关跑完这一条，接下来一刻钟你自己也进不去管理台。
 */
describe('暴力破解防护：同 IP 连续失败 8 次锁 15 分钟（最后跑）', () => {
  it('🔴 第 9 次拿到 429 + retryAfterSec，而不是继续让人猜', NEEDS_ADMIN, async () => {
    let locked: any = null;
    for (let i = 1; i <= 9; i++) {
      // ⚠️ 值只能是 ASCII —— HTTP 头是 ByteString，中文会在 fetch 里当场抛
      const r = await req('/admin/users', { headers: { 'X-Admin-Token': `wrong-guess-${i}` } });
      if (r.status === 429) {
        locked = { at: i, json: r.json };
        break;
      }
      assert.equal(r.status, 401, `第 ${i} 次应该是 401`);
    }
    assert.ok(locked, '🔴 试满 9 次都没锁 —— 等于没有防护');
    assert.equal(locked.at, 9, `第 ${locked.at} 次就锁了（MAX_FAILS=8，应当第 9 次）`);
    assert.equal(locked.json.error, 'locked');
    assert.ok(locked.json.retryAfterSec > 0, '要告诉人多久之后再来');
    assert.ok(locked.json.retryAfterSec <= 15 * 60);

    // 🔴 锁上之后，**对的 token 也进不去** —— 否则攻击者只要撞对一次就解锁了
    const good = await adminUsers();
    assert.equal(good.status, 429, '🔴 锁定期内正确 token 仍然放行');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  盘点表（T82）里剩下的三个端点 + 两处「有单测、集成层没跑到」的逻辑
// ═══════════════════════════════════════════════════════════════════

describe('批量确认 POST /staging/confirm-batch（晚上回酒店一次性核十几条）', () => {
  const batch = (token: string, items: unknown[]) =>
    req('/staging/confirm-batch', {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });

  it('没 token → 401 · 空清单 → 422', async () => {
    assert.equal((await req('/staging/confirm-batch', { method: 'POST' })).status, 401);
    const { token } = await loginAs(ADMIN);
    assert.equal((await batch(token, [])).status, 422);
    assert.equal((await batch(token, [])).json.error, 'empty');
  });

  it('🔴 批量不是放松闸门的理由 —— 四道和单条完全一样', async () => {
    const { token } = await loginAs(ADMIN);
    const p = await loginAs(PLAIN);

    const noCompany = await readyStaging(token, { recordType: 'support' });
    const others = await readyStaging(p.token, { recordType: 'support' });
    const already = await confirmedStaging(token);
    const gone = await readyStaging(token, { recordType: 'support' });
    await sql`update staging set status = 'superseded' where id = ${gone}`;

    const r = await batch(token, [
      { id: noCompany },                              // 没给 companyId
      { id: others, companyId: randomUUID() },        // 别人的
      { id: already, companyId: randomUUID() },       // 已入库
      { id: gone, companyId: randomUUID() },          // 被改口取代了
    ]);

    assert.equal(r.status, 200);
    const by = Object.fromEntries(r.json.results.map((x: any) => [x.id, x]));
    // D28 那道闸门对批量同样成立 —— 挂错客户的数据比没录更糟
    assert.deepEqual(by[noCompany], { id: noCompany, ok: false, reason: 'company_required' });
    assert.equal(by[others].reason, 'not_found', '🔴 批量这条路绕过了作用域');
    assert.deepEqual(by[already], { id: already, ok: true, reason: 'already' }, '重复点不该报错');
    assert.equal(by[gone].reason, 'superseded', '🔴 被取代的还能入库 = CRM 里两份都有（issue #14）');
    assert.equal((await readStaging(noCompany)).status, 'ready', '被拒的却排了队');
  });

  it('合法的那些真的排进队，并带回撤销窗', async () => {
    const { token } = await loginAs(ADMIN);
    const a = await readyStaging(token, { recordType: 'support' });
    const b = await readyStaging(token, { recordType: 'support' });

    const r = await batch(token, [
      { id: a, companyId: randomUUID() },
      { id: b, companyId: randomUUID() },
    ]);

    assert.ok(r.json.results.every((x: any) => x.ok));
    assert.ok(r.json.undoMs > 0, '没带回 undoMs，界面就没法显示倒计时');
    for (const id of [a, b]) assert.equal((await readStaging(id)).status, 'confirming');
    for (const id of [a, b]) await req(`/staging/${id}/confirm`, { method: 'DELETE', headers: auth(token) });
  });

  it('🔴 一次最多 100 条，而且第 101 条是**静默**丢掉的（把这个行为钉住）', async () => {
    const { token } = await loginAs(ADMIN);
    // 全是不存在的 id：走到 loadOwned 就返回 not_found，不建任何东西
    const items = Array.from({ length: 101 }, () => ({ id: randomUUID(), companyId: randomUUID() }));

    const r = await batch(token, items);

    assert.equal(r.json.results.length, 100, `实际处理了 ${r.json.results.length} 条`);
    /**
     * ⚠️ 回包里**没有任何字段**说「你传了 101 条，我只做了 100 条」——
     * 人在界面上勾了 101 条、点一下、看到「都提交了」，而最后那条其实没动。
     * 这一条不是在夸它，是把现状钉住：真要改，改的是加一个 `truncated` 字段，
     * 那时这条断言会红，提醒你同步改前端。
     */
    assert.equal(r.json.truncated, undefined, '如果加了 truncated 字段，请一并更新前端提示');
  });
});

describe('重转写 POST /inbox/:id/transcribe（issue #19 的手动救援口）', () => {
  /**
   * 造一条**带音频**的速记 —— 只有它才谈得上重转写。
   *
   * ⚠️ **音频必须真的随请求传上去，不能事后 `update inbox set audio_path=…`** ——
   *    `inbox` 只增不改（§4.2 第 2 条），库里有触发器挡着，那条 UPDATE 会被拒。
   *    第一版就是这么写的，四条用例当场红 —— 等于这套测试**自己撞了一次那道纪律**。
   *    `staging` 是派生层，改它没问题。
   */
  const withAudio = async (token: string, over: Record<string, unknown> = {}) => {
    /**
     * ⚠️ **上行时把 `transcript` 一起带上，否则后台转写队列会和这些用例抢那一行。**
     *
     * 带音频的速记一落库就会被 `enqueueTranscribe` 排进队；占位的 OpenAI key 让它
     * 失败并按 2s/4s 退避重试，于是我这边刚 `update staging set status='transcribing'`，
     * 那边就把它改成了别的 —— 第一版就是这么红的（「transcribing 居然又排了一次」）。
     * 带了 `transcript` 服务端就跳过转写（issue #15：同一段音频只转一次），队列压根不介入。
     *
     * 而端点里 **busy 那一档排在 `alreadyDone` 前面**，所以带着 transcript 也验得到 busy；
     * 要验「该重转的」那条时，再把 transcript 置空即可（`staging` 是派生层，改它不违反 §4.2 第2条）。
     */
    const r = await post(
      token,
      { clientId: randomUUID(), text: '要重转的', createdAt: Date.now(), transcript: '占位转录' },
      [['audio', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' }), 'a.webm']],
    );
    assert.equal(r.status, 201, JSON.stringify(r.json));
    await sql`update staging set status = ${(over.status as string) ?? 'failed'},
                transcript = ${(over.transcript as string | null) ?? null}, error = 'boom'
              where inbox_id = ${r.json.inboxId}`;
    return r.json.inboxId as string;
  };

  it('没 token → 401 · 别人的 → 404', async () => {
    assert.equal(
      (await req(`/inbox/${randomUUID()}/transcribe`, { method: 'POST' })).status,
      401,
    );
    const { token } = await loginAs(ADMIN);
    const p = await loginAs(PLAIN);
    const his = await withAudio(p.token);
    const r = await req(`/inbox/${his}/transcribe`, { method: 'POST', headers: auth(token) });
    assert.equal(r.status, 404, '🔴 admin 也不能重转别人的（D76①）');
  });

  it('🔴 没有音频就如实说，别排一个什么都不做的活然后回「已排队」', async () => {
    const { token } = await loginAs(ADMIN);
    const r0 = await post(token, { clientId: randomUUID(), text: '纯文字', createdAt: Date.now() });

    const r = await req(`/inbox/${r0.json.inboxId}/transcribe`, { method: 'POST', headers: auth(token) });

    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'no_audio');
  });

  it('🔴 已经在跑 / 已经进 CRM 的不动它 —— 说「排队了」而其实被覆盖掉最糟', async () => {
    const { token } = await loginAs(ADMIN);
    for (const status of ['transcribing', 'extracting', 'confirming', 'committing', 'confirmed']) {
      const id = await withAudio(token, { status });
      const r = await req(`/inbox/${id}/transcribe`, { method: 'POST', headers: auth(token) });
      assert.equal(r.json.queued, false, `${status} 居然又排了一次`);
      assert.equal(r.json.busy, true);
      assert.equal(r.json.status, status);
      assert.equal((await readStaging((await sql`select id from staging where inbox_id=${id}`)[0]!.id)).status, status);
    }
  });

  it('已经转出来了就别再烧一次', async () => {
    const { token } = await loginAs(ADMIN);
    const id = await withAudio(token, { transcript: '上次已经转好的那段' });

    const r = await req(`/inbox/${id}/transcribe`, { method: 'POST', headers: auth(token) });

    assert.equal(r.json.queued, false);
    assert.equal(r.json.alreadyDone, true);
  });

  it('🔴 该重转的：状态重置成 pending、次数清零、错误抹掉（否则那行红字永远擦不掉）', async () => {
    const { token } = await loginAs(ADMIN);
    const id = await withAudio(token);
    await sql`update staging set attempts = 5 where inbox_id = ${id}`;

    const r = await req(`/inbox/${id}/transcribe`, { method: 'POST', headers: auth(token) });

    assert.equal(r.json.queued, true);
    const [st] = await sql<Array<{ status: string; attempts: number; error: string | null }>>`
      select status, attempts, error from staging where inbox_id = ${id}`;

    /**
     * ⚠️ **这里只断言「重置之后后台不会再改回去」的那几样，不断言 `status === 'pending'`。**
     *
     * 端点重置完就把活排进转写队列，而队列跑得比这条断言快：
     * CI 里 agent 是开着的、OpenAI key 是占位符 → 立刻失败 → status 又变回 `failed`。
     * 本地一次性环境（`AGENT_ENABLED=0`）看得到 `pending`，CI 里看不到 ——
     * **一条只在某种配置下才成立的断言，等于没有断言**（§2.42①，这是它的第二次）。
     *
     * 剩下这两样是单调的：`attempts` 从 5 被清零（后台最多再 +1），
     * 原来那条 `boom` 被抹掉了（后台只会写新的错误，不会写回旧的）。
     * 变异测试验过：把 `attempts = 0` 从那条 UPDATE 里去掉，这条当场红。
     */
    assert.ok(st!.attempts < 5, `attempts 没清零（${st!.attempts}）—— 一进队列就又被判成「试太多次了」`);
    assert.notEqual(st!.error, 'boom', '🔴 上一次的错误没抹掉 —— 那行红字会永远擦不掉');
  });
});

describe('一句话标题 POST /title', () => {
  it('没 token → 401', async () => {
    const r = await req('/title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '随便' }),
    });
    assert.equal(r.status, 401);
  });

  it('空文本也要给个字符串，不能 undefined（列表页拿它当标题）', async () => {
    const { token } = await loginAs(ADMIN);
    const r = await req('/title', {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.title, 'string');
  });
});

describe('🔴 拿不到「CRM 里已经到几号了」就一个号都不发（D91④）', () => {
  it('Twenty 连不上时 reserveProjectCode 回 null，绝不退回从 -001 开始', async () => {
    const { token } = await loginAs(ADMIN);
    const sid = await readyStaging(token, { recordType: 'project' });

    const got = await reserveProjectCode(sid, { companyCode: `ZZTEST${SUFFIX}`, name: '取号测试' } as never);

    if (twentyProbe) {
      // Twenty 在的话它**应该**发得出号 —— 那是另一条路径，这里只确认不是 null
      assert.ok(got?.code, 'Twenty 通着却没发出号');
      return;
    }
    /**
     * 🔴 这一条在**默认的一次性环境里**才验得到（`SERVER_URL` 指向不通的端口）。
     *
     * 发出去的 `-001` 撞上一个已存在项目的后果是**入库时 PATCH 掉别人的项目** ——
     * 数据被改，界面一路绿色。所以宁可让编号继续空着（人在核对卡上还能自己填）。
     */
    assert.equal(got, null, '🔴 Twenty 连不上却发了号 —— 这个号极可能撞上一个已存在的项目');
    const [st] = await sql<Array<{ extracted: any }>>`select extracted from staging where id = ${sid}`;
    assert.equal(st!.extracted?.project?.projectCode, undefined, '🔴 没发号却写进了 staging');
  });

  it('客户代号为空 → 同样不发号（连前缀都拼不出来）', async () => {
    const { token } = await loginAs(ADMIN);
    const sid = await readyStaging(token, { recordType: 'project' });
    assert.equal(await reserveProjectCode(sid, { companyCode: '  ' } as never), null);
  });
});

describe('🔴 网关重启之后，点过确认的那些捡得回来（D48）', () => {
  /**
   * ⚠️ **`confirm_after` 一律排在未来 —— 否则真实心跳会和这条用例抢那一行。**
   *
   * 网关里的 ticker 每秒跑一次 `claimDue()`，会把**已到点**的 `confirming` 抢走改成
   * `committing`。第一版把 `confirm_after` 设成 `now() - 1 minute`，于是这条用例
   * 时灵时不灵 —— 靠 `AGENT_ENABLED=1` 那一轮才撞出来（它和 agent 无关，纯粹是运气）。
   * 判据同 §2.42①：**一条要靠运气才成立的断言，等于没有断言。**
   */
  it('resumeConfirming 不动 confirming 的行 —— 那是心跳的活，不是它的', async () => {
    const { token } = await loginAs(ADMIN);
    const sid = await readyStaging(token, { recordType: 'support' });
    await sql`update staging set status = 'confirming', confirm_after = now() + interval '1 hour',
              confirm_payload = ${sql.json({ companyId: randomUUID() } as never)} where id = ${sid}`;

    await resumeConfirming();

    /**
     * 这条守的是「重启不丢」（D48）：状态落在库里，进程没了它还在，
     * 重启之后既不该被清掉、也不该被 `resumeConfirming` 自己提交。
     * 之前这个函数一条测试都没有，而仓库里记过一次真实事故正好落在这一带
     * （两个网关抢同一批 staging，一堆卡在 committing）。
     */
    assert.equal((await readStaging(sid)).status, 'confirming', '🔴 重启把待提交的那条弄丢了');
    assert.equal(
      (await claimDue()).some((r) => r.id === sid),
      false,
      '🔴 还没到点就被认领了 —— 那 5 秒撤销窗就是假的',
    );
    await sql`update staging set status = 'ready', confirm_after = null where id = ${sid}`;
  });

  it('到点之后由心跳认领，不会永远停在 confirming', async () => {
    const { token } = await loginAs(ADMIN);
    const sid = await readyStaging(token, { recordType: 'support' });
    await sql`update staging set status = 'confirming', confirm_after = now() - interval '1 second',
              confirm_payload = ${sql.json({ companyId: randomUUID() } as never)} where id = ${sid}`;

    // 谁先抢到都行（网关的 ticker 每秒一跳，这里也可能自己抢到）——
    // 要断言的是**它一定会被处理掉**，不是「一定由谁处理」。
    for (let i = 0; i < 40; i++) {
      await claimDue().catch(() => []);
      if ((await readStaging(sid)).status !== 'confirming') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.notEqual((await readStaging(sid)).status, 'confirming', '🔴 到点了却永远停在 confirming');
    await sql`update staging set status = 'ready', confirm_after = null where id = ${sid}`;
  });

  it('🔴 卡在 committing 的**不自动重试**，只报出来让人去核（重跑会写重复，issue #1）', async () => {
    const { token } = await loginAs(ADMIN);
    const sid = await readyStaging(token, { recordType: 'support' });
    await sql`update staging set status = 'committing' where id = ${sid}`;

    await resumeConfirming();

    assert.equal((await readStaging(sid)).status, 'committing', '🔴 自动重试了 —— CRM 里会多一份');
    assert.equal((await claimDue()).some((r) => r.id === sid), false, '🔴 被心跳认领了');
    await sql`update staging set status = 'ready' where id = ${sid}`;
  });
});

/**
 * ── 网关被硬杀之后，留在 `running` 的那一轮（T99）────────────────────
 *
 * 这一组守的是 D130 那条判据的**另一半**：思考动画现在由服务端的
 * 「有没有 `status='running'` 的 agent_run」说了算 —— 那么那个答案必须是真的。
 * 进程被 `kill` 时没有任何代码来得及收尾，于是那一行永远停在 `running`，
 * **那条对话从此永远「正在思考…」，换个标签页打开也一样。**
 *
 * ⚠️ `reapStaleRuns()` 是全局的（没有参数），所以它会把这个库里**所有**
 *    `running` 的行收掉。一次性环境里 `AGENT_ENABLED=0`，不会有真的在跑；
 *    `--here` 档万一撞上真的一轮，损失也是自愈的 —— 它只写库、不动内存里的队列，
 *    那一轮跑完照样会把自己的行覆盖回去（动画闪一下，不丢数据）。
 */
describe('网关重启之后的收尸（T99）', () => {
  /**
   * 造一条「上个进程被杀时留下的」轮次。
   *
   * 🔴 **那条速记绝不能带 `threadId`。** `POST /inbox` 里是
   * `toAgent = payload.toAgent === true || Boolean(payload.threadId)`（index.ts）——
   * 带上它这条速记就真进 agent 队列了，而队列失败时会跑
   * `update agent_run set status='failed' … where inbox_id = ? and status='running'`
   * （loop.ts）：**它按 inbox_id 收，正好把我们刚造的这具尸体收走**，
   * 于是断言前置条件的那一条会莫名其妙地红。第一版就是这么写的，查了两轮。
   * （反过来说，这也顺手证明了进程还活着时那条失败路径本来就管用。）
   *
   * `/threads/:id` 判「在不在跑」只看 `agent_run.thread_id`，不看有没有消息 ——
   * 所以速记走纯速记那条路（D31：不进队列），thread_id 直接写在 agent_run 上。
   */
  const deadRun = async (token: string, status = 'running') => {
    const th = await req('/threads', {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '集成测试：收尸' }),
    });
    const threadId = th.json.id as string;
    assert.ok(threadId, '前置：对话没建出来');
    const f = new FormData();
    f.append(
      'payload',
      JSON.stringify({ clientId: randomUUID(), text: '集成测试：收尸', createdAt: Date.now() }),
    );
    const r = await req('/inbox', { method: 'POST', headers: auth(token), body: f });
    const inboxId = r.json.inboxId as string;
    const [run] = await sql<Array<{ id: string }>>`
      insert into agent_run (inbox_id, thread_id, status, stage, max_steps)
      values (${inboxId}, ${threadId}, ${status}, ${'在想'}, 8) returning id`;
    return { threadId, inboxId, runId: run!.id };
  };

  const readRun = async (id: string) => {
    const [r] = await sql<Array<{ status: string; stop_reason: string | null; error: string | null }>>`
      select status, stop_reason, error from agent_run where id = ${id}`;
    return r!;
  };

  it('🔴 收之前 /threads/:id 确实在撒谎 —— 它说这条还在跑', async () => {
    const { token } = await loginAs(ADMIN);
    const { threadId } = await deadRun(token);
    const r = await req(`/threads/${threadId}`, { headers: auth(token) });
    assert.notEqual(r.json.running, null, '🔴 前置条件不成立：这一组就白测了');
  });

  it('🔴 收完之后那条对话不再「正在思考…」', async () => {
    const { token } = await loginAs(ADMIN);
    const { threadId, runId } = await deadRun(token);

    assert.ok((await reapStaleRuns()) >= 1);

    const r = await req(`/threads/${threadId}`, { headers: auth(token) });
    assert.equal(r.json.running, null, '🔴 尸体还在 —— 这条对话会永远转圈');
    const run = await readRun(runId);
    assert.equal(run.status, 'failed');
    // 🔴 `aborted` 是「人自己按的停止」，两者混在一起 agent_run 就再也答不了
    //    「今天到底有几条是真的出问题了」（loop.ts 里为这条写过一次注释）
    assert.equal(run.stop_reason, 'interrupted');
    assert.match(run.error ?? '', /跑到一半/);
  });

  it('已经收过尾的一个字都不动（ok / partial / failed 各自的结论是真相）', async () => {
    const { token } = await loginAs(ADMIN);
    const ok = await deadRun(token, 'ok');
    const partial = await deadRun(token, 'partial');
    const failed = await deadRun(token, 'failed');
    await sql`update agent_run set stop_reason = 'done' where id = ${ok.runId}`;
    await sql`update agent_run set stop_reason = 'aborted' where id = ${partial.runId}`;
    await sql`update agent_run set stop_reason = 'error', error = '模型那边 500 了' where id = ${failed.runId}`;

    await reapStaleRuns();

    assert.equal((await readRun(ok.runId)).stop_reason, 'done');
    // 🔴 人叫停的那一轮不能被改写成「网关重启了」
    assert.equal((await readRun(partial.runId)).stop_reason, 'aborted');
    assert.deepEqual(
      { ...(await readRun(failed.runId)) },
      { status: 'failed', stop_reason: 'error', error: '模型那边 500 了' },
      '🔴 真正的失败原因被通用话术盖掉了 —— 那是排查时唯一有用的一格',
    );
  });

  it('🔴 已经写下的失败原因不被通用话术盖掉 —— 那一格是排查时唯一有用的东西', async () => {
    const { token } = await loginAs(ADMIN);
    const { runId } = await deadRun(token);
    // 还停在 running、但已经写下了更具体的一句（`coalesce` 守的就是这一格）
    await sql`update agent_run set error = '模型那边 500 了' where id = ${runId}`;

    await reapStaleRuns();

    const run = await readRun(runId);
    assert.equal(run.status, 'failed');
    assert.equal(run.stop_reason, 'interrupted');
    assert.equal(run.error, '模型那边 500 了', '🔴 被「网关重启了」那句通用话盖掉了');
  });

  it('🔴 被挪到 resumePending() 后面就拒跑 —— 绝不把活着的那一轮当尸体收掉', async () => {
    const { token } = await loginAs(ADMIN);
    const { threadId, runId } = await deadRun(token);
    __setRunsCreated(1); // 假装这个进程已经开跑过一轮（= 调用位置被挪到了后面）
    try {
      assert.equal(await reapStaleRuns(), 0, '🔴 位置守卫没挡住');
      assert.equal((await readRun(runId)).status, 'running', '🔴 活着的那一轮被收掉了');
      const r = await req(`/threads/${threadId}`, { headers: auth(token) });
      assert.notEqual(r.json.running, null);
    } finally {
      __setRunsCreated(0);
    }
    // 收拾干净：这一条是故意留成 running 的，别让它污染后面的用例
    await reapStaleRuns();
  });
});
