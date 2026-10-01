import { sql } from './db.ts';
import { env } from './env.ts';
import {
  CATEGORY_LABELS,
  keepCaseStatus,
  keepCategory,
  keepConfidence,
  keepRecordTypeV2,
  keepSeverity,
  keepStage,
} from '../agent/src/enums.ts';
import {
  appendToSupportCase,
  createOpportunity,
  createProject,
  createProjectDoc,
  createWorkItem,
  updateWorkItem,
  findProjectByCode,
  findWorkItemByCode,
  setWorkItemBlockedBy,
  updateProject,
  updateVisit,
  createProductFitment,
  createSupportCase,
  createVisit,
  updateProductFitment,
  updateSupportCase,
  findOpportunity,
  findSupplierId,
  getCompanyById,
  listCompanies,
  listIntelItems,
  listIntelValues,
  logTimeline,
  saveIntelGaps,
  setAnnualProductionIfEmpty,
  updateOpportunity,
  upsertContributor,
  // D108：改口换了客户时，继承来的那几条要软删（GraphQL，可撤销）
  softDeleteRecords,
  isDeletableObject,
  type RecordRef,
} from './twenty.ts';
import { computeGaps } from './gaps.ts';
// D108：改口从上一版继承过来的记录所有权（issue #37）
import type { Inheritance } from './supersede.ts';
import { suggestProjectCode } from './projectCode.ts';
import { parseDecisionWindow } from './window.ts';

/**
 * 确认入库 —— **5 秒延迟提交**（D48）。
 *
 * 起因是一个我自己提出来、又自己答不上来的问题：界面上那条「已入库 · 撤销」，
 * 点撤销之后要不要回头去删 Twenty 里那条记录？
 *
 * 答案是：**不要存在这条路径。** 改成延迟提交之后 ——
 *   · 点确认，界面立刻显示「已入库」（人的体感没有变慢）
 *   · 网关把这次确认**记在库里**，5 秒后才真的写 Twenty
 *   · 5 秒内点撤销 = 那次写入从来没有发生过
 *
 * 于是「删 Twenty 记录」这条最危险的路径根本不存在，
 * 同时挡住了最常见的那个错：手滑点错行。
 *
 * ⚠️ 为什么状态落在**库里**而不是内存里的 `setTimeout`：
 * 网关重启（部署、崩溃、OOM）会把内存里的定时器一起带走，
 * 那条已经点过确认的记录就永远停在半路上，而且没有人会发现。
 * 落库之后，重启时 `resumeConfirming()` 把它们捡回来。
 */

export type ConfirmPayload = {
  companyId: string;
  /**
   * 钉钉自动入库的「这一次排队」的标识（D143 · D148）。撤回链接绑的是它 ——
   * 撤回之后人说「入库 #N」重新排，旧汇报里那条链接就撤不掉新的倒计时。
   */
  queueId?: string;
  fields?: Record<string, unknown>;
  /**
   * 人选的「接在这条售后上」（手册 P23 / D57）。
   * 不传 = 新开一条。**默认新开是刻意的** —— 见 `commitToTwenty()` 里的理由。
   */
  supportCaseId?: string;
  /**
   * D75：这是一次**重录**（已入库之后改了字段再提交）。
   * `commitToTwenty` 见到它 + `twenty_refs` 非空就进 update 模式：
   * 按存下的 id 逐条 PATCH，**绝不新建第二份** —— 系统里没有删除路径（D48），
   * 「替代」的唯一正确语义是原地更新。
   */
  recommit?: boolean;
};

/**
 * 人在核对卡上「改一格」之后发回来的覆盖值（手册 P8）。
 *
 * 🔴 **和 agent 走同一套白名单，一个字都不放松。**
 *
 * 「不指望模型自觉」这条判据对客户端**同样成立** —— 而且客户端更不该信：
 * agent 至少在我们自己的进程里跑，浏览器里的任何东西都可以被改。
 * 不校验的话，一个 `stage: "随便编"` 会一路走到 Twenty 那一下才 400，
 * 而那时人已经看到「已入库」了。
 *
 * 只认这六个键 —— **界面上能点着改的就是这六格**，其余是自由文本。
 * 不认识的键静默丢弃：将来加了新字段的旧客户端不该因此整条入不了库。
 */
const KEEPERS: Record<string, (v: unknown) => unknown> = {
  recordType: keepRecordTypeV2,
  category: keepCategory,
  stage: keepStage,
  caseStatus: keepCaseStatus,
  severity: keepSeverity,
  sourceConfidence: keepConfidence,
  /**
   * 🔴 **唯一一个非枚举的可编辑键**（issue #17 根因 D，2026-08-05）。
   *
   * 加它之前，整条路是这样的：
   *   agent 按 prompt 的指示把项目编号留空（「没给就留空让人填」）→
   *   核对卡上写着「项目：…」，人以为要建项目 →
   *   **人没有任何地方能填那个编号**（这张表以前六个键全是枚举）→
   *   点确认 → `commitToTwenty` 走到「没编号不建」那个分支 →
   *   **CRM 里什么项目都没有，而界面上是绿色的「已入库」。**
   *
   * 这是这个仓库最贵的一类 bug：不报错、不缺字段、只是少了一个对象。
   *
   * 白名单收得很紧 —— 编号是幂等的支点（Twenty 里 `projectCode` 是 unique），
   * 允许空格和小写的话，`HYM-BAT-001` 和 `hym bat 001` 会变成两个项目。
   */
  projectCode: (v: unknown) => {
    const s = String(v ?? '').trim().toUpperCase().replace(/\s+/g, '-');
    return /^[A-Z0-9][A-Z0-9-]{2,39}$/.test(s) ? s : null;
  },
};

export const sanitizeFieldEdits = (
  raw: unknown,
): { fields: Record<string, unknown>; rejected: string[] } => {
  const fields: Record<string, unknown> = {};
  const rejected: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { fields, rejected };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const keep = KEEPERS[k];
    if (!keep) continue; // 不认识的键：静默丢弃
    const ok = keep(v);
    // keepCategory / keepStage / keepConfidence 认不出就回 null —— 那是**客户端传了非法值**。
    // 必须拒掉整次请求：悄悄当成「没改」入库的话，人看到的是「已入库」，
    // 而 CRM 里躺着的还是他刚刚亲手改掉的那个值。
    if (ok == null) rejected.push(`${k}=${String(v)}`);
    else fields[k] = ok;
  }
  return { fields, rejected };
};

/** 排队。返回真正写入的时间点，前端拿它倒计时。 */
export const requestConfirm = async (
  stagingId: string,
  userId: string,
  payload: ConfirmPayload,
): Promise<{ commitAt: string }> => {
  const at = new Date(Date.now() + env.confirmDelayMs);
  await sql`
    update staging set status = 'confirming', confirm_after = ${at},
      confirm_payload = ${sql.json(payload as never)}, confirm_by = ${userId}, error = null,
      withdrawn_at = null
    where id = ${stagingId}`;
  return { commitAt: at.toISOString() };
};

/**
 * 钉钉来源的自动入库排队（D143）—— 不经人确认，所以**守卫全写在同一条 `where` 里**。
 *
 * 和 `requestConfirm` 分开，是因为 PWA 那条路的语义不同（人点的；`failed` 也能确认；
 * 状态由端点逐条判过）。这里没有人在场，任何一格不对都只能**不排**：
 *   · 只排 `ready` —— pending / extracting 说明还有一版在跑，confirming / committing 已经排过；
 *   · 被取代的不排（同一条对话里有更新的一版，旧版入库 = 第二份）；
 *   · 撤回过的不排（D148：撤回后要人说 `入库 #N` 才重新排，`force` 那一格）；
 *   · 软删 / 速记删过的不排。
 *
 * 🔴 **两段式**：这一步只**占位**（`confirm_after` 写成一天以后，心跳认领不到），
 *    汇报真的送到了再 `armAutoCommit` 开始倒计时；没送到就 `disarmAutoCommit` 撤掉。
 *    一步到位的话，「排上了 → 进程在发送前被杀」会留下一条没人看见、到点自己入库的排队
 *    （D143「发送成功才开始倒计时」）。占位行重启时由 `recoverUnarmedAutoCommits` 收回。
 * 返回 null = 没排上（调用方如实说，不假装在倒计时）。
 */
export const AUTO_PLACEHOLDER_MS = 24 * 60 * 60_000;

export const queueAutoCommit = async (
  stagingId: string,
  userId: string,
  payload: ConfirmPayload & { queueId: string },
  force = false,
): Promise<{ queueId: string } | null> => {
  const placeholder = new Date(Date.now() + AUTO_PLACEHOLDER_MS);
  const rows = await sql`
    update staging set status = 'confirming', confirm_after = ${placeholder},
      confirm_payload = ${sql.json(payload as never)}, confirm_by = ${userId}, error = null,
      withdrawn_at = null
    where id = ${stagingId} and status = 'ready' and superseded_by is null
      and record_deleted_at is null and note_deleted_at is null
      ${force ? sql`` : sql`and withdrawn_at is null`}
    returning id`;
  return rows.length ? { queueId: payload.queueId } : null;
};

/** 汇报送到了：倒计时从**这一刻**开始。返回真正写入的时间点；null = 这一次排队已经不在了。 */
export const armAutoCommit = async (stagingId: string, queueId: string, seconds: number): Promise<Date | null> => {
  const at = new Date(Date.now() + seconds * 1000);
  const rows = await sql`
    update staging set confirm_after = ${at}
    where id = ${stagingId} and status = 'confirming' and confirm_payload->>'queueId' = ${queueId}
    returning id`;
  return rows.length ? at : null;
};

/** 汇报没送到（或中途出错）：撤掉这一次排队。只认自己那一次（queueId），不误伤别人排的。 */
export const disarmAutoCommit = async (stagingId: string, queueId: string): Promise<boolean> => {
  const rows = await sql`
    update staging set status = 'ready', confirm_after = null, confirm_payload = null, confirm_by = null
    where id = ${stagingId} and status = 'confirming' and confirm_payload->>'queueId' = ${queueId}
      and confirm_after > now()
    returning id`;
  return rows.length > 0;
};

/**
 * 撤回（D148 链接）：只撤**这一次排队**、只在倒计时内。原子 —— 和心跳认领（`claimDue`）
 * 抢同一行时只有一边赢。撤回留痕 `withdrawn_at`：出站据此不再自己排它。
 */
export const withdrawAutoCommit = async (stagingId: string, queueId: string): Promise<boolean> => {
  const rows = await sql`
    update staging set status = 'ready', confirm_after = null, confirm_payload = null, confirm_by = null,
      withdrawn_at = now()
    where id = ${stagingId} and status = 'confirming' and confirm_payload->>'queueId' = ${queueId}
      and confirm_after > now()
    returning id`;
  return rows.length > 0;
};

/**
 * 启动时收回「占了位、没开始倒计时」的排队 —— 上一个进程在「排上」和「汇报送到」之间被杀。
 * 收回成 ready，它的汇报账键还没记（只在送达后记），出站下一跳会**重新汇报**一次。
 * 判据是占位的特征（confirm_after 远在未来），不是「有没有 queued 事件」：
 * PWA 里确认的那些本来就没有 queued 事件。
 */
export const recoverUnarmedAutoCommits = async (): Promise<number> => {
  const rows = await sql`
    update staging set status = 'ready', confirm_after = null, confirm_payload = null, confirm_by = null
    where status = 'confirming' and confirm_payload ? 'queueId'
      and confirm_after > now() + interval '12 hours'
    returning id`;
  if (rows.length) console.log(`  ↩️ 收回 ${rows.length} 条没来得及发出汇报的钉钉自动入库排队（会重新汇报）`);
  return rows.length;
};

/**
 * D75：重录 —— 已 `confirmed` 的记录改了字段之后重新排队提交。
 *
 * 三件事在同一条原子更新里完成（`where status='confirmed'` 挡并发）：
 *   ① 上一次提交的 `{at, by, fields, refs}` 推进 `commit_history`（审计，撤销时弹回）；
 *   ② `confirm_payload` 换成合并后的字段 + `recommit: true`；
 *   ③ 回到 `confirming` —— **沿用同一个 5 秒撤销窗和同一个心跳**，
 *     不为重录另起一条提交管线（issue #1 的教训：提交路径只能有一条）。
 */
export const requestReconfirm = async (
  stagingId: string,
  userId: string,
  fields: Record<string, unknown>,
): Promise<{ commitAt: string } | null> => {
  const [st] = await sql<
    Array<{ confirm_payload: ConfirmPayload | null; twenty_refs: Record<string, string> | null }>
  >`select confirm_payload, twenty_refs from staging where id = ${stagingId} and status = 'confirmed'`;
  if (!st?.confirm_payload?.companyId || !st.twenty_refs) return null;

  const payload: ConfirmPayload = {
    companyId: st.confirm_payload.companyId,
    supportCaseId: st.confirm_payload.supportCaseId,
    fields: { ...(st.confirm_payload.fields ?? {}), ...fields },
    recommit: true,
  };
  const histEntry = {
    at: new Date().toISOString(),
    by: userId,
    fields: st.confirm_payload.fields ?? {},
    refs: st.twenty_refs,
  };
  const at = new Date(Date.now() + env.confirmDelayMs);
  const rows = await sql`
    update staging set status = 'confirming', confirm_after = ${at}, error = null,
      confirm_payload = ${sql.json(payload as never)}, confirm_by = ${userId},
      commit_history = commit_history || ${sql.json([histEntry] as never)}
    where id = ${stagingId} and status = 'confirmed'
    returning id`;
  return rows.length ? { commitAt: at.toISOString() } : null;
};

/**
 * D75：把一次没走完的重录**恢复原状** —— 撤销时用，提交失败时也用。
 * 弹出 `commit_history` 最后一条，把上一次的字段装回 `confirm_payload`，
 * 状态回 `confirmed`（记录明明还在 CRM 里，回 ready 会让人再「确认」出第二份）。
 */
const rollbackRecommit = async (stagingId: string, errMsg?: string): Promise<boolean> =>
  sql.begin(async (tx) => {
    const [st] = await tx<
      Array<{ confirm_payload: ConfirmPayload | null; commit_history: any[] }>
    >`select confirm_payload, commit_history from staging where id = ${stagingId} for update`;
    const p = st?.confirm_payload;
    if (!p?.recommit) return false;
    const hist = Array.isArray(st!.commit_history) ? st!.commit_history : [];
    const last = hist[hist.length - 1] ?? {};
    const restored: ConfirmPayload = {
      companyId: p.companyId,
      supportCaseId: p.supportCaseId,
      fields: (last.fields ?? {}) as Record<string, unknown>,
    };
    await tx`
      update staging set status = 'confirmed', confirm_after = null,
        confirm_payload = ${tx.json(restored as never)},
        commit_history = ${tx.json(hist.slice(0, -1) as never)},
        error = ${errMsg ?? null}
      where id = ${stagingId}`;
    return true;
  });

/** 撤销。只有还没到点才撤得掉 —— 到点之后 Twenty 里已经有了，那时只能改不能撤。 */
export const cancelConfirm = async (stagingId: string): Promise<boolean> => {
  /**
   * D75：先看这是不是一次重录的撤销 —— 那要恢复成「上一次提交后的样子」
   * （字段弹回、状态回 confirmed），而不是回 ready。
   * ⚠️ 窗口检查照旧：到点之后两种撤销都不存在。
   */
  const [cur] = await sql<Array<{ payload: ConfirmPayload | null }>>`
    select confirm_payload as payload from staging
    where id = ${stagingId} and status = 'confirming' and confirm_after > now()`;
  if (!cur) return false;
  if (cur.payload?.recommit) return rollbackRecommit(stagingId);

  const rows = await sql`
    update staging set status = 'ready', confirm_after = null, confirm_payload = null, confirm_by = null
    where id = ${stagingId} and status = 'confirming' and confirm_after > now()
    returning id`;
  return rows.length > 0;
};

/** 真正写 Twenty。**整个系统里只有这一个函数会往 CRM 写东西。** */
export const commitToTwenty = async (stagingId: string): Promise<Record<string, string>> => {
  const [st] = await sql<
    Array<{
      id: string;
      inbox_id: string;
      extracted: any;
      confirm_payload: ConfirmPayload | null;
      confirm_by: string | null;
      twenty_refs: Record<string, string> | null;
      /** D108：改口从上一版继承过来的记录所有权（migration 014）。 */
      replaces: Inheritance | null;
    }>
  >`select id, inbox_id, extracted, confirm_payload, confirm_by, twenty_refs, replaces
    from staging where id = ${stagingId}`;
  if (!st?.confirm_payload?.companyId) throw new Error('没有待提交的确认');

  /**
   * ── D75：update 模式（重录）───────────────────────────────────────
   *
   * `recommit` + 上一次的 `twenty_refs` 同时在场，下面每个「建记录」的分支
   * 都换成「按存下的 id 更新」。**没有任何分支在 redo 下新建已存在的对象** ——
   * 系统里没有删除路径（D48），新建一份旧的还在，那不是替代是复制。
   *
   * ── D108（issue #37）：改口继承来的所有权走**同一条** update 路径 ─────
   *
   * 🔴 这就是这个修法「新概念是零个」的地方：改口跨越已入库时，
   *    `staging.replaces` 里带着上一版的 `twenty_refs` ——
   *    把它当成 `prev` 喂进来，下面每个分支自然就变成「按 id 更新」。
   *    在这之前改口产生的是一条全新的 staging（`prev` 为空）→ 每个分支都 create
   *    → CRM 里两版并存（Movara 3000W / 2000W）。
   *
   * ⚠️ **自己的 `twenty_refs` 优先**：那是「这一行自己提交过一次」（D75 重录），
   *    继承来的只在这一行还没提交过时才作数。
   */
  const inherited: Inheritance | null = st.replaces ?? null;
  const ownRefs = (st.twenty_refs ?? {}) as Record<string, string>;
  const inheritedRefs = (inherited?.refs ?? {}) as Record<string, string>;
  const usingInherited = !Object.keys(ownRefs).length && Object.keys(inheritedRefs).length > 0;
  const prev = usingInherited ? inheritedRefs : ownRefs;

  /**
   * 🔴 **客户变了就不能原地更新**（维护者 2026-08-11 拍板要开这条路）。
   *
   * `updateProductFitment` / `updateVisit` / `updateSupportCase` 的 patch 里
   * **根本没有 `companyId` 这一项** —— 不是疏漏：把一条记录从一家客户挪到另一家
   * 等于改写它的归属，而归属是 D28 那道闸门。
   *
   * 所以「改口顺便把客户也改了」（Alpin → Rosenfeld 这种）只能是：
   * **把继承来的那几条软删掉（GraphQL，可撤销）+ 按新客户建新的。**
   * 软删掉的原样记进老那一行的 `record_deleted_refs`，
   * 于是现成的「撤销看板删除」端点就能把它们捞回来。
   */
  const movedCompany =
    usingInherited &&
    Boolean(inherited?.companyId) &&
    inherited!.companyId !== st.confirm_payload.companyId;

  if (movedCompany) {
    const doomed = (Array.isArray(inherited!.createdRecords) ? inherited!.createdRecords : [])
      .filter((r: any) => r?.id && isDeletableObject(String(r.object)))
      .map((r: any) => ({ object: String(r.object), id: String(r.id), name: r.name }) as RecordRef);
    const r = doomed.length ? await softDeleteRecords(doomed) : { deleted: [], failed: [] };
    console.log(
      `  ↪️ 改口换了客户：软删上一版 ${r.deleted.length}/${doomed.length} 条记录，按新客户重建` +
        (r.failed.length ? ` · ${r.failed.length} 条没删掉（如实记下）` : ''),
    );
    /**
     * 🔴 **没删掉的也要记下来**，不能只记删成功的那些 —— 否则 CRM 里留着一条
     * 指向旧客户的孤儿记录，而任何地方都查不到它为什么在那儿。
     */
    await sql`
      update staging set record_deleted_at = now(), record_deleted_by = ${st.confirm_by},
        record_deleted_refs = ${sql.json(r.deleted as never)}
      where id = ${inherited!.stagingId}`;
  }

  /**
   * `movedCompany` 时**退回 create 模式** —— 继承来的那几条刚被软删，
   * 再对着它们 update 就是往一堆已经删掉的记录上写字。
   */
  const redo =
    !movedCompany &&
    (st.confirm_payload.recommit === true || usingInherited) &&
    Object.keys(prev).length > 0;

  const [u] = await sql<Array<{ user_code: string; display_name: string }>>`
    select user_code, display_name from app_user where id = ${st.confirm_by}`;
  const contributorId = await upsertContributor(u?.user_code ?? 'system', u?.display_name ?? '系统');

  const [ib] = await sql<Array<{ visit_label: string | null }>>`
    select visit_label from inbox where id = ${st.inbox_id}`;

  /**
   * 🔴 **人改过的那几格覆盖 agent 抽出来的**（手册 P8：「哪一格不对，点『改一下』」）。
   *
   * `extracted` 保留「这一轮从原话里读出了什么」不动，
   * `confirm_payload.fields` 是「人最后认可的值」。合起来才是要入库的东西。
   * 分开存的意义：三个月后回头看，既看得到当时读出什么，也看得到人改成了什么。
   * `fields` 已经在 `sanitizeFieldEdits()` 里过过白名单，这里拿到的一定是合法值。
   */
  const f = { ...st.extracted, ...st.confirm_payload.fields } as Record<string, any>;

  const company = (await listCompanies()).find((c) => c.id === st.confirm_payload!.companyId);

  /**
   * 🔴 **正文永远要落在某个地方。**
   *
   * 之前只有「有 category」或「是 support」两条分支会建实体记录 ——
   * 两个都不满足时，确认入库只产出**一条空的拜访记录**，
   * 抽出来的东西一个字都没进 CRM（维护者 2026-08-03 实测：
   * 「crm 上还是没有相关数据记录」）。
   *
   * 现在 Visit 的 `visitSummary` 一律带上完整正文：不管走哪条分支，
   * 内容至少有一个归宿。
   */
  /**
   * 客户链只补一次。
   *
   * 抽取出来的 `details` 里模型自己就会写一段 `## 客户链`（prompt 里要求的），
   * 这里再无条件拼一遍、`sourceNote` 里又拼一遍 —— 实测（2026-08-03）
   * 一条售后记录的正文里同一句客户链出现了**三遍**。
   * 所以：正文里已经有这条链了就不补。
   */
  const chainLine = (into: string) =>
    f.customerChain && !into.includes(f.customerChain) ? `客户链：${f.customerChain}` : '';

  /**
   * 附件的名字要写进记录里。
   *
   * Twenty 这个版本没有开放文件上传接口，所以**原件只在网关的磁盘上**。
   * 至少让人在 CRM 里看得见「这条记录背后有一份 xxx.docx」，
   * 并且知道去哪取（`GET /attachments/:id/file`）——
   * 否则就像 维护者 2026-08-03 遇到的：文档传上去了、解析了、
   * 而在 CRM 里一点痕迹都没有。
   */
  const atts = await sql<Array<{ id: string; filename: string }>>`
    select id, filename from attachment where inbox_id = ${st.inbox_id} order by created_at`;
  const attNote = atts.length
    ? `\n附件（原件在网关，凭 id 取）：\n${atts.map((a) => `· ${a.filename} — ${a.id}`).join('\n')}`
    : '';
  const trace = `原文 ID：${st.inbox_id}${attNote}`;

  /**
   * 🔴🔴 **兜到原文为止。永远不产出一条空白记录。**
   *
   * 上一版的兜底只到 `f.details || f.summary` —— 两个都没有时 `core` 是空字符串，
   * `visitSummary` 落成 `null`，于是 CRM 里躺着一条**什么都没有的拜访记录**。
   * 2026-08-03 维护者 实测就是这样：说了一句话、传了一份 1931 字的技术文档，
   * 确认入库之后在 CRM 里**一个字都看不到**。
   *
   * 原文一直都在 `inbox` 里 —— 它不该只在数据库里，人是在 CRM 里找东西的。
   * 所以这里一路兜到原文、转写、附件名：**信息可以不结构化，但不能不存在。**
   */
  const [orig] = await sql<Array<{ text: string | null; transcript: string | null }>>`
    select i.text, s.transcript from inbox i
    join staging s on s.inbox_id = i.id where i.id = ${st.inbox_id}`;
  const attNames = atts.map((a) => a.filename).join(' · ');
  const core =
    f.details ||
    f.summary ||
    [
      (orig?.text ?? '').trim(),
      (orig?.transcript ?? '').trim(),
      attNames && `附件：${attNames}`,
    ]
      .filter(Boolean)
      .join('\n\n') ||
    '（这条只有录音，转写也没成功 —— 原件在网关磁盘上，凭下面的原文 ID 取）';
  const body = [core, chainLine(core)].filter(Boolean).join('\n\n');

  const visitName = `${f.summary || ib?.visit_label || '拜访'} · ${new Date().toISOString().slice(0, 10)}`;

  /**
   * 这次入库产出了哪些记录 —— 攒起来，最后统一写 timeline（D61）。
   *
   * 为什么不边建边写：写 timeline 是**装饰**，建记录是**资产**。
   * 混在一起的话，一次 timeline 失败就会把整条入库带进 catch，
   * 而这两件事的重要性差着一个数量级。攒到最后写，主流程一行都不用改。
   *
   * ⚠️ D75：redo 时**更新过的不进 made** —— timeline 只记「长出了什么」，
   * 重录更新的那些再记一遍就是重复事件。redo 下新建的（比如这次才填了品类）照记。
   */
  const made: Array<{ object: string; id: string; name: string }> = [];

  let visitId: string;
  if (redo && prev.visitId) {
    visitId = prev.visitId;
    // 只更新正文 —— name 里带着首次入库的日期，那是「这条什么时候记的」，别改写历史
    await updateVisit(visitId, { visitSummary: body || null });
  } else {
    visitId = await createVisit({
      name: visitName,
      visitType: 'CUSTOMER_VISIT',
      companyId: st.confirm_payload.companyId,
      recordedById: contributorId,
      startedAt: new Date().toISOString(),
      visitSummary: body || null,
    });
    made.push({ object: 'visit', id: visitId, name: visitName });
  }

  const refs: Record<string, string> = { visitId };
  if (redo) refs.recommitted = new Date().toISOString();

  /**
   * 🔴 **选型情报和售后问题是两条方向相反的生命周期**（D25）。
   *
   * 之前这里只会建 `productFitment` —— 于是「帮我记录一下这个售后问题」
   * 最后落成了一条产品选型情报，人去 CRM 的「售后问题」里找是空的
   * （维护者 2026-08-03 实测）。这不是模型的错：**当时它没有任何字段
   * 可以表达「这是售后」**，而这一层也只有一条路可走。
   */
  if (f.recordType === 'support') {
    const issue = [core, chainLine(core), f.modelName && !f.details && `涉及：${f.modelName}`]
      .filter(Boolean)
      .join('\n\n');

    /**
     * 手册 P23：「**进展是新加的一行 · 三个人记在同一条下 · 状态往前走一格**」。
     *
     * 人在核对卡上点了「接在这条上」才走追加（D57）。
     * **默认是新开一条** —— 自动往最近那条未关闭的 case 上追加看着很聪明，
     * 但一家客户同时有「逆变器断电」和「水箱液位」两个未结案时，
     * 猜错就是把两件不相干的事并成一条，而**没有人会发现**：
     * 看板上它仍然只是一条正常的记录。
     */
    if (redo && prev.supportCaseId) {
      /**
       * D75 重录：只 PATCH 状态类字段，**不重复追加正文**。
       * 正文是 append-only 的时间线（和 inbox 只增不改同一条判据），
       * 而重录能改的本来就只有枚举格 —— 正文没变，再 append 一遍就是把
       * 同一段话写两次。追加型（supportCaseAppended）和新建型走同一条。
       */
      await updateSupportCase(prev.supportCaseId, {
        caseStatus: f.caseStatus || null,
        severity: f.severity || null,
        deliveryBatch: f.deliveryBatch ?? null,
        affectedUnits: f.affectedUnits ?? null,
      });
      refs.supportCaseId = prev.supportCaseId;
      if (prev.supportCaseAppended) refs.supportCaseAppended = prev.supportCaseAppended;
    } else if (st.confirm_payload.supportCaseId) {
      await appendToSupportCase(st.confirm_payload.supportCaseId, {
        progress: [issue, trace].filter(Boolean).join('\n\n'),
        caseStatus: f.caseStatus || null,
        severity: f.severity || null,
        by: u?.display_name ?? '系统',
        deliveryBatch: f.deliveryBatch ?? null,
        affectedUnits: f.affectedUnits ?? null,
      });
      refs.supportCaseId = st.confirm_payload.supportCaseId;
      refs.supportCaseAppended = 'yes'; // 是追加不是新建，留痕
    } else {
      const caseName = f.summary || '售后问题';
      refs.supportCaseId = await createSupportCase({
        name: caseName,
        companyId: st.confirm_payload.companyId,
        // details 是全文；没有 details 才退回到那句 summary。客户链走 chainLine 去重。
        issueDescription: issue,
        caseStatus: f.caseStatus || 'NEW',
        severity: f.severity || 'MEDIUM',
        sourceNote: trace,
        recordedById: contributorId,
        deliveryBatch: f.deliveryBatch ?? null,
        affectedUnits: f.affectedUnits ?? null,
      });
      made.push({ object: 'supportCase', id: refs.supportCaseId, name: caseName });
    }
  } else if (f.category) {
    /**
     * 🔴 **在位品牌只能指向已存在的 supplier 记录**（D23a）。
     *
     * 查不到就留空 + 把原文写进 `sourceNote` —— **绝不新建 supplier**。
     * 允许自由文本的下场在销售那份 Excel 里发生过：`Voltaro` / `voltaro` /
     * `Voltaro Energy` 三个版本，「在位品牌份额」这个聚合永远算不对，
     * 而且看起来完全正常。
     */
    const supplierId = await findSupplierId(f.supplierName);
    const supplierNote =
      f.supplierName && !supplierId ? `在位品牌（名单里没有，未建）：${f.supplierName}` : '';

    if (redo && prev.productFitmentId) {
      // D75 重录：按 ref 更新。溯源字段（sourceNote/sourceInboxId/visitId）永不动
      await updateProductFitment(prev.productFitmentId, {
        name: [CATEGORY_LABELS[f.category] ?? f.category, f.modelName].filter(Boolean).join(' · '),
        category: f.category,
        modelName: f.modelName ?? null,
        supplierId,
        confidence: f.sourceConfidence || null,
      });
      refs.productFitmentId = prev.productFitmentId;
    } else {
      refs.productFitmentId = await createProductFitment({
        /**
         * 标题列给人看，**不给机器看**。
         *
         * 以前这里写的是 `f.category`，于是「在位品牌分布」那个视图的第一列
         * 整列都是 `BATTERY` / `DCDC_CHARGER` —— 一屏全大写英文枚举，
         * 谁也看不出哪条是哪条。品类的机器值在 `category` 字段里，一个字没丢。
         */
        name: [CATEGORY_LABELS[f.category] ?? f.category, f.modelName].filter(Boolean).join(' · '),
        companyId: st.confirm_payload.companyId,
        category: f.category,
        modelName: f.modelName ?? null,
        supplierId,
        // 人在核对卡上选过就用他选的；没选才落 LIKELY。
        // **不要在抽取那一层默认成 LIKELY** —— 那样「模型没说」和
        // 「模型说了较可信」长得一样，人就没机会把传闻降下去（手册 P18）
        confidence: f.sourceConfidence || 'LIKELY',
        sourceNote: [trace, supplierNote, f.sourceCompanyName && `听谁说的：${f.sourceCompanyName}`]
          .filter(Boolean)
          .join('\n'),
        sourceInboxId: st.inbox_id, // §4.2 第5条：可追溯到原文
        recordedById: contributorId,
        visitId,
        recordedAt: new Date().toISOString(),
      });
      made.push({
        object: 'productFitment',
        id: refs.productFitmentId,
        // chip 上的字**就是记录的标题** —— 两边不一致的话，点进去会像是点错了
        name: [CATEGORY_LABELS[f.category] ?? f.category, f.modelName].filter(Boolean).join(' · '),
      });
    }

    /**
     * **阶段挂 Opportunity**（D24），而不是挂在这条选型情报上。
     *
     * 手册场景 B 要的是「接在 5/12 那条后面，阶段从 RFQ 推到整车验证」——
     * 推的必须是同一条项目记录（D56：同一家 + 同一品类 = 同一个项目）。
     * 每次新建的话，看板上一家客户会出现一串阶段各异的同品类项目，
     * 「谁走到哪了」就排不出来 —— 而那正是需求 2「机会地图」的核心。
     *
     * ⚠️ 只在**有阶段或有决策窗口**时才碰 Opportunity。
     * 一条只说了「他们在用 Voltaro」的记录不该凭空开一个项目出来。
     */
    const stage = f.stage || null;
    const windowDate = parseDecisionWindow(f.decisionWindow);

    /**
     * D59 给商机加的四个字段，到 2026-08-04 为止**一次都没被写过**（issue #4）。
     * 抽到了、摘要里显示了、CRM 里是空的 —— 和把信息丢弃没有区别，
     * 而 T01 的验收原话正是「无法承载就该新增字段，而不是把信息丢弃」。
     *
     * ⚠️ `annualDemand` 收的是**这个品类的需求量**，
     *    和 `company.annualProduction`（整车年产量）是两个量纲，别混
     *    —— 那个坑 2026-08-03 已经踩过一次。
     */
    const oppExtras = {
      annualDemand: f.demandQuantity ?? null,
      demandBreakdown: f.demandBreakdown ?? null,
      targetPrice: f.targetPrice ?? null,
      ownerTeam: f.ownerTeam ?? null,
    };
    // 有预算也算「这是个项目」—— 光说金额没说阶段的情况现场很常见
    if (stage || windowDate || f.budgetEur) {
      /**
       * D75 重录：直接更新上一次那条商机，不再按（客户,品类）重找 ——
       * 品类被改过的话，重找会找到别的一条（或找不到而新建第二条）。
       * ⚠️ 商机自己的品类**不随之变更**（D56：那是它的身份键），refs 里如实标注。
       */
      if (redo && prev.opportunityId) {
        await updateOpportunity(prev.opportunityId, {
          stage,
          nextDecisionWindow: windowDate,
          budgetEur: f.budgetEur ?? null,
          ...oppExtras,
        });
        refs.opportunityId = prev.opportunityId;
        if ((st.confirm_payload.fields as any)?.category) {
          refs.oppCategoryUnchanged = '重录改了品类，但商机的品类是身份键（D56），未随之变更';
        }
      } else {
      const existing = await findOpportunity(st.confirm_payload.companyId, f.category);
      if (existing) {
        await updateOpportunity(existing.id, {
          stage,
          nextDecisionWindow: windowDate,
          budgetEur: f.budgetEur ?? null,
          ...oppExtras,
        });
        refs.opportunityId = existing.id;
        refs.opportunityWas = existing.stage; // 从哪一格推过来的，留痕
      } else {
        // 名字是人在 Twenty 里看到的那一行 —— 别让他看到 DISTRIBUTION_BOX
        const oppName = `${company?.name ?? '客户'} · ${CATEGORY_LABELS[f.category] ?? f.category}`;
        refs.opportunityId = await createOpportunity({
          name: oppName,
          companyId: st.confirm_payload.companyId,
          category: f.category,
          stage,
          nextDecisionWindow: windowDate,
          originVisitId: visitId,
          budgetEur: f.budgetEur ?? null,
          ...oppExtras,
        });
        made.push({ object: 'opportunity', id: refs.opportunityId, name: oppName });
      }
      }
    }
  }

  /**
   * 整车年产量写回客户档案（手册场景 A：「年产一万二」）。
   *
   * 🔴 **只收 `annualVehicles`，不收需求量。**
   * `company.annualProduction` 的含义是「这家客户一年造多少辆车」。
   * 把「我们要卖给他 20,000 块电池」写进去，是两个不同量纲的数混成一格 ——
   * 而且看起来完全正常（2026-08-03 T01 实测撞到）。
   * 需求量属于这个品类的机会，落在 `details` 与项目上。
   *
   * 只在原来为空时写：已经有值说明有人核实过，别让一句随口的话覆盖掉。
   */
  if (f.annualVehicles) {
    try {
      if (await setAnnualProductionIfEmpty(st.confirm_payload.companyId, String(f.annualVehicles))) {
        refs.annualProduction = String(f.annualVehicles);
      }
    } catch (e) {
      // 写不进去不该让整条入库失败 —— 主记录已经建好了，这是锦上添花的一格
      console.warn(`  ⚠️ 整车年产量没写进去（${(e as Error).message.slice(0, 120)}）`);
    }
  }

  /**
   * ── D59：项目 / 跟进 / 任务线程 / 文档 ────────────────────────────
   *
   * 这四样是 `test_example` 的 T02–T05 要的东西。写入顺序有讲究：
   *   项目 → 跟进（visit 复用，回填 project）→ 线程 → 依赖 → 文档
   * 依赖必须**等全部线程建完再补** —— T04 里 04 依赖 02 和 03，
   * 而它们可能是后建出来的，先建的那条根本还不知道对方的 id。
   */
  const projectProposal = f.project as Record<string, any> | undefined;
  const workItems = Array.isArray(f.workItems) ? f.workItems : [];
  const docProposal = f.document as Record<string, any> | undefined;

  let projectId: string | null = null;
  if (projectProposal?.name || f.projectCode) {
    /**
     * 编号的三个来源，**按这个顺序**：
     *   ① 人在核对卡上填/改的（`confirm_payload.fields.projectCode`，已过白名单）
     *   ② agent 从原话里抄来的
     *   ③ 🔴 **网关兜底生成** —— 这一档是 issue #17 根因 D 的修复
     *
     * ③ 之前这里是 `console.warn` 然后什么都不做。后果见 KEEPERS 里那段注释：
     * 界面绿色的「已入库」，而 CRM 里根本没有这个项目。
     *
     * 为什么兜底生成是对的、而不是拒绝入库：
     * 编号的作用是**幂等的支点**（下次认得出是同一个项目），
     * 它不需要好看，只需要唯一且可复现。而「这条速记讲了什么」是不可再生的资产 ——
     * 为了一个可以自动生成的编号把整条记录挡在门外，是把便宜的东西看得比贵的东西重。
     *
     * 🔴 **编号由网关生成，不由模型生成。** 模型编的下次认不出是同一个项目
     * （prompt 里那句「不要自己编一个编号」仍然有效，而且更有效了 ——
     * 它现在有一个真正的接盘者）。
     *
     * ⚠️ **D91 之后 ③ 这一档很少走到了** —— `propose_project` 在提案那一刻就取号，
     * 于是 ② 通常已经有值。留着是因为它盖着「提案时客户还没对上号」那条路，
     * 而那正是现场最常见的形状（D28：归属入库前才必填）。
     */
    const fromHuman = String((st.confirm_payload.fields as any)?.projectCode ?? '').trim();
    const fromAgent = String(projectProposal?.projectCode ?? f.projectCode ?? '').trim();
    let code = fromHuman || fromAgent;
    if (!code) {
      /*
       * `Company.code` 就是 `accountCode`（如 HMG-HAVEL）—— 人类可读的稳定代号（D30）。
       * 走 `suggestProjectCode` 而不是直接 `nextProjectCode`：后者只看 CRM，
       * 会把一个**已经被别的待确认提案占住**的号再发一次，两条入库时就并成一个项目了。
       */
      code =
        (
          await suggestProjectCode({
            companyCode: company?.code ?? null,
            category: (f.category as string | null) ?? null,
            name: (projectProposal?.name as string | null) ?? null,
            stagingId: st.id,
          }).catch(() => null)
        )?.code ?? '';
      if (code) {
        // 生成的编号**必须说出来** —— 人得知道 CRM 里那条叫什么，否则下次找不到它
        refs.projectCodeGenerated = code;
        console.log(`  · 项目提案没有编号，网关生成了一个：${code}`);
      }
    }
    /**
     * 🔴 **幂等：编号撞了就更新，绝不新建。**
     * test_example T02 的验收断言：「项目编号唯一；重复提交时不创建第二个相同编号的项目」。
     */
    const existing = code ? await findProjectByCode(code) : null;

    /**
     * D75 重录的冲突守卫：目标永远是**上一次那个项目**（prev.projectId）。
     * 人把编号改成了另一个已存在项目的编号 → 那不是更新，是把两个项目并成一个 ——
     * 409 出去让人自己决定（reconfirm 端点有同样的预检，这里挡的是竞态）。
     */
    if (redo && prev.projectId && existing && existing.id !== prev.projectId) {
      throw new Error(
        `RECOMMIT_CONFLICT:项目编号 ${code} 已属于另一个项目「${existing.name}」—— ` +
          '换一个编号，或先在 CRM 里处理那一条。',
      );
    }
    const base = {
      projectCode: code,
      name: projectProposal?.name ?? `${company?.name ?? '客户'} 项目`,
      companyId: st.confirm_payload.companyId,
      // 定点之后仍然挂着来源商机 —— 那段「怎么赢的」历史有独立价值（D59）
      opportunityId: refs.opportunityId ?? null,
      projectStage: projectProposal?.projectStage ?? null,
      ownerTeam: projectProposal?.ownerTeam ?? null,
      budgetEur: projectProposal?.budgetEur ?? null,
      primaryProductName: projectProposal?.primaryProductName ?? null,
      sampleQty: projectProposal?.sampleQty ?? null,
      plannedSop: projectProposal?.plannedSop ?? null,
      specSummary: projectProposal?.specSummary ?? null,
      openQuestions: projectProposal?.openQuestions ?? null,
      recordedById: contributorId,
      sourceInboxId: st.inbox_id,
    };
    if (redo && prev.projectId) {
      /**
       * D75：redo 的目标钉死在上一次那个项目上 —— 哪怕编号改成了新的
       * （改编号 = 给 prev 那条换名牌，不是新建一条）。上面的冲突守卫已经
       * 挡掉了「新编号属于别的项目」，走到这里 update 是安全的。
       */
      await updateProject(prev.projectId, base);
      projectId = prev.projectId;
      refs.projectUpdated = code || prev.projectId;
    } else if (existing) {
      await updateProject(existing.id, base);
      projectId = existing.id;
      refs.projectUpdated = existing.projectCode || existing.id;
    } else if (base.projectCode) {
      projectId = await createProject(base as never);
      made.push({ object: 'project', id: projectId, name: base.name });
    } else {
      /**
       * 只有 `suggestProjectCode` 也没给出编号才会走到这里 —— 它有两种情况：
       * 客户代号为空（这里不可能，`companyId` 是入库的前置），
       * 或者 Twenty 连不上（那时候它**故意不发号**，见 `projectCode.ts` 文件头）。
       *
       * 🔴 **必须写进 `refs`，不能只写日志。** 判据和下面 workItems 那段一样：
       * 「建了几条和更新了几条必须分开写，合成一个数字的话，
       *   bug 在 refs 里长得和成功一模一样」。
       * 服务器日志没有人会去翻 —— `twenty_refs` 是人在界面上看得到的那份回执。
       */
      refs.projectSkipped = `${base.name}（没有编号，也没能生成一个）`;
      console.warn(`  ⚠️ 项目提案没有编号、生成也失败，跳过：${base.name}`);
    }
    if (projectId) refs.projectId = projectId;
  }

  /**
   * 跟进记录。**复用 visit**（visitType=PROJECT_FOLLOWUP），不另开对象 ——
   * 它和拜访是同一件事：一次和客户的接触，产出若干条要做的事。
   * 上面已经建过 visit 了，这里只把它挂到项目上并改类型。
   */
  if (projectId && (workItems.length || f.recordType === 'followup')) {
    await updateVisit(visitId, { projectId, visitType: 'PROJECT_FOLLOWUP' }).catch((e) =>
      console.warn(`  ⚠️ 跟进没挂上项目：${(e as Error).message.slice(0, 120)}`),
    );
    refs.followupId = visitId;
  }

  if (workItems.length) {
    const byCode = new Map<string, string>(); // itemCode → id
    let updatedItems = 0; // 撞了编号、被更新掉的那些 —— 要在 refs 里留痕，否则「4 条」是句谎话
    for (const w of workItems) {
      const code = String(w?.itemCode ?? '').trim();
      if (!code) continue;
      /**
       * 幂等：同一个线程编号只有一条 —— **但撞了要「更新」，不是「跳过」**。
       *
       * 跳过的后果实测过（2026-08-03 T04）：「更新 …-001，接口与 Pin 定义最优先，
       * 客户希望 8/14 前收到」提的是**同样的四个编号**，于是优先级、客户日期、
       * 依赖关系、连这次跟进的归属，**一个都没进 CRM**，
       * 而 `twenty_refs` 里写着 `workItems: "4"` —— 看起来完全正常。
       *
       * 项目那边一直是「撞了就 updateProject」，线程这边漏了这一半。
       */
      const dup = await findWorkItemByCode(code).catch(() => null);
      const input = {
        itemCode: code,
        name: w.title,
        projectId,
        followupId: visitId,
        companyId: st.confirm_payload.companyId,
        threadType: w.threadType,
        body: w.body,
        priority: w.priority,
        ownerRole: w.ownerRole,
        dueDate: w.dueDate,
        customerDueDate: w.customerDueDate,
        itemStatus: w.itemStatus,
        blockedByCodes: w.blockedByCodes,
        openQuestions: w.openQuestions,
        recordedById: contributorId,
        sourceInboxId: st.inbox_id,
      };

      if (dup) {
        // 已经有这条编号 → 把这次说的覆盖上去。没提到的格子一个不动
        // （`workItemBody` 里全是「有值才带」），所以「这条改成紧急」不会抹掉截止日期。
        await updateWorkItem(dup.id, input);
        byCode.set(code, dup.id);
        updatedItems++;
        continue;
      }
      const id = await createWorkItem(input);
      byCode.set(code, id);
      made.push({ object: 'workItem', id, name: `${code} ${w.title ?? ''}`.trim() });
    }
    // 依赖**最后补**：先建的那条还不知道后建的 id
    for (const w of workItems) {
      const self = byCode.get(String(w?.itemCode ?? '').trim());
      const first = String(w?.blockedByCodes ?? '')
        .split(/[,，、\s]+/)
        .map((x: string) => x.trim())
        .filter(Boolean)[0];
      const target = first ? byCode.get(first) : null;
      if (self && target && self !== target) {
        await setWorkItemBlockedBy(self, target).catch(() => {});
      }
    }
    refs.workItems = String(byCode.size);
    // 🔴 「建了几条」和「更新了几条」必须分开写。
    //    合成一个数字的话，「更新一个字都没落进去」这种 bug 在 refs 里长得和成功一模一样。
    if (updatedItems) refs.workItemsUpdated = String(updatedItems);
  }

  if (redo && prev.projectDocId) {
    // D75：文档内容不在重录可改的格子里 —— 没变的东西不重写，留住原 ref 即可
    refs.projectDocId = prev.projectDocId;
  } else if (docProposal?.content) {
    refs.projectDocId = await createProjectDoc({
      name: docProposal.name,
      docCode: docProposal.docCode,
      projectId,
      companyId: st.confirm_payload.companyId,
      version: docProposal.version,
      docSource: docProposal.docSource,
      isBaseline: docProposal.isBaseline === true,
      content: docProposal.content,
      // 附件 id 优先用提案里的；没有就取这条速记的第一个附件
      attachmentId: docProposal.attachmentId ?? atts[0]?.id ?? null,
      recordedById: contributorId,
      sourceInboxId: st.inbox_id,
    });
    made.push({ object: 'projectDoc', id: refs.projectDocId, name: docProposal.name });
  }

  /**
   * ── D61：把这次入库写进「相关记录」的 timeline ────────────────────
   *
   * Twenty 只给记录自己写事件，不会在它关联到的客户/录入人/项目身上留痕，
   * 所以那三个页面的 Timeline 面板本来是空的（维护者 2026-08-03 截图）。
   * 这里补上，于是：
   *   · 客户页  = 这家客户身上先后发生过什么（一条时间线读完全部履历）
   *   · 录入人页 = 这个人记了什么（他截图问的就是这个）
   *   · 项目页  = 这个项目拆出了哪些线程、出了哪些文档
   *
   * 🔴 **全程不抛。** `logTimeline` 自己吞异常；这里再包一层，
   *    因为到这一步 Twenty 里的记录**已经建好了**，
   *    为一行装饰把整条 commit 推回 ready 会让人再点一次确认 → 真的写两份。
   */
  try {
    const shared = {
      company: st.confirm_payload.companyId,
      contributor: contributorId,
      // 追加到已有售后时没有新建记录，但那条 case 也该看见「又记了一条」
      supportCase: refs.supportCaseAppended ? refs.supportCaseId : null,
    };
    for (const m of made) {
      await logTimeline(m.object, m.id, m.name, {
        ...shared,
        // 项目自己的事件不要再挂回自己（Twenty 已经写过 `project.created`）
        project: m.object === 'project' ? null : projectId,
      });
    }
  } catch (e) {
    console.warn(`  ⚠️ timeline 没写上（不影响已入库的记录）：${(e as Error).message.slice(0, 160)}`);
  }

  /**
   * 情报完整度**每次写入后重算并落库**（D17③）。
   *
   * 不落库的话，「情报最缺的」那个视图（D60）只是一张乱序的表，
   * 客户列表里那一列永远是空的 —— 而需求 1 的全部界面表达就是这一列。
   * 存储字段才能在 Twenty 的视图里排序和筛选，这是当初选存储而不是计算的原因。
   *
   * 和 timeline 一样：**派生数据，失败不抛。** 随时可以用
   * `node scripts/recompute-intel.mjs --yes` 全量重算。
   */
  try {
    const co = await getCompanyById(st.confirm_payload.companyId);
    if (co) {
      const g = computeGaps(await listIntelItems(), await listIntelValues(co.id), co);
      await saveIntelGaps(co.id, g);
      if (g.completeness != null) refs.intelCompleteness = String(g.completeness);
    }
  } catch (e) {
    console.warn(`  ⚠️ 完整度没重算（不影响已入库的记录）：${(e as Error).message.slice(0, 160)}`);
  }

  /**
   * ── 「这次**新建**了哪几条」落库（D93 · issue #25）────────────────
   *
   * 🔴 `made` 一直就在这儿，精确回答了这个问题，**但它只喂给上面那段 timeline
   *    就被扔掉了**。删除功能要的正是这份清单：`twenty_refs` 里混着复用别人的
   *    记录（`opportunityWas` / `projectUpdated` / `supportCaseAppended` 那几条）
   *    和根本不是 id 的东西（`workItems` 是计数），拿它去删就是
   *    「因为删一条拜访而炸掉整条项目线」。详见 migration 012 的文件头。
   *
   * ⚠️ **重录（redo）时要合并，不能覆盖。** `made` 在 redo 下只装这一轮
   *    新长出来的（上面那段注释说的「更新过的不进 made」），
   *    直接写进去会把首次入库建的那几条从清单里抹掉 —— 于是删除时漏删，
   *    而且漏得静悄悄。按 id 去重合并。
   */
  const [prevRow] = await sql<Array<{ created: unknown }>>`
    select created_records as created from staging where id = ${st.id}`;
  const known = new Map<string, { object: string; id: string; name: string }>();
  for (const m of Array.isArray(prevRow?.created) ? (prevRow!.created as any[]) : []) {
    if (m?.id) known.set(String(m.id), m);
  }
  /**
   * 🔴 D108 原地更新：上一版建的那几条**归这一行管了** —— 它们必须进这一行的清单。
   * 漏了的话：下面的交接把老那一行清空，而新这一行只记了「这一轮新长出来的」（made），
   * 首版建的拜访 / 选型情报就从所有清单里消失了 —— 看板删不到它们，
   * 下一次改口换客户也软删不到它们（CRM 里出第二份）。客户变了的那条路（movedCompany）
   * 已经把它们软删掉了，不该再收进来。
   */
  if (usingInherited && !movedCompany) {
    for (const m of Array.isArray(inherited?.createdRecords) ? (inherited!.createdRecords as any[]) : []) {
      if (m?.id) known.set(String(m.id), m);
    }
  }
  for (const m of made) known.set(m.id, m);

  /**
   * ── 所有权转移（D108 · issue #37）─────────────────────────────────
   *
   * 🔴 **到这一行为止，Twenty 那边已经写完了** —— 现在才把上一版的所有权收走。
   *
   * 顺序是承重的：改口之后这一轮**可能永远不会被确认**（人反悔、关掉、换个说法）。
   * 如果在改口那一刻就收走，那几条 CRM 记录会变成**孤儿** —— 谁都不拥有它们，
   * 看板上删哪一行都删不掉它们。所以交接的意向记在改口那一刻（`staging.replaces`），
   * **转移发生在这里**。
   *
   * 两件事必须一起发生（所以在同一个事务里）：
   *   · 新那一行拿到 refs / created_records（下面那句 update）
   *   · 老那一行交出它们（清空 + 状态改 superseded），审计留在 `commit_history`
   *
   * 🔴 **老那一行的 `twenty_refs` / `created_records` 必须真的清空**，
   *    不能只改状态：`deletion.ts` 的 `plan()` 认的就是这两列 ——
   *    留着的话，从看板上删那一行会去软删**现在归新那一行管**的记录。
   *    所有权必须是排他的。
   */
  await sql.begin(async (tx) => {
    await tx`update staging set status = 'confirmed', resolved_company_id = ${st.confirm_payload!.companyId},
              twenty_refs = ${sql.json(refs)},
              created_records = ${sql.json([...known.values()] as never)},
              confirm_after = null where id = ${st.id}`;

    if (usingInherited && inherited) {
      const histEntry = {
        at: new Date().toISOString(),
        by: st.confirm_by,
        movedTo: st.id,
        reason: movedCompany ? 'superseded_moved_company' : 'superseded_rewritten',
        refs: inherited.refs ?? {},
        createdRecords: inherited.createdRecords ?? [],
      };
      await tx`
        update staging
        set status = 'superseded',
            superseded_by = ${st.id},
            twenty_refs = null,
            created_records = ${sql.json([] as never)},
            commit_history = commit_history || ${sql.json([histEntry] as never)}
        where id = ${inherited.stagingId}`;
    }
  });

  if (usingInherited && inherited) {
    console.log(
      `  🔁 记录所有权转给这一轮：staging ${inherited.stagingId.slice(0, 8)} → ${st.id.slice(0, 8)}` +
        (movedCompany ? '（客户变了：旧的已软删，按新客户重建）' : '（原地改写，没有新建第二份）'),
    );
  }
  return refs;
};

// ── 到点提交的心跳 ──────────────────────────────────────────────────
let timer: NodeJS.Timeout | null = null;

/**
 * 🔴 **原子认领。这一句是 issue #1 的整个修复。**
 *
 * 2026-08-04 生产实测：点一次确认，CRM 里写了两份 —— 拜访 2 条、选型情报 2 条，
 * 同名同客户、时间戳同一秒。商机没重复，因为 D56 的「同一家+同一品类」幂等挡住了；
 * **凡是没有自然键的对象（visit / productFitment / supportCase / projectDoc）就实打实写两份。**
 *
 * 旧写法是「先 select 再提交」：
 *
 *     select id from staging where status = 'confirming' and confirm_after <= now()
 *     → for (...) await commitToTwenty(id)      // 里面十几次 Twenty 往返
 *
 * `commitToTwenty()` 直到**最后一行**才把 status 改成 `confirmed`，
 * 而 `setInterval` 不管上一轮跑没跑完，1 秒后照样再跳 —— 同一行还是 `confirming`，
 * 于是被**第二次选中并再提交一遍**。commit 耗时 > 1 秒写两份，> 2 秒三份。
 *
 * 这个竞态一直都在，是 D61（timeline 补链）和 D62（完整度重算）把 commit 拖慢之后
 * 才从「偶尔」变成「几乎每次」。
 *
 * 换成 `update … returning` 之后，**同一行只可能被一轮拿到**：
 * 状态在同一条语句里就变成了 `committing`，第二轮的 `where status='confirming'` 选不到它。
 * `for update skip locked` 让并发的两个网关实例互不阻塞地各拿各的。
 */
export const claimDue = async (limit = 20) =>
  sql<Array<{ id: string }>>`
    update staging set status = 'committing'
    where id in (
      select id from staging
      where status = 'confirming' and confirm_after <= now()
      order by confirm_after
      limit ${limit}
      for update skip locked
    )
    returning id`;

const commitOne = async (id: string) => {
  try {
    await commitToTwenty(id);
  } catch (e) {
    const raw = (e as Error).message;
    // D75 的冲突有专门的前缀 —— 给人看的话不该带着内部标记
    const conflict = raw.startsWith('RECOMMIT_CONFLICT:');
    const msg = (conflict ? raw.slice('RECOMMIT_CONFLICT:'.length) : raw).slice(0, 500);
    console.error(`  ✗ 延迟提交 ${id} 失败：${msg}`);

    /**
     * D75：重录失败**回 confirmed 不回 ready** —— 记录明明还在 CRM 里，
     * 回 ready 会让人再「确认」出第二份。回滚时把字段也弹回上一次的样子
     * （改动没生效就不该假装生效了），失败原因写进 error 给卡片显示。
     */
    if (await rollbackRecommit(id, `重录失败：${msg}`)) return;

    // 退回 ready 而不是 failed：人还看得见它、还能再点一次确认。
    // 标 failed 的话它会从待办里消失，而 Twenty 里其实什么都没写。
    await sql`update staging set status = 'ready', confirm_after = null,
              error = ${`入库失败：${msg}`} where id = ${id}`;
  }
};

/**
 * 一批**并发**提交，但**有上限**。
 *
 * 认领锁已经保证「同一行只会被处理一次」，所以同一批里的几行并行走完全安全 ——
 * 它们本来就互不相干。
 *
 * ⚠️ 但不能无上限地并发：Twenty 的限流是每窗口 100 个请求，
 * 而一条记录入库现在要跑十几次往返（D59 项目链 + D61 timeline + D62 完整度）。
 * 一次放 20 条进去必然把限流打满，然后全部退避重试，反而更慢。
 *
 * 4 是个保守值：现场是一个人一条条确认，这个数只在补积压时才用得上。
 */
const POOL = 4;

const tick = async () => {
  const due = await claimDue();
  for (let i = 0; i < due.length; i += POOL) {
    await Promise.all(due.slice(i, i + POOL).map((row) => commitOne(row.id)));
  }
};

/**
 * 上一轮没跑完就不起新的一轮 —— **纯粹是省掉空转**，不是正确性机制。
 *
 * 正确性完全由认领语句保证（同一行只可能被一轮拿到）。
 * 这一条只是避免「commit 慢的时候每秒起一轮什么都认领不到的查询」。
 *
 * ⚠️ 它会让**吞吐降到「一批接一批」**，所以批内必须并发（见 POOL）——
 * 2026-08-04 实测：批内串行 + 这个守卫，8 条并发确认要排 40 秒，
 * 集成测试直接等超时。修的是重复写入，不该顺手把速度也修没了。
 */
let running = false;

export const startConfirmTicker = () => {
  if (timer) return;
  // 1 秒一跳。延迟窗口是 5 秒，抖动 1 秒无所谓；认领走 staging_due_idx 部分索引，很便宜。
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void tick()
      .catch(() => {})
      .finally(() => {
        running = false;
      });
  }, 1000);
  timer.unref?.();
};

export const stopConfirmTicker = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

/**
 * 启动时清点「点过确认但还没写进去」的。
 *
 * 🔴 **卡在 `committing` 的一律不自动重试。**
 * 那是网关在写 Twenty 的**中途**挂掉留下的 —— 可能已经写了一半（建了 visit、还没建情报）。
 * 自动重跑一遍正是 issue #1 那个重复写入的形状，只不过换了个触发方式。
 * 所以：大声报出来，人看一眼 CRM 再决定。这种情况应该极少，真发生了值得被知道。
 */
export const resumeConfirming = async () => {
  const [waiting] = await sql<Array<{ count: string }>>`
    select count(*)::text from staging where status = 'confirming'`;
  if (waiting && waiting.count !== '0') console.log(`  ↻ 捡回 ${waiting.count} 条待提交的确认`);

  const stuck = await sql<Array<{ id: string }>>`
    select id from staging where status = 'committing'`;
  if (stuck.length) {
    console.warn(
      `\n  🔴 有 ${stuck.length} 条卡在「正在写 CRM」——` +
        `上次网关是在写 Twenty 的中途停的，可能已经写了一半。\n` +
        `     **不会自动重试**（重跑会写重复，见 issue #1）。请去 CRM 里核一眼这几条：\n` +
        stuck.map((s) => `       · staging ${s.id}`).join('\n') +
        `\n     确认没写进去的话，把它改回 ready 让人重新确认：\n` +
        `       update staging set status='ready', confirm_after=null where id='…';\n`,
    );
  }
};
