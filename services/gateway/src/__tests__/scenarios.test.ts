import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { sql } from '../db.ts';
import { hashPassword } from '../auth.ts';
import { env } from '../env.ts';

/**
 * `docs/test_example` 的五个业务用例，逐条断言。
 *
 * 🔴 **这一份和 `api.test.ts` 不是一类东西。**
 * 那边测的是「接口对不对」（造好 staging，验入库那一层）；
 * 这边测的是「**一句真话从头走到底，CRM 里长出来的东西对不对**」——
 * 每条都真的调模型、真的写 Twenty。所以它慢（一轮 30–90 秒）、而且要花钱。
 *
 * 跑法：
 *   node --test src/__tests__/scenarios.test.ts        （只对本地）
 *   ./scripts/test.sh scenarios
 *
 * ⚠️ 不进 `test.sh all` 的默认档：五条用例十几次模型调用，
 * 每次改代码都跑一遍不现实。**它是验收用的，不是回归用的** ——
 * 改数据模型、改 prompt、改 confirm 之后跑一次。
 */

const BASE = process.env.GATEWAY_URL ?? `http://localhost:${env.port}`;
const isLocal = (u: string) => /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(u);
if (!isLocal(BASE) || !/@(localhost|127\.0\.0\.1)[:/]/.test(env.databaseUrl)) {
  // 🔴 和 api.test.ts 同一条：绕过必须写出目标主机名，`=1` 不管用 ——
  //    一个忘在环境里的 `1` 会在你没想起它的那天放行生产（2026-08-10 收紧）。
  const target = (() => {
    try {
      return new URL(BASE).host;
    } catch {
      return BASE;
    }
  })();
  if (process.env.ALLOW_NONLOCAL_TESTS !== target) {
    console.error(
      `\n🔴 业务场景测试只对本地跑（会调模型、会写 Twenty）。\n` +
        `   真要对 ${target} 跑：ALLOW_NONLOCAL_TESTS=${target}\n`,
    );
    process.exit(1);
  }
}

const SUFFIX = randomUUID().slice(0, 6);
const USER = { code: `t-admin-sc-${SUFFIX}`, pass: `pw-${randomUUID()}` };
/** 这一轮用的项目编号带后缀 —— 不同批次的测试不能互相撞编号（那正是幂等要测的东西）。 */
const P1 = `SC-BAT-${SUFFIX}-001`;
const P2 = `SC-BAT-${SUFFIX}-002`;

let token = '';
let havelId = '';

const api = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: { raw: text } };
  }
};

const twenty = async (path: string) => {
  const res = await fetch(`${env.twentyUrl}${path}`, {
    headers: { Authorization: `Bearer ${env.twentyKey}` },
  });
  return res.ok ? ((await res.json()) as any)?.data : null;
};

/** 发一句话给 agent，等它跑完，返回抽出来的东西。 */
const say = async (text: string, file?: { name: string; body: string }) => {
  const t = await api('/threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'scenario' }),
  });
  const f = new FormData();
  f.append(
    'payload',
    JSON.stringify({ clientId: randomUUID(), threadId: t.json.id, toAgent: true, text, createdAt: Date.now() }),
  );
  if (file) f.append('file', new Blob([new TextEncoder().encode(file.body)]), file.name);
  const up = await api('/inbox', { method: 'POST', body: f });
  const stagingId = up.json.stagingId as string;

  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const [s] = await sql<Array<{ status: string }>>`select status from staging where id = ${stagingId}`;
    if (s && ['ready', 'failed'].includes(s.status)) break;
  }
  const [s] = await sql<Array<{ status: string; extracted: any; error: string | null }>>`
    select status, extracted, error from staging where id = ${stagingId}`;
  assert.notEqual(s?.status, 'failed', `agent 跑失败了：${s?.error}`);
  return { stagingId, extracted: (s?.extracted ?? {}) as Record<string, any> };
};

/** 确认入库，等心跳写完，返回 twenty_refs。 */
const commit = async (stagingId: string) => {
  const r = await api(`/staging/${stagingId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ companyId: havelId }),
  });
  assert.equal(r.status, 200, `确认失败：${JSON.stringify(r.json)}`);
  for (let i = 0; i < 16; i++) {
    await new Promise((x) => setTimeout(x, 1000));
    const [s] = await sql<Array<{ status: string; twenty_refs: any; error: string | null }>>`
      select status, twenty_refs, error from staging where id = ${stagingId}`;
    if (s?.status === 'confirmed') return s.twenty_refs as Record<string, string>;
    if (s?.status === 'ready' && s.error) throw new Error(`入库失败：${s.error}`);
  }
  throw new Error('等入库超时');
};

before(async () => {
  const up = await fetch(`${BASE}/health`);
  assert.equal(up.status, 200, `网关没跑起来（${BASE}）`);
  await sql`insert into app_user (user_code, display_name, password_hash, role)
            values (${USER.code}, ${'场景验收'}, ${await hashPassword(USER.pass)}, 'admin')`;
  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userCode: USER.code, password: USER.pass }),
  });
  token = ((await login.json()) as any).token;
  const cos = await api('/companies');
  const havel = cos.json.items?.find((c: any) => c.code === 'HAVEL') ?? cos.json.items?.[0];
  assert.ok(havel, '客户名单是空的 —— 先跑 import-accounts');
  havelId = havel.id;
});

after(async () => {
  await sql`update app_user set is_active = false, token_version = token_version + 1
            where user_code = ${USER.code}`;
  await sql.end();
});

// ═══════════════════════════════════════════════════════════════════
describe('T01 · 新建商机：竞争信息与需求量', () => {
  it('Voltaro 是竞品不是客户；需求量、占比、价格接受度、预算都没丢', async () => {
    const { stagingId, extracted } = await say(
      '刚和 Havel 的项目团队开完会。他们正在为 2027 款房车寻找 12V 锂电池供应商，预计年需求量 20,000 台。' +
        '现在主要使用 Voltaro，单台可接受价格大约 500 欧元。产品组合是 100Ah 和 150Ah，其中 100Ah 约占 30%，' +
        '150Ah 约占 70%。希望 2026 年 10 月底前确定候选供应商。项目由欧洲 OE 销售团队负责，' +
        '初步预计首年采购预算为 900 万欧元。',
    );

    // 🔴 最容易错的一条：把竞品认成客户
    // node:assert/strict 没有 notMatch —— 用 ok(!test) 写
    assert.ok(
      !/voltaro/i.test(String(extracted.companyCode ?? '')),
      '🔴 Voltaro 被当成了客户 —— 它是在位竞品',
    );
    assert.match(String(extracted.supplierName ?? ''), /voltaro/i, 'Voltaro 没被记成在位品牌');

    const blob = JSON.stringify(extracted);
    for (const must of ['20,000', '100Ah', '150Ah', '30', '70']) {
      assert.ok(blob.includes(must), `🔴 「${must}」丢了 —— T01 要求两种容量和占比都不能丢`);
    }
    assert.ok(
      /500/.test(blob),
      '🔴 价格接受度丢了。用例原话：无法承载就该新增字段，而不是把信息丢弃',
    );
    assert.equal(extracted.budgetEur, 9_000_000, '预算没抽成数字，就没法在 CRM 里筛');

    /**
     * 🐛 回归 issue #3：「刚和 Havel 的项目团队**开完会**」是销售亲自在场的一手信息。
     * 生产实测它被判成「销售转述，RUMOR」——
     * 而展会十天记的绝大多数都是一手的，全判传闻的话这个字段的区分度当场归零：
     * 手册 P18 的机制是让人**把传闻降下去**，默认就在最低档时根本无从降起。
     */
    assert.equal(
      extracted.sourceConfidence,
      'CONFIRMED',
      '🔴 「刚和 X 开完会」被判成传闻了 —— 可信度这个字段就没有区分度了（issue #3）',
    );

    // issue #4：D59 加的四个字段，抽取这一层至少要把负责团队和价格接受度读出来
    assert.match(String(extracted.ownerTeam ?? ''), /OE/, '🔴 负责团队没抽成结构化字段');
    assert.match(String(extracted.targetPrice ?? ''), /500/, '🔴 价格接受度没抽成结构化字段');

    const refs = await commit(stagingId);
    assert.ok(refs.opportunityId, '没建商机');
    const opp = (await twenty(`/rest/opportunities/${refs.opportunityId}`))?.opportunity;
    assert.equal(
      opp?.nextDecisionWindow?.slice(0, 10),
      '2026-10-31',
      '🔴 「2026 年 10 月底前」没转成日期 —— 按决策窗口排的视图会是空的',
    );
    assert.equal(
      Number(opp?.amount?.amountMicros) / 1e6,
      9_000_000,
      '🔴 预算没落到金额字段上，筛不出来',
    );
  });
});

describe('T02 · 从商机建项目（有需求文档）', () => {
  it('项目建出来、挂上来源商机、附件成为需求基线 v1.0', async () => {
    const { stagingId, extracted } = await say(
      `Havel 已经正式确定我们作为 12V 锂电池供应商，请基于之前的商机创建项目。` +
        `项目名称是「Havel 150Ah CI-Bus 电池供应项目」，项目编号 ${P1}，` +
        `由欧洲 OE 项目团队负责，当前阶段是客户定点，首年项目预算 840 万欧元。详细参数见附件。`,
      {
        name: '产品需求规格书.md',
        body:
          '# 产品需求规格书\n\n| 文档编号 | HYM-REQ-001 |\n| 版本 | v1.0 |\n\n' +
          '## 供货范围\n- 型号：VLB12150-CIBUS\n- 样品数量：20 台\n\n' +
          '## 电气参数\n- 标称电压 12.8V，标称容量 150Ah\n- 持续放电 150A，峰值 300A 持续 10 秒\n\n' +
          '## 通信要求\n- CI-Bus，从机模式，波特率 500 kbit/s\n\n' +
          '## 项目里程碑\n| 里程碑 | 目标日期 |\n| 样品交付 | 2026-09-30 |\n| SOP | 2027-03-01 |\n\n' +
          '## 待确认事项\n- 4 Pin 连接器最终料号\n- 报文 ID 与字节序\n',
      },
    );

    assert.equal(extracted.project?.projectCode, P1, '🔴 项目编号没照抄 —— 幂等全靠它');
    assert.ok(extracted.document, '🔴 客户给的规格书没被登记成文档');
    assert.equal(
      extracted.document?.docSource,
      'CUSTOMER_ATTACHMENT',
      '🔴 客户给的附件被标成了别的来源 —— 来源混淆是这套系统最贵的错',
    );

    const refs = await commit(stagingId);
    assert.ok(refs.projectId, '没建项目');
    const p = (await twenty(`/rest/projects/${refs.projectId}?depth=1`))?.project;
    assert.equal(p?.projectCode, P1);
    assert.ok(p?.opportunity?.id, '🔴 项目没挂来源商机 —— T02 要求双向可查');
    assert.equal(Number(p?.budget?.amountMicros) / 1e6, 8_400_000, '预算没进去');
    assert.ok(
      String(p?.specSummary?.markdown ?? '').includes('150'),
      '🔴 附件里的参数没进项目 —— T02 断言「关键参数可在项目记录中查看或检索」',
    );
    assert.ok(
      String(p?.openQuestions?.markdown ?? '').length > 10,
      '🔴 附件的「待确认事项」没单独留 —— 混进正文就分不清哪些是确认过的',
    );

    const docs = (await twenty(`/rest/projectDocs?filter=${encodeURIComponent(`projectId[eq]:${refs.projectId}`)}`))
      ?.projectDocs ?? [];
    const baseline = docs.find((d: any) => d.isBaseline);
    assert.ok(baseline, '🔴 附件没被标成需求基线');
    assert.ok(baseline.attachmentId, '🔴 没留原件 id —— 那份文件就再也取不回来了');
  });

  it('🔴 同一个项目编号重复提交，不产生第二条项目', async () => {
    const before = ((await twenty('/rest/projects?limit=200'))?.projects ?? []).filter(
      (p: any) => p.projectCode === P1,
    ).length;
    assert.equal(before, 1, '前置条件：这个编号应该只有一条');

    const { stagingId } = await say(
      `更新 ${P1}：项目已经进入样品测试阶段，样品数量确认 20 台。`,
    );
    await commit(stagingId);

    const after = ((await twenty('/rest/projects?limit=200'))?.projects ?? []).filter(
      (p: any) => p.projectCode === P1,
    );
    assert.equal(
      after.length,
      1,
      '🔴 同一个编号建出了第二条项目 —— 幂等破了，之后所有跟进都会分叉',
    );
  });
});

describe('T03 · 无文档，仅口述参数', () => {
  it('照样建出项目，并生成一份标明来源的文档；没说的列为待确认', async () => {
    const { stagingId, extracted } = await say(
      `再建一个无附件的测试项目，名称叫「口述需求项目」，编号 ${P2}，由欧洲 OE 项目团队负责，` +
        `目前是客户定点阶段，预算 420 万欧元。客户要 12V 150Ah 磷酸铁锂电池，CI-Bus 通讯，` +
        `峰值放电 300A 持续 10 秒，持续放电 150A，IP65，样品先要 10 台。` +
        `没有规格书，请把我说的整理成一份需求文档，没说到的列为待确认，不要自行补成客户已确认参数。`,
    );

    assert.equal(extracted.project?.projectCode, P2);
    assert.notEqual(extracted.project?.projectCode, P1, '🔴 和 T02 的项目撞编号了');

    const doc = extracted.document;
    assert.ok(doc, '🔴 没附件时没有生成文档 —— T03 的核心要求');
    assert.ok(
      ['DICTATION', 'AGENT_GENERATED'].includes(doc.docSource),
      `🔴 口述整理的文档来源标成了 ${doc.docSource} —— 会被当成客户确认过的规格`,
    );
    assert.match(
      String(doc.content ?? ''),
      /未经客户书面确认|未经客户确认|根据口述整理/,
      '🔴 生成的文档没写明「根据口述整理，未经客户书面确认」',
    );
    assert.ok(
      String(extracted.project?.openQuestions ?? '').length > 10,
      '🔴 没提到的参数没列进待确认 —— T03 断言：不能编造为已确认值',
    );

    const refs = await commit(stagingId);
    const docs = (await twenty(`/rest/projectDocs?filter=${encodeURIComponent(`projectId[eq]:${refs.projectId}`)}`))
      ?.projectDocs ?? [];
    assert.ok(docs.length, '文档没进 CRM');
    assert.equal(
      docs[0].reviewStatus,
      'DRAFT',
      '🔴 AI 整理的文档不是草稿状态 —— 「客户已确认」只能由人给',
    );
  });
});

describe('T04 / T05 · 跟进拆成可分派的线程', () => {
  it('复合需求拆成文档/硬件/协议/软件四条，依赖可见，客户日期与内部截止都留', async () => {
    const { stagingId, extracted } = await say(
      `更新 ${P1}。客户对 CI-Bus 兼容性有疑问，需要通信端口说明、Pin 脚定义、协议详细说明，` +
        `以及一份可运行的测试代码。请按文档、硬件接口、通信协议、测试软件四条线程拆开记录，` +
        `都挂在同一个项目和本次跟进下面。接口与 Pin 定义最优先，客户希望 2026 年 8 月 14 日前收到第一版回复。`,
    );

    const items = extracted.workItems ?? [];
    assert.ok(items.length >= 4, `🔴 只拆出 ${items.length} 条 —— T04 要四条独立可分派的线程`);
    const types = new Set(items.map((w: any) => w.threadType));
    for (const t of ['doc', 'hardware', 'protocol', 'software']) {
      assert.ok(types.has(t), `🔴 缺「${t}」这条线 —— 拆不开就没法分别派人`);
    }
    const hw = items.find((w: any) => w.threadType === 'hardware');
    assert.equal(hw?.priority, 'URGENT', '🔴 「接口与 Pin 定义最优先」没体现在优先级上');
    assert.ok(
      items.some((w: any) => w.customerDueDate === '2026-08-14'),
      '🔴 客户期望日期没留下 —— T04 断言「客户要求日期…均被保留」',
    );
    assert.ok(
      items.some((w: any) => String(w.blockedByCodes ?? '').trim()),
      '🔴 四条线之间没有依赖关系 —— 测试代码本来依赖 Pin 定义和协议',
    );

    const refs = await commit(stagingId);
    assert.ok(refs.followupId, '🔴 没有跟进记录 —— 四条线程会变成没有来源的孤立事项');

    const v = (await twenty(`/rest/visits/${refs.followupId}?depth=1`))?.visit;
    assert.equal(v?.visitType, 'PROJECT_FOLLOWUP', '跟进没标成项目跟进');
    assert.equal(v?.project?.projectCode, P1, '🔴 跟进没挂到项目上');

    const ws = (await twenty(`/rest/workItems?filter=${encodeURIComponent(`projectId[eq]:${refs.projectId}`)}&limit=100&depth=1`))
      ?.workItems ?? [];
    const mine = ws.filter((w: any) => w.followup?.id === refs.followupId);
    assert.ok(mine.length >= 4, '🔴 线程没挂在这次跟进下 —— 父记录就汇总不了进度');
    assert.ok(
      ws.some((w: any) => w.blockedBy?.id),
      '🔴 依赖关系在 CRM 里看不见 —— T04 断言「问题之间的依赖关系可见」',
    );
    assert.ok(
      ws.every((w: any) => w.itemStatus),
      '线程没有初始状态，就没法跟踪',
    );
  });
});

/**
 * T06 · 售后：**从发生到关闭**（手册 P23 / D25 / D57）
 *
 * 补这一条的直接原因很实际：2026-08-03 在 Chrome 里逐页看 CRM，
 * 「售后问题」整张表是空的 —— 而 T01–T05 五条用例**一条售后都不涉及**。
 * 表是空的不是 bug，但「没有任何验收用例走过售后这条链」是。
 *
 * 它和商机的方向正好相反（D25）：商机是往前推进，售后是从发生到关闭。
 * 手册 P23 的原话：「**进展是新加的一行 · 三个人记在同一条下 · 状态往前走一格**」。
 */
describe('T06 · 售后：三个人记在同一条上，状态往前走一格', () => {
  it('新开一条 → 第二次接在同一条上追加，不新建第二条', async () => {
    const { stagingId, extracted } = await say(
      'Havel 那边报了个问题：交付的第 3 批车里有 12 台，逆变器在低温启动时会断电重启。' +
        '客户很急，已经影响到终端用户交付了。',
    );
    assert.equal(extracted.recordType, 'support', '🔴 认成了别的类型 —— 售后会落进选型情报里');

    const refs = await commit(stagingId);
    assert.ok(refs.supportCaseId, '🔴 没建售后记录');
    const c1 = (await twenty(`/rest/supportCases/${refs.supportCaseId}?depth=1`))?.supportCase;
    // ⚠️ `issueDescription` 是 **RICH_TEXT** —— 读回来是 `{blocknote, markdown}` 对象，
    //    `String(它)` 得到的是 "[object Object]"。整个 stringify 再找（实测踩过）。
    assert.match(
      JSON.stringify(c1?.issueDescription ?? ''),
      /逆变器|断电/,
      '🔴 问题正文没进去',
    );

    // ── 第二个人来记进展。**人点了「接在这条上」才追加**（D57）──────
    const follow = await say('Havel 那个逆变器低温断电的事：现场换了一批固件，先观察一周。');
    const r2 = await api(`/staging/${follow.stagingId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId: havelId, supportCaseId: refs.supportCaseId }),
    });
    assert.equal(r2.status, 200, `接续确认失败：${JSON.stringify(r2.json).slice(0, 200)}`);
    for (let i = 0; i < 40; i++) {
      const [s] = await sql<Array<{ status: string }>>`
        select status from staging where id = ${follow.stagingId}`;
      if (s?.status === 'confirmed') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const [s2] = await sql<Array<{ twenty_refs: any }>>`
      select twenty_refs from staging where id = ${follow.stagingId}`;
    assert.equal(
      s2?.twenty_refs?.supportCaseId,
      refs.supportCaseId,
      '🔴 又新开了一条 —— 同一个问题在 CRM 里会变成两条，谁也不知道哪条是最新的',
    );
    assert.equal(s2?.twenty_refs?.supportCaseAppended, 'yes', '没留下「这是追加不是新建」的痕迹');

    // 进展**追加在 `issueDescription` 里**，没有单独的 progressLog 字段 ——
    // 一条 case 的全部历史在同一段正文里，从上往下读就是时间顺序。
    const c2 = (await twenty(`/rest/supportCases/${refs.supportCaseId}?depth=1`))?.supportCase;
    const full = JSON.stringify(c2?.issueDescription ?? '');
    assert.match(full, /固件|观察/, '🔴 进展没加进去 —— 手册 P23：「进展是新加的一行」');
    // 🔴 追加**不能把原来的问题描述冲掉**。这是最容易发生又最难发现的一种丢数据：
    //    看起来 case 还在、还有内容，只是「当初报的是什么」没了。
    assert.match(full, /逆变器|断电/, '🔴 追加进展时把原始问题描述覆盖掉了');
  });
});

/**
 * T07 · **全新项目识别**（`docs/test_example` T07 / issue #17）
 *
 * 🔴 这一条是 2026-08-05 手机实测直接产生的。维护者 拿一个真实的 CI-Bus
 * 新项目走了一遍，结论是「完全没有按照我的预期」：它被记成了**选型情报**。
 *
 * 事后查出来这不是模型能力问题，是**它没地方表达「这是项目」**：
 * `list_enums` 用的是 `RECORD_TYPES`（V1，只有 fitment/support），
 * 而给人用的 `/enums` 用的是 V2（四种）。系统提示词第一条就是
 * 「先 list_enums 看合法值」—— 它照做了，工具告诉它项目不存在。
 *
 * T02 测的是「从已有商机建项目」，前提是客户和商机都在。
 * **这一条测的是最难的那个入口：什么都还没有的时候，它认不认得出来。**
 *
 * ⚠️ **客户必须用一家本套件没碰过的**（2026-08-05，T51 实测三轮）。
 * 原来写的是 Havel —— 而 T02/T03 恰好也在 Havel 名下建了「150Ah CI-Bus 电池
 * 供应项目」（同产品、同样品数、已到 SAMPLE_TESTING）。于是模型每一轮都把
 * 这条判成**那个项目的更新**、照抄它的编号 —— 平心而论它没读错：
 * 同一家客户、同一单生意，「立项」接在「样品测试」后面就是同一个项目的推进。
 * 这一条要测的是 issue #17 的原始场景 —— **CRM 里什么都没有**的时候认不认得出
 * 「这是项目」—— 所以换 Alpin：套件里没有任何东西挂它名下，场景干净。
 * （「名下已有相近项目时该更新还是新建」是另一道题，人对着核对卡都要想一下，
 * 不适合拿全绿/全红的断言去卡模型。）
 */
describe('T07 · 全新项目：口述、无附件、时间线要变成可跟踪的线程', () => {
  it('认出这是项目而不是选型情报，并把口述的时间线拆成线程', async () => {
    const { stagingId, extracted } = await say(
      '刚跟 Alpin 那边开完会，CI-Bus 这个事定下来了，他们决定用我们的方案，要正式立一个项目。' +
        '核心产品是 VLB12150-CIBUS，先做 20 台样品。' +
        '时间上：八月中我们把通信协议说明发过去，九月他们装车做整车验证，' +
        '十一月底前要完成 ECWVTA 相关的测试，明年三月 SOP。' +
        '项目这边我们出欧洲 OE 项目团队。连接器型号他们还没定，等他们给。',
    );

    // ── ① 记录类型。这是 issue #17 的原始症状 ────────────────────────
    assert.equal(
      extracted.recordType,
      'project',
      `🔴 记成了「${extracted.recordType}」而不是 project —— ` +
        'issue #17 的原始症状。先看 list_enums 里到底有没有 project（agent.test.ts 有对账用例）',
    );

    // ── ② 项目提案本身。只交字段不交项目 = CRM 里什么都不会长出来 ──────
    const proj = extracted.project as Record<string, any> | undefined;
    assert.ok(proj, '🔴 没有项目提案 —— propose_fields 和 propose_project 是两个都要，不是二选一');
    assert.match(String(proj!.name ?? ''), /CI.?Bus/i, '项目名里没有 CI-Bus');
    assert.match(
      String(proj!.primaryProductName ?? ''),
      /VLB12150/i,
      '核心产品型号丢了 —— 后面所有人拿这个型号找记录',
    );
    assert.equal(proj!.sampleQty, 20, '样品数量不对');
    assert.match(String(proj!.plannedSop ?? ''), /^\d{4}-03-/, '计划 SOP 没转成日期（「明年三月」）');
    assert.match(
      String(proj!.openQuestions ?? ''),
      /连接器/,
      '🔴 「连接器型号还没定」没进待确认 —— T03 的同一条断言：不能编造为已确认值',
    );

    // ── ③ 🔴 时间线必须是**可跟踪的线程**，不是 details 里的四行文字 ────
    //     维护者 的原话：「为什么不能在 CRM 中也创建相应的时间线管理，
    //     将内容结构化，而不是只是记录一堆详情」。
    const items = (extracted.workItems ?? []) as Array<Record<string, any>>;
    assert.ok(
      items.length >= 4,
      `🔴 只拆出 ${items.length} 条 —— 原话里有四个时间点（8月中/9月/11月底/明年3月），` +
        '每一个都该是一条能排期、能提醒、能看出谁卡住谁的线程',
    );
    assert.ok(
      items.filter((w) => w.dueDate).length >= 3,
      '🔴 线程上没有日期 —— 没有日期的「时间线」在 CRM 里排不了期，等于还是一段文字',
    );

    // ── ④ 不许自己编项目编号（编错了下次认不出是同一个项目）──────────
    //     留空是**正确行为**：网关会在确认那一步生成一个建议编号。
    if (proj!.projectCode) {
      assert.match(
        String(proj!.projectCode),
        /^[A-Z0-9][A-Z0-9-]{2,39}$/,
        '编号格式不合规 —— 服务端白名单会把它拒掉',
      );
    }

    // ── ⑤ 「我刚跟他们开完会」= 本人在场 = 一手（issue #3 的同一条）────
    assert.equal(
      extracted.sourceConfidence,
      'CONFIRMED',
      '🔴 本人在场的会议被判成了转述 —— issue #3 修过一次，别回退',
    );

    // ── ⑥ 入库之后 CRM 里**真的有这个项目** ─────────────────────────
    //     这是 issue #17 根因 D：以前编号留空 → commit 静默跳过 →
    //     界面绿色的「已入库」，而 CRM 里什么都没有。
    const refs = await commit(stagingId);
    assert.ok(
      refs.projectId,
      `🔴 确认入库了但 CRM 里没有项目。refs=${JSON.stringify(refs)} —— ` +
        'issue #17 根因 D：没有编号时以前会静默跳过，现在应该由网关生成一个',
    );
    const p = (await twenty(`/rest/projects/${refs.projectId}?depth=1`))?.project;
    assert.ok(p?.projectCode, '🔴 项目建了但没有编号 —— 编号是幂等的支点，下次认不出是同一个');
    assert.ok(p?.company?.id, '项目没挂客户');
  });
});

describe('跨用例 · 完整业务链', () => {
  it('客户 → 商机 → 项目 → 跟进 → 线程 → 文档，一条都不断', async () => {
    const p = ((await twenty('/rest/projects?limit=200&depth=1'))?.projects ?? []).find(
      (x: any) => x.projectCode === P1,
    );
    assert.ok(p, '项目不在了');
    assert.ok(p.company?.id, '项目没挂客户');
    assert.ok(p.opportunity?.id, '项目没挂来源商机');

    const [ws, ds, vs] = await Promise.all([
      twenty(`/rest/workItems?filter=${encodeURIComponent(`projectId[eq]:${p.id}`)}&limit=100`),
      twenty(`/rest/projectDocs?filter=${encodeURIComponent(`projectId[eq]:${p.id}`)}&limit=50`),
      twenty(`/rest/visits?filter=${encodeURIComponent(`projectId[eq]:${p.id}`)}&limit=50`),
    ]);
    assert.ok((ws?.workItems ?? []).length, '项目下没有任务线程');
    assert.ok((ds?.projectDocs ?? []).length, '项目下没有文档');
    assert.ok((vs?.visits ?? []).length, '项目下没有跟进记录');

    // 🔴 来源必须分得开 —— 跨用例断言里最要紧的一条
    const sources = new Set((ds.projectDocs ?? []).map((d: any) => d.docSource));
    assert.ok(
      sources.size >= 1 && [...sources].every(Boolean),
      '🔴 有文档没标来源 —— 分不清哪份是客户给的、哪份是 AI 写的',
    );
  });
});
