import { env } from './env.ts';
import { sql } from './db.ts';
import { DefiniteItemOperationError, isDurableItemMutation, recordItemMutationRequest } from './item-operations.ts';
import { TwentyHttpError } from './twenty-errors.ts';
import { companyCountry, normalizeCountry } from '../../../shared/countries.mjs';
import {
  portalProjectBody,
  projectTypeBody,
  projectUpdateBody,
  stageBody,
  type ProjectPatch,
} from './portalModel.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Twenty 客户端 —— **网关是唯一持有 Twenty key 的地方**（§4.2 第1条）。
 * D8 硬纪律：只走 REST API，绝不直连它的数据库表。
 *
 * 🔴 **429 要退避重试。**
 *
 * Twenty 的限流是「每窗口 100 个请求」。一条速记入库现在要跑十几次往返
 * （D59 的项目链 + D61 的 timeline + D62 的完整度重算），连着确认几条就撞得上。
 *
 * 2026-08-04 实测（跑一轮集成测试）日志里就有：
 *
 *     [gaps] 完整度没写回客户档案：Twenty PATCH /rest/companies/… → 429 Limit reached (100 tokens)
 *
 * 而 timeline 和完整度这两处都是**故意吞异常**的（它们是派生数据，不该阻断入库）——
 * 于是 429 的表现是「入库成功、日志干净、CRM 里少了东西」，
 * 正是这个仓库反复栽的那种**静默失败**。
 *
 * `scripts/` 里那几个脚本早就有退避重试了，网关这边一直没有。补上。
 */
const call = async (
  method: string,
  path: string,
  body?: unknown,
  attempt = 0,
  /**
   * 单次请求的超时（毫秒）。**不传 = 不设超时**，和原来一模一样 —— 确认入库那条路径靠的就是这个行为。
   * 只有门户（D139，`/portal/*`）传：门户服务端等 8 秒就改用缓存，网关没必要陪一个卡死的 Twenty 耗下去。
   */
  timeoutMs?: number,
): Promise<any> => {
  await recordItemMutationRequest({ method, path, body });
  const res = await fetch(`${env.twentyUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.twentyKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });

  // 0.5s → 1s → 2s → 4s → 8s，最多 5 次。限流窗口通常一秒级，够用了。
  if (res.status === 429 && attempt < 5 && !isDurableItemMutation(method)) {
    await sleep(500 * 2 ** attempt);
    return call(method, path, body, attempt + 1, timeoutMs);
  }

  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new TwentyHttpError(method, path, res.status, json, text);
  return json;
};

/** Bounded read surface for candidate discovery and final target validation. */
export const twentyRead = (path: string): Promise<any> => {
  if (!path.startsWith('/rest/')) throw new Error('invalid_twenty_read_path');
  return call('GET', path, undefined, 0, 8_000);
};

export type TwentyRecordType='supportCase'|'project'|'workItem'|'visit'|'productFitment'|'opportunity'|'projectDoc';
export const readTwentyRecord = async (type: TwentyRecordType, id: string): Promise<any | null> => {
  const plural = { supportCase: 'supportCases', project: 'projects', workItem: 'workItems',visit:'visits',productFitment:'productFitments',opportunity:'opportunities',projectDoc:'projectDocs' }[type];
  if (!plural || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('invalid_target_id');
  try {
    const r = await twentyRead(`/rest/${plural}/${id}`);
    const record = r?.data?.[type] ?? r?.data;
    if (!record || typeof record !== 'object' || record.id !== id) throw new Error('invalid_target_response');
    return record;
  } catch (error) {
    if ((error as Error).message.includes('→ 404 ')) return null;
    throw error;
  }
};

/** A session lock serializes gateway read/append/write across worker processes. */
export const withTwentyTargetLock = async <T>(object: string, id: string, execute: () => Promise<T>): Promise<T> => {
  const connection=await sql.reserve();
  const key=`crm:${object}:${id}`;
  try {
    const [r]=await connection<Array<{locked:boolean}>>`select pg_try_advisory_lock(hashtextextended(${key},0)) as locked`;
    if (!r?.locked) throw new DefiniteItemOperationError('目标正在由另一轮写入，请稍后核对');
    try { return await execute(); }
    finally { await connection`select pg_advisory_unlock(hashtextextended(${key},0))`; }
  } finally { connection.release(); }
};

export type Company = {
  id: string;
  code: string;
  name: string;
  group: string;
  type: string;
  /** 渠道链上游（D54）。和 group（集团树）是两根不同的轴。 */
  soldViaId?: string | null;
};

let cache: { at: number; items: Company[] } | null = null;
const TTL = 5 * 60_000;

/**
 * 客户名单。PWA 要把它缓存进 IndexedDB 离线用；抽取时也用它做候选枚举注入
 * （§4.2 第3条：关系字段只能是已存在的 UUID，模型不许自由生成名字）。
 */
export const listCompanies = async (force = false): Promise<Company[]> => {
  if (!force && cache && Date.now() - cache.at < TTL) return cache.items;

  const items: Company[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const q = `/rest/companies?limit=60&depth=1${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ''}`;
    const r = await call('GET', q);
    const rows: any[] = r?.data?.companies ?? [];
    if (!rows.length) break;
    for (const c of rows) {
      if (!c?.accountCode) continue; // 只要我们导进去的账户，过滤掉 Twenty 自带的示例数据
      items.push({
        id: c.id,
        code: c.accountCode,
        name: c.name,
        group: c.parentCompany?.name ?? '',
        type: c.accountType ?? '',
        soldViaId: c.soldVia?.id ?? c.soldViaId ?? null,
      });
    }
    if (!r?.pageInfo?.hasNextPage || !r?.pageInfo?.endCursor) break;
    cursor = r.pageInfo.endCursor;
  }
  cache = { at: Date.now(), items };
  return items;
};

export const listSuppliers = async (): Promise<Array<{ id: string; name: string }>> => {
  const r = await call('GET', '/rest/suppliers?limit=100');
  return (r?.data?.suppliers ?? []).map((s: any) => ({ id: s.id, name: s.name }));
};

/**
 * 名字 → 已存在的 supplier 记录（D23a）。
 *
 * 🔴 **查不到就返回 null，绝不新建。**
 *
 * `productFitment.supplier` 是关系字段，值必须受控。允许自由文本的后果
 * 在销售那份 Excel 里已经发生过：同一家会出现 `Voltaro` / `voltaro` /
 * `Voltaro Energy` / `VOLTARO` 四个版本，于是「在位品牌份额」这个
 * 聚合永远算不对，而且**看起来完全正常**。
 *
 * 查不到时调用方把原文写进 `sourceNote` —— 信息不丢，只是暂时没结构。
 */
export const findSupplierId = async (name: string | null | undefined): Promise<string | null> => {
  const wanted = String(name ?? '').trim().toLowerCase();
  if (!wanted) return null;
  const all = await listSuppliers();
  const norm = (s: string) => s.trim().toLowerCase();
  return (
    all.find((s) => norm(s.name) === wanted)?.id ??
    // 「Voltaro」对「Voltaro Energy」这种包含关系也算命中，但**必须够长**：
    // 两个字母的包含匹配会把不相干的牌子连到一起
    (wanted.length >= 4
      ? (all.find((s) => norm(s.name).includes(wanted) || wanted.includes(norm(s.name)))?.id ?? null)
      : null)
  );
};

/**
 * 年产量写回客户档案（手册场景 A：「年产一万二」）。
 *
 * ⚠️ `annualProduction` 是 **TEXT**，原话照抄不换算 ——
 * 现场听到的是「一万二左右」「大概 12k」「12000 台上下」，
 * 硬转成数字会把「左右」「上下」这个信息丢掉，而那恰恰是它的可信度。
 *
 * **只在原来为空时写**：已经有值的说明有人核实过，别让一句随口的话覆盖掉。
 */
export const setAnnualProductionIfEmpty = async (companyId: string, text: string) => {
  const r = await call('GET', `/rest/companies/${companyId}`);
  const cur = (r?.data?.company ?? r?.data)?.annualProduction ?? '';
  if (String(cur).trim()) return false;
  await call('PATCH', `/rest/companies/${companyId}`, { annualProduction: text.slice(0, 120) });
  cache = null;
  return true;
};

/** 把 boothnote 的账号投影成 Twenty 的 contributor（D34/D35④：只同步代号和名字，凭据永不过来）。 */
export const upsertContributor = async (userCode: string, displayName: string): Promise<string> => {
  const r = await call('GET', `/rest/contributors?filter=${encodeURIComponent(`userCode[eq]:${userCode}`)}`);
  const hit = r?.data?.contributors?.[0];
  if (hit) return hit.id;
  const created = await call('POST', '/rest/contributors', {
    name: displayName,
    userCode,
    contributorType: 'INTERNAL',
    isActive: true,
  });
  return (created?.data?.createContributor ?? created?.data)?.id;
};

// ════════════════════════════════════════════════════════════════════
//  Timeline（D61）
//
//  维护者 2026-08-03 问：「录入人的 timeline 怎么都是白的？」
//
//  查下来不是坏了，是 Twenty **只给记录自己写事件**：建一条 Visit，
//  它写一条 `visit.created` 挂在那条 Visit 上，**不会**在这条拜访关联到的
//  客户、录入人、项目身上留下任何痕迹。于是：
//    · 录入人页 timeline = 只有「创建了这个录入人」一条
//    · 客户页  timeline = 只有 created / updated 两条
//  三个面里最该有履历的两个，恰好一片空白。
//
//  修法不碰 Twenty 源码（D8 仍然成立）：`timelineActivity` 就是个普通对象，
//  `target*Id` 是可写的关系字段，我们自己补一条 `linked-<对象>.created` 就行。
//  前端的判据是实测出来的（读了它的 bundle）：
//    · 名字必须是 `linked-<nameSingular>.<动词>` —— 它按前缀反查对象元数据
//    · `linkedRecordId` + `linkedObjectMetadataId` 缺一个就渲染不出那个可点的 chip
//    · 作者名取自 `workspaceMember`，我们没有 → 显示 "Twenty"，如实即可
//
//  🔴 **这是装饰，不是资产。** 写失败一律吞掉 —— timeline 少一行没人会死，
//     因为一行 timeline 而让整条记录入不了库才是真事故。
// ════════════════════════════════════════════════════════════════════

/** nameSingular → objectMetadataId。元数据一辈子不变，进程内缓存到死。 */
const objMetaIds = new Map<string, string>();

const objectMetadataId = async (nameSingular: string): Promise<string | null> => {
  if (objMetaIds.has(nameSingular)) return objMetaIds.get(nameSingular)!;
  // ⚠️ 不带 limit 的话默认只回 30 个对象，我们的自定义对象正好排在后面（实测踩过）
  const r = await call('GET', '/rest/metadata/objects?limit=200');
  const objs: any[] = r?.data?.objects ?? (Array.isArray(r?.data) ? r.data : []);
  for (const o of objs) if (o?.nameSingular && o?.id) objMetaIds.set(o.nameSingular, o.id);
  return objMetaIds.get(nameSingular) ?? null;
};

/** 事件能挂到谁身上。key 就是 timelineActivity 上那个字段去掉 `target`/`Id`。 */
export type TimelineTargets = {
  company?: string | null;
  contributor?: string | null;
  project?: string | null;
  opportunity?: string | null;
  visit?: string | null;
  supportCase?: string | null;
  productFitment?: string | null;
  workItem?: string | null;
  projectDoc?: string | null;
  intelValue?: string | null;
};

/** 一条 timeline 事件的入参。**纯函数部分抽出来是为了能单测**（见 timeline.test.ts）。 */
export const timelineBody = (
  linkedObject: string,
  linkedObjectMetaId: string,
  linkedId: string,
  linkedName: string,
  targets: TimelineTargets,
  happensAt?: string,
) => {
  const body: Record<string, unknown> = {
    name: `linked-${linkedObject}.created`,
    happensAt: happensAt ?? new Date().toISOString(),
    properties: {},
    linkedRecordId: linkedId,
    // 名字是**当时的**快照 —— 记录后来改名了，timeline 上仍是当时那个名字。
    // 这正是 Twenty 起名 `Cached` 的意思，不要改成实时查。
    linkedRecordCachedName: String(linkedName ?? '').slice(0, 200),
    linkedObjectMetadataId: linkedObjectMetaId,
  };
  for (const [k, v] of Object.entries(targets)) {
    if (v) body[`target${k[0]!.toUpperCase()}${k.slice(1)}Id`] = v;
  }
  return body;
};

/**
 * 在若干条记录的 timeline 上留下「某某创建了 X」。
 *
 * 一次 POST 能同时挂到多个 target 上（每个 target 是独立的外键列），
 * 所以一条新记录只多一次写，不是每个 target 一次。
 */
export const logTimeline = async (
  linkedObject: string,
  linkedId: string,
  linkedName: string,
  targets: TimelineTargets,
  happensAt?: string,
): Promise<boolean> => {
  try {
    if (!linkedId) return false;
    if (!Object.values(targets).some(Boolean)) return false; // 没人看得到，别写
    const metaId = await objectMetadataId(linkedObject);
    if (!metaId) return false;
    await call(
      'POST',
      '/rest/timelineActivities',
      timelineBody(linkedObject, metaId, linkedId, linkedName, targets, happensAt),
    );
    return true;
  } catch (e) {
    console.warn('[timeline] 写失败（不影响入库）：', String(e).slice(0, 200));
    return false;
  }
};

export const createVisit = async (input: Record<string, unknown>) => {
  const r = await call('POST', '/rest/visits', input);
  return (r?.data?.createVisit ?? r?.data)?.id as string;
};

/**
 * 把一条拜访挂到项目上、改成「项目跟进」（D59）。
 *
 * 跟进复用 visit 而不是另开对象 —— 它和拜访本来就是同一件事：
 * 一次和客户的接触，产出若干条要做的事。
 */
export const updateVisit = async (
  id: string,
  patch: {
    projectId?: string | null;
    visitType?: string | null;
    /** D75 重录：正文按 ref 更新，不新建第二条拜访。 */
    visitSummary?: string | null;
    name?: string | null;
  },
) => {
  const body: Record<string, unknown> = {};
  if (patch.projectId) body.projectId = patch.projectId;
  if (patch.visitType) body.visitType = sel(patch.visitType);
  if (patch.visitSummary !== undefined && patch.visitSummary !== null) {
    body.visitSummary = patch.visitSummary;
  }
  if (patch.name) body.name = String(patch.name).slice(0, 120);
  if (!Object.keys(body).length) return;
  await call('PATCH', `/rest/visits/${id}`, body);
};

// ── 项目（Opportunity）—— 「阶段」挂在这里（D24 / D56）────────────────
export type Opportunity = {
  id: string;
  name: string;
  stage: string;
  category: string | null;
  nextDecisionWindow: string | null;
};

/**
 * 找这家客户在这个品类下**已经在推进**的那个项目（D56）。
 *
 * 「同一家 + 同一品类 = 同一个项目」是 维护者 2026-08-03 定的。
 * 手册场景 B 描述的正是它：「接在 5/12 那条后面的一条进度，
 * 阶段从 RFQ 往前推到整车验证」—— 推的必须是**同一条**记录，
 * 每次新建的话「阶段」这个字段就失去意义（看板上一家客户会出现
 * 一串阶段各异的同品类项目，排不出「谁走到哪了」）。
 *
 * ⚠️ 没有 category 就返回 null —— **不拿「这家最近的那个项目」凑数**。
 * 品类不明时接错项目，比新开一条糟得多：错的那条会一直错下去。
 */
export const findOpportunity = async (
  companyId: string,
  category: string | null,
): Promise<Opportunity | null> => {
  if (!category) return null;
  const filter = `companyId[eq]:${companyId},category[eq]:${category}`;
  const r = await call(
    'GET',
    `/rest/opportunities?filter=${encodeURIComponent(filter)}&limit=10&order_by=updatedAt[DescNullsLast]`,
  );
  const rows: any[] = r?.data?.opportunities ?? [];
  const hit = rows[0];
  return hit
    ? {
        id: hit.id,
        name: hit.name,
        stage: hit.stage ?? '',
        category: hit.category ?? null,
        nextDecisionWindow: hit.nextDecisionWindow ?? null,
      }
    : null;
};

/** 这家客户的全部项目。给 agent 看「现在走到哪一格」用（手册 P12）。 */
export const listOpportunities = async (companyId: string): Promise<Opportunity[]> => {
  const r = await call(
    'GET',
    `/rest/opportunities?filter=${encodeURIComponent(`companyId[eq]:${companyId}`)}&limit=30`,
  );
  return (r?.data?.opportunities ?? []).map((o: any) => ({
    id: o.id,
    name: o.name,
    stage: o.stage ?? '',
    category: o.category ?? null,
    nextDecisionWindow: o.nextDecisionWindow ?? null,
  }));
};

// ── 项目 / 任务线程 / 项目文档（D59）─────────────────────────────────
export type Project = {
  id: string;
  projectCode: string;
  name: string;
  projectStage: string;
  companyId: string | null;
  opportunityId: string | null;
};

const toProject = (p: any): Project => ({
  id: p.id,
  projectCode: p.projectCode ?? '',
  name: p.name ?? '',
  projectStage: p.projectStage ?? '',
  companyId: p.company?.id ?? p.companyId ?? null,
  opportunityId: p.opportunity?.id ?? p.opportunityId ?? null,
});

/**
 * 按编号找项目。**幂等的支点**（test_example T02 的验收断言：
 * 「项目编号唯一；重复提交时不创建第二个相同编号的项目」）。
 *
 * ⚠️ 编号是人给的，大小写和空格都不可靠 —— 先规范化再比。
 */
export const findProjectByCode = async (code: string | null | undefined): Promise<Project | null> => {
  const want = String(code ?? '').trim();
  if (!want) return null;
  const r = await call(
    'GET',
    `/rest/projects?filter=${encodeURIComponent(`projectCode[eq]:${want}`)}&limit=1&depth=1`,
  );
  const hit = r?.data?.projects?.[0];
  if (hit) return toProject(hit);
  // 大小写/空格不同的情况：拉一页回来自己比。项目不会有几千个，这一步很便宜。
  const all = await call('GET', '/rest/projects?limit=200&depth=1');
  const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, '');
  const loose = (all?.data?.projects ?? []).find(
    (p: any) => norm(String(p.projectCode ?? '')) === norm(want),
  );
  return loose ? toProject(loose) : null;
};

export const listProjects = async (companyId: string): Promise<Project[]> => {
  const r = await call(
    'GET',
    `/rest/projects?filter=${encodeURIComponent(`companyId[eq]:${companyId}`)}&limit=50&depth=1`,
  );
  return (r?.data?.projects ?? []).map(toProject);
};

/**
 * 全库找项目（按编号或名字模糊）。
 *
 * 🔴 **为什么需要它**（issue #17 根因 C，2026-08-05）：
 * `listProjects(companyId)` 要一个**已经匹配上的客户**。而 维护者 实测的
 * 那条 CI-Bus 速记恰恰是新项目 + 客户没对上号 —— 于是 agent
 * **没有任何办法**回答「这是新项目还是已有项目」，只能猜，然后猜错。
 *
 * prompt 里写着「先 get_projects 看编号在不在」，那条指令在客户对不上号时
 * 根本无法执行 —— **指令给了、能力没给，是这个仓库反复踩的形状**。
 *
 * 只读，Ring 1。项目在 CRM 里本来就是团队共享的（作用域只在 `/staging?scope=all`
 * 那一层按 role 裁），所以放开全库查**不构成新的泄露**。
 */
export const searchProjects = async (query: string, limit = 8): Promise<Project[]> => {
  const q = String(query ?? '').trim();
  if (!q) return [];
  // 项目不会有几千个，拉一页回来自己比 —— 比拼 filter 语法稳，也不怕大小写
  const all = await call('GET', '/rest/projects?limit=200&depth=1');
  const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, '');
  const want = norm(q);
  return (all?.data?.projects ?? [])
    .filter((p: any) => norm(String(p.projectCode ?? '')).includes(want) || norm(String(p.name ?? '')).includes(want))
    .slice(0, limit)
    .map(toProject);
};

/**
 * 下一个可用的项目编号。**编号由网关生成，不由模型生成**（issue #17 根因 D）。
 *
 * 模型编的编号下次认不出是同一个项目 —— 而编号是幂等的支点（`projectCode` 在
 * Twenty 里是 `isUnique`）。网关编的是查得到、可复现的。
 *
 * ⚠️ **这里有一个已知竞态**：延迟提交是并发的（`confirm.ts` 的 `POOL = 4`），
 * 两条速记同批确认可能同时取到同一个序号，第二条会因为唯一约束写失败。
 * 现场是一个人一条条确认，实际撞不上；真撞上时上层会退回 `ready` 并留错误，
 * 人再点一次就是下一个号。**不要假设它是串行的**。
 */
export const nextProjectCode = async (prefix: string, opts: { portal?: boolean } = {}): Promise<string> => {
  const base = prefix.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').replace(/-+$/, '');
  /*
   * 🔴 **只读这个前缀、并且翻完所有页**（review 2026-10-01）。原来是一页 `limit=200`、不排序、不过滤 ——
   * 项目一多，第 201 个起的编号就看不见，发出去的 `-004` 可能早已存在，而撞上的后果是
   * 入库时 `findProjectByCode` 命中别人的项目 → update 掉它（projectCode.ts ②）。
   * `ilike`：手工建的编号大小写不可靠，下面的正则本来就是不分大小写地比。实测 2026-10-01 本地 Twenty。
   */
  const filter = encodeURIComponent(`projectCode[ilike]:"${base}-%"`);
  const get = (path: string) => (opts.portal ? pcall('GET', path) : call('GET', path));
  const re = new RegExp(`^${base}-(\\d{3})$`);
  let max = 0;
  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    if (page >= 50) throw new TooManyRecords(`projects（前缀 ${base}）`, 50 * PAGE);
    const all = await get(
      `/rest/projects?limit=${PAGE}&depth=0&filter=${filter}` + (cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ''),
    );
    for (const p of all?.data?.projects ?? []) {
      const m = String(p.projectCode ?? '').toUpperCase().match(re);
      if (m?.[1]) max = Math.max(max, Number(m[1]));
    }
    if (!all?.pageInfo?.hasNextPage || !all?.pageInfo?.endCursor) break;
    cursor = all.pageInfo.endCursor;
  }
  return `${base}-${String(max + 1).padStart(3, '0')}`;
};

export type ProjectInput = {
  projectCode: string;
  name: string;
  companyId: string;
  opportunityId?: string | null;
  projectStage?: string | null;
  ownerTeam?: string | null;
  budgetEur?: number | null;
  primaryProductName?: string | null;
  sampleQty?: number | null;
  plannedSop?: string | null;
  specSummary?: string | null;
  openQuestions?: string | null;
  recordedById?: string | null;
  sourceInboxId?: string | null;
};

const projectBody = (i: Partial<ProjectInput>) => ({
  ...(i.name ? { name: i.name.slice(0, 120) } : {}),
  ...(i.projectCode ? { projectCode: i.projectCode.trim() } : {}),
  ...(i.companyId ? { companyId: i.companyId } : {}),
  ...(i.opportunityId ? { opportunityId: i.opportunityId } : {}),
  ...(i.projectStage ? { projectStage: sel(i.projectStage) } : {}),
  ...(i.ownerTeam ? { ownerTeam: i.ownerTeam.slice(0, 120) } : {}),
  ...(i.budgetEur ? { budget: eur(i.budgetEur) } : {}),
  ...(i.primaryProductName ? { primaryProductName: i.primaryProductName.slice(0, 120) } : {}),
  ...(Number.isFinite(Number(i.sampleQty)) && i.sampleQty != null
    ? { sampleQty: Number(i.sampleQty) }
    : {}),
  ...(i.plannedSop ? { plannedSop: i.plannedSop } : {}),
  ...(i.specSummary ? { specSummary: { markdown: i.specSummary } } : {}),
  ...(i.openQuestions ? { openQuestions: { markdown: i.openQuestions } } : {}),
  ...(i.recordedById ? { recordedById: i.recordedById } : {}),
  ...(i.sourceInboxId ? { sourceInboxId: i.sourceInboxId } : {}),
});

export const createProject = async (input: ProjectInput): Promise<string> => {
  const r = await call('POST', '/rest/projects', projectBody(input));
  return (r?.data?.createProject ?? r?.data)?.id as string;
};

/**
 * 更新已有项目。**只发要改的那几个** ——
 * 空值也发过去的话，第二次跟进会把第一次填好的参数清掉。
 */
export const updateProject = async (id: string, patch: Partial<ProjectInput>) => {
  const body = projectBody(patch);
  if (!Object.keys(body).length) return;
  await call('PATCH', `/rest/projects/${id}`, body);
};

export type WorkItemInput = {
  itemCode: string;
  name: string;
  projectId?: string | null;
  followupId?: string | null;
  companyId?: string | null;
  threadType?: string | null;
  body?: string | null;
  priority?: string | null;
  ownerRole?: string | null;
  dueDate?: string | null;
  customerDueDate?: string | null;
  itemStatus?: string | null;
  blockedById?: string | null;
  blockedByCodes?: string | null;
  openQuestions?: string | null;
  recordedById?: string | null;
  sourceInboxId?: string | null;
};

export const findWorkItemByCode = async (code: string): Promise<{ id: string } | null> => {
  const want = String(code ?? '').trim();
  if (!want) return null;
  const r = await call(
    'GET',
    `/rest/workItems?filter=${encodeURIComponent(`itemCode[eq]:${want}`)}&limit=1`,
  );
  const hit = r?.data?.workItems?.[0];
  return hit ? { id: hit.id } : null;
};

/**
 * 一条线程的载荷。create 和 update 共用 —— 两边不一致的话，
 * 「新建时记住的字段」和「更新时记住的字段」会慢慢分叉，而且谁也发现不了。
 */
const workItemBody = (i: WorkItemInput) => ({
  name: i.name.slice(0, 120),
  ...(i.projectId ? { projectId: i.projectId } : {}),
  ...(i.followupId ? { followupId: i.followupId } : {}),
  ...(i.companyId ? { companyId: i.companyId } : {}),
  ...(i.threadType ? { threadType: sel(i.threadType) } : {}),
  ...(i.body ? { body: { markdown: i.body } } : {}),
  ...(i.priority ? { priority: sel(i.priority) } : {}),
  ...(i.ownerRole ? { ownerRole: i.ownerRole.slice(0, 120) } : {}),
  ...(i.dueDate ? { dueDate: i.dueDate } : {}),
  ...(i.customerDueDate ? { customerDueDate: i.customerDueDate } : {}),
  ...(i.blockedById ? { blockedById: i.blockedById } : {}),
  ...(i.blockedByCodes ? { blockedByCodes: i.blockedByCodes.slice(0, 200) } : {}),
  ...(i.openQuestions ? { openQuestions: i.openQuestions.slice(0, 500) } : {}),
  ...(i.recordedById ? { recordedById: i.recordedById } : {}),
  ...(i.sourceInboxId ? { sourceInboxId: i.sourceInboxId } : {}),
});

/**
 * 🔴 **编号撞了要「更新」，不是「跳过」。**
 *
 * 2026-08-03 实测撞到的最贵的一个 bug，因为它**完全静默**：
 * T02 那次提交建了 `…-001-01..04` 四条线程；T04 说「更新 …-001，接口与 Pin 定义最优先，
 * 客户希望 8/14 前收到第一版」——**同样的四个编号**。
 * 旧实现 `findWorkItemByCode` 一命中就 `continue`，于是
 *   · 线程类型还是 T02 那次的 milestone（应该是 doc / software）
 *   · 「最优先」没变成 URGENT
 *   · 客户日期还是 9/30（应该是 8/14）
 *   · 依赖关系一条都没连上
 *   · 这次跟进底下**一条线程都没挂**
 * 而 `twenty_refs` 里写着 `workItems: "4"` —— 看起来一切正常。
 *
 * 「同编号不新建第二条」（D59 的幂等）和「同编号的后续更新一律丢弃」是两回事。
 * 前者是要的，后者是 bug —— 项目那边一直是「撞了就 updateProject」，线程这边漏了。
 *
 * ⚠️ 只覆盖**这次真的说了**的字段（`workItemBody` 里全是 `...(x ? {} : {})`），
 * 没提到的一格不动 —— 否则一句「这条改成紧急」会把截止日期抹掉。
 */
export const updateWorkItem = async (id: string, i: WorkItemInput) => {
  const patch = workItemBody(i);
  // itemStatus 不在这里覆盖：状态是**人在 CRM 里推的**，
  // 一次跟进提案不该把「处理中」打回「待处理」。
  await call('PATCH', `/rest/workItems/${id}`, patch);
  return id;
};

export const createWorkItem = async (i: WorkItemInput): Promise<string> => {
  const r = await call('POST', '/rest/workItems', {
    ...workItemBody(i),
    itemCode: i.itemCode.trim(),
    itemStatus: sel(i.itemStatus || 'open'),
  });
  return (r?.data?.createWorkItem ?? r?.data)?.id as string;
};

/** 把依赖补上。**建完全部线程之后再做** —— 依赖可能指向后建的那条。 */
export const setWorkItemBlockedBy = async (id: string, blockedById: string) => {
  await call('PATCH', `/rest/workItems/${id}`, { blockedById });
};

export const listWorkItems = async (projectId: string) => {
  const r = await call(
    'GET',
    `/rest/workItems?filter=${encodeURIComponent(`projectId[eq]:${projectId}`)}&limit=100&depth=1`,
  );
  return (r?.data?.workItems ?? []).map((w: any) => ({
    id: w.id,
    itemCode: w.itemCode ?? '',
    name: w.name ?? '',
    threadType: w.threadType ?? '',
    priority: w.priority ?? '',
    itemStatus: w.itemStatus ?? '',
    dueDate: w.dueDate ?? null,
  }));
};

export type ProjectDocInput = {
  name: string;
  docCode?: string | null;
  projectId?: string | null;
  workItemId?: string | null;
  companyId?: string | null;
  version?: string | null;
  /** 🔴 customerAttachment / agentGenerated / dictation / internal —— 这一栏最要紧 */
  docSource: string;
  reviewStatus?: string | null;
  isBaseline?: boolean;
  content?: string | null;
  attachmentId?: string | null;
  recordedById?: string | null;
  sourceInboxId?: string | null;
};

export const createProjectDoc = async (i: ProjectDocInput): Promise<string> => {
  const r = await call('POST', '/rest/projectDocs', {
    name: i.name.slice(0, 120),
    ...(i.docCode ? { docCode: i.docCode.slice(0, 80) } : {}),
    ...(i.projectId ? { projectId: i.projectId } : {}),
    ...(i.workItemId ? { workItemId: i.workItemId } : {}),
    ...(i.companyId ? { companyId: i.companyId } : {}),
    version: (i.version || 'v0.1').slice(0, 20),
    docSource: sel(i.docSource),
    /**
     * 🔴 **默认 draft，而且 AI 生成的只能是 draft。**
     * 「客户已确认」这个状态只有人能给 —— AI 整理的东西被当成客户书面确认过的规格，
     * 是这类系统最贵的一种错（D59）。
     */
    reviewStatus: sel(
      i.docSource === 'agentGenerated' || i.docSource === 'dictation'
        ? 'draft'
        : i.reviewStatus || 'draft',
    ),
    ...(i.isBaseline ? { isBaseline: true } : {}),
    ...(i.content ? { content: { markdown: i.content } } : {}),
    ...(i.attachmentId ? { attachmentId: i.attachmentId } : {}),
    generatedAt: new Date().toISOString(),
    ...(i.recordedById ? { recordedById: i.recordedById } : {}),
    ...(i.sourceInboxId ? { sourceInboxId: i.sourceInboxId } : {}),
  });
  return (r?.data?.createProjectDoc ?? r?.data)?.id as string;
};

export const listProjectDocs = async (projectId: string) => {
  const r = await call(
    'GET',
    `/rest/projectDocs?filter=${encodeURIComponent(`projectId[eq]:${projectId}`)}&limit=50`,
  );
  return (r?.data?.projectDocs ?? []).map((d: any) => ({
    id: d.id,
    name: d.name,
    version: d.version,
    docSource: d.docSource,
    reviewStatus: d.reviewStatus,
    isBaseline: d.isBaseline === true,
  }));
};

/** 这家客户已经记过的在位品牌。避免同一件事报第二遍。 */
export const listProductFitments = async (companyId: string) => {
  const r = await call(
    'GET',
    `/rest/productFitments?filter=${encodeURIComponent(`companyId[eq]:${companyId}`)}&limit=40&depth=1`,
  );
  return (r?.data?.productFitments ?? []).map((p: any) => ({
    id: p.id,
    category: p.category ?? null,
    supplier: p.supplier?.name ?? null,
    modelName: p.modelName ?? null,
    confidence: p.confidence ?? null,
  }));
};

/** 欧元 → Twenty 的 CURRENCY 形状。它存的是「微单位」，1 欧 = 1_000_000。 */
const eur = (amount: number) => ({
  amountMicros: Math.round(amount * 1_000_000),
  currencyCode: 'EUR',
});

export type OpportunityInput = {
  name: string;
  companyId: string;
  category: string;
  stage?: string | null;
  nextDecisionWindow?: string | null;
  originVisitId?: string | null;
  budgetEur?: number | null;
  /**
   * ⚠️ 下面四个是 D59 加进 schema 的，但**到 2026-08-04 为止一次都没被写过**
   * —— 抽到了、摘要里显示了、CRM 里是空的（issue #4）。
   * T01 的验收原话是「无法承载就该新增字段，而不是把信息丢弃」；
   * 字段早就有了，只是没接上，那和丢弃没有区别。
   */
  annualDemand?: string | null;
  demandBreakdown?: string | null;
  targetPrice?: string | null;
  ownerTeam?: string | null;
};

/** create 和 update 共用 —— 两边分叉的话，「新建时记住的」和「更新时记住的」会慢慢不一样。 */
const opportunityBody = (i: Partial<OpportunityInput>) => ({
  ...(i.stage ? { stage: sel(i.stage) } : {}),
  ...(i.nextDecisionWindow ? { nextDecisionWindow: i.nextDecisionWindow } : {}),
  ...(i.budgetEur ? { amount: eur(i.budgetEur) } : {}),
  ...(i.annualDemand ? { annualDemand: i.annualDemand.slice(0, 500) } : {}),
  ...(i.demandBreakdown ? { demandBreakdown: i.demandBreakdown.slice(0, 500) } : {}),
  ...(i.targetPrice ? { targetPrice: i.targetPrice.slice(0, 200) } : {}),
  ...(i.ownerTeam ? { ownerTeam: i.ownerTeam.slice(0, 120) } : {}),
});

export const createOpportunity = async (input: OpportunityInput) => {
  const r = await call('POST', '/rest/opportunities', {
    name: input.name.slice(0, 120),
    companyId: input.companyId,
    category: sel(input.category),
    ...(input.originVisitId ? { originVisitId: input.originVisitId } : {}),
    ...opportunityBody(input),
  });
  return (r?.data?.createOpportunity ?? r?.data)?.id as string;
};

/** 推进已有项目。只传要改的那几个 —— 别把 null 也发过去覆盖掉别人填的东西。 */
export const updateOpportunity = async (id: string, patch: Partial<OpportunityInput>) => {
  // 只传这次真的说了的那几个 —— 空值不发过去，别覆盖掉别人填的东西
  const body: Record<string, unknown> = opportunityBody(patch);
  if (!Object.keys(body).length) return;
  await call('PATCH', `/rest/opportunities/${id}`, body);
};

export const createProductFitment = async (input: Record<string, unknown>) => {
  // null 的关系字段直接不发 —— Twenty 对显式 null 的关系 id 不总是宽容，
  // 而「没查到在位品牌」和「在位品牌是 null」在这里是同一件事
  const body = Object.fromEntries(Object.entries(input).filter(([, v]) => v != null));
  const r = await call('POST', '/rest/productFitments', body);
  return (r?.data?.createProductFitment ?? r?.data)?.id as string;
};

/**
 * D75 重录：按 ref 更新已入库的选型情报，不新建第二条。
 * 只发这次真的要改的 —— `sourceNote` / `sourceInboxId` / `visitId` 是溯源，永不动。
 */
export const updateProductFitment = async (
  id: string,
  patch: {
    name?: string | null;
    category?: string | null;
    modelName?: string | null;
    supplierId?: string | null;
    confidence?: string | null;
  },
) => {
  const body: Record<string, unknown> = {};
  if (patch.name) body.name = String(patch.name).slice(0, 120);
  if (patch.category) body.category = sel(patch.category);
  if (patch.modelName) body.modelName = patch.modelName;
  if (patch.supplierId) body.supplierId = patch.supplierId;
  if (patch.confidence) body.confidence = sel(patch.confidence);
  if (!Object.keys(body).length) return;
  await call('PATCH', `/rest/productFitments/${id}`, body);
};

// ── 新建客户（D28 修订 / 维护者 2026-07-30）─────────────────────────
// 「新建客户不需要审批，记录 recordedBy 就行，但必须 specify 名字、国家、类型」。
// **查重不在这里做** —— 在 `POST /companies` 那一层，因为查重要拦的是人的手，
// 而这个函数只是最后那一下写入。放这里的话，agent 或将来任何调用方绕过去就没了。
export const createCompany = async (input: {
  name: string;
  accountCode: string;
  accountType: string;
  hqCountry: string;
  parentCompanyId?: string | null;
}) => {
  const country = normalizeCountry(input.hqCountry);
  if (!country) throw new Error('invalid_country');
  const r = await call('POST', '/rest/companies', {
    name: input.name,
    accountCode: input.accountCode,
    accountType: input.accountType,
    hqCountryCode: country,
    ...(input.parentCompanyId ? { parentCompanyId: input.parentCompanyId } : {}),
  });
  const id = (r?.data?.createCompany ?? r?.data)?.id as string;
  cache = null; // 名单变了，别让 5 分钟 TTL 里新建的客户搜不到
  return id;
};

// ── 2C 问卷（D138）──────────────────────────────────────────────────
// 调用顺序与幂等性在 `surveys.ts` 顶部；这里只是四下写入。

/** 按手机上那份问卷的 id 找已经写进去的那一行 —— 重试前先查，有就不再建。 */
export const findConsumerSurvey = async (
  clientId: string,
): Promise<{ id: string; companyId: string | null } | null> => {
  const r = await call('GET', `/rest/consumerSurveys?filter=${encodeURIComponent(`clientId[eq]:${clientId}`)}`);
  const hit = r?.data?.consumerSurveys?.[0];
  return hit ? { id: hit.id, companyId: hit.companyId ?? hit.company?.id ?? null } : null;
};

export const createConsumerSurvey = async (body: Record<string, unknown>): Promise<string> => {
  const r = await call('POST', '/rest/consumerSurveys', body);
  return (r?.data?.createConsumerSurvey ?? r?.data)?.id as string;
};

/**
 * 答问卷的人 → 一家终端客户。
 *
 * 🔴 **故意不给 `accountCode`**：`listCompanies()` 只收有代号的，于是几百个消费者
 * 不会出现在 PWA 的客户页、也不会进 agent 的候选名单（那两处都是给 56 家 OEM 用的）。
 * 在 Twenty 里照样是一家客户，按「账户类型 = 终端客户」筛得出来。
 */
export const createEndUserCompany = async (name: string): Promise<string> => {
  const r = await call('POST', '/rest/companies', { name, accountType: 'END_USER' });
  return (r?.data?.createCompany ?? r?.data)?.id as string;
};

export const linkSurveyCompany = async (surveyId: string, companyId: string) => {
  await call('PATCH', `/rest/consumerSurveys/${surveyId}`, { companyId });
};

/**
 * 把 A 的渠道上游设成 B（D54）。
 *
 * ⚠️ 用的是 `soldVia`，**不是 `parentCompany`** —— 后者是集团树。
 * 写错一个字段名，两棵树会一起烂掉。
 */
export const setSoldVia = async (companyId: string, upstreamId: string | null) => {
  await call('PATCH', `/rest/companies/${companyId}`, { soldViaId: upstreamId });
  cache = null;
};

export const getCompanyByCode = async (code: string): Promise<Record<string, any> | null> => {
  const r = await call(
    'GET',
    `/rest/companies?filter=${encodeURIComponent(`accountCode[eq]:${code}`)}&depth=1`,
  );
  const company = r?.data?.companies?.[0];
  return company ? { ...company, hqCountry: companyCountry(company) } : null;
};

/** 整条客户档案（含全部自定义列）—— 算情报完整度要按 `itemKey` 逐列看有没有值。 */
export const getCompanyById = async (id: string): Promise<Record<string, any> | null> => {
  const r = await call('GET', `/rest/companies/${id}?depth=1`);
  const company = r?.data?.company ?? r?.data;
  return company ? { ...company, hqCountry: companyCountry(company) } : null;
};

// ── 情报清单与取值（D17 / D47）──────────────────────────────────────
export type IntelItem = {
  id: string;
  itemKey: string;
  question: string;
  /**
   * 英文问法。**空着就退回中文** —— 一个中文问题比一个空白格子有用。
   *
   * 🔴 这一列 2026-08-07 就随 schema 建好了、`seed-intel-items.mjs` 也一直在写，
   *    19 条一条不缺 —— 但**在这之前没有任何代码读过它**：
   *    `normalizeIntelItem` 把它丢在这里，于是英文账号的「还没问过的」
   *    整块都是中文（2026-08-11 维护者 报的第一条）。
   *    **provision 写得进去、字段查得到，不代表有人在读。**
   */
  questionEn: string;
  valueType: string;
  appliesTo: string;
  wave: number | null;
  weight: number | null;
  isEnabled: boolean;
  createdByAgent: boolean;
};

/**
 * 一条清单项的规范形。**纯函数，为了能单测**（见 `intel.test.ts`）。
 *
 * 🔴 **`appliesTo` / `valueType` 在 Twenty 里是大写的**（`COMPANY` / `TEXT`），
 * 而调用方比的是小写字面量 `'company'`。
 *
 * 2026-08-03 实测撞到：清单灌进库之后 `/gaps` 与 agent 的 `get_company_gaps`
 * **依然返回「情报清单还没有配置任何项」** —— 19 条记录明明在 CRM 里躺着。
 * 没有报错、没有警告，需求 1 整个卖点就这么静默地不存在。
 *
 * 所以在**读取这一层**统一压成小写：调用方一个都不用改，
 * 以后新加的调用方也自动是对的。
 */
export const normalizeIntelItem = (i: any): IntelItem => ({
  id: i.id,
  itemKey: i.itemKey,
  question: i.question ?? '',
  questionEn: i.questionEn ?? '',
  valueType: String(i.valueType ?? 'text').toLowerCase(),
  appliesTo: String(i.appliesTo ?? 'company').toLowerCase(),
  wave: i.wave ?? null,
  weight: i.weight ?? null,
  isEnabled: i.isEnabled !== false,
  createdByAgent: i.createdByAgent === true,
});

export const listIntelItems = async (): Promise<IntelItem[]> => {
  const r = await call('GET', '/rest/intelItems?limit=200');
  return (r?.data?.intelItems ?? []).map(normalizeIntelItem);
};

/**
 * 把算出来的缺口**写回客户档案**（D17③：完整度是存储字段，不是计算字段）。
 *
 * 为什么必须落库而不是每次算：存储才能在 Twenty 的视图里直接排序和筛选。
 * 「完整度 < 40% 且属于 OEM 品牌」就是一个保存视图，不用写一行代码 ——
 * 「情报最缺的」那个视图（D60）整个就靠这一列，它是空的时候那个视图只是一张乱序的表。
 *
 * 🔴 **写失败不许往上抛。** 这是派生数据，随时能重算；
 *    而调用它的地方（`commitToTwenty`）此刻已经把真记录写进 CRM 了。
 */
export const saveIntelGaps = async (
  companyId: string,
  g: { completeness: number | null; missing: Array<{ key: string; question: string }> },
): Promise<boolean> => {
  try {
    await call('PATCH', `/rest/companies/${companyId}`, {
      intelCompleteness: g.completeness,
      // 缺什么：给人看的清单，逗号分隔就够了（Twenty 上是 TEXT）
      missingIntel: g.missing.map((m) => m.key).join(', ').slice(0, 500) || null,
      // 🔴 只放**前三个**。D17④：一次摊 27 项等于回到钉钉文档，销售直接放弃。
      nextAsk: g.missing.slice(0, 3).map((m) => m.question).join('　/　').slice(0, 500) || null,
    });
    cache = null;
    return true;
  } catch (e) {
    console.warn('[gaps] 完整度没写回客户档案（不影响已入库的记录）：', String(e).slice(0, 160));
    return false;
  }
};

/**
 * D47 护栏③：**新造的 `weight` 一定是 0**，不参与完整度算分。
 *
 * 理由值得写在代码里，因为它不是显然的：完整度 = 已填权重 / 总权重。
 * agent 每造一个带权重的字段，分母就大一点，于是**所有客户的完整度都往下掉**——
 * 造得越多掉得越狠。那个指标当场作废，而没有人会立刻意识到是 agent 干的。
 * 人把它升级成正式列时，再手动给权重。
 */
/**
 * 🔴 SELECT 字段的值在 Twenty 里是**大写**的。
 *
 * `twenty-schema.mjs` 里写的是 `yn('text','文本','gray')` 小写，
 * 但 Twenty 建字段时会把 option value 规范化成 `TEXT`。传小写会拿到
 * `400 Invalid value "text" for field valueType` —— 实测（2026-08-03）
 * 就是这么炸的，而且只在 agent 真的去造字段那一刻才炸。
 * 所有 SELECT 值都过这一层，别在调用点各写各的。
 */
const sel = (v: string) => String(v ?? '').toUpperCase();

export const createIntelItem = async (input: {
  itemKey: string;
  question: string;
  valueType: string;
  appliesTo: string;
  sourceInboxId: string;
}) => {
  const r = await call('POST', '/rest/intelItems', {
    name: input.question.slice(0, 80),
    itemKey: input.itemKey,
    question: input.question,
    valueType: sel(input.valueType),
    appliesTo: sel(input.appliesTo),
    wave: 9, // 9 = 「机会型」，不是首访就该问的那种
    weight: 0, // ← 护栏③
    isEnabled: true,
    createdByAgent: true,
    sourceInboxId: input.sourceInboxId,
  });
  return (r?.data?.createIntelItem ?? r?.data)?.id as string;
};

export const createIntelValue = async (input: {
  intelItemId: string;
  companyId: string | null;
  value: string;
  valueType: string;
  sourceInboxId: string;
  recordedById?: string | null;
  /** 手册 P18：传闻必须标成传闻。留空才落 LIKELY。 */
  confidence?: string | null;
  /** 听谁说的。只留痕，不改这条挂在谁名下。 */
  sourceName?: string | null;
}) => {
  const num = Number(input.value);
  const r = await call('POST', '/rest/intelValues', {
    name: input.value.slice(0, 80),
    intelItemId: input.intelItemId,
    ...(input.companyId ? { companyId: input.companyId } : {}),
    valueText: input.value,
    ...(input.valueType === 'number' && Number.isFinite(num) ? { valueNumber: num } : {}),
    ...(input.valueType === 'boolean'
      ? { valueBoolean: /^(true|yes|是|1)$/i.test(input.value.trim()) }
      : {}),
    confidence: sel(input.confidence || 'LIKELY'),
    ...(input.sourceName ? { sourceName: String(input.sourceName).slice(0, 120) } : {}),
    sourceInboxId: input.sourceInboxId,
    recordedAt: new Date().toISOString(),
    ...(input.recordedById ? { recordedById: input.recordedById } : {}),
    createdByAgent: true,
  });
  return (r?.data?.createIntelValue ?? r?.data)?.id as string;
};

/**
 * 建一条售后问题（D25）。
 *
 * ⚠️ 和 `productFitment` 是**两条方向相反的生命周期**：
 * 选型情报是「从没接触推进到成交」，售后是「从发生到关闭」。
 * 所以必须是两个对象、两个看板 —— 不能因为「都是关于这家客户的一条记录」
 * 就混着写。混了之后两边的看板都会失去意义。
 */
export const createSupportCase = async (input: {
  name: string;
  companyId: string;
  issueDescription: string;
  caseStatus: string;
  severity: string;
  sourceNote: string;
  recordedById?: string | null;
  /** 手册 P22 那张卡上的两格。之前只画了界面没有字段，2026-08-03 补上。 */
  deliveryBatch?: string | null;
  affectedUnits?: number | null;
}) => {
  const r = await call('POST', '/rest/supportCases', {
    name: input.name.slice(0, 120),
    companyId: input.companyId,
    ...(input.deliveryBatch ? { deliveryBatch: String(input.deliveryBatch).slice(0, 120) } : {}),
    ...(Number.isFinite(Number(input.affectedUnits)) && input.affectedUnits != null
      ? { affectedUnits: Number(input.affectedUnits) }
      : {}),
    /**
     * 🔴 `issueDescription` 是 **RICH_TEXT**，**不收纯字符串**。
     *
     * 传字符串会拿到 `400 Invalid object value '…' for field "issueDescription"`。
     * 实测（2026-08-03）：`{ markdown }` 和 `{ blocknote, markdown }` 都收，
     * 字符串不收。这类错只在真去写那一刻才炸 —— 类型检查和单元测试都碰不到。
     */
    issueDescription: { markdown: `${input.issueDescription}\n\n${input.sourceNote}` },
    caseStatus: sel(input.caseStatus),
    severity: sel(input.severity),
    reportedAt: new Date().toISOString(),
    ...(input.recordedById ? { recordedById: input.recordedById } : {}),
  });
  return (r?.data?.createSupportCase ?? r?.data)?.id as string;
};

/**
 * 这家客户**还没关掉**的售后问题（手册 P23）。
 *
 * 「三天后有进展，接着推」—— 推的必须是同一条 case。
 * 之前每次确认都无条件新建，于是同一个故障在看板上变成三条独立记录，
 * 而「最常见的失败是被忘了」（手册 P24）这句话就成了自我实现的预言：
 * 三条重复记录里没有一条是完整的，谁也说不清哪条才算数。
 *
 * 已解决 / 已关闭的不算 —— 那些是**结束了**的，新进展该开新的一条。
 */
export type OpenCase = {
  id: string;
  name: string;
  caseStatus: string;
  severity: string;
  reportedAt: string | null;
};

export const listOpenSupportCases = async (companyId: string): Promise<OpenCase[]> => {
  const filter = `companyId[eq]:${companyId}`;
  const r = await call(
    'GET',
    `/rest/supportCases?filter=${encodeURIComponent(filter)}&limit=30&order_by=createdAt[DescNullsLast]`,
  );
  return (r?.data?.supportCases ?? [])
    .filter((c: any) => !['RESOLVED', 'CLOSED'].includes(String(c.caseStatus ?? '').toUpperCase()))
    .map((c: any) => ({
      id: c.id,
      name: c.name,
      caseStatus: c.caseStatus ?? '',
      severity: c.severity ?? '',
      reportedAt: c.reportedAt ?? null,
    }));
};

/**
 * 往已有的 case 上追加一段进展。
 *
 * ⚠️ **追加，不是覆盖。** 把原来的 `issueDescription` 读出来接在前面 ——
 * 售后记录的价值一半在时间线上，覆盖掉等于把前两次的排查全扔了。
 * 这和 `inbox` 只增不改是同一条判据，只是这里的载体是 Twenty 的字段。
 */
export const appendToSupportCase = async (
  id: string,
  input: {
    progress: string;
    caseStatus?: string | null;
    severity?: string | null;
    by: string;
    deliveryBatch?: string | null;
    affectedUnits?: number | null;
    operationId?: string;
    expectedCompanyId?: string;
  },
) => {
  const append = async () => {
  let cur: any;
  try { cur=await readTwentyRecord('supportCase',id); }
  catch { throw new DefiniteItemOperationError('目标售后单读取失败，尚未追加'); }
  if (!cur || cur.deletedAt) throw new DefiniteItemOperationError('目标售后单已不存在或已删除');
  if (input.expectedCompanyId && (cur.companyId??cur.company?.id)!==input.expectedCompanyId) {
    throw new DefiniteItemOperationError('目标售后单客户已变更');
  }
  const prev = cur?.issueDescription?.markdown ?? '';
  const marker=input.operationId ? `<!-- boothnote-operation:${input.operationId} -->` : '';
  if (marker && prev.includes(marker)) return;
  if (['CLOSED','RESOLVED'].includes(String(cur.caseStatus).toUpperCase())) {
    throw new DefiniteItemOperationError('目标售后单已经结束，不能追加或重新打开');
  }
  const stamp = new Date().toISOString().slice(0, 10);

  const body: Record<string, unknown> = {
    issueDescription: {
      markdown: `${prev}\n\n---\n\n### 进展 · ${stamp} · ${input.by}\n\n${input.progress}${marker ? `\n\n${marker}` : ''}`.trim(),
    },
  };
  if (input.caseStatus) body.caseStatus = sel(input.caseStatus);
  if (input.severity) body.severity = sel(input.severity);
  // 批次和台数只补空的 —— 后一次说「大概 20 台」不该盖掉前一次数清楚的 18
  if (input.deliveryBatch && !String(cur.deliveryBatch ?? '').trim()) {
    body.deliveryBatch = input.deliveryBatch;
  }
  if (input.affectedUnits != null && cur.affectedUnits == null) {
    body.affectedUnits = input.affectedUnits;
  }
  // 首次响应时间：空的时候补上，之后不再动
  if (!cur.firstResponseAt) body.firstResponseAt = new Date().toISOString();
  // 状态推到「已解决」时记下解决时间
  if (['RESOLVED', 'CLOSED'].includes(sel(input.caseStatus ?? '')) && !cur.resolvedAt) {
    body.resolvedAt = new Date().toISOString();
  }

  await call('PATCH', `/rest/supportCases/${id}`, body);
  };
  return withTwentyTargetLock('supportCase',id,append);
};

/**
 * D75 重录：更新已入库售后的**状态类字段**。
 *
 * 🔴 **不碰 `issueDescription`。** 正文是 append-only 的时间线
 * （和 `inbox` 只增不改同一条判据）—— 重录能改的只有枚举格，
 * 正文本来也不在可改清单里。推到已解决时补 `resolvedAt`（只补空的）。
 */
export const updateSupportCase = async (
  id: string,
  patch: {
    caseStatus?: string | null;
    severity?: string | null;
    deliveryBatch?: string | null;
    affectedUnits?: number | null;
    expectedCompanyId?: string;
  },
) => {
  const update=async()=> {
  let current: any;
  if (patch.expectedCompanyId) {
    try { current=await readTwentyRecord('supportCase',id); }
    catch { throw new DefiniteItemOperationError('目标售后单读取失败，尚未修改'); }
    if (!current || current.deletedAt) throw new DefiniteItemOperationError('目标售后单已不存在或已删除');
    if ((current.companyId??current.company?.id)!==patch.expectedCompanyId) throw new DefiniteItemOperationError('目标售后单客户已变更');
    if (['CLOSED','RESOLVED'].includes(String(current.caseStatus).toUpperCase()) &&
        patch.caseStatus && sel(patch.caseStatus)!==String(current.caseStatus).toUpperCase()) {
      throw new DefiniteItemOperationError('目标售后单已经结束，不能重新打开');
    }
  }
  const body: Record<string, unknown> = {};
  if (patch.caseStatus) body.caseStatus = sel(patch.caseStatus);
  if (patch.severity) body.severity = sel(patch.severity);
  if (patch.deliveryBatch) body.deliveryBatch = String(patch.deliveryBatch).slice(0, 120);
  if (patch.affectedUnits != null && Number.isFinite(Number(patch.affectedUnits))) {
    body.affectedUnits = Number(patch.affectedUnits);
  }
  if (!Object.keys(body).length) return;
  if (['RESOLVED', 'CLOSED'].includes(sel(patch.caseStatus ?? ''))) {
    const r = current ? null : await call('GET', `/rest/supportCases/${id}`);
    const cur = current ?? r?.data?.supportCase ?? r?.data ?? {};
    if (!cur.resolvedAt) body.resolvedAt = new Date().toISOString();
  }
  await call('PATCH', `/rest/supportCases/${id}`, body);
  };
  return withTwentyTargetLock('supportCase',id,update);
};

export const listIntelValues = async (companyId: string) => {
  const r = await call(
    'GET',
    `/rest/intelValues?filter=${encodeURIComponent(`companyId[eq]:${companyId}`)}&limit=200&depth=1`,
  );
  return (r?.data?.intelValues ?? []) as any[];
};

/* ══════════════════════════════════════════════════════════════════
 *  软删除与恢复（issue #25 · D93）
 *
 *  这是这个系统里**第二条**会动 Twenty 已有记录的路径 ——
 *  第一条是 `commitToTwenty`（D48③：只有它往 CRM 写）。
 *  D63 里那句「全系统唯一的删除路径」说的是 `scripts/purge-test-records.mjs`，
 *  那是运维脚本；这里是人在界面上点出来的，所以门槛完全不同。
 *
 *  ── 🔴 实测（2026-08-10 复测，本地 Twenty v2.25.1，§2.38）────────────
 *
 *  ⛔ **纠正 2026-08-07 记下的那条事实，它是错的。**
 *     （那条只存在于 `acea35c` 的提交信息里，编号写的是 §2.39，从没落进规划文档；
 *      现在正确的那一条在文档里是 §2.38。）
 *     当时写的是「REST `DELETE /rest/{对象}/{id}` 打的是 GraphQL 的
 *     `delete{Object}`，本来就是软删」。**不是。**
 *     REST DELETE 在这个版本上是**硬删除** —— 复测的做法是绕开 API
 *     直接查 Twenty 的库表：
 *
 *       GraphQL deleteVisit  → 行还在，`deletedAt` 有时间戳 → restoreVisit ✅ 回得来
 *       REST   DELETE /rest/visits/:id → **`_visit` 表里那一行整个没了** → 无法恢复
 *
 *     两者的**回包长得几乎一样**（都是 `{"data":{"deleteVisit":{...}}}`），
 *     所以只看 API 响应完全分不出来 —— 08-07 那次就是这么判错的。
 *     🔴 **判据：「软删还是硬删」这种问题，回包答不了，只有数据本身能答。**
 *        验证方法必须是「删完之后去存储层看那一行还在不在」，不是读响应。
 *
 *  ✅ ① GraphQL `delete{Object}(id:)` **是真软删**：`deletedAt` 被打上时间戳，
 *        库里那行原样留着。
 *  ✅ ② GraphQL `restore{Object}(id:)` 能把它原样恢复（`deletedAt` 回 null，
 *        之后 REST GET 又是 200）—— **但只对①删掉的那些有效**。
 *        八个对象的 delete/restore 都由 schema 内省确认存在，不是按命名规律猜的。
 *  ✅ ③ 软删之后那条记录**用任何过滤器都查不回来**：`deletedAt: {is: NOT_NULL}`
 *        返回空、`withSoftDeleted` 这个参数在这个版本压根不存在（报
 *        `Argument not allowed`）—— 查询层有个抹不掉的 `deletedAt IS NULL` 作用域。
 *
 *  ③ 决定了整个设计：**能恢复的前提是我们自己存住了那串 id。**
 *  所以删除时绝不清 `staging.twenty_refs` / `created_records`，
 *  它们是撤销时唯一的线索来源。
 *
 *  ①② 决定了这里**只能走 GraphQL，一个 REST DELETE 都不能发** ——
 *  维护者 2026-08-07 的裁定是「用软删除，不用硬删除」，而在这个版本上
 *  REST DELETE 就是硬删除。`destroy{Object}`（永久删除）同样一处都不调。
 *
 *  ⚠️ `scripts/purge-test-records.mjs` 仍然用 REST DELETE，那是**对的**：
 *     它要的就是真删掉（清测试垃圾），而且是运维脚本、一次性、人在场。
 *     两条路径的目标不同，不要「统一」它们。
 * ══════════════════════════════════════════════════════════════════ */

/**
 * GraphQL 调用。删除和恢复**都**走它（见上面 ①）。
 *
 * 没有复用 `call()`：它是 REST 专用的（拼 `/rest/...`、按 HTTP 状态判成败），
 * 而 GraphQL 永远回 200，错误在 body 的 `errors` 里 —— 判成败的方式不一样，
 * 硬塞进同一个函数会得到一个「两边都对付一下」的 `call`。
 */
const gql = async <T = any>(query: string, variables: Record<string, unknown>, attempt = 0): Promise<T> => {
  const res = await fetch(`${env.twentyUrl}/graphql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.twentyKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json: any = await res.json().catch(() => null);
  /**
   * 🔴 **GraphQL 的限流不是 429。** Twenty 的节流器在 GraphQL 这一侧抛的是 UserInputError ——
   * 回包是 HTTP 200 + `errors[].extensions.subCode = "LIMIT_REACHED"`（2026-09-30 读 Twenty 源码
   * `throttler-to-graphql-api-exception-handler` 确认；门户集成测试里真撞到过一次）。
   * 只认 429 的话，限流会被当成「删除/恢复失败」—— 又是 §2.39 那个「限流伪装成数据问题」的形状。
   */
  const limited =
    res.status === 429 ||
    (Array.isArray(json?.errors) && json.errors.some((e: any) => e?.extensions?.subCode === 'LIMIT_REACHED'));
  if (limited && attempt < 5) {
    await sleep(500 * 2 ** attempt);
    return gql<T>(query, variables, attempt + 1);
  }
  // 🔴 GraphQL 回 200 也可能是失败的。只看 res.ok 会把每一次错误当成功。
  if (!res.ok || json?.errors?.length) {
    throw new Error(`Twenty GraphQL → ${res.status} ${JSON.stringify(json?.errors ?? json).slice(0, 300)}`);
  }
  return json?.data as T;
};

/**
 * 可删对象表。**顺序是承重的：子在前，父在后。**
 *
 * 项目下面挂着工作项和文档，反过来删会被外键挡住 ——
 * 这个顺序是 `scripts/purge-test-records.mjs` 用 111 个真实 DELETE 试出来的，
 * 直接沿用，不要重新排。
 * （软删其实碰不到外键，但恢复时「父先回来」仍然要靠它，所以照留。）
 *
 * `gql` 是 mutation 名里的单数 PascalCase（`deleteWorkItem` / `restoreProjectDoc`），
 * 八个的两种拼法都由 schema 内省确认过；第九个 `projectUpdate`（D139）的 delete / restore
 * 2026-09-30 在本地 Twenty 上实测过（软删后 REST GET 回 404、列表里消失，restore 回得来）。
 * ⚠️ **没有 `rest` 了** —— 这里一个 REST DELETE 都不发（见文件头 §2.38）。
 */
const DELETABLE = {
  workItem: { gql: 'WorkItem' },
  projectDoc: { gql: 'ProjectDoc' },
  // D139：门户删进展（DELETE /portal/updates/:id）。挂在项目下，所以排在 project 前面
  projectUpdate: { gql: 'ProjectUpdate' },
  visit: { gql: 'Visit' },
  productFitment: { gql: 'ProductFitment' },
  supportCase: { gql: 'SupportCase' },
  intelValue: { gql: 'IntelValue' },
  opportunity: { gql: 'Opportunity' },
  project: { gql: 'Project' },
} as const;

export type DeletableObject = keyof typeof DELETABLE;
export const isDeletableObject = (s: string): s is DeletableObject => s in DELETABLE;

/** 删除顺序（子→父）。恢复时反过来走，让父先回来。 */
const DELETE_ORDER = Object.keys(DELETABLE) as DeletableObject[];

export type RecordRef = { object: DeletableObject; id: string; name?: string };
export type SoftDeleteResult = {
  deleted: RecordRef[];
  failed: Array<RecordRef & { reason: string }>;
};

export type RestoreResult = {
  /** 真的回来了的。 */
  restored: RecordRef[];
  /**
   * 🔴 **永远回不来了** —— Twenty 说这条记录不存在。
   *
   * 和 `failed` 分开是有实际后果的，不是分类学：
   *   · `gone`   再试一百次也是这个结果 → 撤销该**照做**（把看板那一行放回去），
   *              然后如实说「CRM 里那几条找不回来了」。卡着不放等于人两头都失去。
   *   · `failed` 限流 / 500 / 断网 → **值得再试** → 撤销先别做，
   *              免得看板上出现一行指向空气的记录。
   * 分不清这两者的话，只能二选一：要么永久卡死，要么永久说谎。
   */
  gone: Array<RecordRef & { reason: string }>;
  /** 这次没成、但下次可能成的。 */
  failed: Array<RecordRef & { reason: string }>;
};

/**
 * 按 ref 清单逐条软删，子在前父在后。
 *
 * 🔴 **一条失败不影响其余** —— 部分成功要如实报回去，
 *    不能整批回滚（回滚意味着把刚软删的再恢复，而恢复本身也可能失败，
 *    那时候状态就彻底说不清了）。调用方拿 `failed` 去告诉人「这几条没删掉」。
 *
 * 🔴 **「本来就不在了」算成功。** 那条记录上一次已经删过、或在 CRM 里被人删掉了，
 *    目的地状态和我们要的一致。报成失败会让人以为还有东西留着。
 *
 * 🔴 **只走 GraphQL 的 `delete{Object}`。** REST `DELETE /rest/...` 在
 *    Twenty v2.25.1 上是**硬删除**（复测见文件头 §2.38），而 维护者 的裁定是
 *    「用软删除，不用硬删除」—— 硬删掉的记录撤销按钮永远救不回来。
 */
export const softDeleteRecords = async (refs: RecordRef[]): Promise<SoftDeleteResult> => {
  const out: SoftDeleteResult = { deleted: [], failed: [] };
  const ordered = [...refs].sort(
    (a, b) => DELETE_ORDER.indexOf(a.object) - DELETE_ORDER.indexOf(b.object),
  );
  for (const ref of ordered) {
    const spec = DELETABLE[ref.object];
    try {
      await gql(`mutation($id: UUID!) { delete${spec.gql}(id: $id) { id } }`, { id: ref.id });
      out.deleted.push(ref);
    } catch (e) {
      const msg = (e as Error).message;
      // 已经不在了 = 目的达到。Twenty 回的是 `RECORD_NOT_FOUND` / `NOT_FOUND`
      if (/NOT_FOUND|not found/i.test(msg)) out.deleted.push(ref);
      else out.failed.push({ ...ref, reason: msg.slice(0, 200) });
    }
  }
  return out;
};

/**
 * 撤销删除：把软删掉的记录恢复回来。
 *
 * 走 GraphQL —— REST 没有恢复动作。**父在前子在后**（删除顺序反过来）。
 *
 * ⚠️ 对一条**没被删过**的记录调 restore 是无害的（Twenty 直接回该记录），
 *    所以这里可以把整份 ref 清单一股脑喂进来，不需要先知道哪几条真被删了。
 *    这一点很重要：删除时的 `deleted` 清单可能因为网关重启而没写完整，
 *    而「全部 restore 一遍」是幂等的。
 */
export const restoreRecords = async (refs: RecordRef[]): Promise<RestoreResult> => {
  const out: RestoreResult = { restored: [], gone: [], failed: [] };
  const ordered = [...refs].sort(
    (a, b) => DELETE_ORDER.indexOf(b.object) - DELETE_ORDER.indexOf(a.object),
  );
  for (const ref of ordered) {
    const spec = DELETABLE[ref.object];
    try {
      await gql(`mutation($id: UUID!) { restore${spec.gql}(id: $id) { id } }`, { id: ref.id });
      out.restored.push(ref);
    } catch (e) {
      const msg = (e as Error).message;
      /**
       * 🔴 `RECORD_NOT_FOUND` 在这里的意思是「这条记录**真的不在库里了**」。
       *
       * 软删掉的记录 restore 是找得到的（那正是 restore 存在的理由）——
       * 找不到只有一种原因：它被硬删了。历史上有两个来源：
       *   · `scripts/purge-test-records.mjs`（REST DELETE，它就是要真删）
       *   · 08-07 到 08-10 之间这条路径自己发的 REST DELETE（§2.38 那个错误）
       * 再试多少次都一样，所以归到 `gone`，让调用方**照常撤销**并说实话。
       */
      if (/NOT_FOUND|not found/i.test(msg)) out.gone.push({ ...ref, reason: msg.slice(0, 200) });
      else out.failed.push({ ...ref, reason: msg.slice(0, 200) });
    }
  }
  return out;
};

/* ══════════════════════════════════════════════════════════════════
 * 客户项目进度（D139–D142 · docs/portal-projects.md）—— 只给 `portal.ts` 用
 *
 * 🔴 **这是「写 Twenty 只在 commitToTwenty()」之外的第三条被允许的路**
 *    （前两条：2C 问卷 D138、管理台 upsertContributor）。门户 admin 在门户里点的每一下
 *    都是一次人明确发起的写入，没有「待确认」这一层可挂 —— 所以直接写，失败就回 502，
 *    门户那边提示稍后再试（docs/gateway-contract.md 规则 4 的例外清单）。
 *
 * 请求体一律由 `portalModel.ts` 的纯函数拼（只放给了的字段、SELECT 转 UPPER_SNAKE、
 * create 时不带空关系）—— 这里只管发出去、读回来。
 * ══════════════════════════════════════════════════════════════════ */

/** 门户这条路上每个 Twenty 请求的超时。门户自己 8 秒就放弃改用缓存，这里多给一点余量。 */
const PORTAL_TIMEOUT_MS = 10_000;
const pcall = (method: string, path: string, body?: unknown) => call(method, path, body, 0, PORTAL_TIMEOUT_MS);

/** Twenty REST 一页最多 200 条（多要也只给 200，实测 2026-10-01）。 */
const PAGE = 200;

/**
 * 分页读全读到了上限。**单独一个类型** —— 门户那边要能和「Twenty 暂时连不上」分开（`snapshot_too_large`）：
 * 这一种不会自己好，躲在「用缓存」后面的话，所有人看到的都是一份永远不再更新的旧数据，而且没人知道。
 */
export class TooManyRecords extends Error {
  readonly plural: string;
  readonly limit: number;
  constructor(plural: string, limit: number) {
    super(`Twenty ${plural}：${limit} 条还没读完 —— 不截断，停在这里`);
    this.plural = plural;
    this.limit = limit;
  }
}

/**
 * 分页读全一个对象（每页 200，按 `starting_after` 游标往下翻）。
 *
 * 🔴 **超过页数上限就抛，绝不静默截断。** 截断的后果是「第 N+1 个项目不存在」——
 * 门户那边看不出区别，而对某个客户来说他的项目就是凭空没了。
 * ⚠️ 页是串行翻的（游标翻页只能这样），所以每页尽量大：原来 60 一页，1000 条进展就是 17 次往返。
 */
export const listAllRecords = async (plural: string, filter?: string, maxPages = 50): Promise<any[]> => {
  const out: any[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const r = await pcall(
      'GET',
      `/rest/${plural}?limit=${PAGE}&depth=0` +
        (filter ? `&filter=${encodeURIComponent(filter)}` : '') +
        (cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ''),
    );
    out.push(...(r?.data?.[plural] ?? []));
    if (!r?.pageInfo?.hasNextPage || !r?.pageInfo?.endCursor) return out;
    cursor = r.pageInfo.endCursor;
  }
  throw new TooManyRecords(plural, maxPages * PAGE);
};

/** 按 id 读一条。**不存在（含已软删）→ null**，别的错照抛（门户那边据此回 502）。 */
export const getRecord = async (plural: string, singular: string, id: string): Promise<any | null> => {
  try {
    const r = await pcall('GET', `/rest/${plural}/${encodeURIComponent(id)}?depth=0`);
    return r?.data?.[singular] ?? null;
  } catch (e) {
    if (/ → 404 /.test((e as Error).message)) return null;
    throw e;
  }
};

/**
 * **所有**客户（门户绑账号要能选到任何一家）。
 * ⚠️ 和 `listCompanies()` 不是一回事：那个只要带 accountCode 的（给 PWA 和 agent），
 * 会把 END_USER 这类没有代号的客户滤掉。
 */
export const listAllCompanies = () => listAllRecords('companies');

const created = (r: any, singular: string) => {
  const rec = r?.data?.[`create${singular}`] ?? r?.data;
  if (!rec?.id) throw new Error(`Twenty 建 ${singular} 没回 id`);
  return rec;
};
const updated = (r: any, singular: string) => r?.data?.[`update${singular}`] ?? r?.data ?? null;

export const createProjectType = async (i: Parameters<typeof projectTypeBody>[0]) =>
  created(await pcall('POST', '/rest/projectTypes', projectTypeBody(i)), 'ProjectType');

export const updateProjectType = async (id: string, i: Parameters<typeof projectTypeBody>[0]) => {
  const body = projectTypeBody(i);
  if (!Object.keys(body).length) return null;
  return updated(await pcall('PATCH', `/rest/projectTypes/${id}`, body), 'ProjectType');
};

export const createProjectTypeStage = async (i: Parameters<typeof stageBody>[0]) =>
  created(await pcall('POST', '/rest/projectTypeStages', stageBody(i)), 'ProjectTypeStage');

export const updateProjectTypeStage = async (id: string, i: Parameters<typeof stageBody>[0]) => {
  const body = stageBody(i);
  if (!Object.keys(body).length) return null;
  return updated(await pcall('PATCH', `/rest/projectTypeStages/${id}`, body), 'ProjectTypeStage');
};

/** 门户建项目。`projectCode` 必须有（它是 isUnique，空串也会撞）—— 调用方负责生成。 */
export const createPortalProject = async (i: ProjectPatch & { projectCode: string; name: string }) =>
  created(await pcall('POST', '/rest/projects', portalProjectBody(i)), 'Project');

/**
 * 按编号精确找一个项目（原始行，depth=0）。门户建项目「发出去了、没等到回包」之后用它认领：
 * Twenty 可能已经提交了那一行（超时只是我们这边不等了）—— 不认领就会再建第二个。
 */
export const findPortalProjectByCode = async (code: string): Promise<any | null> => {
  const r = await pcall('GET', `/rest/projects?filter=${encodeURIComponent(`projectCode[eq]:"${code}"`)}&limit=1&depth=0`);
  return r?.data?.projects?.[0] ?? null;
};

/** 只改门户那几列（`portalProjectBody` 里根本没有别的列）。空补丁不发请求。 */
export const updatePortalProject = async (id: string, patch: ProjectPatch) => {
  const body = portalProjectBody(patch);
  if (!Object.keys(body).length) return null;
  return updated(await pcall('PATCH', `/rest/projects/${id}`, body), 'Project');
};

export const createProjectUpdate = async (i: Parameters<typeof projectUpdateBody>[0]) =>
  created(await pcall('POST', '/rest/projectUpdates', projectUpdateBody(i, 'create')), 'ProjectUpdate');

export const updateProjectUpdate = async (id: string, i: Parameters<typeof projectUpdateBody>[0]) => {
  const body = projectUpdateBody(i, 'patch');
  if (!Object.keys(body).length) return null;
  return updated(await pcall('PATCH', `/rest/projectUpdates/${id}`, body), 'ProjectUpdate');
};

/**
 * 按幂等键找进展。⚠️ **软删掉的找不到，但它的 clientId 仍然占着唯一索引**（2026-09-30 实测：
 * 删掉之后用同一个 clientId 再建 → 400「A duplicate entry was detected」）—— 调用方要能分辨这一种。
 */
export const findProjectUpdateByClientId = async (clientId: string): Promise<any | null> => {
  const r = await pcall(
    'GET',
    `/rest/projectUpdates?filter=${encodeURIComponent(`clientId[eq]:${clientId}`)}&limit=1&depth=0`,
  );
  return r?.data?.projectUpdates?.[0] ?? null;
};

/** Twenty 的唯一约束冲突（projectCode / clientId / typeCode）。报文是它定的，只认这一句。 */
export const isDuplicateEntry = (e: unknown) => /duplicate entry/i.test(String((e as Error)?.message ?? e));
