/**
 * ══════════════════════════════════════════════════════════════════
 *  钉钉汇报（D145 · docs/dingtalk-confirm-pool.md §4）
 *
 *  维护者 2026-10-01：「先回答状态，入库还是未入库……不要有太多的 emoji，
 *  结构专业一点，简洁一点，但是如果涉及到信息的 propose，也要详尽。」
 *
 *  所以版式是固定的：
 *    第 1 行  #128 类型 · 状态
 *    第 2 行  **状态**：… [撤回](链接)      ← 链接永远在第 2 行，再长的明细也截不掉它
 *    然后     客户 · 本版变更 · 拟写入 CRM（逐条，详尽）· 待核 · 要点 · 明细 · 待回答
 *
 *  `planOf()` 判「新建还是更新」用的是 `confirm.ts` **同一批查找函数**
 *  （findOpportunity / findProjectByCode / findWorkItemByCode）—— 判断只有一份；
 *  这里只是先问一遍同样的问题。CRM 查不到时如实写「新建或更新」，不猜。
 *
 *  渲染（`renderReport` / `renderNotice`）是纯函数；`planOf` 的查找可注入，测试不碰 Twenty。
 * ══════════════════════════════════════════════════════════════════ */
import {
  CATEGORY_LABELS,
  CASE_STATUS_LABELS,
  CONFIDENCE_LABELS,
  DOC_SOURCE_LABELS,
  ITEM_STATUS_LABELS,
  PRIORITY_LABELS,
  RECORD_TYPE_LABELS,
  SEVERITY_LABELS,
  STAGE_LABELS,
  THREAD_TYPE_LABELS,
} from '../../agent/src/enums.ts';
import { parseDecisionWindow } from '../window.ts';
import { md, type DingMessage } from './render.ts';

const str = (v: unknown): string => String(v ?? '').trim();
const lab = (map: Record<string, string>, v: unknown): string => {
  const s = str(v);
  return s ? (map[s] ?? s) : '';
};
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 「字段名 值」拼成一行；空的不出现。 */
const kv = (pairs: Array<[string, unknown]>): string =>
  pairs
    .map(([k, v]) => [k, str(v)] as const)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k} ${v}`)
    .join('；');

// ── 拟写入清单 ─────────────────────────────────────────────────────

export type PlanItem = {
  /** 拜访记录 / 选型情报 / 商机 / …… */
  what: string;
  /** 新建 / 更新「…」/ 新建或更新 */
  action: string;
  /** 字段明细，一行。 */
  detail: string;
  /** 子项（任务线程逐条）。 */
  children?: string[];
};

export type Lookups = {
  findOpportunity: (companyId: string, category: string | null) => Promise<{ name: string; stage: string } | null>;
  findProjectByCode: (code: string) => Promise<{ name: string; projectStage: string } | null>;
  findWorkItemByCode: (code: string) => Promise<{ id: string } | null>;
};

const UNKNOWN = '新建或更新（CRM 暂时查不到）';

/**
 * 「确认后会写进 CRM 的是什么」—— 分支结构照抄 `commitToTwenty`（confirm.ts）：
 * 拜访永远有 · support 走售后 · 否则有品类走选型情报（+ 有阶段 / **能解析的**窗口 / 预算才动商机）·
 * 年产量只在原来为空时写 · 项目 / 任务线程 / 文档各自按编号判新旧。
 *
 * `prevRefs` = 这一版接管的是已入库的那一版（D108 `replaces.refs`）：
 * **逐个对象看** —— 上一版建过这个对象（refs 里有它的 id）才是「更新上一版那条」，
 * 没建过的照常判新旧（和 commitToTwenty 的 `redo && prev.xxxId` 一条一条对上）。
 * `softDeleted` > 0 = 客户变了：上一版那几条会被软删、全部按新客户重建。
 */
export const planOf = async (
  x: Record<string, unknown>,
  ctx: { companyId: string | null; companyName: string | null; prevRefs: Record<string, unknown> | null; softDeleted?: number },
  look: Lookups,
): Promise<PlanItem[]> => {
  const out: PlanItem[] = [];
  const prev = ctx.prevRefs ?? {};
  const had = (k: string): boolean => Boolean(ctx.prevRefs && str(prev[k]));
  const redoAction = '更新（上一版写入的那条）';
  if (ctx.softDeleted) {
    out.push({
      what: '上一版写入的记录',
      action: `软删 ${ctx.softDeleted} 条（可恢复）`,
      detail: '客户变了，下面全部按新客户新建',
    });
  }
  const safe = async <T,>(p: () => Promise<T>): Promise<T | 'unknown'> => {
    try {
      return await p();
    } catch {
      return 'unknown';
    }
  };

  out.push({
    what: '拜访记录',
    action: had('visitId') ? '更新正文' : '新建',
    detail: kv([['标题', clip(str(x['summary']), 40)]]),
  });

  const type = str(x['recordType']) || 'fitment';
  if (type === 'support') {
    out.push({
      what: '售后问题',
      action: had('supportCaseId') ? redoAction : '新建',
      detail: kv([
        ['标题', clip(str(x['summary']), 40)],
        ['严重程度', lab(SEVERITY_LABELS, x['severity']) || '中（默认）'],
        ['状态', lab(CASE_STATUS_LABELS, x['caseStatus']) || '新建（默认）'],
        ['型号', x['modelName']],
        ['批次', x['deliveryBatch']],
        ['受影响台数', x['affectedUnits']],
      ]),
    });
  } else if (str(x['category'])) {
    out.push({
      what: '选型情报',
      action: had('productFitmentId') ? redoAction : '新建',
      detail: kv([
        ['品类', lab(CATEGORY_LABELS, x['category'])],
        ['在位品牌', x['supplierName']],
        ['型号', x['modelName']],
        ['信息来源', lab(CONFIDENCE_LABELS, x['sourceConfidence']) || '较可信（默认）'],
        ['听谁说的', x['sourceCompanyName']],
      ]),
    });
    // 和 confirm.ts 同一个条件：窗口要**解析得出日期**才算（「明年吧」这种不动商机，只记在拜访正文里）
    if (str(x['stage']) || parseDecisionWindow(str(x['decisionWindow']) || null) || x['budgetEur'] != null) {
      const newStage = lab(STAGE_LABELS, x['stage']);
      let action = '新建';
      let stageText = newStage;
      if (had('opportunityId')) action = redoAction;
      else if (ctx.companyId) {
        const hit = await safe(() => look.findOpportunity(ctx.companyId!, str(x['category']) || null));
        if (hit === 'unknown') action = UNKNOWN;
        else if (hit) {
          action = `更新已有「${hit.name}」`;
          const was = lab(STAGE_LABELS, hit.stage);
          if (newStage && was && was !== newStage) stageText = `${was} → ${newStage}`;
        } else {
          action = `新建「${ctx.companyName ?? '客户'} · ${lab(CATEGORY_LABELS, x['category'])}」`;
        }
      }
      out.push({
        what: '商机',
        action,
        detail: kv([
          ['阶段', stageText],
          ['决策窗口', x['decisionWindow']],
          ['预算 EUR', x['budgetEur']],
          ['需求量', x['demandQuantity']],
          ['目标价', x['targetPrice']],
          ['负责团队', x['ownerTeam']],
        ]),
      });
    }
  }

  if (str(x['annualVehicles'])) {
    out.push({ what: '客户整车年产量', action: '写入（只在原来为空时）', detail: str(x['annualVehicles']) });
  }

  const p = (x['project'] ?? null) as Record<string, unknown> | null;
  if (p && typeof p === 'object') {
    const code = str(p['projectCode']);
    let action = code ? `新建 ${code}` : '新建（编号入库时生成）';
    if (had('projectId')) action = redoAction;
    else if (code) {
      const hit = await safe(() => look.findProjectByCode(code));
      if (hit === 'unknown') action = `${code}：${UNKNOWN}`;
      else if (hit) action = `更新已有 ${code}「${hit.name}」`;
    }
    out.push({
      what: '项目',
      action,
      detail: kv([
        ['名称', p['name']],
        ['阶段', lab(STAGE_LABELS, p['projectStage'])],
        ['核心型号', p['primaryProductName']],
        ['样品数', p['sampleQty']],
        ['计划 SOP', p['plannedSop']],
        ['预算 EUR', p['budgetEur']],
        ['负责团队', p['ownerTeam']],
        ['待确认', p['openQuestions'] ? clip(str(p['openQuestions']), 80) : ''],
      ]),
    });
  }

  const items = Array.isArray(x['workItems']) ? (x['workItems'] as Array<Record<string, unknown>>) : [];
  if (items.length) {
    const shown = items.slice(0, 12);
    const children: string[] = [];
    let created = 0;
    let updated = 0;
    for (const it of shown) {
      const code = str(it['itemCode']);
      let tag = '新建';
      if (code) {
        const hit = await safe(() => look.findWorkItemByCode(code));
        tag = hit === 'unknown' ? '新建或更新' : hit ? '更新' : '新建';
      }
      if (tag === '新建') created++;
      if (tag === '更新') updated++;
      children.push(
        `${code} ${str(it['title'])}（${tag}；` +
          kv([
            ['类型', lab(THREAD_TYPE_LABELS, it['threadType'])],
            ['截止', it['dueDate']],
            ['客户期望', it['customerDueDate']],
            ['负责', it['ownerRole']],
            ['优先级', lab(PRIORITY_LABELS, it['priority'])],
            ['状态', lab(ITEM_STATUS_LABELS, it['itemStatus'])],
          ]) +
          '）',
      );
    }
    if (items.length > shown.length) children.push(`另有 ${items.length - shown.length} 条未列出`);
    out.push({
      what: `任务线程 ${items.length} 条`,
      action: [created && `新建 ${created}`, updated && `更新 ${updated}`].filter(Boolean).join('，') || '新建或更新',
      detail: '',
      children,
    });
  }

  const doc = (x['document'] ?? null) as Record<string, unknown> | null;
  if (doc && typeof doc === 'object') {
    out.push({
      what: '项目文档',
      action: had('projectDocId') ? redoAction : '新建',
      detail: kv([
        ['名称', doc['name']],
        ['来源', lab(DOC_SOURCE_LABELS, doc['docSource'])],
        ['版本', doc['version']],
      ]),
    });
  }
  return out;
};

// ── 版本差异 ───────────────────────────────────────────────────────

const DIFF_FIELDS: Array<[string, string, Record<string, string> | null]> = [
  ['companyCode', '客户', null],
  ['recordType', '类型', RECORD_TYPE_LABELS],
  ['category', '品类', CATEGORY_LABELS],
  ['supplierName', '在位品牌', null],
  ['modelName', '型号', null],
  ['stage', '阶段', STAGE_LABELS],
  ['decisionWindow', '决策窗口', null],
  ['demandQuantity', '需求量', null],
  ['targetPrice', '目标价', null],
  ['budgetEur', '预算', null],
  ['annualVehicles', '整车年产量', null],
  ['severity', '严重程度', SEVERITY_LABELS],
  ['caseStatus', '售后状态', CASE_STATUS_LABELS],
  ['sourceConfidence', '信息来源', CONFIDENCE_LABELS],
];

/**
 * 这一版相对上一版改了什么。**客户变了单独返回** —— 汇报里要加粗，
 * 它是「错并线」（一句无关的话被接到这一条上）唯一能被人一眼看出来的信号。
 */
export const diffOf = (
  prev: Record<string, unknown> | null,
  cur: Record<string, unknown>,
): { lines: string[]; companyChanged: boolean } => {
  if (!prev) return { lines: [], companyChanged: false };
  const lines: string[] = [];
  let companyChanged = false;
  for (const [k, label, map] of DIFF_FIELDS) {
    const a = map ? lab(map, prev[k]) : str(prev[k]);
    const b = map ? lab(map, cur[k]) : str(cur[k]);
    if (a === b) continue;
    if (k === 'companyCode') companyChanged = Boolean(a && b);
    lines.push(`${label} ${a || '（空）'} → ${b || '（空）'}`);
  }
  const pa = str((prev['project'] as any)?.projectStage);
  const pb = str((cur['project'] as any)?.projectStage);
  if (pa !== pb) lines.push(`项目阶段 ${lab(STAGE_LABELS, pa) || '（空）'} → ${lab(STAGE_LABELS, pb) || '（空）'}`);
  const wa = Array.isArray(prev['workItems']) ? (prev['workItems'] as unknown[]).length : 0;
  const wb = Array.isArray(cur['workItems']) ? (cur['workItems'] as unknown[]).length : 0;
  if (wa !== wb) lines.push(`任务线程 ${wa} → ${wb} 条`);
  return { lines, companyChanged };
};

/**
 * 给某一条登记「待回答」的那个问题：只有 agent 自己的追问和**真实的信息缺口**才算 ——
 * 状态说明（已撤回 / 自动入库关着）不算。算了的话，30 分钟里这个人说的下一句不相干的话
 * 会被当成「回答」并进这一条（评审抓出来的：回滚开关一开，每条汇报都登记一个假问题）。
 */
export const askFor = (questions: string[], gate: { hard: string[]; soft: string[] }): string | null =>
  questions[0] ?? (gate.hard.length + gate.soft.length ? `补充：${[...gate.hard, ...gate.soft].join('；')}` : null);

// ── 渲染 ──────────────────────────────────────────────────────────

export type ReportState =
  | { kind: 'countdown'; seconds: number; withdrawUrl: string | null }
  | { kind: 'held'; hard: string[]; soft: string[] }
  | { kind: 'failed'; error: string }
  /** 门槛过了，但排队那一步没排上（并发：同一条对话刚来了新的一句 / 已被取代）。 */
  | { kind: 'not_queued'; why: string };

export type ReportView = {
  sender: string;
  /** 这一版接管的是已入库的那一版（D108）—— 没入库时要说「本次修改未入库」，不是整条未入库。 */
  redo?: boolean;
  refNo: number;
  version: number;
  extracted: Record<string, unknown>;
  companyLabel: string | null;
  suggestedCompany: string | null;
  diff: { lines: string[]; companyChanged: boolean };
  plan: PlanItem[];
  warn: string[];
  questions: string[];
  state: ReportState;
};

/** 状态那一格的字（第 1 行的尾巴）。 */
const headState = (s: ReportState, redo?: boolean): string =>
  s.kind === 'countdown' ? (redo ? '修改待入库' : '待入库') : redo ? '修改未入库' : '未入库';

export const renderReport = (v: ReportView): DingMessage => {
  const x = v.extracted ?? {};
  const type = lab(RECORD_TYPE_LABELS, x['recordType']) || lab(RECORD_TYPE_LABELS, 'fitment') || '速记';
  const L: string[] = [];
  L.push(`#### #${v.refNo} ${type} · ${headState(v.state, v.redo)}`);

  // 第 2 行永远是状态 —— 链接长在这里，后面再长都截不到它
  const s = v.state;
  if (s.kind === 'countdown') {
    L.push(
      `**状态**：待入库，${s.seconds} 秒后自动写入 CRM。` +
        (s.withdrawUrl ? `[撤回](${s.withdrawUrl})` : '（没有撤回链接：网关没配 CAPTURE_URL，找 维护者）'),
    );
  } else if (s.kind === 'held') {
    L.push(`**状态**：${v.redo ? '这次修改未入库（CRM 里仍是上一版）' : '未入库'}。原因：${[...s.hard, ...s.soft].join('；')}。`);
    L.push(
      s.hard.length
        ? `**需要**：@我 补一句（30 分钟内直接说即可，之后带上 #${v.refNo}）。`
        : `**需要**：@我 补一句（30 分钟内直接说即可，之后带上 #${v.refNo}），或 @我「入库 #${v.refNo}」按现在的内容入库。`,
    );
  } else if (s.kind === 'failed') {
    L.push(`**状态**：${v.redo ? '这次修改未入库（CRM 里仍是上一版）' : '未入库'}，处理失败（${clip(s.error, 80)}）。原话已保存。`);
    L.push(`**需要**：@我 #${v.refNo} 再说一遍。`);
  } else {
    L.push(`**状态**：${v.redo ? '这次修改未入库（CRM 里仍是上一版）' : '未入库'}（${s.why}）。`);
  }

  L.push(
    `**客户**：${
      v.companyLabel ?? (v.suggestedCompany ? `未对上名单（提议：${v.suggestedCompany}）` : '未对上名单')
    }`,
  );
  if (v.version > 1 && v.diff.lines.length) {
    L.push(
      `**本版变更**（第 ${v.version} 版）：${v.diff.lines.join('；')}` +
        (v.diff.companyChanged ? '\n**注意：客户变了**，确认这句话确实是在改这一条。' : ''),
    );
  }

  if (v.plan.length) {
    L.push(s.kind === 'countdown' ? '**拟写入 CRM**' : '**整理结果（入库时会写入）**');
    v.plan.forEach((p, i) => {
      L.push(`${i + 1}. ${p.what} · ${p.action}${p.detail ? ` —— ${p.detail}` : ''}`);
      for (const c of p.children ?? []) L.push(`   - ${c}`);
    });
  }
  if (v.warn.length) L.push(`**待核**：${v.warn.join('；')}`);
  const summary = str(x['summary']);
  if (summary) L.push(`**要点**：${clip(summary, 80)}`);
  const details = str(x['details']);
  if (details && details !== summary) L.push(`**明细**：${clip(details.replace(/\s*\n\s*/g, ' '), 600)}`);
  for (const q of v.questions.slice(0, 1)) L.push(`**待回答**：${clip(q, 120)}（@我 直接回答，30 分钟内有效）`);
  if (s.kind === 'countdown') L.push(`撤回只在入库前有效。入库后要改：@我 #${v.refNo} + 修改内容。`);
  return md(L.join('\n'), v.sender);
};

/** 群回声：入库成功 / 入库失败 / 已撤回（D143 · D148）。 */
export type Notice =
  | { kind: 'committed'; refNo: number; created: Record<string, number>; updated: string[] }
  | { kind: 'commit_failed'; refNo: number; error: string }
  | { kind: 'withdrawn'; refNo: number; via: 'link'; redo?: boolean };

export const renderNotice = (n: Notice, sender: string): DingMessage => {
  if (n.kind === 'committed') {
    const made = Object.entries(n.created).map(([k, c]) => `${k} ${c}`).join('、');
    const parts = [made && `新建 ${made}`, n.updated.length && `更新 ${n.updated.join('、')}`].filter(Boolean);
    return md(
      `#### #${n.refNo} · 已入库\n**状态**：已写入 CRM${parts.length ? `：${parts.join('；')}` : ''}。\n` +
        `要改：@我 #${n.refNo} + 修改内容。`,
      sender,
    );
  }
  if (n.kind === 'commit_failed') {
    // commitToTwenty 是一步一步写的 —— 中途失败时前几步可能已经写进去了，不能说「CRM 里没有」
    return md(
      `#### #${n.refNo} · 入库失败\n**状态**：写入 CRM 中途失败（${clip(n.error, 100)}）。可能已写入一部分。\n` +
        `**需要**：先在 CRM 里核一眼，再 @我「入库 #${n.refNo}」重试。`,
      sender,
    );
  }
  return md(
    `#### #${n.refNo} · 已撤回\n**状态**：${n.redo ? '这次修改已撤回，CRM 里仍是上一版' : '已撤回，没有写入 CRM'}（通过撤回链接）。\n` +
      `**后续**：@我 #${n.refNo} + 修改内容；或 @我「入库 #${n.refNo}」按原样入库。`,
    sender,
  );
};
