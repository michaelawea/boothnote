/**
 * ══════════════════════════════════════════════════════════════════
 *  自动入库的确信度门槛（D144 · docs/dingtalk-confirm-pool.md §3）
 *
 *  钉钉来源不做确认（D143）：agent 跑完、汇报发出去，60 秒后自动写 CRM。
 *  这个函数回答的是**「这一版够不够格自动写」**。
 *
 *  维护者 2026-10-01：「如果信息非常不完善，还是要挡。」
 *
 *  🔴 **判据全是机器判据，不靠模型自评「我有多确定」**（§2.37）——
 *     唯一读模型自报的是 `confidence` 里那两格（客户、品类），
 *     而且只拿它**往严里判**（low 就挡），从不拿它往松里放。
 *
 *  三级：
 *    hard  —— 不能入库，`入库 #N` 也不行。客户没对上 = D28（入库前必须有归属）。
 *    soft  —— 默认不入库；补一句再跑，或 `入库 #N` 按原样入库。
 *             留这个出口是因为：真不知道的信息永远补不上，挡死了这条情报就永远进不了 CRM。
 *    warn  —— 照常倒计时，只在汇报里列「待核」。
 *
 *  纯函数，零依赖 —— 规则表在 `commitGate.test.ts` 里逐条钉住。
 * ══════════════════════════════════════════════════════════════════ */

export type GateInput = {
  status: string;
  partial: boolean;
  extracted: Record<string, unknown>;
  /**
   * 每一格的把握度（high / medium / low）。🔴 **存在 `staging.confidence` 这一列，不在 extracted 里**
   * （write.ts：`confidence = …` 单独落列，名字特意和 `sourceConfidence` 分开）。
   * 第一版读的是 `extracted.confidence` —— 生产上永远是空的，「把握 low 就挡」一次都不会触发，
   * 而单元测试照样全绿（fixture 把它塞进了 extracted）。评审抓出来的。
   */
  confidence?: Record<string, unknown> | null;
  /** agent 提议的新客户（只提议不建，§4.2 第3条）。 */
  suggestedCompany: string | null;
};

export type GateResult = {
  /** true = 可以自动排队入库。 */
  auto: boolean;
  /** 不能入库的理由（`入库 #N` 也越不过）。 */
  hard: string[];
  /** 默认挡住的理由（`入库 #N` 可越过）。 */
  soft: string[];
  /** 不挡，只在汇报里提一句。 */
  warn: string[];
};

const str = (v: unknown): string => String(v ?? '').trim();
const has = (v: unknown): boolean => {
  if (v == null) return false;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return str(v) !== '';
};

/** 汇报里「待核」那一行用的字段名。只列人看得懂的那几格，其余的不提（提了也看不懂）。 */
const FIELD_LABEL: Record<string, string> = {
  companyCode: '客户',
  category: '品类',
  supplierName: '在位品牌',
  modelName: '型号',
  stage: '阶段',
  decisionWindow: '决策窗口',
  demandQuantity: '需求量',
  targetPrice: '目标价',
  budgetEur: '预算',
  annualVehicles: '整车年产量',
  severity: '严重程度',
  caseStatus: '售后状态',
  affectedUnits: '受影响台数',
};

const lowOf = (c: Record<string, unknown>, key: string): boolean => str(c[key]).toLowerCase() === 'low';

export const commitGate = (g: GateInput): GateResult => {
  const x = g.extracted ?? {};
  const conf = (g.confidence ?? {}) as Record<string, unknown>;
  const hard: string[] = [];
  const soft: string[] = [];
  const warn: string[] = [];

  // ── hard ─────────────────────────────────────────────────────────
  if (g.status === 'failed') hard.push('这一条没处理成');
  if (!str(x['companyCode'])) {
    hard.push(
      g.suggestedCompany
        ? `客户「${g.suggestedCompany}」不在名单里（新客户要先在 CRM 建好）`
        : '客户没对上名单',
    );
  }

  // ── soft ─────────────────────────────────────────────────────────
  if (x['agentSkipped'] === true) soft.push('AI 没整理出结构化字段（下面是原文）');
  if (g.partial) soft.push('处理到了上限，结果可能不全');
  if (str(x['companyCode']) && lowOf(conf, 'companyCode')) soft.push('客户识别把握低');
  /**
   * 客户格子有值、agent 却又提议了一家新客户 —— 多半是这一格是**上一版继承来的**，
   * 而这一句其实在说另一家。不挡的话 60 秒后挂到旧客户名下。
   */
  if (str(x['companyCode']) && g.suggestedCompany) {
    soft.push(`AI 提议了新客户「${g.suggestedCompany}」，但客户仍是 ${str(x['companyCode'])}`);
  }

  const type = str(x['recordType']) || 'fitment';
  if (x['agentSkipped'] !== true) {
    if (type === 'support') {
      if (!has(x['details']) && !has(x['summary'])) soft.push('缺问题描述');
      if (!has(x['modelName']) && !has(x['category'])) soft.push('缺型号或品类');
    } else if (type === 'project') {
      if (!has(x['project'])) soft.push('判成项目，但没有项目提案');
    } else if (type === 'followup') {
      const proj = (x['project'] ?? {}) as Record<string, unknown>;
      if (!has(x['projectCode']) && !has(proj['projectCode']) && !has(x['workItems']) && !has(x['project'])) {
        soft.push('判成项目跟进，但没指向任何项目、也没有任务线程');
      }
    } else {
      // 选型情报（默认类型）
      if (!has(x['category'])) soft.push('缺品类');
      else if (lowOf(conf, 'category')) soft.push('品类把握低');
      const anyFact = ['supplierName', 'modelName', 'stage', 'demandQuantity', 'decisionWindow'].some((k) =>
        has(x[k]),
      );
      if (!anyFact) soft.push('在位品牌、型号、阶段、需求量、决策窗口一项都没有');
    }
  }

  // ── warn ─────────────────────────────────────────────────────────
  for (const [k, label] of Object.entries(FIELD_LABEL)) {
    if (k === 'companyCode' || (k === 'category' && type === 'fitment')) continue; // 上面已经按 soft 判过
    if (has(x[k]) && lowOf(conf, k)) warn.push(`${label}（把握低）`);
  }
  if (str(x['sourceConfidence']) === 'RUMOR') warn.push('信息来源是传闻');

  return { auto: hard.length === 0 && soft.length === 0, hard, soft, warn };
};

/** `入库 #N`：人说「就按现在这样入库」。只越得过 soft。 */
export const canForceCommit = (r: GateResult): boolean => r.hard.length === 0;
