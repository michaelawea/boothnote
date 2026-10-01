/**
 * ══════════════════════════════════════════════════════════════════
 *  手动删除：算出「删这一条会动 CRM 里的哪几条记录」（issue #25 · D93）
 *
 *  这个文件只回答一个问题，而且是**在人点确认之前**回答它：
 *  「按下去到底会删掉什么？」
 *
 *  🔴 为什么这一步必须单独存在，而不是删的时候顺手算：
 *     删除对话框上写「确定删除吗？」的成本是零，而它换来的是人条件反射地点掉。
 *     写「会同时删掉 CRM 里的 3 条：拜访 · 商机 · 项目文档」才是一次真正的复核 ——
 *     而要写得出这句话，预览和执行就必须**共用同一份判断**（下面的 `plan()`），
 *     否则总有一天对话框说的和实际删的不是一回事。
 *
 *  ── `twenty_refs` 不能直接拿去删（migration 012 的文件头说得更细）──────
 *
 *  它混着三种东西：
 *    ① 这条速记自己建的     —— 该删
 *    ② **复用**别人已有的   —— 绝不能删（删掉一个共享项目 = 因为删一条拜访
 *                              而炸掉整条项目线）
 *    ③ 根本不是 id 的       —— `workItems: "4"` 是计数、`recommitted` 是时间戳
 *
 *  所以 D93 加了 `staging.created_records`：`confirm.ts` 里那个 `made` 变量
 *  精确回答了「这次**新建**了什么」，以前只喂给 timeline 就扔了，现在落库。
 *
 *  ⚠️ **这一列上线之前入库的记录没有这份清单**（生产上已有的那些）。
 *     那些走 `legacyPlan()` —— 一个保守白名单，而且**删不掉的当场说出来**。
 * ══════════════════════════════════════════════════════════════════ */
import { isDeletableObject, type DeletableObject, type RecordRef } from './twenty.ts';

/** 预览/执行共用的一份结论。 */
export type DeletionPlan = {
  /** 会被软删的那几条。顺序不重要 —— `softDeleteRecords` 自己按子→父排。 */
  refs: RecordRef[];
  /**
   * 🔴 **删不掉的必须说出来。**
   *
   * 「看不见」和「不存在」要分得开：一条留在 CRM 里的孤儿工作项，
   * 如果界面上不提，人会以为整条记录都干净了。
   * 每一项写清**为什么**删不掉，不是一句「部分失败」。
   */
  skipped: Array<{ what: string; why: string }>;
  /** 这份清单是从哪儿来的。界面上要能区分「精确」和「保守推断」。 */
  source: 'created_records' | 'legacy_refs' | 'none';
};

/** 一条 staging 行里和删除有关的那几格。 */
export type DeletableRow = {
  status: string;
  twenty_refs: Record<string, unknown> | null;
  created_records: unknown;
};

const OBJECT_LABEL: Record<DeletableObject, string> = {
  workItem: '工作项',
  projectDoc: '项目文档',
  projectUpdate: '项目进展', // D139：只有门户删它（DELETE /portal/updates/:id），速记管道不建
  visit: '拜访',
  productFitment: '选型情报',
  supportCase: '售后问题',
  intelValue: '情报字段',
  opportunity: '商机',
  project: '项目',
};

export const labelOf = (o: string): string => (o in OBJECT_LABEL ? OBJECT_LABEL[o as DeletableObject] : o);

/**
 * `created_records` 那一列：`confirm.ts` 的 `made` 原样落库
 * （`[{object, id, name}]`）。**这一份是精确的** —— 它记的就是「这次新建了什么」，
 * 复用别人的记录压根没进来过。
 */
const fromCreated = (raw: unknown): RecordRef[] | null => {
  if (!Array.isArray(raw)) return null;
  const out: RecordRef[] = [];
  for (const r of raw) {
    const object = String((r as any)?.object ?? '');
    const id = String((r as any)?.id ?? '');
    // 认不出的对象**跳过而不是猜**：`DELETABLE` 是内省确认过的八个，
    // 往里塞一个猜来的名字，删除时打的是一个不存在的 REST 路径。
    if (!id || !isDeletableObject(object)) continue;
    out.push({ object, id, name: String((r as any)?.name ?? '') || undefined });
  }
  return out;
};

/**
 * 老记录的保守白名单。
 *
 * 只认**确定是自己建的**那几类，而且三个「复用」的痕迹一旦在场就跳过对应那条：
 *   · `supportCaseAppended` → 这条售后是追加到别人已有的那一条上的
 *   · `opportunityWas`      → 商机是已存在的，只是把阶段推了一格
 *   · `projectUpdated`      → 项目是已存在的
 *
 * 这三个标记是 `confirm.ts` 在复用时**同时**写下的（:436 / :567 / :711），
 * 所以「有标记 = 复用」这个判断不是推测，是那几行代码的直接读法。
 */
const legacyPlan = (refs: Record<string, unknown>): DeletionPlan => {
  const s = (k: string): string | null => {
    const v = refs[k];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  const out: RecordRef[] = [];
  const skipped: DeletionPlan['skipped'] = [];

  const visitId = s('visitId');
  if (visitId) out.push({ object: 'visit', id: visitId });

  const caseId = s('supportCaseId');
  if (caseId) {
    if (s('supportCaseAppended')) {
      skipped.push({
        what: labelOf('supportCase'),
        why: '这条是追加到一条**已有**的售后问题上的 —— 那条不是这次建的，删掉会连累别人记的内容。',
      });
    } else out.push({ object: 'supportCase', id: caseId });
  }

  const fitId = s('productFitmentId');
  if (fitId) out.push({ object: 'productFitment', id: fitId });

  const docId = s('projectDocId');
  if (docId) out.push({ object: 'projectDoc', id: docId });

  const oppId = s('opportunityId');
  if (oppId) {
    if (s('opportunityWas')) {
      skipped.push({
        what: labelOf('opportunity'),
        why: '这条商机在这次入库之前就存在（只是被推了一格阶段）—— 不是这次建的。',
      });
    } else out.push({ object: 'opportunity', id: oppId });
  }

  const projId = s('projectId');
  if (projId) {
    if (s('projectUpdated')) {
      skipped.push({
        what: labelOf('project'),
        why: '这个项目在这次入库之前就存在 —— 删掉它等于因为删一条拜访而炸掉整条项目线。',
      });
    } else out.push({ object: 'project', id: projId });
  }

  /**
   * 🔴 工作项在老记录上**删不掉**，而且必须说出来。
   *
   * `refs.workItems` 存的是**计数**（`String(byCode.size)`，confirm.ts:808），
   * 那几条的 id 从来没进过 refs。D93 之后新建的会进 `created_records`，
   * 历史的只能留在 CRM 里 —— 界面照实说，不静默留孤儿。
   */
  const n = Number(refs.workItems ?? 0);
  if (Number.isFinite(n) && n > 0) {
    skipped.push({
      what: `${n} 条${labelOf('workItem')}`,
      why: '这条是在「删除」这个功能之前入库的，当时只记了条数没记 id —— 请去 CRM 里删。',
    });
  }

  return { refs: out, skipped, source: 'legacy_refs' };
};

/**
 * 「删这一条，会动 CRM 里的哪几条」。**预览和执行共用它。**
 *
 * 还没入库的（`ready` / `failed` / 处理中）在 CRM 里根本没有东西 ——
 * 返回一份空计划，删除就只是「这一行不再出现在看板上」。
 * 这正是 issue #29 的主场景（「错误、重复或已经不需要的记录」），
 * 而它和 issue #25 的差别不在代码分支，在**这条记录进没进过 CRM**。
 */
export const plan = (row: DeletableRow): DeletionPlan => {
  const created = fromCreated(row.created_records);
  if (created?.length) return { refs: created, skipped: [], source: 'created_records' };

  const refs = (row.twenty_refs ?? {}) as Record<string, unknown>;
  // `created_records` 是空数组（这次一条都没新建，比如纯更新的重录）也算数 ——
  // 和「这一列还没上线」不是一回事，后者是 null。
  if (created && !Object.keys(refs).length) return { refs: [], skipped: [], source: 'created_records' };
  if (!Object.keys(refs).length) return { refs: [], skipped: [], source: 'none' };
  return legacyPlan(refs);
};

/** 给人看的一句话：「拜访 · 商机 · 2 条工作项」。 */
export const describe = (refs: RecordRef[]): string => {
  const byObject = new Map<string, number>();
  for (const r of refs) byObject.set(r.object, (byObject.get(r.object) ?? 0) + 1);
  return [...byObject].map(([o, n]) => (n > 1 ? `${n} 条${labelOf(o)}` : labelOf(o))).join(' · ');
};
