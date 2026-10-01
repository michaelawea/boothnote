import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { env } from './env.ts';
import { codeBase } from './projectCode.ts';
import {
  actorName,
  buildSnapshot,
  LIVE_STATUSES,
  needsType,
  normProject,
  normStage,
  normType,
  normUpdate,
  planStages,
  sanitizeProjectCreate,
  sanitizeProjectPatch,
  sanitizeTypeCreate,
  sanitizeTypePatch,
  sanitizeUpdateCreate,
  sanitizeUpdatePatch,
  typeCodeFor,
  UUID_RE,
  type Snapshot,
} from './portalModel.ts';
import {
  createPortalProject,
  createProjectType,
  createProjectTypeStage,
  createProjectUpdate,
  findPortalProjectByCode,
  findProjectUpdateByClientId,
  getRecord,
  isDuplicateEntry,
  listAllCompanies,
  listAllRecords,
  nextProjectCode,
  softDeleteRecords,
  TooManyRecords,
  updatePortalProject,
  updateProjectType,
  updateProjectTypeStage,
  updateProjectUpdate,
} from './twenty.ts';

/**
 * 客户项目进度的网关一侧：`/portal/*`（D139–D142 · docs/portal-projects.md §4）。
 *
 * 谁调它：**只有订单门户的服务端**，走本机 `127.0.0.1:4000`（D141）——
 * Caddy 对外把 `/api/portal/*` 回 404，Cloudflare Flexible 的回源段是明文，secret 不能过公网。
 * 浏览器永远碰不到这里；Twenty key 仍然只在网关手里（规则 4）。
 *
 * 🔴 **鉴权照抄 `channels/route.ts`**：PORTAL_SECRET 留空 = 整组 503（D66 安全默认）；
 *    secret 只认请求头 `X-Portal-Secret`，放进 URL 一律 401（URL 会进日志和历史）。
 * 🔴 **Twenty 出任何错都回 502 `twenty_unavailable`，不回显 Twenty 的原文** ——
 *    门户靠这个码切到「最后一次好数据」；原文里有 Twenty 的内部细节，不该出网关。
 * 🔴 **关系只收已存在的 UUID**（规则 3）：公司 / 类型 / 阶段逐个回读确认存在、阶段属于项目的类型，
 *    绝不按名字建任何东西。
 * 🔴 删进展只走 GraphQL 软删（`softDeleteRecords`）—— REST DELETE 是硬删（§2.38）。
 *
 * ⚠️ **启动时什么都不碰**：部署序列里网关先起、provision 后跑（deploy-server.sh），
 *    那几分钟里新对象还不存在 —— 这时 `/portal/*` 回 502，门户用缓存兜着。
 */

export const portalStatus = () => (env.portalSecret ? 'on' : 'off');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const secretOk = (given: unknown): boolean => {
  const s = env.portalSecret;
  if (typeof given !== 'string' || !given || !s) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(s);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** 我们自己判出来的 4xx（参数错 / 不存在 / 冲突）。其余一切异常都当 Twenty 出错 → 502。 */
// ⚠️ 不用构造函数参数属性（`constructor(readonly x)`）：Node 直接跑 .ts 是 strip-only 模式，不认那种写法 ——
//    tsc 放过、进程一启动就 SyntaxError（2026-09-30 一次性环境里实测撞到）。
class PortalError extends Error {
  readonly status: 400 | 404 | 409;
  readonly code: string;
  readonly detail: string | undefined;
  readonly extra: Record<string, unknown>;
  constructor(status: 400 | 404 | 409, code: string, detail?: string, extra: Record<string, unknown> = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.extra = extra;
  }
}
const invalid = (errors: string[] | string) =>
  new PortalError(400, 'invalid', Array.isArray(errors) ? errors.join('; ') : errors);
const notFound = (what: string) => new PortalError(404, 'not_found', what);

const guardId = (id: string, what: string) => {
  if (!UUID_RE.test(id)) throw invalid(`${what}: not a UUID`);
  return id.toLowerCase();
};

// ── 快照缓存：~15 秒，**任何一次写都作废**（写完门户马上刷新，必须看到刚写的那条）──────
const SNAPSHOT_TTL_MS = 15_000;
let generation = 0;
let cached: { at: number; gen: number; data: Snapshot } | null = null;
let inflight: { gen: number; p: Promise<Snapshot> } | null = null;

const invalidate = () => {
  generation++;
  cached = null;
};

/**
 * 单飞：同一代里并发的读共用一次拉取。
 * ⚠️ 写发生在拉取途中时，那次拉取的结果**不进缓存**（代号对不上）—— 否则刚写的东西会被一份旧快照盖住 15 秒。
 */
const loadSnapshot = async (): Promise<Snapshot> => {
  if (cached && cached.gen === generation && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.data;
  if (inflight && inflight.gen === generation) return inflight.p;
  const gen = generation;
  const p = (async () => {
    const [companies, projectTypes, stages, projects, updates] = await Promise.all([
      listAllCompanies(),
      listAllRecords('projectTypes'),
      listAllRecords('projectTypeStages'),
      listAllRecords('projects'),
      listAllRecords('projectUpdates'),
    ]);
    const data = buildSnapshot({ companies, projectTypes, stages, projects, updates }, new Date());
    if (gen === generation) cached = { at: Date.now(), gen, data };
    return data;
  })();
  inflight = { gen, p };
  try {
    return await p;
  } finally {
    if (inflight?.p === p) inflight = null;
  }
};

// ── POST /portal/projects 的幂等：同一个 clientId 15 分钟内重放 → 同一个项目 ─────────────
// 内存里记（契约如此）：网关重启之后的重放会建第二个 —— 代价写在 docs/portal-projects.md。
// `codes` = 这个 clientId 已经拿去 POST 过的编号。POST 超时 ≠ 没建成（Twenty 可能已经提交了，
// 只是回包晚于 10 秒）—— 重试之前先按这些编号去认领，认不到才建（review 2026-10-01）。
const DEDUPE_MS = 15 * 60_000;
type Attempt = { at: number; p: Promise<string>; codes: string[] };
const recentProjects = new Map<string, Attempt>();
const sweepRecent = () => {
  const now = Date.now();
  for (const [k, v] of recentProjects) if (now - v.at > DEDUPE_MS) recentProjects.delete(k);
};

/**
 * 门户建的项目编号：有 accountCode 的客户 → `HMG-HAVEL-P2026-003`；没有（或 Twenty 没答上来）→ `PRJ-2026-7F3A9C`。
 *
 * 🔴 **带一个 `P`，和速记管道的 `HMG-HAVEL-2026-003` 分开两条序号**（review 2026-10-01）。
 * 速记那边防撞号靠的是 `staging` 这本账 + 按客户上的 advisory lock（projectCode.ts ②）——
 * 门户建的项目只在 Twenty 里、永远不进那本账，于是两种撞法都挡不住：
 *   · 速记取号时 Twenty 那一下没读到它（翻页 / 门户刚 suggest 完还没 create 的那几百毫秒）；
 *   · 撞上之后**不报错**：速记那条确认时 `findProjectByCode` 命中门户的项目 → `updateProject`
 *     把客户看得见的名字/产品静默改成速记提案的 —— 正是 projectCode.ts ② 说的「最贵的那类 bug」。
 * 分开命名空间之后，速记永远发不出 `-P` 号（`codeBase` 是 `<代号>-<年>`，序号只认纯数字），
 * 门户之间的撞号由 Twenty 的唯一索引当场挡住（下面 isDuplicateEntry 那条退路）—— 不再需要那把锁。
 * 🔴 projectCode 在 Twenty 里是 isUnique，**永远不能是空串**（空串之间也会撞）。
 */
const fallbackCode = () => `PRJ-${new Date().getUTCFullYear()}-${randomBytes(3).toString('hex').toUpperCase()}`;
/** `HMG-HAVEL` + 2026 → `HMG-HAVEL-P2026`。导出给测试锁住「速记那一套永远算不到这里」。 */
export const portalCodeBase = (accountCode: string, year: number) =>
  codeBase(accountCode, year).replace(/-(\d{4})$/, '-P$1');
const projectCodeFor = async (company: any): Promise<string> => {
  const accountCode = typeof company?.accountCode === 'string' ? company.accountCode.trim() : '';
  if (!accountCode) return fallbackCode();
  const got = await nextProjectCode(portalCodeBase(accountCode, new Date().getUTCFullYear()), { portal: true }).catch(() => null);
  return got || fallbackCode();
};

/** 换阶段自动记一条 stageChange（D139）。失败不回滚项目 —— 如实告诉门户「没记上」。 */
const logStageChange = async (projectId: string, stage: any, actor: string | null): Promise<boolean> => {
  try {
    await createProjectUpdate({
      projectId,
      stageId: stage.id,
      kind: 'stageChange',
      title: `Stage: ${String(stage.name ?? '').slice(0, 150)}`,
      occurredAt: new Date().toISOString(),
      datePrecision: 'minute',
      customerVisible: true,
      authorName: actor,
      clientId: randomUUID(),
    });
    return true;
  } catch (e) {
    console.warn(`[portal] 项目 ${projectId} 换了阶段，但 stageChange 进展没记上：${String((e as Error).message).slice(0, 160)}`);
    return false;
  }
};

/** 读一个阶段并确认它属于这个类型（规则 3 + D140）。 */
const stageOfType = async (stageId: string, typeId: string, field: string, opts: { mustBeActive: boolean }) => {
  const stage = await getRecord('projectTypeStages', 'projectTypeStage', stageId);
  if (!stage) throw invalid(`${field}: no such stage`);
  if (normStage(stage).projectTypeId !== typeId) throw invalid(`${field}: stage does not belong to the project's type`);
  if (opts.mustBeActive && stage.isActive !== true) throw invalid(`${field}: stage is no longer in use`);
  return stage;
};

const readType = async (id: string) => {
  const type = await getRecord('projectTypes', 'projectType', id);
  if (!type) return null;
  const stages = await listAllRecords('projectTypeStages', `projectTypeId[eq]:${id}`);
  return { type, stages };
};

/**
 * 建一个类型 + 它的全部阶段。**一个请求是好几次写**（类型一次、每个阶段一次），中途任何一次失败
 * （Twenty 抖一下、10 秒超时）都会留下半个类型。原来它一建出来就是 `isActive:true`：
 * 门户里能选到一个缺阶段的类型，而 admin 重试同一张表单撞上「同名已存在」400，只能手工去修（review 2026-10-01）。
 *
 * 现在：① **先建成停用的**，阶段全建完才打开 —— 半成品永远选不到；
 * ② 重试时撞上的同名类型若是**停用的、而且是刚建的**（15 分钟内）= 上一次没建完的那个 → 接着建完它
 *    （阶段按名字认领，缺的补、多的停用、顺序照这次的来 —— 和 PATCH 走同一个 `planStages`）。
 * 停用了很久的同名类型仍然 400：那是 admin 停用的，不是我们的半成品，不该被「新建」悄悄复活。
 */
const RESUME_MS = 15 * 60_000;
let typeCreates: Promise<unknown> = Promise.resolve();
const createTypeOnce = async (value: ReturnType<typeof sanitizeTypeCreate>['value']) => {
  const types = await listAllRecords('projectTypes');
  const same = types.find((t) => String(t.name ?? '').trim().toLowerCase() === value.name.toLowerCase());
  const unfinished =
    same && same.isActive !== true && Date.now() - Date.parse(String(same.createdAt ?? '')) < RESUME_MS ? same : null;
  // 同名类型会让门户那边两行长得一样 —— 也挡住「上一次其实成功了、门户超时重试」建出第二个
  if (same && !unfinished) throw invalid('name: a project type with this name already exists');

  invalidate();
  const type =
    unfinished ??
    (await createProjectType({
      name: value.name,
      typeCode: typeCodeFor(value.name, types.map((t) => t.typeCode)),
      description: value.description,
      isActive: false,
    }));
  const live = unfinished ? await listAllRecords('projectTypeStages', `projectTypeId[eq]:${type.id}`) : [];
  const liveStages = live.map((s) => {
    const n = normStage(s);
    return { id: n.id, name: n.name, nameZh: n.nameZh ?? '', stageKey: n.stageKey ?? '', order: n.order, isActive: n.isActive };
  });
  // 上一次已经建出来的阶段按名字认领（每个只认一次），认不到的就是要新建的
  const claimed = new Set<string>();
  const desired = value.stages.map((s) => {
    const hit = liveStages.find((l) => !claimed.has(l.id) && l.name.trim().toLowerCase() === s.name.trim().toLowerCase());
    if (hit) claimed.add(hit.id);
    return { ...(hit ? { id: hit.id } : {}), name: s.name, nameZh: s.nameZh ?? '' };
  });
  const plan = planStages(liveStages, desired, []); // 停用的类型上不会有项目
  if (plan.errors.length) throw invalid(plan.errors);
  for (const c of plan.create) await createProjectTypeStage({ projectTypeId: type.id, ...c, isActive: true });
  for (const u of plan.update) await updateProjectTypeStage(u.id, u.patch);
  for (const d of plan.deactivate) await updateProjectTypeStage(d, { isActive: false });
  // 🔴 最后一步才打开 —— 走到这里阶段一定齐了
  await updateProjectType(type.id, { isActive: true, ...(unfinished ? { description: value.description } : {}) });
  invalidate();
  const fresh = await readType(type.id);
  if (!fresh) throw notFound('project type');
  return normType(fresh.type, fresh.stages);
};

export const registerPortal = (app: FastifyInstance) => {
  const guard = async (req: any, reply: any) => {
    // 留空 = 这组接口不存在（D66）。提示指到两处 —— .env 写了但 compose 没传，是这个仓库踩过的坑
    if (!env.portalSecret)
      return reply.code(503).send({
        error: 'portal_disabled',
        hint: '网关进程里 PORTAL_SECRET 是空的。查 .env 和 docker-compose 的 gateway environment 两处',
      });
    if (!secretOk(req.headers['x-portal-secret'])) {
      await sleep(400); // 故意慢一点，让逐个试 secret 不划算
      return reply.code(401).send({ error: 'bad_secret' });
    }
  };

  /** 每个路由的外壳：我们判的 4xx 原样回；**其余一律 502，不回显 Twenty 原文**。 */
  const handle =
    (fn: (req: any, reply: any) => Promise<unknown>) =>
    async (req: any, reply: any) => {
      try {
        return await fn(req, reply);
      } catch (e) {
        if (e instanceof PortalError)
          return reply
            .code(e.status)
            .send({ error: e.code, ...(e.detail ? { detail: e.detail } : {}), ...e.extra });
        // 读到了上限 ≠ Twenty 暂时连不上：这一种**不会自己好**。仍回 502（门户照样有缓存可用），
        // 但换一个码 —— 混在 twenty_unavailable 里的话，所有人看着一份永远不再更新的旧数据，而且没人知道
        if (e instanceof TooManyRecords) {
          console.error(`[portal] 🔴 ${req.method} ${req.routeOptions?.url ?? req.url}：${e.message} —— 要分页/收窄这张表了`);
          return reply.code(502).send({ error: 'snapshot_too_large', detail: `${e.plural} > ${e.limit}` });
        }
        console.warn(`[portal] ${req.method} ${req.routeOptions?.url ?? req.url} → Twenty 出错：${String((e as Error)?.message ?? e).slice(0, 200)}`);
        return reply.code(502).send({ error: 'twenty_unavailable' });
      }
    };

  const opts = { preHandler: guard };

  // ── 读 ────────────────────────────────────────────────────────────
  app.get('/portal/snapshot', opts, handle(async () => loadSnapshot()));

  // ── 项目类型 ──────────────────────────────────────────────────────
  app.post(
    '/portal/project-types',
    opts,
    handle(async (req, reply) => {
      const { value, errors } = sanitizeTypeCreate(req.body);
      if (errors.length) throw invalid(errors);
      // 建类型排成一队：一次超时的重试可能和前一次同时在跑，两个都去补阶段就会建出两套
      const run = typeCreates.then(() => createTypeOnce(value));
      typeCreates = run.catch(() => undefined);
      return reply.code(201).send({ projectType: await run });
    }),
  );

  app.patch(
    '/portal/project-types/:id',
    opts,
    handle(async (req) => {
      const id = guardId(req.params.id, 'id');
      const { value, errors } = sanitizeTypePatch(req.body);
      if (errors.length) throw invalid(errors);
      const cur = await readType(id);
      if (!cur) throw notFound('project type');

      if (value.name !== undefined) {
        const others = (await listAllRecords('projectTypes')).filter((t) => t.id !== id);
        if (others.some((t) => String(t.name ?? '').trim().toLowerCase() === value.name!.toLowerCase()))
          throw invalid('name: a project type with this name already exists');
      }

      const projects =
        value.isActive === false || value.stages
          ? (await listAllRecords('projects')).map(normProject)
          : [];

      // 停用类型：还有在跑的项目用着它就拒（它们的进度条会失去「这个类型还在用」的依据）
      if (value.isActive === false) {
        const live = projects.filter((p) => p.projectTypeId === id && LIVE_STATUSES.includes(p.status));
        if (live.length)
          throw new PortalError(409, 'type_in_use', `${live.length} active project(s) still use this type`, {
            projects: live.map((p) => ({ id: p.id, name: p.name })),
          });
      }

      let plan: ReturnType<typeof planStages> | null = null;
      if (value.stages) {
        plan = planStages(
          cur.stages.map((s) => {
            const n = normStage(s);
            return { id: n.id, name: n.name, nameZh: n.nameZh ?? '', stageKey: n.stageKey ?? '', order: n.order, isActive: n.isActive };
          }),
          value.stages,
          projects,
        );
        if (plan.errors.length) throw invalid(plan.errors);
        // 🔴 整个计划作废，一条都不写（理由见 planStages 的注释）
        if (plan.inUse.length)
          throw new PortalError(
            409,
            'stage_in_use',
            plan.inUse.map((u) => `"${u.stageName}" is the current stage of ${u.projects.length} project(s)`).join('; '),
            { projects: plan.inUse.flatMap((u) => u.projects.map((p) => ({ ...p, stageId: u.stageId }))) },
          );
      }

      invalidate();
      await updateProjectType(id, { name: value.name, description: value.description, isActive: value.isActive });
      if (plan) {
        // 先建先改、最后停用 —— 中途失败时，宁可多一个在用阶段，也别先把在用的停掉
        for (const c of plan.create) await createProjectTypeStage({ projectTypeId: id, ...c, isActive: true });
        for (const u of plan.update) await updateProjectTypeStage(u.id, u.patch);
        for (const d of plan.deactivate) await updateProjectTypeStage(d, { isActive: false });
      }
      invalidate();
      const fresh = await readType(id);
      if (!fresh) throw notFound('project type');
      return { projectType: normType(fresh.type, fresh.stages) };
    }),
  );

  // ── 项目 ──────────────────────────────────────────────────────────
  app.post(
    '/portal/projects',
    opts,
    handle(async (req, reply) => {
      const { value, errors } = sanitizeProjectCreate(req.body);
      if (errors.length) throw invalid(errors);
      const actor = actorName(req.headers['x-portal-actor']);

      sweepRecent();
      // 上一次（或正在跑的那一次）的结果。🔴 每次 await 回来都要再看一眼它还是不是表里那一条：
      // 两个重试同时等着同一个失败的前任，不复核的话两个都会去建 —— 第二个应当去等第一个。
      let carried: string[] = [];
      for (;;) {
        const prior = recentProjects.get(value.clientId);
        if (!prior) break;
        const id = await prior.p.catch(() => null);
        const rec = id ? await getRecord('projects', 'project', id) : null;
        if (recentProjects.get(value.clientId) !== prior) continue;
        if (rec) return reply.code(200).send({ project: normProject(rec), duplicate: true });
        carried = prior.codes; // 上一次失败了 —— 这一次接着做，先认领它可能已经建成的那个
        recentProjects.delete(value.clientId);
        break;
      }

      let stageChangeLogged: boolean | undefined;
      let reclaimed = false;
      const attempt: Attempt = { at: Date.now(), p: null as unknown as Promise<string>, codes: [...carried] };
      /** 这个编号下有没有一个**就是这次要建的**项目（客户 + 名字都对得上，别认领别人的）。 */
      const claim = async (code: string) => {
        const hit = await findPortalProjectByCode(code);
        return hit && hit.companyId === value.companyId && hit.name === value.name ? hit : null;
      };
      const work = (async () => {
        const company = await getRecord('companies', 'company', value.companyId);
        if (!company) throw invalid('companyId: no such company');
        const type = await getRecord('projectTypes', 'projectType', value.projectTypeId);
        if (!type) throw invalid('projectTypeId: no such project type');
        if (type.isActive !== true) throw invalid('projectTypeId: project type is no longer in use');
        const stage = value.currentStageId
          ? await stageOfType(value.currentStageId, type.id, 'currentStageId', { mustBeActive: true })
          : null;
        if (needsType({ portalVisible: value.portalVisible, projectTypeId: type.id, currentStageId: stage?.id ?? null }))
          throw new PortalError(409, 'needs_type', 'a project needs a type and a current stage before it can be shown in the portal');

        const fields = {
          name: value.name,
          companyId: company.id,
          projectTypeId: type.id,
          ...(stage ? { currentStageId: stage.id } : {}),
          status: value.status ?? ('active' as const),
          portalVisible: value.portalVisible === true,
          ...(value.customerSummary ? { customerSummary: value.customerSummary } : {}),
          ...(value.targetDate ? { targetDate: value.targetDate } : {}),
        };
        invalidate();
        // 上一次已经 POST 过、但没等到回包的编号：Twenty 那边建成了就认领它，不建第二个
        for (const code of carried) {
          const hit = await claim(code);
          if (hit) {
            reclaimed = true;
            // 那一次的 stageChange 可能没来得及记：查一下，没有才补（补两条比不补更糟）
            if (stage) {
              const ups = (await listAllRecords('projectUpdates', `projectId[eq]:${hit.id}`)).map(normUpdate);
              stageChangeLogged = ups.some((u) => u.kind === 'stageChange') || (await logStageChange(hit.id, stage, actor));
            }
            invalidate();
            return hit;
          }
        }
        /** 发一次 create；**发之前**先记下编号。超时/断线 → 回头按编号认领一次，认不到再如实抛。 */
        const create = async (projectCode: string) => {
          attempt.codes.push(projectCode);
          try {
            return await createPortalProject({ ...fields, projectCode });
          } catch (e) {
            if (isDuplicateEntry(e)) throw e;
            const hit = await claim(projectCode).catch(() => null);
            if (hit) return hit;
            throw e;
          }
        };
        let project: any;
        try {
          project = await create(await projectCodeFor(company));
        } catch (e) {
          // 编号撞了（两个门户请求同时取到同一个号）：换一个一定不撞的再来一次
          if (!isDuplicateEntry(e)) throw e;
          project = await create(fallbackCode());
        }
        if (stage) stageChangeLogged = await logStageChange(project.id, stage, actor);
        invalidate();
        return project;
      })();
      attempt.p = work.then((p) => p.id as string);
      attempt.p.catch(() => undefined); // 失败由下面的 await 抛；这里只是别让它变成 unhandled
      recentProjects.set(value.clientId, attempt);

      const project = await work;
      // 认领回来的 = 上一次其实建成了：和重放一样回 200 duplicate
      return reply.code(reclaimed ? 200 : 201).send({
        project: normProject(project),
        ...(reclaimed ? { duplicate: true } : {}),
        ...(stageChangeLogged === false ? { stageChangeLogged: false } : {}),
      });
    }),
  );

  app.patch(
    '/portal/projects/:id',
    opts,
    handle(async (req) => {
      const id = guardId(req.params.id, 'id');
      const { value, errors } = sanitizeProjectPatch(req.body);
      if (errors.length) throw invalid(errors);
      const actor = actorName(req.headers['x-portal-actor']);
      const raw = await getRecord('projects', 'project', id);
      if (!raw) throw notFound('project');
      const cur = normProject(raw);

      if (value.companyId && value.companyId !== cur.companyId) {
        if (!(await getRecord('companies', 'company', value.companyId))) throw invalid('companyId: no such company');
      }

      const typeChanged = value.projectTypeId !== undefined && value.projectTypeId !== cur.projectTypeId;
      if (typeChanged) {
        // 换类型必须同时给新类型下的阶段 —— 否则项目停在一个不属于自己类型的阶段上
        if (!value.currentStageId) throw invalid('currentStageId: required when projectTypeId changes');
        const type = await getRecord('projectTypes', 'projectType', value.projectTypeId!);
        if (!type) throw invalid('projectTypeId: no such project type');
        if (type.isActive !== true) throw invalid('projectTypeId: project type is no longer in use');
      }
      const typeId = value.projectTypeId ?? cur.projectTypeId;

      let stage: any = null;
      const stageChanged = value.currentStageId !== undefined && value.currentStageId !== cur.currentStageId;
      // 🔴 换了类型就**一定**核阶段，哪怕阶段 id 没变（review 2026-10-01）：表单换了类型、
      //    却把阶段下拉框的旧值原样发回来 → 原来 stageChanged=false、这一步整个跳过，
      //    项目落成「类型 B + 类型 A 的阶段」（破 D140 / 规则 3），客户那边的进度条放不下它。
      if (stageChanged || typeChanged) {
        if (!typeId) throw invalid('currentStageId: the project has no type yet — send projectTypeId with it');
        const checked = await stageOfType(value.currentStageId!, typeId, 'currentStageId', { mustBeActive: true });
        if (stageChanged) stage = checked; // stageChange 进展只在阶段真的变了时记
      }

      // 只在「打开公开」这一下判 —— 老项目（速记管道建的，没有类型）改个名字不该被挡
      if (
        needsType({
          portalVisible: value.portalVisible,
          projectTypeId: typeId,
          currentStageId: value.currentStageId ?? cur.currentStageId,
        })
      )
        throw new PortalError(409, 'needs_type', 'a project needs a type and a current stage before it can be shown in the portal');

      invalidate();
      const updatedRow = await updatePortalProject(id, value);
      const stageChangeLogged = stage ? await logStageChange(id, stage, actor) : undefined;
      invalidate();
      const fresh = updatedRow?.id ? updatedRow : await getRecord('projects', 'project', id);
      return {
        project: normProject(fresh ?? raw),
        stageChanged,
        ...(stageChangeLogged === false ? { stageChangeLogged: false } : {}),
      };
    }),
  );

  // ── 进展 ──────────────────────────────────────────────────────────
  app.post(
    '/portal/projects/:id/updates',
    opts,
    handle(async (req, reply) => {
      const projectId = guardId(req.params.id, 'id');
      const { value, errors } = sanitizeUpdateCreate(req.body);
      if (errors.length) throw invalid(errors);
      const actor = actorName(req.headers['x-portal-actor']);
      const project = await getRecord('projects', 'project', projectId);
      if (!project) throw notFound('project');

      // 幂等：clientId 在 Twenty 里是 isUnique —— 先查，查到就是重放
      // ⚠️ 这个助手**回数据，不回 reply**：Fastify 的 reply 是 thenable，从 async 函数里 return 它
      //    会被当成 promise 展开成 undefined —— 第一版就这样「以为没查到」接着又建了一次
      //    （Twenty 撞唯一索引、网关日志里一串 FST_ERR_REP_ALREADY_SENT，而门户收到的回包是对的）。
      const replayed = async () => {
        const hit = await findProjectUpdateByClientId(value.clientId);
        if (!hit) return null;
        const u = normUpdate(hit);
        if (u.projectId !== projectId) throw invalid('clientId: already used by an update on another project');
        return u;
      };
      const again = await replayed();
      if (again) return reply.code(200).send({ update: again, duplicate: true });

      if (value.stageId) {
        const typeId = normProject(project).projectTypeId;
        if (!typeId) throw invalid('stageId: the project has no type yet');
        await stageOfType(value.stageId, typeId, 'stageId', { mustBeActive: false });
      }

      invalidate();
      let rec: any;
      try {
        rec = await createProjectUpdate({ ...value, projectId, authorName: actor });
      } catch (e) {
        if (!isDuplicateEntry(e)) throw e;
        // 并发的另一次先写进去了 → 当重放；查不到 = 那条已经被删掉，它的 clientId 仍占着唯一索引
        const late = await replayed();
        if (late) return reply.code(200).send({ update: late, duplicate: true });
        throw invalid('clientId: already used by an update that was deleted');
      }
      invalidate();
      return reply.code(201).send({ update: normUpdate(rec) });
    }),
  );

  app.patch(
    '/portal/updates/:id',
    opts,
    handle(async (req) => {
      const id = guardId(req.params.id, 'id');
      const raw = await getRecord('projectUpdates', 'projectUpdate', id);
      if (!raw) throw notFound('update');
      const cur = normUpdate(raw);
      const { value, errors } = sanitizeUpdatePatch(req.body, cur);
      if (errors.length) throw invalid(errors);

      if (value.stageId) {
        const project = cur.projectId ? await getRecord('projects', 'project', cur.projectId) : null;
        const typeId = project ? normProject(project).projectTypeId : null;
        if (!typeId) throw invalid('stageId: the project has no type yet');
        await stageOfType(value.stageId, typeId, 'stageId', { mustBeActive: false });
      }

      invalidate();
      const row = await updateProjectUpdate(id, value);
      invalidate();
      const fresh = row?.id ? row : await getRecord('projectUpdates', 'projectUpdate', id);
      return { update: normUpdate(fresh ?? raw) };
    }),
  );

  app.delete(
    '/portal/updates/:id',
    opts,
    handle(async (req) => {
      const id = guardId(req.params.id, 'id');
      if (!(await getRecord('projectUpdates', 'projectUpdate', id))) throw notFound('update');
      invalidate();
      // 🔴 软删（GraphQL delete），不是 REST DELETE —— 删错了还能从 Twenty 里恢复
      const r = await softDeleteRecords([{ object: 'projectUpdate', id }]);
      invalidate();
      if (r.failed.length) throw new Error(r.failed[0]!.reason);
      return { deleted: true };
    }),
  );
};
