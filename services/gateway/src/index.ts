import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';

import { env, assertEnv } from './env.ts';
import { sql, publicUser, canSeeBoard, type AppUser } from './db.ts';
import { verifyPassword, signToken, userFromToken } from './auth.ts';
import { findSimilar } from './match.ts';
import {
  enqueue,
  enqueueTranscribe,
  reapStaleRuns,
  resumePending,
  agentHealth,
  abortInbox,
  forgetThreadHistory,
  warnIfColumnSwitchOn,
  industryTerms,
  transcribe,
  selfTestTranscribe,
  makeTitle,
} from '../agent/src/index.ts';
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_LABELS,
  CASE_STATUSES,
  CASE_STATUS_LABELS,
  CATEGORIES,
  CATEGORY_LABELS,
  CATEGORY_LABELS_EN,
  CASE_STATUS_LABELS_EN,
  SEVERITY_LABELS_EN,
  STAGE_LABELS_EN,
  CONFIDENCE_LABELS_EN,
  ACCOUNT_TYPE_LABELS_EN,
  RECORD_TYPE_LABELS_EN,
  labelsFor,
  type Locale,
  CONFIDENCES,
  CONFIDENCE_LABELS,
  RECORD_TYPES_V2,
  RECORD_TYPE_LABELS,
  SEVERITIES,
  SEVERITY_LABELS,
  STAGES,
  STAGE_LABELS,
  isValidChain,
  keepAccountType,
  keepCategory,
} from '../agent/src/enums.ts';
import {
  cancelConfirm,
  requestConfirm,
  requestReconfirm,
  sanitizeFieldEdits,
  resumeConfirming,
  startConfirmTicker,
} from './confirm.ts';
import { computeGaps } from './gaps.ts';
import { registerSurveys, resumeSurveys, startSurveyTicker, surveyHealth } from './surveys.ts';
import {
  createCompany,
  findOpportunity,
  findProjectByCode,
  findSupplierId,
  getCompanyByCode,
  getCompanyById,
  listCompanies,
  listOpenSupportCases,
  listIntelItems,
  listIntelValues,
  listSuppliers,
  setSoldVia,
  softDeleteRecords,
  restoreRecords,
} from './twenty.ts';
import { describe as describePlan, labelOf, plan as deletionPlan, type DeletableRow } from './deletion.ts';
// 改口会盖掉什么：**预览和执行共用这一份判断**（D108 · issue #37）
import { inheritance, ownerOf, scopeOf } from './supersede.ts';
import { suggestProjectCode } from './projectCode.ts';
import { registerAdmin } from './admin.ts';
import { portalStatus, registerPortal } from './portal.ts';
import { ingestNote } from './ingest.ts';
import {
  registerChannels,
  registerLabChannel,
  startChannelTicker,
  channelStatus,
} from './channels/route.ts';

// 缺必填配置就别启动 —— env 的字段是惰性的（见 env.ts），这里显式兜住
assertEnv();

const app = Fastify({ logger: { level: 'warn' } });
await app.register(cors, { origin: true });
// 25 MB → 40 MB：加了附件之后，一张 iPhone 原图 5–8 MB，一份产品 PDF 十几 MB。
// 上限不是越大越好 —— 展馆里 4G 上行本来就慢，太大的文件会卡住整个队列。
await app.register(multipart, { limits: { fileSize: 40 * 1024 * 1024, files: 8 } });

declare module 'fastify' {
  interface FastifyRequest {
    user?: AppUser;
  }
}

/** 鉴权钩子。**每次请求查库** —— 撤权立即生效（D35⑤）。 */
const requireAuth = async (req: any, reply: any) => {
  const h = req.headers.authorization ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const user = token ? await userFromToken(token) : null;
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  req.user = user;
};

// ── 健康检查 ────────────────────────────────────────────────────
app.get('/health', async () => ({ ok: true, at: new Date().toISOString() }));

/** agent 的健康。冒烟脚本盯着它 —— 队列积压是「等你发现时已经影响所有人」的那类问题。 */
app.get('/agent/health', async () => ({
  ...agentHealth(),
  channels: channelStatus(),
  // 2C 问卷进不去 Twenty 时（多半是 schema 没 provision），这一格是唯一看得见的地方（D138）
  surveys: await surveyHealth().catch(() => null),
  // D139：订单门户那组接口开没开（PORTAL_SECRET 留空 = off = 整组 503）
  portal: portalStatus(),
}));

// ── 登录 ────────────────────────────────────────────────────────
app.post('/auth/login', async (req, reply) => {
  const { userCode, password } = (req.body ?? {}) as { userCode?: string; password?: string };
  if (!userCode || !password) return reply.code(400).send({ error: 'missing_fields' });

  const [u] = await sql<Array<AppUser & { password_hash: string }>>`
    select id, user_code, display_name, role, is_active, token_version, locale, password_hash
    from app_user where user_code = ${userCode}`;

  // 用户不存在与密码错误返回**同一个**错误 —— 不泄漏账号是否存在
  if (!u || !u.is_active || !(await verifyPassword(password, u.password_hash)))
    return reply.code(401).send({ error: 'invalid_credentials' });

  return { token: await signToken(u), user: me(u) };
});

/**
 * 用户信息。
 *
 * 🔴 `boardUrl` **由服务端按 role 决定发不发**（§4.2 第4条）。
 * 前端拿不到这个字段就没有看板可点 —— 而不是「前端拿到了但藏起来」。
 * 前端过滤等于没过滤：改一行 JS 就能看到。这是六个必须有的测试里的第 6 条。
 */
const me = (u: AppUser) => ({
  ...publicUser(u),
  ...(canSeeBoard(u.role) ? { boardUrl: env.boardUrl } : {}),
});

app.get('/me', { preHandler: requireAuth }, async (req) => ({ user: me(req.user!) }));

/**
 * 改自己的界面语言（D83）。**这是 `app_user.locale` 唯一的写入口。**
 *
 * 🔴 **只能改自己的。** 没有 `?userCode=`，路径里也没有别人的位置 ——
 * 和 `/records` 不接受 `scope` 参数同一条判据（§4.2 第 4 条的最强形式：
 * 没有参数就没有传错的可能）。管理员要替别人改，走管理台，不是这里。
 *
 * 🔴 **只认 'zh' / 'en'，不接受浏览器给的 `Accept-Language`。** 语言是账号上的属性
 * （D80），库里还有 check 约束兜着 —— 因为这个值会被拼进 agent 的 prompt
 * （「用什么语言写小结」），一个没人认识的值传到那里模型会自己发挥。
 *
 * 语言不是权限，所以**不动 `token_version`** —— 改个语言不该把自己踢下线。
 */
app.patch('/me', { preHandler: requireAuth }, async (req, reply) => {
  const { locale } = (req.body ?? {}) as { locale?: unknown };
  if (locale !== 'zh' && locale !== 'en')
    return reply.code(400).send({ error: 'bad_locale', hint: "只认 'zh' 或 'en'" });

  const [u] = await sql<AppUser[]>`
    update app_user set locale = ${locale}
    where id = ${req.user!.id}
    returning id, user_code, display_name, role, is_active, token_version, locale`;
  if (!u) return reply.code(404).send({ error: 'not_found' });
  return { user: me(u) };
});

// ── 客户名单（供 PWA 离线缓存）──────────────────────────────────
app.get('/companies', { preHandler: requireAuth }, async () => ({
  items: await listCompanies(),
  accountTypes: ACCOUNT_TYPES,
}));

/**
 * 枚举 + 中文标签。**PWA 要把它缓存进 IndexedDB 离线用。**
 *
 * 核对卡上的「改一格」（手册 P8）弹出的就是这些选项。展馆里断网时
 * 那个弹层不能是空的 —— 否则「改一格」这一步在最需要它的场合失效。
 *
 * 值和标签都从 `agent/enums.ts` 来，那是网关侧唯一的枚举来源；
 * 前端**不许自己维护一份**（自己维护 = 加了新品类界面上永远选不到）。
 */
app.get('/enums', { preHandler: requireAuth }, async (req) => {
  /**
   * 🔴 **标签按当前用户的语言给，作用域和别处一样在服务端**（D80）。
   *
   * 不接受 `?locale=` 这样的参数：语言是账号上的属性，
   * 让前端传就等于让前端说了算 —— 和 §4.2 第 4 条同一条判据。
   * 找不到英文时 `labelsFor` 退回中文，绝不退回裸的枚举值。
   */
  const L = req.user!.locale === 'en' ? 'en' : 'zh';
  const cat = labelsFor(L, CATEGORY_LABELS, CATEGORY_LABELS_EN);
  const stg = labelsFor(L, STAGE_LABELS, STAGE_LABELS_EN);
  const cs = labelsFor(L, CASE_STATUS_LABELS, CASE_STATUS_LABELS_EN);
  const sev = labelsFor(L, SEVERITY_LABELS, SEVERITY_LABELS_EN);
  const conf = labelsFor(L, CONFIDENCE_LABELS, CONFIDENCE_LABELS_EN);
  const acc = labelsFor(L, ACCOUNT_TYPE_LABELS, ACCOUNT_TYPE_LABELS_EN);
  const rt = labelsFor(L, RECORD_TYPE_LABELS, RECORD_TYPE_LABELS_EN);
  return {
    locale: L,
    // D59：四种了 —— 界面上「记成什么」那一格要能选到项目和跟进
    recordType: RECORD_TYPES_V2.map((v) => ({ value: v, label: rt[v] ?? v })),
    category: CATEGORIES.map((v) => ({ value: v, label: cat[v] ?? v })),
    stage: STAGES.map((v) => ({ value: v, label: stg[v] ?? v })),
    caseStatus: CASE_STATUSES.map((v) => ({ value: v, label: cs[v] ?? v })),
    severity: SEVERITIES.map((v) => ({ value: v, label: sev[v] ?? v })),
    confidence: CONFIDENCES.map((v) => ({ value: v, label: conf[v] ?? v })),
    accountType: ACCOUNT_TYPES.map((v) => ({ value: v, label: acc[v] ?? v })),
  };
});

/** 查重接口。前端在「新建客户」那一步**必须**先调它（后端也会再查一次）。 */
app.get('/companies/search', { preHandler: requireAuth }, async (req) => {
  const { q } = req.query as { q?: string };
  const items = await listCompanies();
  return { items: findSimilar(q ?? '', items, { limit: 8 }).map((h) => ({ ...h.item, score: h.score })) };
});

/**
 * 新建客户（维护者 2026-07-30：不需要审批，但必须 specify 名字、国家、类型）。
 *
 * 🔴 **查重是强制的，而且在服务端。** 前端查过一遍不算数 ——
 * 销售那份 Excel 就是因为同一家客户有三种写法而散架的（品牌名单交集 32/61）。
 * 命中相似项时回 409 + 候选列表，客户端必须显式带 `confirmedUnique: true` 才放行，
 * 那一下是**人**看过候选之后按的。
 */
app.post('/companies', { preHandler: requireAuth }, async (req, reply) => {
  const b = (req.body ?? {}) as {
    name?: string;
    country?: string;
    accountType?: string;
    parentCode?: string;
    confirmedUnique?: boolean;
  };
  const name = (b.name ?? '').trim();
  const country = (b.country ?? '').trim();
  const accountType = keepAccountType(b.accountType);

  const missing = [!name && 'name', !country && 'country', !accountType && 'accountType'].filter(
    Boolean,
  );
  if (missing.length) return reply.code(422).send({ error: 'missing_fields', missing });

  const items = await listCompanies();
  const dupes = findSimilar(name, items, { limit: 5 });
  if (dupes.length && !b.confirmedUnique) {
    return reply.code(409).send({
      error: 'possible_duplicate',
      candidates: dupes.map((d) => ({ ...d.item, score: d.score })),
    });
  }

  // 代号：从名字生成，冲突就加序号。人看得懂，且稳定（D30）。
  const base =
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 16) || 'NEW';
  const taken = new Set(items.map((i) => i.code));
  let code = base;
  for (let i = 2; taken.has(code); i++) code = `${base}-${i}`;

  const parent = b.parentCode ? items.find((i) => i.code === b.parentCode) : null;
  const id = await createCompany({
    name,
    accountCode: code,
    accountType: accountType!,
    hqCountry: country,
    parentCompanyId: parent?.id ?? null,
  });

  // 谁建的要留痕（维护者 的原话：记录 recordedBy 谁就行了）
  await sql`
    insert into intel_field_log (item_key, question, value_type, applies_to, company_code, value, created_by)
    values (${`company_created:${code}`}, ${'新建客户'}, ${'text'}, ${'company'}, ${code},
            ${`${name} · ${country} · ${accountType}`}, ${req.user!.user_code})
    on conflict (item_key) do nothing`;

  return reply.code(201).send({ id, code, name, country, accountType });
});

/**
 * 渠道链（D54）—— 两个端点，**分开是刻意的**。
 *
 *   resolve：把 agent 给的名字对到已有客户上，对不上的报出来
 *   link   ：拿人确认过的 id 列表，设 `soldVia`
 *
 * 为什么不合成一个：合成一个就意味着「对不上就自动建」——
 * 而 §4.2 第3条说关系字段只能指向**已存在**的记录，建客户必须经过
 * `POST /companies` 那道强制查重。分成两步，中间那一步才留得下人的判断。
 */
app.post('/chain/resolve', { preHandler: requireAuth }, async (req, reply) => {
  const { chain } = (req.body ?? {}) as { chain?: Array<{ name: string; role: string }> };
  if (!Array.isArray(chain) || !chain.length) return reply.code(422).send({ error: 'empty' });

  const items = await listCompanies();
  return {
    levels: chain.map((c) => {
      const hits = findSimilar(c.name, items, { limit: 3 });
      // 完全一致才算「认出来了」；差一点的只作为候选给人看
      const exact = hits.find((h) => h.score >= 0.99);
      return {
        name: c.name,
        role: keepAccountType(c.role) ?? c.role,
        matched: exact ? { id: exact.item.id, code: exact.item.code, name: exact.item.name } : null,
        candidates: hits
          .filter((h) => h !== exact)
          .map((h) => ({ id: h.item.id, code: h.item.code, name: h.item.name, score: h.score })),
      };
    }),
  };
});

/** 建立链路。**顺序必须从上游到下游**，反了直接拒绝。 */
app.post('/chain/link', { preHandler: requireAuth }, async (req, reply) => {
  const { levels } = (req.body ?? {}) as { levels?: Array<{ companyId: string }> };
  if (!Array.isArray(levels) || levels.length < 2) {
    return reply.code(422).send({ error: 'need_at_least_two' });
  }

  const items = await listCompanies();
  const resolved = levels.map((l) => items.find((i) => i.id === l.companyId));
  if (resolved.some((r) => !r)) return reply.code(404).send({ error: 'unknown_company' });

  const types = resolved.map((r) => r!.type);
  if (!isValidChain(types)) {
    return reply.code(422).send({
      error: 'bad_order',
      hint: '渠道链必须从上游到下游：分销商 → 二级分销商 → 经销商 → 二级经销商 → 终端客户',
      got: types,
    });
  }

  // 逐级往上挂：下游的 soldVia 指向它的上游
  for (let i = 1; i < resolved.length; i++) {
    await setSoldVia(resolved[i]!.id, resolved[i - 1]!.id);
  }
  return { linked: resolved.length - 1, chain: resolved.map((r) => ({ id: r!.id, name: r!.name, type: r!.type })) };
});

// ── 对话线程 ────────────────────────────────────────────────────
/** 历史列表里**只有没删的**（D102 · issue #33）。删掉的靠撤销回来，见下面那两个端点。 */
app.get('/threads', { preHandler: requireAuth }, async (req) => {
  const rows = await sql`
    select t.id, t.title, t.company_code, t.created_at, t.last_message_at,
           (select count(*) from thread_message m where m.thread_id = t.id)::int as messages
    from thread t where t.user_id = ${req.user!.id} and t.deleted_at is null
    order by t.last_message_at desc limit 100`;
  return { items: rows };
});

app.post('/threads', { preHandler: requireAuth }, async (req, reply) => {
  const { title, companyCode } = (req.body ?? {}) as { title?: string; companyCode?: string };
  const [t] = await sql<Array<{ id: string }>>`
    insert into thread (user_id, title, company_code)
    values (${req.user!.id}, ${title ?? null}, ${companyCode ?? null}) returning id`;
  return reply.code(201).send({ id: t!.id });
});

/**
 * 一条对话的全文。
 *
 * 🔴 **删掉的照样返回，只多带一格 `deleted_at`**（D102 · issue #33）。
 * 回 404 的话，从看板那一行点「去对话里看」会落到一屏静默的空白 ——
 * 而人删掉的是「它出现在历史列表里」，不是这条链接。
 * 界面据此打一条横幅（「这条对话已删除 · 恢复」），
 * **「看不见」和「不存在」必须分得开**，这条判据在这个仓库里写第七遍了。
 */
app.get('/threads/:id', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  // 作用域在**服务端**裁：只能看自己的对话
  const [t] = await sql<Array<{ id: string; title: string | null; deleted_at: string | null }>>`
    select id, title, deleted_at from thread where id = ${id} and user_id = ${req.user!.id}`;
  if (!t) return reply.code(404).send({ error: 'not_found' });

  const messages = await sql`
    select m.id, m.role, m.text, m.inbox_id, m.meta, m.created_at,
           -- 🔴 被改口取代的那些（D90 · issue #23）。**照样返回、照样显示** ——
           -- 取代不是删除，原话一个字没动。界面淡一档 + 一句「已改」，
           -- 因为「看不见」和「不存在」必须分得开（这个仓库最贵的 bug 全长那样）。
           ms.superseded_by, ms.reason as supersede_reason,
           s.id as staging_id, s.status, s.extracted, s.confidence, s.partial, s.suggested_company,
           -- 确认状态也要带回去。少了这两个，界面上「已入库 · N 秒内可撤销」
           -- 就只能靠组件自己的内存 state —— 而一次轮询重渲染就没了（实测踩到）
           s.confirm_after, s.twenty_refs,
           -- 🔴 工作日志（D74）。轨迹每一步本来就落在库里（agent_run 为「盲盒」
           -- 问题而建），但这里从来没带出去 —— 于是对话一完成，人就再也看不到
           -- 它当时做了什么。维护者 2026-08-06：「思考流程记录就不在了」。
           s.agent_trace, s.agent_steps,
           run.stop_reason as run_stop_reason, run.duration_ms as run_duration_ms,
           -- D75：重录失败的原因要能到卡片上（比如编号冲突）——
           -- 不带的话失败是静默的：卡片还是绿的「已入库」，改动没生效
           s.error as staging_error,
           -- D75：人上次确认时改过的那几格。重录界面显示的必须是**入库的值**，
           -- 只显示 extracted 的话，上次已经改过 stage 的人会看到旧值以为丢了
           s.confirm_payload->'fields' as confirmed_fields,
           -- 附件。不带的话，人在对话里**根本看不到自己传了什么**，
           -- 只能凭记忆相信它上去了（维护者 2026-08-03 实测的第一条抱怨）
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'id', a.id, 'name', a.filename, 'kind', a.kind, 'bytes', a.bytes,
               'parsed', t.status, 'chars', coalesce(t.chars, 0)) order by a.created_at)
             from attachment a
             left join attachment_text t on t.attachment_id = a.id
             where a.inbox_id = m.inbox_id
           ), '[]'::jsonb) as attachments
    from thread_message m
    left join message_supersede ms on ms.message_id = m.id
    left join staging s on s.inbox_id = m.inbox_id
    -- 最近一轮 agent_run 的收尾信息（D74）：停止原因 + 耗时。
    -- lateral 而不是普通 join：一条 inbox 可能跑过多轮（重跑/降级重试），只要最新那轮
    left join lateral (
      select stop_reason, duration_ms from agent_run
      where inbox_id = m.inbox_id and status <> 'running'
      order by created_at desc limit 1
    ) run on true
    where m.thread_id = ${id} order by m.created_at`;

  /**
   * 这条对话里**正在跑的那一轮**，给界面显示进度用。
   *
   * 没有它，人按下去之后看到的就是一个转圈 —— 而转圈十几秒之后，
   * 他不知道是在干活还是已经死了，**不知道的那几秒里他会再按一次**。
   * `stage` 是人话（「正在转写录音」「查客户」「在想」），`steps/max_steps` 给个尽头。
   */
  const [running] = await sql<
    Array<{ stage: string | null; steps: number; max_steps: number | null; trace: unknown }>
  >`select stage, steps, max_steps, trace from agent_run
    where thread_id = ${id} and status = 'running'
    order by created_at desc limit 1`;

  return { thread: t, messages, running: running ?? null };
});

/**
 * ── 手动叫停这条对话上正在跑的那一轮（D89 · issue #22）─────────────
 *
 * 维护者：「跑起来的 agent 必须能手动叫停。这是其他 agent / chatbot 的基础配置。」
 * 在这之前，从前端到后端**一条中止路径都没有** —— 发出去就只能等它跑完
 * 或者撞上限（8 步 / 120 秒，带附件再 +6 步 +60 秒）。
 * 现场是「说一句 → 看一眼 → 改一句」的节奏，干等两分钟等于这东西不会被用。
 *
 * 🔴 **和 `DELETE /staging/:id/confirm` 完全不是一回事。** 那个是 D48 的
 * 5 秒延迟入库撤销（撤的是「写 Twenty」这件事）；这个撤的是「模型这一轮」。
 * 两者一个字都不共用，别把它们合并。
 *
 * 🔴 **停下来之后不能什么都不留。** 中止走的是 agent 内部同一条收尾路径
 * （`loop.ts` 里 `aborted` 那几处）：已经 propose 上来的字段本来就在 staging 里
 * （partial-first），`agent_run.stop_reason` 记 `aborted`，工作日志（trace）原样保留。
 *
 * 作用域和别处一样在服务端裁：只能停自己的对话，admin 也一样（D76①）。
 * 返回 `stopped` 的真实条数 —— **「点了停止但其实什么都没停」不许假装成功**。
 */
app.post('/threads/:id/abort', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const [own] = await sql<Array<{ id: string }>>`
    select id from thread where id = ${id} and user_id = ${req.user!.id}`;
  // 别人的对话回 404 而不是 403 —— 和 GET /threads/:id 一致，不确认它存在
  if (!own) return reply.code(404).send({ error: 'not_found' });

  /**
   * ⚠️ 三个「还没收工」的状态都要捞：`extracting` 是正在跑模型，
   * `transcribing` / `pending` 是还在预处理或还排在队列里 ——
   * **排队那一段同样要能停**，否则前面积压两条时点停止会静默失效，
   * 几秒后它照样开跑（`loop.ts` 里把手是在 enqueue 那一刻就登记的，正是为了这个）。
   */
  const rows = await sql<Array<{ inbox_id: string }>>`
    select s.inbox_id from staging s join inbox i on i.id = s.inbox_id
    where coalesce(i.thread_id, s.thread_id) = ${id}
      and i.user_id = ${req.user!.id}
      and s.status in ('pending','transcribing','extracting')`;

  const stopped = rows.filter((r) => abortInbox(r.inbox_id)).length;
  return { stopped, candidates: rows.length };
});

/**
 * ══════════════════════════════════════════════════════════════════
 *  删掉一条对话历史（D102 · issue #33）
 *
 *  🔴 **这一刀只切对话这一层，另外两个面一个字不动**（migration 013 的文件头）：
 *     · 速记页那条原话   —— 照常在（要删去速记页删，那是 `note_deleted_at`）
 *     · CRM 里已入库的行 —— 照常在（要删去看板删，那是 `record_deleted_at`）
 *
 *  这句话必须原样出现在确认框上。不说的话，人以为删对话会把整理进 CRM 的
 *  那几条一起带走，于是不敢删；或者反过来以为带走了，于是不去看板删 ——
 *  两种误解都比没有这个功能更糟。
 *
 *  🔴 软删而不是 `delete from thread`：`thread` 上的外键是 `on delete cascade`，
 *     真删会去级联删 `thread_message`，**当场撞上它的只增不改触发器**。
 *
 *  ⚠️ 正在跑的那一轮**不许删**（下面那道 409）。删了的话：模型还在往一条
 *     已经从列表里消失的对话里写消息，人看不见、也停不掉（停止键在那一屏上）。
 *     如实说「先停下来」—— 停止键是现成的（D89 · issue #22）。
 * ══════════════════════════════════════════════════════════════════ */
app.delete('/threads/:id', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const [t] = await sql<Array<{ id: string; deleted_at: string | null }>>`
    select id, deleted_at from thread where id = ${id} and user_id = ${req.user!.id}`;
  // 别人的对话回 404 而不是 403 —— 和这一族的其余端点一致，不确认它存在
  if (!t) return reply.code(404).send({ error: 'not_found' });
  if (t.deleted_at) return { alreadyDeleted: true, deletedAt: t.deleted_at };

  const [run] = await sql<Array<{ id: string }>>`
    select id from agent_run where thread_id = ${id} and status = 'running' limit 1`;
  if (run) {
    return reply.code(409).send({
      error: 'running',
      message: 'AI 正在这条对话里跑 —— 先按停止，等它收尾之后再删。',
    });
  }

  const [row] = await sql<Array<{ deleted_at: string }>>`
    update thread set deleted_at = now(), deleted_by = ${req.user!.id}
    where id = ${id} returning deleted_at`;
  return { deleted: true, deletedAt: row!.deleted_at };
});

/**
 * 「改这一句会改写 CRM 里的哪几条」—— 人**按发送之前**拿它（D108 · issue #37）。
 *
 * 🔴 纯只读，而且和真正执行改口的那段**共用 `scopeOf()`**（`supersede.ts`）——
 * 分两份实现的话，总有一天卡片上写的和实际改的不是一回事，
 * 而这种不一致人只有在事后才发现得了（D93 那条判据的第二次兑现）。
 */
app.get('/threads/:id/supersede-preview', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const { messageId } = req.query as { messageId?: string };
  if (!messageId) return reply.code(400).send({ error: 'missing_message_id' });

  const scope = await scopeOf(messageId, id, req.user!.id);
  // 那条消息不是自己的 / 不在这条对话里 —— 和 DELETE 一族一致，不确认它存在
  if (!scope) return reply.code(404).send({ error: 'not_found' });

  const owner = ownerOf(scope);
  const plan = owner
    ? deletionPlan({
        status: 'confirmed',
        twenty_refs: owner.refs,
        created_records: owner.createdRecords,
      } as DeletableRow)
    : null;

  return {
    /** 会盖掉几条消息（含 agent 的回应）。 */
    messages: scope.messageIds.length,
    /** 🔴 这几条**已经在 CRM 里**，发出去会被改写 —— 卡片上逐条列名字。 */
    rewriting: (plan?.refs ?? []).map((r) => ({
      object: r.object,
      label: labelOf(r.object),
      name: r.name ?? null,
    })),
    /** 老记录清单是精确的还是保守推断的（D93 上线前入库的没有 `created_records`）。 */
    source: plan?.source ?? 'none',
    /** 🔴 除了要改写的那一版，还有几版也已入库 —— 它们一个字不会被动。 */
    otherCommitted: Math.max(0, scope.committed.length - 1),
  };
});

/**
 * 撤销删除。**纯改一格时间戳** —— 消息、staging、CRM 记录从头到尾没被动过，
 * 所以恢复是无损的（不像看板删除那样要靠存住一串 Twenty id 才回得来）。
 */
app.post('/threads/:id/restore', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const [t] = await sql<Array<{ id: string }>>`
    select id from thread where id = ${id} and user_id = ${req.user!.id}`;
  if (!t) return reply.code(404).send({ error: 'not_found' });
  await sql`update thread set deleted_at = null, deleted_by = null where id = ${id}`;
  return { restored: true };
});

// ── 上行：原文入库 ──────────────────────────────────────────────
/** 三类附件（合并自「上传文件 / 上传资料」，维护者 2026-08-03）：拍照 · 相册 · 文件。 */
const KINDS = new Set(['photo', 'image', 'file']);

app.post('/inbox', { preHandler: requireAuth }, async (req, reply) => {
  let payload: any = null;
  let audio: { buf: Buffer; mime: string; name: string } | null = null;
  const files: Array<{ kind: string; buf: Buffer; mime: string; name: string }> = [];

  for await (const part of req.parts()) {
    if (part.type === 'file') {
      if (part.fieldname === 'audio') {
        audio = { buf: await part.toBuffer(), mime: part.mimetype, name: part.filename };
      } else if (KINDS.has(part.fieldname)) {
        files.push({
          kind: part.fieldname,
          buf: await part.toBuffer(),
          mime: part.mimetype,
          name: part.filename,
        });
      } else {
        await part.toBuffer(); // 必须消费掉，否则流卡住
      }
    } else if (part.type === 'field' && part.fieldname === 'payload') {
      payload = JSON.parse(String(part.value));
    }
  }
  if (!payload?.clientId) {
    /**
     * 🔴 这一行必须打（issue #53）。2026-09-02 展会现场 iPhone 传图一直 400，
     * 网关这边**一个字的痕迹都没有**（Fastify 只打 warn 以上，4xx 不打；Caddy 没开访问日志），
     * 最后是 tcpdump 抓到 `Content-Length: 0` 才定的案。空正文 = 客户端把 Blob 弄丢了，
     * 不是「用户漏填了字段」—— 得让下一次一眼看出来。
     */
    console.warn(
      `  ⚠️ POST /inbox 没有 payload：content-length=${req.headers['content-length'] ?? '?'} ` +
        `files=${files.length}${audio ? '+audio' : ''} ua=${String(req.headers['user-agent'] ?? '').slice(0, 60)}`,
    );
    return reply.code(400).send({ error: 'missing_client_id' });
  }

  /**
   * 🔴 **速记不自动跑 agent**（D31，维护者 2026-07-31 定，2026-08-03 重申）。
   *
   * 速记页只管把话记下来；要不要交给 AI 整理，是**人显式按一下**的事。
   * 我之前做成了每条速记自动跑一轮 —— 那是漂移，代价很具体：
   *   · 展会现场连录 5 条 = 5 次模型调用，其中大多数人根本不想让它整理
   *   · 每条自动开一条对话，AI 那一屏的历史被一堆没人看的对话塞满
   *   · 弱网时录完还要等 agent，而 D31 的原话就是「速记不依赖 Agent 就绪」
   *
   * 走 agent 的只有两种：AI 那一屏发出来的（`toAgent`），和续写（带了 `threadId`）。
   * 剩下的速记随时可以用 `POST /inbox/:id/agent` 补送。
   */
  const toAgent = payload.toAgent === true || Boolean(payload.threadId);

  /**
   * 落库核心在 `src/ingest.ts` —— **和钉钉渠道共用一份**（T93）。
   * 幂等 → 建对话 → inbox → 附件 → staging → 对话消息，行为与抽出前逐行一致；
   * 「客户端已转好的别再转一遍」（issue #15）那条也搬了过去。
   */
  const ing = await ingestNote({
    userId: req.user!.id,
    clientId: payload.clientId,
    text: payload.text ?? null,
    companyCode: payload.companyCode ?? null,
    visitLabel: payload.visitLabel ?? null,
    deviceCreatedAt: payload.createdAt ? new Date(payload.createdAt) : null,
    threadId: payload.threadId ?? null,
    toAgent,
    source: payload.threadId ? 'followup' : 'note',
    transcript: payload.transcript,
    audio,
    audioSeconds: payload.audioSeconds ?? null,
    files,
  });
  if (ing.duplicate)
    return reply.code(200).send({
      inboxId: ing.inboxId,
      stagingId: ing.stagingId,
      threadId: ing.threadId,
      attachments: ing.attachments,
      duplicate: true,
    });
  const threadId = ing.threadId;
  const newMessageId = ing.newMessageId;
  const audioPath = ing.audioPath;

  /**
   * ── 改口重发（D90 · issue #23）────────────────────────────────────
   *
   * 🔴 **绝不改写原来那行。** `supersedesMessageId` 指的那句话在
   * `thread_message` 里一个字都不动（那张表有触发器挡着 UPDATE/DELETE），
   * 新的那句话是上面刚插进去的**新一行**、挂在**新一条 inbox** 上。
   * 这里做的全部事情是在派生层记一句「那条不再是活的那一条了」。
   * 和 D68（改速记正文写 edited_text）、D75（重录走 reconfirm）是同一个套路。
   *
   * 取代的范围是**被改的那条 + 它之后的全部**：agent 基于那句话回的每一条
   * 都是在回答一个已经被撤回的问题。issue 里的说法是「回退到这条消息之前的状态再跑」。
   *
   * 🔴 上一轮的 `staging` 也要一起标（issue 的第 3 条硬要求）——
   * 不标的话同一条对话里会有两张都能按的核对卡，两张都按就是 CRM 里两份记录
   * （拜访 / 选型情报 / 售后这些没有自然键，会实打实多出一条）。
   * **已经入库的那些一个都不碰**：`status in ('ready','failed')` 是 issue #14
   * 定下来的同一道边界 —— 东西已经在 Twenty 里了，改这里没有意义，
   * 要改走 D75 的重录。
   */
  const supersedes = String(payload.supersedesMessageId ?? '').trim() || null;
  /**
   * 取代**没做成**时，如实回一句（下面 201 里的 `superseded`）。
   *
   * ⚠️ **不 return、不回滚。** 这一句是人真的说过的话，`inbox` 已经落库
   * 且只增不改；把整个请求打回去等于把这句话丢了。它照常跑 agent、照常出核对卡，
   * 只是老的那条没被撤回 —— 而这件事必须让界面知道，
   * 否则人以为改口生效了，实际上对话里两版都还是活的。
   */
  let supersededCount = 0;
  let supersedeFailed = false;
  /** 这一轮会**改写**哪几条已入库的记录（D108 · issue #37）—— 回包要带给界面。 */
  let rewriting: Array<{ object: string; label: string; name: string | null }> = [];
  /** 除了要交接的那一条，还有几版也已入库 —— **必须如实报**，它们一个字不会被动。 */
  let otherCommitted = 0;
  if (supersedes && threadId && newMessageId) {
    // 「这一句会盖掉什么」和预览端点**共用一份判断**（`supersede.ts`）
    const scope = await scopeOf(supersedes, threadId, req.user!.id, newMessageId);
    if (!scope) {
      supersedeFailed = true;
    } else {
      for (const id of scope.messageIds) {
        await sql`
          insert into message_supersede (message_id, superseded_by, thread_id, reason, created_by)
          values (${id}, ${newMessageId}, ${threadId},
                  ${id === supersedes ? 'edited' : 'stale_reply'}, ${req.user!.id})
          on conflict (message_id) do nothing`;
      }
      supersededCount = scope.messageIds.length;

      // 上一轮的提案退场。**只动还没进 CRM 的那些**（同 issue #14 的边界）。
      const inboxIds = scope.inboxIds;
      if (inboxIds.length) {
        await sql`
          update staging set status = 'superseded', superseded_by = ${ing.stagingId}
          where inbox_id = any(${inboxIds}) and status in ('ready','failed')`;
      }

      /**
       * ── 已经入库的那一版：把**记录的所有权**交给这一轮（D108 · issue #37）──
       *
       * 🔴 在这之前，已入库的那些一个都不碰 —— 于是这一轮照常新建一份，
       *    CRM 里两版并存（Movara 3000W / 2000W 就是这么来的）。
       *    人的意思是「上一句作废」，系统做成了「又说了一件新事」。
       *
       * 🔴 **这里只记下交接的意向，不动任何记录、也不收走老那一行的所有权。**
       *    改口之后这一轮**可能永远不会被确认**（人反悔、关掉、换个说法）——
       *    那时老那一版仍然是有效的、仍然拥有 CRM 里那几条。
       *    真正的转移发生在提交成功那一刻（`confirm.ts`）。
       *
       * ⚠️ 只继承**最近的那一条**：update-in-place 只能对着一套记录做。
       *    其余的如实报出来（`otherCommitted`），它们一个字不会被动。
       */
      const owner = ownerOf(scope);
      if (owner) {
        await sql`update staging set replaces = ${sql.json(inheritance(owner) as never)}
                  where id = ${ing.stagingId}`;
        // 老那一行先标一句「这一版已经不是活的那一条了」——
        // 但 **status 保持 confirmed**：记录确实还在 CRM 里，也确实还归它管。
        await sql`update staging set superseded_by = ${ing.stagingId} where id = ${owner.stagingId}`;
        const plan = deletionPlan({
          status: 'confirmed',
          twenty_refs: owner.refs,
          created_records: owner.createdRecords,
        } as DeletableRow);
        rewriting = plan.refs.map((r) => ({
          object: r.object,
          label: labelOf(r.object),
          name: r.name ?? null,
        }));
        otherCommitted = scope.committed.length - 1;
      }

      /**
       * 🔴 **这条路径以前在日志里几乎不可见**（issue #37 的附带发现）：
       * 整整一轮改口 —— 取代几条消息、几条提案退场、有没有已入库的 ——
       * 网关一行都不打。能把 Movara 那次复原出来，全靠 D74 把 trace 落进了库。
       */
      console.log(
        `  ✏️ 改口：取代 ${supersededCount} 条消息 · ${inboxIds.length} 条提案退场 · ` +
          `${rewriting.length} 条已入库记录将被改写${otherCommitted ? ` · 另有 ${otherCommitted} 版已入库未动` : ''}`,
      );

      /**
       * 🔴 消息史也要退场，否则这件事**只做了一半**。
       *
       * D73① 的续跑会把整条对话的消息史灌回模型 —— 里面就有那句被撤回的话。
       * 不归档的话模型看到的是「他说了 A，然后又说了 A′」，按续写理解，
       * 而人的意思是「A 作废」。那正是 issue #23 开头抱怨的
       * 「唯一的补救是再说一遍」，一个字都没改善。
       */
      await forgetThreadHistory(threadId);
    }
  }

  /**
   * 🔴 **转写和抽取是两件事**（issue #15，2026-08-05）。
   *
   *   · 有音频就转写 —— **无条件**。转写是把不可再生的资产变成可读的文字。
   *   · 抽取（跑 agent）—— 人显式要过才跑（D31）。
   *
   * 之前只有 `if (toAgent) enqueue()` 这一行，于是速记页录的音
   * **一个字都没被转写过**：卡片上永远是「🎙 12秒 语音」。
   * 那不是「转录还没回来」，是从来没开始过。
   *
   * ⚠️ 顺序：agent 那条已经包含转写，所以两个都要时只排 agent，别排两次。
   */
  if (toAgent) enqueue(ing.inboxId); // 后台跑，不阻塞手机
  else if (audioPath) enqueueTranscribe(ing.inboxId);
  return reply.code(201).send({
    inboxId: ing.inboxId,
    stagingId: ing.stagingId,
    threadId,
    // 清单不是数量（issue #53）：客户端传成功就丢掉原件，之后靠这份引用显示 📎 和缩略图
    attachments: ing.attachments,
    toAgent,
    duplicate: false,
    // D90：改口重发取代掉了几条。`supersedeFailed` = 那条没找到（不是自己的 /
    // 不在这条对话里）—— 这一句照样发出去了，但老的那条**没有**被撤回，得说出来
    ...(supersedes
      ? {
          superseded: supersededCount,
          supersedeFailed,
          /**
           * 🔴 **CRM 那一面也要有出口**（D108 · issue #37）。
           * 以前回包只报「取代了几条**消息**」—— 而「上一轮已经入库了」
           * 这一种情况一个字都没有，于是人以为改口生效了，
           * 实际上 CRM 里两版并存。
           */
          rewriting,
          otherCommitted,
        }
      : {}),
  });
});

/**
 * 「一键发给 AI」—— 速记落库之后补送（D31：抽取是**显式触发**）。
 *
 * 幂等：已经在跑或已经跑过的直接回原来那条对话，不会再烧一次模型。
 */
app.post('/inbox/:id/agent', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const [row] = await sql<
    Array<{
      id: string;
      thread_id: string | null;
      text: string | null;
      body: string | null;
      company_code: string | null;
    }>
  >`select i.id, i.text, i.company_code,
           -- 开新对话时用它当开场那句话。三层取最靠下那层（migration 007）：
           -- 人改定的 > 机器听的 > 人打的 —— 和 agent 自己读的是同一份（loop.ts 的 source）
           coalesce(nullif(s.edited_text, ''), nullif(s.transcript, ''), i.text) as body,
           -- ⚠️ 两处都要看。inbox 只增不改（§4.2 第2条），所以补送时建的那条对话
           -- 只能记在 staging 上；只读 inbox.thread_id 的话它永远是 null，
           -- 于是连按两下就开出两条对话、烧两次模型（集成测试抓到过）。
           -- （SQL 也是模板字符串 —— 注释里同样不能出现反引号）
           -- 🔴 **删掉的那条对话不算数**（D102 · issue #33）：接着往一条已经从
           --    历史列表里消失的对话里写，人看不见结果，只会以为「发了没反应」。
           --    这里取不到就是 null，下面那段照常新开一条 —— 和从没发过一样。
           (select t.id from thread t
             where t.id = coalesce(i.thread_id, s.thread_id) and t.deleted_at is null) as thread_id
    from inbox i left join staging s on s.inbox_id = i.id
    where i.id = ${id} and i.user_id = ${req.user!.id}`;
  if (!row) return reply.code(404).send({ error: 'not_found' });

  /**
   * ── 「再开一条对话」（D95 · issue #26）─────────────────────────────
   *
   * 维护者 2026-08-07：「……或者客户也可以选择，创建一个新的对话，
   * 当创建新对话之后，该速记链接的聊天进程，就会变成两个，用户就可以进行选择。」
   *
   * 🔴 它**不是**「重跑一遍」的别名。两者的区别很实在：
   *   · 重跑（`force`）走的是原来那条对话 —— 上一轮的提案会被继承下来当起点
   *     （loop.ts 的 `inheritedFrom`），适合「在上一轮基础上补一句」。
   *   · 新对话是**从零重读这条速记**：新线程里没有上一轮的 staging，
   *     继承那一步查不到东西，模型看到的就只有原话。
   *     适合「上一轮整个理解错了，重来」。
   *
   * ⚠️ 正在跑的时候**一律不给开**（下面那道 `alreadyRunning` 挡着）。
   *    这正是这个 issue 的第一句话要防的事：「避免同一个速记同时创立多个 Agent 进程」。
   */
  const wantsNewThread = (req.body as { newThread?: boolean } | undefined)?.newThread === true;

  const [st] = await sql<Array<{ status: string }>>`
    select status from staging where inbox_id = ${row.id}`;
  // 已经在跑 / 已经确认过的，不重复烧模型
  // ⚠️ `committing`（issue #1 加的中间态）也算「已经在走了」——
  //    漏了它，一条正在写 CRM 的记录会被重新跑一遍 agent
  if (st && ['transcribing', 'extracting', 'confirming', 'committing', 'confirmed'].includes(st.status)) {
    return { threadId: row.thread_id, alreadyRunning: true, status: st.status };
  }

  let threadId = wantsNewThread ? null : row.thread_id;
  if (!threadId) {
    const [t] = await sql<Array<{ id: string }>>`
      insert into thread (user_id, title, company_code)
      values (${req.user!.id}, ${(row.text ?? '').slice(0, 40) || null}, ${row.company_code})
      returning id`;
    threadId = t!.id;
    // ⚠️ inbox 只增不改（§4.2 第2条）—— thread_id 属于「这条速记归哪次对话」，
    //    是**建立关联**不是改内容，触发器拦的是行级 UPDATE…… 所以这里不能走 UPDATE。
    //    改为把关联记在 staging 上，agent 从 staging 取 thread_id。
    await sql`update staging set thread_id = ${threadId} where inbox_id = ${row.id}`;
    /**
     * 开场那句话进对话。
     *
     * ⚠️ 用 `body` 不用 `text`（D95）：纯语音速记的 `i.text` 是空的，
     *    于是这条对话里**一句人话都没有**，人跳进去看到的是一屏空白。
     *    更要紧的是「这条速记关联了哪几条对话」正是靠 `thread_message.inbox_id`
     *    反查的（下面那个端点）—— 不插这一行，这条关联就只剩 `staging.thread_id`
     *    一个位置，而它只存得下**最新**那一条。
     */
    if (row.body) {
      await sql`
        insert into thread_message (thread_id, role, text, inbox_id)
        values (${threadId}, 'user', ${row.body}, ${row.id})`;
    }
  }

  /**
   * 🔴 **已经整理过的（`ready`）必须显式 `force` 才重跑**（issue #16，2026-08-05）。
   *
   * 维护者 的原话：「这个确认键不能说点10次就发10次，要有相应的保护」。
   * 之前 `ready` 不在上面那个列表里，于是再点一次就会：
   *   status 打回 pending → 跑一整轮 agent（又一次模型调用）→
   *   对话里插第二条 agent 消息（第二张核对卡，指向同一个 staging）→
   *   `extracted` 被新一轮整包合并覆盖。
   *
   * **按钮的 disabled 状态挡不住这个** —— PWA 的重试队列、第二台设备、
   * 手滑双击都绕得过去。护栏必须在服务端，和 `confirm.ts` 挡重复入库同一条判据。
   *
   * 运维出口没变：`update staging set status='pending'` 仍然能强制重跑。
   */
  const force = (req.body as { force?: boolean } | undefined)?.force === true;
  // 开新对话本身就是一次显式的「我要它重读一遍」—— 不用再要一个 force（D95）
  if (st?.status === 'ready' && !force && !wantsNewThread) {
    return {
      threadId,
      alreadyDone: true,
      hint: '这条已经整理过了 —— 要重新整理请带 force。',
    };
  }

  await sql`update staging set status = 'pending', error = null where inbox_id = ${row.id}`;
  enqueue(row.id);
  return { threadId, queued: true, newThread: wantsNewThread };
});

/**
 * 「这条速记关联着哪几条对话」（D95 · issue #26）。
 *
 * 🔴 **这个端点是那道 double check 的全部依据。** 没有它，前端只知道
 * 「我这台设备上次点过发送」（`sentToAgentAt` 存在本地 IndexedDB 里）——
 * 换台手机、清个缓存、或者根本就是同事在另一台上发的，都会看不见，
 * 于是又开一条对话、又烧一轮模型。**「已经发过没有」必须由服务端回答。**
 *
 * 三个来源取并集，缺一个都会漏：
 *   · `inbox.thread_id`          —— 这条速记本来就是从对话里发出来的
 *   · `staging.thread_id`        —— 补送时建的那条（inbox 只增不改，只能记这儿）
 *   · `thread_message.inbox_id`  —— **历史**。开了新对话之后上面那格就被改写了，
 *                                   老对话只在这里找得回来
 */
app.get('/inbox/:id/threads', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const [own] = await sql<Array<{ id: string }>>`
    select id from inbox where id = ${id} and user_id = ${req.user!.id}`;
  if (!own) return reply.code(404).send({ error: 'not_found' });

  const rows = await sql`
    select t.id, t.title, t.created_at, t.last_message_at,
           (select count(*)::int from thread_message m where m.thread_id = t.id) as messages,
           -- 这条对话现在是不是这条速记的「活的那一条」（提案落在它名下）
           (s.thread_id = t.id) as active,
           -- 还在跑没有。人跳进去之前就该知道 —— 免得对着一屏静止的对话等
           exists (select 1 from agent_run r
                   where r.thread_id = t.id and r.status = 'running') as running
    from thread t
    join staging s on s.inbox_id = ${id}
    where t.user_id = ${req.user!.id}
      -- 删掉的不算（D102 · issue #33）。留着的话，那道 double check 会把人
      -- 指进一条他自己刚删掉的对话里 —— 而且「已经发过了」这个结论也不再成立。
      and t.deleted_at is null
      and t.id in (
        select thread_id from thread_message where inbox_id = ${id}
        union select thread_id from inbox where id = ${id} and thread_id is not null
        union select thread_id from staging where inbox_id = ${id} and thread_id is not null
      )
    order by t.last_message_at desc`;
  return { items: rows };
});

/**
 * 重试**只转写**那一步（D87 · issue #21②）。
 *
 * 🔴 为什么单独一个端点，而不是复用上面那个 `/agent`：
 * 两件事的代价差一个数量级。转写是「把不可再生的资产变成可读的文字」，
 * 该随手就能再来一次；跑 agent 是烧一轮模型 + 开一条对话 + 产出一条待确认（D31），
 * 那是人**显式要过**才发生的。把它们合成一个按钮，等于「我只想看看它说了什么」
 * 每次都附赠一次抽取 —— 而展会现场重试转写恰恰是最常按的那个。
 *
 * ⚠️ 只重置**派生层**：`staging.status` / `error` / `attempts`。
 *    `inbox` 一个字不动（§4.2 第 2 条，库里有触发器挡着）。
 * ⚠️ 作用域一律只有自己的，admin 也一样（D76①）—— 端点上没有别人的位置。
 */
app.post('/inbox/:id/transcribe', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const [row] = await sql<Array<{ id: string; audio_path: string | null; status: string; transcript: string | null }>>`
    select i.id, i.audio_path, s.status, s.transcript
    from inbox i join staging s on s.inbox_id = i.id
    where i.id = ${id} and i.user_id = ${req.user!.id}`;
  if (!row) return reply.code(404).send({ error: 'not_found' });

  // 没有音频就没什么可转的 —— 如实说，别排一个什么都不做的活然后回「已排队」
  if (!row.audio_path) return reply.code(400).send({ error: 'no_audio' });

  /**
   * 已经在跑、或者已经进 CRM 的不动它。
   * 判据同上面那个端点：**界面绿色而东西没进去，比报错糟得多** ——
   * 这里的镜像是「说排队了、其实被别的流程覆盖掉」。
   */
  if (['transcribing', 'extracting', 'confirming', 'committing', 'confirmed'].includes(row.status)) {
    return { queued: false, busy: true, status: row.status };
  }
  // 已经有转录了就别再烧一次（`transcribeOnly` 自己也会跳过，这里先说清楚为什么）
  if (row.transcript) return { queued: false, alreadyDone: true };

  await sql`
    update staging set status = 'pending', error = null, attempts = 0
    where inbox_id = ${row.id}`;
  enqueueTranscribe(row.id);
  return { queued: true };
});

/**
 * 改一条速记的正文（issue #15 · #16）。
 *
 * 维护者 2026-08-05：「每条速记，可以进去修改」「（转录）可以进行手动的修改」。
 *
 * 🔴 **这个端点不碰 `inbox`。** 那张表只增不改（§4.2 第 2 条，库里有触发器，
 * 就算这里写了 UPDATE 也会被数据库挡回来）。改动落在 `staging.edited_text` ——
 * 派生层。原话和原始转录一个字不动，三层各答一个问题（migration 007）。
 *
 * 改的动机几乎总是「转录把品牌名听错了」。所以这一步的收益很具体：
 * 纠正之后再「发给 AI」，agent 读的是纠正后的那一版（loop.ts 的 `source`）。
 */
app.patch('/inbox/:id/text', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = req.body as { text?: unknown };
  // 允许改成空串（「这条转录全是噪音，我不要它」），但不接受非字符串
  if (typeof body?.text !== 'string') return reply.code(400).send({ error: 'missing_text' });
  const text = body.text.slice(0, 20_000);

  const [st] = await sql<Array<{ id: string; status: string }>>`
    select s.id, s.status from staging s join inbox i on i.id = s.inbox_id
    where i.id = ${id} and i.user_id = ${req.user!.id}`;
  if (!st) return reply.code(404).send({ error: 'not_found' });

  /**
   * 已经在写 Twenty 或已经写完的，**改了也没用**，所以明确拒绝而不是假装成功。
   *
   * 判据是这个仓库最贵的那一条：**界面绿色、而东西没进去，比报错糟得多。**
   * 人改完看到「已保存」，CRM 里却还是错的名字 —— 他不会再改第二次。
   * 想改已入库的记录，只能去 CRM 里改（那边才是那份数据的家）。
   */
  if (['confirming', 'committing', 'confirmed'].includes(st.status)) {
    return reply.code(409).send({ error: 'already_committed', status: st.status });
  }

  await sql`
    update staging set edited_text = ${text}, edited_at = now() where id = ${st.id}`;
  return { ok: true, stagingId: st.id, editedAt: new Date().toISOString() };
});

/**
 * 只转写，**不落 inbox**（issue #15）。
 *
 * 维护者 2026-08-05 的原话：
 *   「录音完成之后，按下终止键，转录到输入框中，用户可以手动修改，
 *     或者在选中的地方，继续补充转录，然后再发送，
 *     **不要把转录的工作整合进入 Agent**。」
 *
 * 所以 AI 那一屏的流程变成三步各自独立：**转写 → 人改 → 发送**。
 * 这一个端点只负责第一步。
 *
 * ⚠️ **它故意不建任何记录。** 音频这时还在手机上（IndexedDB 里），
 * 人按发送时才随 `POST /inbox` 一起上来，连同这里返回的文字
 * （`payload.transcript`）—— 于是同一段音频只转一次，而且
 * 人在输入框里看到的和 agent 读到的是同一份。
 *
 * 🔴 反过来做（先建 inbox 再转写）会多出一条「录了但没发」的空记录，
 * 而且人放弃这条录音时那行删不掉（inbox 只增不改）。
 */
app.post('/transcribe', { preHandler: requireAuth }, async (req, reply) => {
  let audio: { buf: Buffer; mime: string; name: string } | null = null;
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      if (part.fieldname === 'audio' && !audio) {
        audio = { buf: await part.toBuffer(), mime: part.mimetype, name: part.filename || 'clip.webm' };
      } else {
        await part.toBuffer(); // 必须消费掉，否则流卡住
      }
    }
  }
  if (!audio?.buf.length) return reply.code(400).send({ error: 'missing_audio' });

  // 品牌名喂给转写 —— 实测这一步决定 Rosenfeld 会不会被听成 Rozenfelt
  const [companies, suppliers] = await Promise.all([
    listCompanies().catch(() => []),
    listSuppliers().catch(() => []),
  ]);
  const brands = [...companies.map((c) => c.name), ...suppliers.map((s) => s.name)];

  try {
    const text = await transcribe(audio.buf, audio.mime, audio.name, brands);
    return { text };
  } catch (e) {
    /**
     * 🔴 **转写失败必须让手机知道**，不能返回空字符串装作听到了一段静音。
     * 前端拿到 5xx 会退回「把音频直接发出去，转写稍后在服务端补」——
     * 那条路仍然保住了录音，只是人这次没法先改。
     */
    const msg = (e as Error).message.slice(0, 300);
    console.error(`  ✗ /transcribe 失败：${msg}`);
    return reply.code(502).send({ error: 'transcribe_failed', message: msg });
  }
});

/** 给一段文字起个标题（issue #15）。手机上改完正文想重起一个标题时用。 */
app.post('/title', { preHandler: requireAuth }, async (req) => {
  const { text } = (req.body ?? {}) as { text?: string };
  return { title: await makeTitle(String(text ?? '')) };
});

// ── 下行：跨设备同步自己的速记 ──────────────────────────────────
app.get('/inbox', { preHandler: requireAuth }, async (req) => {
  const { since, limit } = req.query as { since?: string; limit?: string };
  const rows = await sql`
    select i.id, i.client_id, i.company_code, i.text, i.audio_seconds, i.visit_label,
           i.device_created_at, i.created_at, i.thread_id,
           s.id as staging_id, s.status, s.transcript, s.extracted, s.confidence,
           s.suggested_company, s.partial,
           -- 🔴 失败原因（D87 · issue #21②）。**以前这一列没带出来**，于是
           -- 「后端如实记了失败、前端一个字都不显示」—— 和 issue #19 的对话线程
           -- 是**同一个形状的 bug**，只是发生在速记页。人看到的只有一条永远
           -- 没有转录的语音速记，而它其实早就失败了、且可以重试。
           s.error,
           -- 人改定的正文 + 自动标题（issue #15/#16）。换台设备登录也要看得到。
           s.edited_text, s.edited_at, s.title,
           -- 🔴 删掉的那些**照样返回**，带上这一格（D93 · issue #25）。
           -- 过滤掉的话，另一台手机上那条速记会永远留在本地列表里 ——
           -- pullInbox() 是全量拉取 + 只补不删，服务端不说它就无从知道。
           -- 把「它被删了」这件事传下去，由客户端删掉本地那份。
           -- （⚠️ SQL 也是模板字符串，注释里不能出现反引号）
           s.note_deleted_at,
           -- 附件**清单**而不是数量（issue #53）：换台手机登录，列表上的 📎 和详情里的图
           -- 全靠它；原件走 GET /attachments/:id/file
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'id', a.id, 'kind', a.kind, 'name', a.filename,
               'mime', coalesce(a.mime, 'application/octet-stream'), 'bytes', a.bytes)
               order by a.created_at, a.id)
             from attachment a where a.inbox_id = i.id
           ), '[]'::jsonb) as attachments
    from inbox i join staging s on s.inbox_id = i.id
    where i.user_id = ${req.user!.id}
      ${since ? sql`and i.created_at > ${new Date(since)}` : sql``}
    order by i.created_at
    limit ${Math.min(Number(limit ?? 200), 500)}`;
  return {
    items: rows,
    nextSince: rows.at(-1)?.created_at ?? since ?? null,
  };
});

/**
 * 取回附件原件。
 *
 * 原件只在网关的磁盘上（`GATEWAY_AUDIO_DIR`）—— Twenty 这个版本没有开放
 * 文件上传接口，所以 CRM 里只有引用、没有文件本身。这个口子让人还能拿到它。
 *
 * 🔴 作用域在服务端：只能取**自己那条速记**的附件 —— admin 也一样（D76①）。
 *    以前这里有 `or canSeeBoard(role)`，于是管理层能下载同事拍的每一张照片。
 */
app.get('/attachments/:id/file', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const [a] = await sql<Array<{ path: string; filename: string; mime: string | null }>>`
    select a.path, a.filename, a.mime from attachment a
    join inbox i on i.id = a.inbox_id
    where a.id = ${id} and i.user_id = ${req.user!.id}`;
  if (!a) return reply.code(404).send({ error: 'not_found' });

  const buf = await readFile(join(env.audioDir, a.path)).catch(() => null);
  if (!buf) return reply.code(410).send({ error: 'file_gone' });
  reply.header('Content-Type', a.mime || 'application/octet-stream');
  // filename* 用 RFC 5987 编码 —— 中文/德文文件名不这么写会在下载时变乱码
  reply.header(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
  );
  return reply.send(buf);
});

/**
 * 待确认列表。
 *
 * 🔴 **没有 `scope` 参数了**（D76②，维护者 2026-08-07：「无论是 admin 还是
 * 其他任何权限，你都只能访问自己写的内容」）。
 *
 * 以前这里有一条 `scope=all && canSeeBoard(role)` 的分支。它今天没人走
 * （PWA 写死 `scope=own`），但**开着的路和走过的路一样危险** ——
 * 一个参数就能翻出全公司的待确认队列，而这件事在界面上没有任何痕迹。
 * 现在的形状是最强的那一种：**没有参数就没有传错参数的可能**。
 */
app.get('/staging', { preHandler: requireAuth }, async (req) => {
  const { status } = req.query as { status?: string };
  /**
   * 🔴 `supersedes` = 这条取代了同一对话里的几版（issue #14）。
   *
   * 折叠掉的东西**必须能被看见** —— 界面上写一句「前面还有 2 版，已被这一版取代」，
   * 否则「看不见」和「不存在」就分不开了，而这个仓库最贵的 bug 全长这个样子。
   */
  const rows = await sql`
    select s.*, i.text, i.company_code, i.audio_seconds, i.created_at as captured_at, u.display_name,
           (select count(*)::int from staging p where p.superseded_by = s.id) as supersedes
    from staging s join inbox i on i.id = s.inbox_id join app_user u on u.id = i.user_id
    where ${status ? sql`s.status = ${status}` : sql`true`}
      and i.user_id = ${req.user!.id}
      -- 看板上删掉的不该还能被确认入库（D93）。前端不显示不等于挡住了：
      -- 一个还开着的旧标签页、一次 PWA 重放都能把它送进来（§4.2 第 4 条）。
      and s.record_deleted_at is null
    order by s.created_at desc limit 200`;
  // `scope` 保留在响应里 —— 它现在是一个**常量**，用来让调用方（和冒烟脚本）
  // 一眼看出「这个接口只会给你自己的」，而不是靠读文档相信这件事。
  return { items: rows, scope: 'own' as const };
});

/**
 * ── 我的记录表格（D76 · 看板改版）───────────────────────────────
 *
 * 维护者 2026-08-07：「看板不是一个 inbox，它应该就是一个表格，可以进行粗略的查看」。
 *
 * 和 `GET /staging` 的区别是**一个参数**，而那个参数决定了整屏的性质：
 * `/staging?status=ready` 只回答「还有什么没确认」，确认完一条那条就从屏幕上消失；
 * 这里**不按状态过滤**，回答的是「我到底记了些什么、哪些进去了哪些没进去」。
 *
 * 🔴 失败的、被取代的也一并返回。不返回的话，一条录了却没进 CRM 的记录
 * 在人这边是彻底不存在的 —— 而「界面绿色、东西没进去」是这个仓库最贵的那类 bug。
 *
 * 🔴 **两道口子，都在服务端：**
 *   ① `user` 角色直接 403（D76①：这一屏对他暂时整个关闭）
 *   ② 没有 `scope` 参数，`where i.user_id = 当前用户` 写死 —— admin 也一样
 *
 * ⚠️ 客户名与品类**不在这里解析**：`resolved_company_id`（已入库那些）和
 * `company_code`（录入时定的）原样给出去，由 PWA 用它缓存的客户名单对。
 * 这样断网时表格照样显示得出客户名，而且解析规则只有一份（前端那一份）。
 */
app.get('/records', { preHandler: requireAuth }, async (req, reply) => {
  if (!canSeeBoard(req.user!.role)) {
    // 403 而不是空列表：**「你没有权限」和「你还没记过东西」必须分得开**，
    // 否则一个新同事第一次打开会以为自己的记录丢了。
    return reply.code(403).send({ error: 'board_forbidden' });
  }

  const rows = await sql`
    select s.id, s.inbox_id, s.status, s.title, s.extracted, s.confidence, s.partial,
           s.suggested_company, s.twenty_refs, s.confirm_after, s.error,
           s.resolved_company_id, s.updated_at,
           -- D75：人上次确认时改过的那几格。表格上显示的必须是**入库的值**，
           -- 只看 extracted 的话，改过阶段的那条会显示旧值 —— 人会以为改动丢了
           s.confirm_payload->'fields' as confirmed_fields,
           -- 三层文字取最靠下那层（migration 007）：人改定的 > 机器听的 > 人打的
           coalesce(nullif(s.edited_text, ''), nullif(s.transcript, ''), i.text) as text,
           -- 补送给 AI 时对话记在 staging 上（inbox 只增不改），两处都要看，
           -- 否则表格上的「去对话里确认」按钮对补送的那些永远是灰的
           coalesce(i.thread_id, s.thread_id) as thread_id,
           i.company_code, i.audio_seconds, i.visit_label,
           i.created_at as captured_at,
           (select count(*)::int from staging p where p.superseded_by = s.id) as supersedes,
           (select count(*)::int from attachment a where a.inbox_id = i.id) as attachments
    from staging s join inbox i on i.id = s.inbox_id
    where i.user_id = ${req.user!.id}
      -- 人从看板上删掉的不再出现（D93 · issue #25/#29）。
      -- ⚠️ 只看 record_deleted_at：从**速记页**删掉的那些在这张表上照常显示，
      --    因为 Twenty 里那条记录确实还在，而看板是它的视图（migration 012 的文件头）。
      and s.record_deleted_at is null
    order by i.created_at desc limit 300`;

  return { items: rows, scope: 'own' as const };
});

/**
 * 「这条已经从看板上删掉了」（D93）。
 *
 * 🔴 **确认 / 重录都要挡。** 一条删掉的记录如果还能入库，就会在 CRM 里
 * 长出一份人以为自己已经删掉的东西 —— 而看板上它不显示，
 * 于是这份数据从此没有任何一屏能看见。「看不见」和「不存在」必须分得开。
 */
const RECORD_DELETED = {
  error: 'record_deleted',
  message: '这条已经从看板上删掉了 —— 要用它先撤销删除。',
} as const;

// ── 确认入库 → 5 秒后写 Twenty（D48）────────────────────────────
/**
 * 「这条是不是你的」。确认 / 撤销 / 重录 / 查落点全走它。
 *
 * 🔴 **只认自己的，admin 也不例外**（D76①，维护者 2026-08-07）。
 *
 * 以前这里是 `or canSeeBoard(user.role)` —— management 及以上能确认和重录
 * **别人录的**记录。那条路的用处是「同事手机没电了我帮他确认掉」，
 * 代价是「入库人」和「录入人」可以不是同一个人，而 Timeline 上只留得下一个。
 * 现在按 维护者 的定义收成最简单的形状：**谁录的谁负责**。
 *
 * ⚠️ 这是**暂时**的定法。要放开就是把这一行加回去，不需要建权限引擎（D35②）。
 */
const loadOwned = async (id: string, user: AppUser) => {
  const [st] = await sql<
    Array<{
      id: string;
      inbox_id: string;
      status: string;
      /** D93：两个面各一个时间戳。**空 = 没删过。** 见 migration 012 的文件头。 */
      note_deleted_at: string | null;
      record_deleted_at: string | null;
      twenty_refs: Record<string, unknown> | null;
      created_records: unknown;
    }>
  >`
    select s.id, s.inbox_id, s.status, s.note_deleted_at, s.record_deleted_at,
           s.twenty_refs, s.created_records
    from staging s join inbox i on i.id = s.inbox_id
    where s.id = ${id} and i.user_id = ${user.id}`;
  return st ?? null;
};

/**
 * ══════════════════════════════════════════════════════════════════
 *  手动删除（issue #25 / #29 · D93）
 *
 *  维护者 2026-08-07 两条裁定：**不开跨人的口子**（沿用 D76，只能删自己写的）、
 *  **用软删除不用硬删除**。所以这几个端点里：
 *    · 一律走 `loadOwned` —— 和确认 / 重录同一道门，admin 也不例外
 *    · Twenty 那边打的是 `delete{Object}`（本来就是软删），`destroy` 一处都不调
 *    · `inbox` 一个字不动（§4.2 第 2 条，库里有触发器），音频也不删
 *
 *  🔴 **两个面，两个动作，可以任意组合**（migration 012 为此加了两列而不是一列+枚举）：
 *    · 速记页删除 → `note_deleted_at`。**CRM 一个字不动**（维护者 明确要的：
 *      「如果速记内容已经入库，其涉及到的入库内容却不会被删除」）。
 *    · 看板删除   → `record_deleted_at` + 按计划软删 CRM 里那几条。
 *      速记那条原话照常留在速记页（除非也被单独删了）。
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 「按下去到底会删掉什么」—— 删除对话框在**人点确认之前**拿它。
 *
 * 🔴 纯只读。它和真正执行删除的那个端点**共用 `deletionPlan()`** ——
 * 分两份实现的话，总有一天对话框说的和实际删的不是一回事，
 * 而这种不一致人只有在事后才发现得了。
 */
app.get('/staging/:id/deletion', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const st = await loadOwned(id, req.user!);
  if (!st) return reply.code(404).send({ error: 'not_found' });

  const p = deletionPlan(st as DeletableRow);
  return {
    status: st.status,
    noteDeletedAt: st.note_deleted_at,
    recordDeletedAt: st.record_deleted_at,
    /** 进过 CRM 没有。没进过的话，看板删除就只是「这一行不再显示」。 */
    committed: st.status === 'confirmed',
    records: p.refs.map((r) => ({ object: r.object, label: labelOf(r.object), name: r.name ?? null })),
    summary: describePlan(p.refs),
    skipped: p.skipped,
    source: p.source,
  };
});

/**
 * 从**速记页**删掉一条速记（issue #25 的后半段）。
 *
 * 🔴 **它不碰 CRM，一个请求都不发。** 这是 维护者 原话里明确分开的两件事。
 * 也不碰 `inbox` 和音频：删掉的只是「它出现在我的速记列表里」这件事，
 * 不是那句话本身 —— 展会 10 天说过的话是全项目唯一不可再生的资产。
 */
app.delete('/staging/:id/note', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const st = await loadOwned(id, req.user!);
  if (!st) return reply.code(404).send({ error: 'not_found' });
  if (st.note_deleted_at) return { alreadyDeleted: true, deletedAt: st.note_deleted_at };

  const [row] = await sql<Array<{ note_deleted_at: string }>>`
    update staging set note_deleted_at = now(), note_deleted_by = ${req.user!.id}
    where id = ${st.id} returning note_deleted_at`;
  return { deleted: true, deletedAt: row!.note_deleted_at };
});

/** 撤销「从速记页删掉」。纯改一格时间戳 —— 原话从来没动过，所以恢复是无损的。 */
app.post('/staging/:id/note/restore', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const st = await loadOwned(id, req.user!);
  if (!st) return reply.code(404).send({ error: 'not_found' });
  await sql`update staging set note_deleted_at = null, note_deleted_by = null where id = ${st.id}`;
  return { restored: true };
});

/**
 * 从**看板**删掉一条记录，并同步软删 CRM 里那几条（issue #25 的前半段 + #29）。
 *
 * 🔴 **部分失败要如实报回去，不整批回滚。** 回滚意味着把刚软删的再恢复一遍，
 *    而恢复本身也可能失败 —— 那时状态比「删了 3 条、有 1 条没删掉」更难说清。
 *    删掉了哪几条原样记进 `record_deleted_refs`，撤销和 data-guard 都只认那一列。
 *
 * ⚠️ 正在写 CRM 的（`confirming` / `committing`）**不许删**：那 5 秒里
 *    `twenty_refs` 还没定下来，删了等于对着一份马上就要变的清单动手。
 *    如实说「等它写完」，别假装删成功。
 */
app.delete('/staging/:id/record', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const st = await loadOwned(id, req.user!);
  if (!st) return reply.code(404).send({ error: 'not_found' });
  if (st.record_deleted_at) return { alreadyDeleted: true, deletedAt: st.record_deleted_at };
  if (['confirming', 'committing'].includes(st.status)) {
    return reply.code(409).send({
      error: 'committing',
      message: '这条正在写进 CRM —— 等它写完（几秒）再删，那时才知道到底建了哪几条。',
    });
  }

  const p = deletionPlan(st as DeletableRow);
  const r = p.refs.length ? await softDeleteRecords(p.refs) : { deleted: [], failed: [] };

  /**
   * 🔴 存的是**实际删掉的那几条**（结果），不是 `plan()` 算出来的（意图）。
   *    两者会不一样：部分失败、老记录走保守白名单、工作项删不掉。
   *    撤销时逐条 `restore{Object}` 走的就是这一列 —— 软删之后那些记录在
   *    Twenty 里**用任何过滤器都查不回来**，这串 id 是唯一的线索（§2.39③）。
   */
  await sql`
    update staging set record_deleted_at = now(), record_deleted_by = ${req.user!.id},
                       record_deleted_refs = ${sql.json(r.deleted as never)}
    where id = ${st.id}`;

  return {
    deleted: true,
    /** 真删掉了几条 CRM 记录。0 = 这条压根没进过 CRM（issue #29 的主场景）。 */
    removed: r.deleted.length,
    summary: describePlan(r.deleted),
    /** 🔴 没删掉的必须让界面说出来 —— 静默留孤儿就是「看不见」当成「不存在」。 */
    failed: r.failed.map((f) => ({ label: labelOf(f.object), reason: f.reason })),
    skipped: p.skipped,
  };
});

/**
 * 撤销看板删除：把软删掉的 CRM 记录恢复回来。
 *
 * ⚠️ 对一条没被删过的记录调 `restore` 是无害的（Twenty 直接回该记录），
 *    所以整份清单一股脑喂进去就行，不需要先问「哪几条真被删了」。
 */
app.post('/staging/:id/record/restore', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const st = await loadOwned(id, req.user!);
  if (!st) return reply.code(404).send({ error: 'not_found' });

  const [row] = await sql<Array<{ refs: unknown }>>`
    select record_deleted_refs as refs from staging where id = ${st.id}`;
  const refs = Array.isArray(row?.refs) ? (row!.refs as any[]) : [];
  const r = refs.length ? await restoreRecords(refs) : { restored: [], gone: [], failed: [] };

  /**
   * 🔴 **只有「值得再试」的失败才卡住撤销。**
   *
   * 限流 / 500 / 断网 → 现在清掉标记的话，看板上会出现一行指向空气的记录，
   * 而下一次点撤销本来是会成功的。所以先不做，让人再点一次。
   *
   * ⚠️ `gone`（Twenty 说这条记录根本不存在）**不算这一类** —— 它再试一百次
   *    也是同一个结果。卡着不放等于人两头都失去：CRM 里那几条回不来，
   *    看板上这一行也永远拿不回来。那种情况下照常撤销，然后**如实说**。
   */
  if (r.failed.length) {
    return reply.code(502).send({
      error: 'restore_failed',
      message: 'CRM 里那几条这次没恢复成功（不是永久性的）—— 看板上这一行先留在删除状态，稍后再试一次。',
      failed: r.failed.map((f) => ({ label: labelOf(f.object), reason: f.reason })),
    });
  }

  await sql`
    update staging set record_deleted_at = null, record_deleted_by = null, record_deleted_refs = null
    where id = ${st.id}`;
  return {
    restored: true,
    recovered: r.restored.length,
    /**
     * 🔴 这几条**永远回不来了**，界面必须说出来。
     * 看板上那一行回来了、而它指向的 CRM 记录没了 —— 不说的话，
     * 人会以为撤销把一切都还原了，直到某天去 CRM 里找才发现是空的。
     */
    gone: r.gone.map((f) => ({ label: labelOf(f.object), reason: f.reason })),
  };
});

/**
 * 「这条会接到哪去」—— 核对卡在入库之前拿它显示落点（D57）。
 *
 * 手册 P23 那一页要的是：人看得见「这家还有一条没关掉的售后」，
 * 然后**自己点**接在它上面，还是另开一条。
 * 猜是不行的：一家客户同时有两个未结案时猜错，
 * 就是把两件不相干的事并成一条，而看板上它仍然只是一条正常记录。
 *
 * ⚠️ 纯只读，不改任何东西。`companyId` 由客户端传 ——
 * 它是人**刚在卡片上选的**那家，还没写进 staging。
 */
app.get('/staging/:id/targets', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const { companyId, category } = req.query as { companyId?: string; category?: string };
  const st = await loadOwned(id, req.user!);
  if (!st) return reply.code(404).send({ error: 'not_found' });
  if (!companyId) return { openCases: [], opportunity: null };

  const { supplierName } = req.query as { supplierName?: string };
  const [openCases, opportunity, supplierId] = await Promise.all([
    listOpenSupportCases(companyId).catch(() => []),
    findOpportunity(companyId, keepCategory(category) as string | null).catch(() => null),
    findSupplierId(supplierName).catch(() => null),
  ]);

  /**
   * 🔴 **项目提案没有编号时，给一个建议编号**（issue #17 根因 D）。
   *
   * 之前的链路：agent 按 prompt 留空编号 → 人在核对卡上**没有任何地方能填** →
   * 确认之后 `commitToTwenty` 静默跳过 → CRM 里没有项目，界面上却是绿色的「已入库」。
   *
   * 编号必须在**人按确认之前**就摆在他眼前 —— 他得知道 CRM 里那条会叫什么，
   * 否则下次他去找这个项目会找不到。生成规则和 `confirm.ts` 的兜底同一个函数，
   * 所以「卡片上显示的」和「真的写进去的」一定一致（除非他自己改了）。
   *
   * ⚠️ **D91 之后这条路多半用不上了** —— `propose_project` 在提案那一刻就取号，
   * 走到这里时 `proj.projectCode` 通常已经有值。留着是因为它还盖住两种情况：
   * ① 提案时客户还没对上号（那时候取不了号，前缀就是客户代号）；
   * ② 提案时 Twenty 连不上，agent 那一侧如实放弃了发号。
   *
   * 🔴 **只读，不占号。** 这是一个 GET，人可能只是把卡片打开看了一眼就走 ——
   * 占了号再走人，序号里就留一个永远的空洞。真正占住是确认那一刻的事。
   */
  let suggestedProjectCode: string | null = null;
  const [row] = await sql<Array<{ extracted: any }>>`
    select extracted from staging where id = ${st.id}`;
  const proj = row?.extracted?.project as Record<string, unknown> | undefined;
  if (proj && !String(proj.projectCode ?? '').trim()) {
    const company = await getCompanyById(companyId).catch(() => null);
    suggestedProjectCode =
      (
        await suggestProjectCode({
          companyCode: company?.accountCode ?? null,
          category: keepCategory(category) as string | null,
          name: typeof proj.name === 'string' ? proj.name : null,
          stagingId: st.id,
        }).catch(() => null)
      )?.code ?? null;
  }

  /**
   * 🔴 **这两个 label 也跟账号的语言走**（D80，和 `/enums`、`/gaps` 同一条判据）。
   *
   * 它们在核对卡上就贴着「当前阶段 {a}」「报于 {a}」显示 —— 那两句是翻了的，
   * 而这两个值原来永远是中文，拼出来就是 `Current stage 样品/台架测试`。
   * ⚠️ **这类漏网 `i18n-report.mjs` 看不见**：字符串在服务端，PWA 源码里
   *    只有一个 `{a}` 占位符。**扫源码的守卫只能守住源码里的东西。**
   */
  const L: Locale = req.user!.locale === 'en' ? 'en' : 'zh';
  const caseLabels = labelsFor(L, CASE_STATUS_LABELS, CASE_STATUS_LABELS_EN);
  const stageLabels = labelsFor(L, STAGE_LABELS, STAGE_LABELS_EN);

  return {
    suggestedProjectCode,
    openCases: openCases.map((c) => ({
      ...c,
      statusLabel: caseLabels[c.caseStatus] ?? c.caseStatus,
    })),
    opportunity: opportunity
      ? { ...opportunity, stageLabel: stageLabels[opportunity.stage] ?? opportunity.stage }
      : null,
    /**
     * 在位品牌对不上受控名单时**必须说出来**（D23a）。
     *
     * 不说的话就是这个项目反复踩的那种「安静的失败」：
     * 卡片上明明写着「在位品牌：Brändle」，人点了确认，
     * 而 CRM 里那一格是空的 —— 没有报错，没有提示，只有一个空格子。
     * 补名单的办法写在 `data/suppliers.json` 里。
     */
    supplierUnmatched: supplierName && !supplierId ? supplierName : null,
  };
});

app.post('/staging/:id/confirm', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as {
    companyId?: string;
    fields?: Record<string, unknown>;
    supportCaseId?: string;
  };

  // D28 修订的闸门就在这里：录入时可以不定客户，**入库时必须定**。
  // 现场每多一步下拉就少录一条；但挂错客户的数据比没录更糟，所以门槛在这一步。
  if (!body.companyId) return reply.code(422).send({ error: 'company_required' });

  const st = await loadOwned(id, req.user!);
  if (!st) return reply.code(404).send({ error: 'not_found' });
  if (st.record_deleted_at) return reply.code(409).send(RECORD_DELETED);
  if (st.status === 'confirmed') return reply.code(200).send({ alreadyConfirmed: true });
  /**
   * 🔴 **`committing` 必须在这里挡住 —— 它是 issue #1 的第二条重复写入路径。**
   *
   * 漏掉它的话：一条正在写 Twenty 的记录再收到一次确认（手滑双击、PWA 重试、
   * 两个人同时点），会一路走到下面的 `requestConfirm()`，
   * 把 status **从 `committing` 改回 `confirming`** 并给一个新的 5 秒窗口 ——
   * 于是心跳再认领一次，**再写一份**。
   *
   * 认领锁只挡得住心跳自己的重入，挡不住这条从 HTTP 进来的。两处都要。
   */
  if (['confirming', 'committing'].includes(st.status)) {
    return reply.code(200).send({ pending: true });
  }
  /**
   * 🔴 被取代的那一版不能入库（issue #14）。
   *
   * 界面上它已经不显示了，但**前端不显示不等于挡住了**（§4.2 第 4 条的同一条判据）：
   * 一个还开着的旧标签页、一次 PWA 重放、批量入库那条路，都能把它送进来。
   * 而它一旦入库，就是同一段对话在 CRM 里写了两份 —— 拜访 / 选型情报 /
   * 售后这些没有自然键的对象会实打实多出一条，这正是这个 issue 要挡的事。
   */
  if (st.status === 'superseded') {
    return reply.code(409).send({
      error: 'superseded',
      message: '这一版已经被同一条对话里后面那次修改取代了 —— 确认最新那一版。',
    });
  }

  const { fields, rejected } = sanitizeFieldEdits(body.fields);
  if (rejected.length) {
    return reply.code(422).send({ error: 'bad_field_value', rejected });
  }

  const { commitAt } = await requestConfirm(st.id, req.user!.id, {
    companyId: body.companyId,
    fields: Object.keys(fields).length ? fields : undefined,
    supportCaseId: body.supportCaseId,
  });
  return { queued: true, commitAt, undoMs: env.confirmDelayMs };
});

/** 撤销。5 秒内点 = Twenty 里从来没写过这条（重录的撤销 = 恢复上一次的样子）。 */
app.delete('/staging/:id/confirm', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const st = await loadOwned(id, req.user!);
  if (!st) return reply.code(404).send({ error: 'not_found' });
  const ok = await cancelConfirm(st.id);
  // 撤不掉只有一种情况：已经过了 5 秒、Twenty 里已经有了。
  // 这时候诚实地说「来不及了」，而不是假装撤销成功再去删记录。
  return ok ? { cancelled: true } : reply.code(409).send({ error: 'too_late' });
});

/**
 * D75：重录 —— 已入库之后改字段，重新提交，**替代**之前那份。
 *
 * 「替代」= `commitToTwenty` 的 update 模式按 `twenty_refs` 逐条 PATCH，
 * 绝不新建第二份（系统里没有删除路径，新建一份旧的还在，那不是替代是复制）。
 * 沿用同一个 5 秒撤销窗：撤销 = 字段弹回上一次的样子，什么都没发生。
 */
app.post('/staging/:id/reconfirm', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as { fields?: Record<string, unknown> };
  const raw = (body.fields ?? {}) as Record<string, unknown>;

  const st = await loadOwned(id, req.user!);
  if (!st) return reply.code(404).send({ error: 'not_found' });
  if (st.record_deleted_at) return reply.code(409).send(RECORD_DELETED);
  if (st.status !== 'confirmed') {
    return reply.code(409).send({
      error: 'not_confirmed',
      message: '这条还没入库（或正在写入）—— 只有已入库的才能重录。',
    });
  }

  /**
   * 🔴 两把明说的锁（D75③）—— 拒绝要说清楚为什么，静默吞掉的下场是
   * 人以为改成功了（这个仓库最贵的那类 bug）：
   * · recordType 在 KEEPERS 里，不显式拦会**悄悄通过**然后把记录落到另一张表里；
   * · companyId 不在 KEEPERS 里，会被**静默丢弃** —— 也要说出来。
   */
  if ('recordType' in raw) {
    return reply.code(422).send({
      error: 'record_type_locked',
      message: '记录类型不能在重录时改 —— 选型和售后是两条生命周期（D25），改类型等于换一条记录，而系统里没有删除路径。回对话里重新说一条吧。',
    });
  }
  if ('companyId' in raw || 'companyCode' in raw) {
    return reply.code(422).send({
      error: 'company_locked',
      message: '客户归属不能在重录时改 —— 已写进 CRM 的一串记录要整体换归属，请在 CRM 里操作。',
    });
  }

  const { fields, rejected } = sanitizeFieldEdits(raw);
  if (rejected.length) return reply.code(422).send({ error: 'bad_field_value', rejected });
  if (!Object.keys(fields).length) {
    return reply.code(422).send({ error: 'nothing_changed', message: '没有可提交的改动。' });
  }

  /**
   * 编号冲突**预检**（维护者：「只要不与现有数据库冲突」）——
   * 提交是 5 秒后异步的，那时的 409 到不了这个请求；能在人还看着屏幕时
   * 说的冲突，就在这里说。commit 里还有同一道守卫挡竞态。
   */
  if (fields.projectCode) {
    const [cur] = await sql<Array<{ refs: Record<string, string> | null }>>`
      select twenty_refs as refs from staging where id = ${st.id}`;
    const other = await findProjectByCode(String(fields.projectCode)).catch(() => null);
    if (other && other.id !== cur?.refs?.projectId) {
      return reply.code(409).send({
        error: 'code_conflict',
        message: `编号 ${fields.projectCode} 已属于另一个项目「${other.name}」—— 换一个编号，或先在 CRM 里处理那一条。`,
      });
    }
  }

  const r = await requestReconfirm(st.id, req.user!.id, fields);
  if (!r) return reply.code(409).send({ error: 'not_confirmed' });
  return { commitAt: r.commitAt, undoMs: env.confirmDelayMs };
});

/** 批量确认。晚上回酒店一次性核对十几条时用。 */
app.post('/staging/confirm-batch', { preHandler: requireAuth }, async (req, reply) => {
  const { items } = (req.body ?? {}) as { items?: Array<{ id: string; companyId: string }> };
  if (!Array.isArray(items) || !items.length) return reply.code(422).send({ error: 'empty' });

  const results: Array<{ id: string; ok: boolean; reason?: string }> = [];
  for (const it of items.slice(0, 100)) {
    if (!it?.companyId) {
      results.push({ id: it?.id, ok: false, reason: 'company_required' });
      continue;
    }
    const st = await loadOwned(it.id, req.user!);
    if (!st) {
      results.push({ id: it.id, ok: false, reason: 'not_found' });
      continue;
    }
    if (st.status === 'confirmed') {
      results.push({ id: it.id, ok: true, reason: 'already' });
      continue;
    }
    // 批量这条路同样要挡被取代的那些（issue #14）——
    // 「批量」不是放松闸门的理由，D28 那条闸门对批量也成立
    if (st.status === 'superseded') {
      results.push({ id: it.id, ok: false, reason: 'superseded' });
      continue;
    }
    await requestConfirm(st.id, req.user!.id, { companyId: it.companyId });
    results.push({ id: it.id, ok: true });
  }
  return { results, undoMs: env.confirmDelayMs };
});

// ── 情报缺口（需求1 在采集端的落点）─────────────────────────────
app.get('/gaps/:code', { preHandler: requireAuth }, async (req, reply) => {
  const { code } = req.params as { code: string };
  const company = await getCompanyByCode(code);
  if (!company) return reply.code(404).send({ error: 'not_found' });

  const items = await listIntelItems();
  const values = await listIntelValues(company.id);
  /**
   * 🔴 **问法和可信度标签跟账号的语言走**（D80，和 `/enums` 同一条判据）。
   * 和那边一样不收 `?locale=` —— 语言是账号上的属性，让前端传就等于让前端说了算。
   */
  const g = computeGaps(items, values, company, req.user!.locale === 'en' ? 'en' : 'zh');

  /**
   * 🔴 **「清单是空的」和「都问过了」是两回事。**
   *
   * 界面上原来只看 `missing.length === 0` 就显示「都问过了。」——
   * 而情报清单一条都还没配（T36），`missing` 当然是空的。
   * 于是每家客户都显示「都问过了」，**那是一句谎话**，
   * 而且刚好把「这个系统区别于一个录音笔的地方」整个盖掉了。
   * 所以 `totalItems` 必须回去，界面靠它区分这两种情况。
   */
  return { code, ...g };
});

// ── 管理控制台。**独立的鉴权（ADMIN_TOKEN），不用 PWA 的 JWT** ──────
// 见 src/admin.ts：它与 PWA 完全分开，不进 PWA 的包。
registerAdmin(app);

// ── 钉钉渠道（T93）。secret 留空 = 整个渠道不存在，下面两行都是空转。──
registerChannels(app);
// ── 实验室 agent（T94）：群里的第二个 bot，独立 secret、空工具表。──
registerLabChannel(app);
// ── 2C 问卷（D138）：不走 agent，网关直接写 Twenty。──
registerSurveys(app, requireAuth);
// ── 订单门户的项目进度（D139–D142）：只有门户服务端经本机 127.0.0.1 调，secret 留空 = 整组 503。──
registerPortal(app);

warnIfColumnSwitchOn();
/**
 * 🔴 **这一行必须排在 `resumePending()` 前面**（T99）—— 它收的是上个进程被杀时
 * 留在 `running` 的 agent_run，判据是「这个进程一轮都还没建过」。
 * 排到后面就会把 `resumePending()` 刚排起来的那一轮当尸体收掉；
 * 真挪了的话 `reapStaleRuns()` 会拒跑并在日志里喊一声，不会静默出事。
 */
await reapStaleRuns();
await resumePending();
await resumeConfirming();
startConfirmTicker();
await resumeSurveys();
startSurveyTicker();
startChannelTicker();
await app.listen({ port: env.port, host: '0.0.0.0' });
console.log(`\n🚪 网关 http://localhost:${env.port}`);
console.log(`   Twenty  ${env.twentyUrl}`);
// 🔴 这一行是故意加的（D67）：`boardUrl` 是唯一一个**发到别人手机上、由别人的浏览器去打开**的地址，
//    而它错的时候完全不报错。它悄悄指着容器内网地址过了一整天，直到有人点了才发现 ——
//    所以让它每次启动都露个脸。和上面那行不一样的话，一眼就能看出来。
console.log(`   看板    ${env.boardUrl}   ← 这个要能在手机上打开`);
console.log(`   模型    转写 ${env.transcribeModel} · 抽取 ${env.extractModel}`);
/**
 * 🔴 **词表条数每次启动都打出来。**
 *
 * 2026-08-05 部署实测：`data/` 在 `.dockerignore` 里，词表根本没进镜像，
 * 容器里读到 0 条 —— 而降级是静默的，转写照常返回，看起来一切正常。
 * 判据和 D67 那条一样：**「配置写了」≠「进程读得到」**，
 * 唯一可靠的办法是让进程自己在启动时把它读到的东西说出来。
 */
{
  const n = industryTerms().length;
  console.log(
    `   词表    ${n} 个行业词${n ? '' : '  ← 🟠 0 个！容器里多半没挂 data/stt-terms.json'}`,
  );
}
console.log(
  `   agent   ${env.agentEnabled ? `开（${env.extractModel} · 思考 ${env.agentReasoning || 'none'} · 上限 ${env.agentMaxSteps} 步 / ${env.agentTimeoutMs / 1000} 秒）` : '🔴 已关闭'}`,
);
console.log(`   确认    延迟 ${env.confirmDelayMs / 1000} 秒提交，期间可撤销`);
console.log(
  `   钉钉    ${env.dingtalkSecret ? `开（回执兜底 webhook ${env.dingtalkDefaultWebhook ? '已配' : '未配'}）` : '关（CHANNEL_DINGTALK_SECRET 留空）'}`,
);
// D127 路由器：和 D125 同一条判据 —— 「配错了完全不报错、只是行为不对」的配置要露在横幅上
console.log(
  `   路由    ${env.routerEnabled ? `开（${env.routerModel} · 不思考 · 超时 ${env.routerTimeoutMs / 1000}s · 判不动进速记 · 杂项由 ${env.chatModel} 直答）` : '关（CHANNEL_ROUTER=off —— 统一入口每条都进速记）'}`,
);
// D139：和钉钉那两行同一条判据（D67）—— 「配错了完全不报错、只是门户那边一直显示旧数据」的开关要露在横幅上
console.log(
  `   门户    ${env.portalSecret ? '开（/portal/* · 只该从本机 127.0.0.1:4000 调）' : '关（PORTAL_SECRET 留空 —— /portal/* 503）'}`,
);
console.log(
  `   实验室  ${env.labSecret ? `开（${env.labModel} · 思考 ${env.labReasoning || 'none'} · 窗口 ${env.labSessionWindowMin} 分钟 · 同步等 ${env.labSyncWaitMs / 1000}s）` : '关（CHANNEL_LAB_SECRET 留空）'}`,
);
/**
 * 🔴 **数据读到没读到，让进程自己说出来**（同 D67 词表那条：`data/` 曾经在
 * `.dockerignore` 里，容器读到 0 条而降级是静默的）。skill 的资料和索引都在
 * 镜像里，但「在镜像里」和「这个进程读得到」是两件事。
 */
if (env.labSecret) {
  void (async () => {
    try {
      const { loadManifest } = await import('../agent/src/lab-products.ts');
      const m = await loadManifest();
      console.log(
        `   产品库  文档索引 ${m.counts.files} 个 / ${m.counts.skus} 个 SKU · ` +
          `下载 ${env.productDocsShareUrl ? '开' : '关（PRODUCT_DOCS_SHARE_URL 留空）'} · ` +
          `定价 ${env.productPricingFile ? `已挂（授权群 ${env.labPricingGroups || '无'}）` : '未挂'}\n`,
      );
    } catch (e) {
      console.warn(`   产品库  🟠 索引读不到：${(e as Error).message.slice(0, 120)}\n`);
    }
  })();
} else console.log('');

/**
 * ── 转写链路自检：**现在踩下去会不会响**（D85 · issue #19 建议⑤）────────
 *
 * 🔴 起因：2026-08-07 上线的 `9247b7f` 让**生产上所有语音输入 100% 不可用**
 * （multipart 里数组编码错了，逐条 400），而部署当天的冒烟**一路绿灯** ——
 * 因为那时还没人录音。故障要等**展会现场第一段录音**才暴露，
 * 而那正是这套系统最贵的一次调用。
 *
 * 所以让网关自己在启动时踩一脚：一段合成的静音，走**和真录音完全同一条
 * 代码路径**（同样的参数、同样的编码、同样的降级）。实测这一脚能踩响这次这个 bug。
 *
 * ⚠️ **不 await。** 自检是诊断，不是前置条件 —— 网络不通时它绝不能拖住网关启动。
 *    结果同时进 `GET /agent/health`，`smoke.sh` 拿它当硬门槛。
 */
void selfTestTranscribe().then((r) => {
  if (r.status === 'ok') console.log(`   转写    ✅ 自检通过（${env.transcribeModel}）\n`);
  else if (r.status === 'skipped') console.log(`   转写    ⏭ 自检已关（TRANSCRIBE_SELFTEST=0）\n`);
  else if (r.status === 'degraded')
    console.warn(
      `   转写    🟠 自检通过，但接口不认 ${r.dropped.join('/')} —— 已自动关掉这些参数。\n` +
        '           转写照常工作，只是听错专有名词的概率变高。\n',
    );
  else
    console.error(
      `\n🔴🔴 转写自检失败 —— **语音输入现在多半是坏的**：${r.detail}\n` +
        '     这条链路是展会现场的主输入路径。先跑一次 node scripts/check-models.mjs，\n' +
        '     再看 .env 里的 OPENAI_API_KEY / OPENAI_TRANSCRIBE_MODEL。\n',
    );
});
