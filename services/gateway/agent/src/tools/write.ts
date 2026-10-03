import { Type } from '@earendil-works/pi-ai';

import { sql, companySuggestion, createAgentQuestion, bindExplicitCandidate, hasProposalItems } from '../host.ts';
import type { AgentQuestionInput } from '../host.ts';
import type { CompanySuggestion } from '../host.ts';
import { findSimilar } from '../host.ts';
import {
  chainRank,
  isValidChain,
  keepCaseStatus,
  keepCategory,
  keepConfidence,
  keepRecordTypeV2,
  keepSeverity,
  keepStage,
} from '../enums.ts';
import type { Skill } from '../runtime.ts';
import type { SkillContext } from './context.ts';

/** 新客户建议的归属必须是同名客户或明确事项 key，不能成为整轮默认值。 */
export const rememberCompanySuggestion = (ctx: SkillContext, suggestion: CompanySuggestion, itemKey?: string): void => {
  (ctx.companySuggestions ??= new Map()).set(suggestion.name, suggestion);
  if (itemKey) (ctx.itemCompanySuggestions ??= new Map()).set(itemKey, suggestion);
};

/** 继续旧草稿是补丁，省略的默认值不能盖掉原客户、台数、状态或改字留痕。 */
export const legacyContinuationPatch = (basis: Record<string, any>, supplied: Record<string, any>, computed: Record<string, any>) => {
  const patch = Object.fromEntries(Object.entries(computed).filter(([key]) => key === 'recordType'
    || Object.hasOwn(supplied, key) || (key === 'demandQuantity' && Object.hasOwn(supplied, 'quantity'))));
  if (typeof patch.details === 'string' && patch.details.trim() && typeof basis.details === 'string' && basis.details.trim()) {
    patch.details = [...new Set([basis.details, patch.details])].join('\n\n');
  }
  return patch;
};

/**
 * Ring 2 —— **写提案**。落 staging，等人确认。
 *
 * 这一圈没有任何东西直接进 Twenty。它写的每一行都停在「待人核对」那一格里，
 * 所以「模型出错」的最坏后果是**一条提案被人否掉**，不是脏数据进了 CRM。
 */

export const writeSkills = (ctx: SkillContext): Skill[] => [
  {
    name: 'propose_fields',
    label: '提交抽取结果',
    description:
      '把从这段话里读出来的结构化字段提交上去，等人核对。' +
      '读不出来就留空 —— **猜错比留空糟得多**：留空的字段会进情报缺口清单，下次拜访再问；' +
      '猜错的字段会被当成事实用下去。一轮里可以调多次，后一次覆盖前一次。',
    parameters: Type.Object({
      companyCode: Type.Optional(
        Type.String({ description: '客户代号，必须来自 search_companies 的返回值' }),
      ),
      targetCandidateHandle: Type.Optional(Type.String({ description: '原话明确给了目标编号/UUID时，使用本轮 get_company_records/get_projects 返回的候选句柄预填。未明确给编号先用 ask_user 推荐确认。' })),
      /**
       * 🔴 这条速记该落成哪种记录。**没有这个字段之前，
       * 「帮我记录一下这个售后问题」会被抽成一条产品选型情报**（实测踩过）——
       * 模型当时没做错什么，它只是没地方表达「这是售后」。
       */
      recordType: Type.Optional(
        Type.String({
          description:
            'fitment = 产品选型情报（成交前：客户在用谁、想换谁、什么时候定）；' +
            'support = 售后问题（已交付的东西出了毛病，要闭环解决）；' +
            'project = 项目（已定点，要建/更新带编号的交付项目）；' +
            'followup = 项目跟进（针对已有项目的一次跟进，通常要拆任务线程）。' +
            '不确定就留空，按选型处理。',
        }),
      ),
      caseStatus: Type.Optional(
        Type.String({ description: '仅 support：NEW / ACKNOWLEDGED / IN_PROGRESS / WAITING_CUSTOMER / RESOLVED / CLOSED' }),
      ),
      severity: Type.Optional(
        Type.String({ description: '仅 support：LOW / MEDIUM / HIGH / CRITICAL' }),
      ),
      deliveryBatch: Type.Optional(
        Type.String({
          description:
            '仅 support：交付批次，**原话照抄**，如「2025-03 批次」「MY2025 首批」。别换算成日期。',
        }),
      ),
      affectedUnits: Type.Optional(
        Type.Number({
          description:
            '仅 support：影响台数。**只有原话里明确说了数字才填**，' +
            '「好几台」「一批」这种一律留空 —— 猜一个数字比留空糟得多，' +
            '它会被拿去排「哪个问题影响面最大」。',
        }),
      ),
      /**
       * 🔴 **传闻必须标成传闻。**
       *
       * 「传闻被当成事实用下去，才是真正的坏账」（手册 P18 那一整页在讲这件事）。
       * 之前 `confirm.ts` 把它写死成 `LIKELY` —— 于是隔壁展台听来的一句话
       * 和客户当面说的一句话，进 CRM 之后长得一模一样。
       *
       * ⚠️ 名字是 `sourceConfidence` 不是 `confidence` —— 后者被
       * 「每一格的把握度」占了（`staging.confidence`），两个东西同名迟早取错。
       */
      sourceConfidence: Type.Optional(
        Type.String({
          description:
            '这条消息离事实有几手 —— 判的是**录入的人当时在不在场**，不是「我有多确定」：' +
            'CONFIRMED = 录入者本人在场（开完会 / 当面问了 / 亲眼看到资料）；' +
            'LIKELY = 不在场但有据（对方发来的邮件资料、官网、展台印刷品）；' +
            'RUMOR = 听第三方说的（「听 X 说」「据说」）。' +
            '🔴 **不要因为「这是销售记的」就判 RUMOR** —— 销售在场就是一手。' +
            '留空则按 LIKELY。',
        }),
      ),
      /**
       * 消息是从谁那听来的（手册 P18：「说话的那家留作来源」）。
       * 只留痕，不建客户，也不改这条记录挂在谁名下 —— 挂的永远是**被说的那家**。
       */
      sourceCompanyName: Type.Optional(
        Type.String({ description: '这条消息是听谁说的（公司名或人名）。客户自己说的就留空。' }),
      ),
      category: Type.Optional(Type.String({ description: '产品品类，取自 list_enums' })),
      supplierName: Type.Optional(Type.String({ description: '在位竞品品牌' })),
      modelName: Type.Optional(Type.String({ description: '型号' })),
      stage: Type.Optional(Type.String({ description: '推进阶段，取自 list_enums' })),
      decisionWindow: Type.Optional(Type.String({ description: '决策窗口，如「2026 Q4 定点」' })),
      /**
       * 🔴 **这两个数是两回事，混了就是静默的错数据。**
       *
       * 实测（2026-08-03，T01 用例）：原来只有一个笼统的 `quantity`，
       * 描述写的是「数量/年产量」。模型拿它装了「电池年需求量 20,000 台」，
       * 而 `confirm.ts` 把它写进 `company.annualProduction` ——
       * 那一栏的含义是**这家客户一年造多少辆车**（Havel 实际 8,000–10,000）。
       * 这次没覆盖只是因为 Havel 那一格已经有值；空的话就会把「20,000」
       * 记成 Havel 的整车产量，**差一倍，而且没有任何地方会报错**。
       */
      annualVehicles: Type.Optional(
        Type.String({
          description:
            '这家客户**一年造多少辆车**（整车年产量）。原样写，如「年产一万二左右」。' +
            '⚠️ 不是我们卖给他多少件 —— 那个填 demandQuantity。原话没说就留空。',
        }),
      ),
      demandQuantity: Type.Optional(
        Type.String({
          description:
            '客户对**这个品类**的需求量，原样写，如「年需求量 20,000 台；100Ah 约 30%，150Ah 约 70%」。' +
            '产品组合占比也写在这里，别丢。',
        }),
      ),
      /**
       * ⚠️ 下面这三个 D59 就加进 schema 了，但**一直没有任何地方写它们**
       * （2026-08-04 审计：annualDemand / demandBreakdown / targetPrice / ownerTeam
       * 四个字段，confirm.ts 和 twenty.ts 里一次都没出现过）。
       * 抽到了、摘要里显示了、CRM 里是空的 —— §2.16 那一类的复发（issue #4）。
       */
      demandBreakdown: Type.Optional(
        Type.String({
          description:
            '产品组合与占比，如「100Ah 约 30%、150Ah 约 70%」。原话照抄。' +
            '🔴 系统算出来的参考数量必须标明是算的，例：「参考：100Ah 约 6,000 台（20,000×30%，系统计算）」。',
        }),
      ),
      targetPrice: Type.Optional(
        Type.String({
          description:
            '客户能接受的价格，原样写，如「约 EUR 500/台」。' +
            '⚠️ 这不是成交价 —— 写成成交价会让后面所有的毛利测算失真。',
        }),
      ),
      ownerTeam: Type.Optional(
        Type.String({
          description: '我方负责这个项目的团队，如「欧洲 OE 销售团队」。是团队不是人。',
        }),
      ),
      /**
       * 预算。Twenty 的 `opportunity.amount` 本来就在那儿，一直没接。
       * T01 用例里「首年采购预算 900 万欧元」原来只进了自由文本，筛不出来。
       */
      budgetEur: Type.Optional(
        Type.Number({
          description:
            '这个项目的预算，**换算成欧元的整数**（900 万 → 9000000）。' +
            '⚠️ 只有原话明确说了金额才填；「大概不少」这种一律留空。' +
            '注意区分：这是**采购预算**，不是单价 —— 单价写进 details。',
        }),
      ),
      summary: Type.Optional(Type.String({ description: '一句话标题，中文，30 字以内。**只是标题** —— 细节写进 details' })),
      /**
       * 🔴 **详情。这一栏才是记录本身。**
       *
       * 维护者 2026-08-03 传了一份 8703 字的远程支持技术报告，
       * 而当时抽出来的只有一句 30 字的 summary —— 车辆、合同号、涉及的 SKU、
       * 客户链、时间线、两条根因、待办，全部丢了。他的原话：「录入一定要非常详细」。
       *
       * 所以：**有附件时按附件的详细程度转录，不要压缩**。宁可长，不要漏。
       */
      details: Type.Optional(
        Type.String({
          description:
            '完整详情，markdown。**有附件时必须写，而且要详细** —— ' +
            '把附件里的车辆/合同号、涉及的产品型号、客户链、时间线、根因、待办、结论都转录进来。' +
            '不要压缩成一句话：这一栏会原样进 CRM，是这条记录唯一完整的载体。',
        }),
      ),
      /**
       * 客户链。文档里写的是
       * `KESSEL GmbH → KWR Reisemobile (dealer) → Rovena (OEM) → Voltline`。
       * ⚠️ 目前只作为文本保存 —— Twenty 里的 `parentCompany` 是**集团树**（D19），
       * 拿它装销售链会把那棵树弄脏。要建真正的关系得先定 schema（见 T38）。
       */
      customerChain: Type.Optional(
        Type.String({
          description:
            '客户链原文，从终端客户到我们，用 → 连起来。**照原文抄** —— 这是溯源，不做规范化。' +
            '例：KESSEL GmbH（终端）→ KWR Reisemobile（dealer）→ Rovena（整车厂）→ Voltline。',
        }),
      ),
      /**
       * 🔴 结构化的渠道链（D54）。**从上游到下游排**。
       *
       * 和上面那个 `customerChain` 文本的分工：文本是原文留痕，这个是**能建关系的形状**。
       * 人在核对卡上确认之后，网关按它设 `company.soldVia`。
       *
       * ⚠️ **只提议，不建**。名单里没有的那几层，是人在界面上点「新建」才建的
       * —— §4.2 第3条：关系字段只能指向已存在的记录。
       */
      chain: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ description: '公司名，照原文写' }),
            role: Type.String({
              description: 'DISTRIBUTOR / SUB_DISTRIBUTOR / DEALER / SUB_DEALER / END_USER',
            }),
          }),
          {
            description:
              '渠道链，**从上游到下游**（distributor 在前，终端客户在最后）。中间层可以缺。' +
              '例：[{name:"KWR Reisemobile",role:"DEALER"},{name:"KESSEL GmbH",role:"END_USER"}]。' +
              '⚠️ 整车厂（OEM）不放进这个数组 —— 它走 companyCode。原话里没提到链就别编。',
          },
        ),
      ),
      confidence: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: '每个非空字段给 high / medium / low',
        }),
      ),
      corrections: Type.Optional(
        Type.Array(
          Type.Object({ heard: Type.String(), corrected: Type.String() }),
          { description: '你纠正过的听错的品牌名，留痕给人看，不要静默改写' },
        ),
      ),
    }),
    execute: async (p: Record<string, any>) => {
      if (ctx.legacyDispositionRequired) {
        return { text: 'legacy_disposition_required: 多事项与旧提案关系未明确，不能退回 propose_fields 压成一项。先 ask_user 提供准确旧草稿 continue 与独立新事项 create 出口。', details: { rejected: true } };
      }
      if (await hasProposalItems(ctx.stagingId)) {
        return { text: '本轮已经保存独立事项，不能再压成一份字段；用逐项提案工具修订明确 itemId/版本，其余事项不变。' };
      }
      // 服务端白名单再校验一次。**不指望 agent 自觉** —— 这一层在 ai.ts 时代就有，保留。
      const codes = new Set(ctx.companies.map((c) => c.code));
      const [continuationBasis] = ctx.continuedLegacyStagingId ? await sql<Array<{ extracted: Record<string, any> }>>`
        select s.extracted from staging s join inbox i on i.id=s.inbox_id where s.id=${ctx.stagingId} and i.user_id=${ctx.userId}` : [];
      const recordType = keepRecordTypeV2(p.recordType ?? continuationBasis?.extracted?.recordType);
      /** 空串当没填。模型很爱交 `""`，而 `jsonb_strip_nulls` 只去 null。 */
      const blank = (v: unknown) => (typeof v === 'string' && !v.trim() ? null : (v ?? null));
      const fields = {
        recordType,
        companyCode: p.companyCode && codes.has(p.companyCode) ? p.companyCode : null,
        // 只有售后才带这两个 —— 选型记录上挂一个「严重度」是没有意义的噪声
        caseStatus: recordType === 'support' ? keepCaseStatus(p.caseStatus) : null,
        severity: recordType === 'support' ? keepSeverity(p.severity) : null,
        deliveryBatch: recordType === 'support' ? (p.deliveryBatch ?? null) : null,
        // 台数必须是个正整数才收 —— 「好几台」被模型写成 0 或 NaN 的话，
        // 「影响面最大」那个排序会把它排到最前面或者直接崩掉
        affectedUnits:
          recordType === 'support' && Number.isInteger(p.affectedUnits) && p.affectedUnits > 0
            ? p.affectedUnits
            : null,
        category: keepCategory(p.category),
        // 认不出就留 null，由 confirm 那一层落到 LIKELY ——
        // **别在这里默认成 LIKELY**，否则「模型没说」和「模型说了较可信」
        // 在核对卡上长得一样，人就没机会把它降下来
        sourceConfidence: keepConfidence(p.sourceConfidence),
        sourceCompanyName: blank(p.sourceCompanyName),
        supplierName: blank(p.supplierName),
        modelName: blank(p.modelName),
        stage: keepStage(p.stage),
        decisionWindow: blank(p.decisionWindow),
        // 兼容：旧版 agent 可能还在传 quantity。当成需求量收下，
        // **绝不再让它流到 company.annualProduction**
        annualVehicles: blank(p.annualVehicles),
        // 负数 / 0 / NaN 一律丢 —— 一个 0 元的预算会让「按金额排」整个失真
        budgetEur: Number.isFinite(p.budgetEur) && p.budgetEur > 0 ? Math.round(p.budgetEur) : null,
        demandQuantity: p.demandQuantity ?? p.quantity ?? null,
        demandBreakdown: blank(p.demandBreakdown),
        targetPrice: blank(p.targetPrice),
        ownerTeam: blank(p.ownerTeam),
        summary: blank(p.summary),
        details: blank(p.details),
        customerChain: blank(p.customerChain),
        // 顺序不对的链一律丢弃 —— 「终端客户 → 分销商」是反的，
        // 建出来的关系会让「这家经销商下面有几个终端客户」永久算错
        chain: (() => {
          const raw = Array.isArray(p.chain) ? p.chain : [];
          const cleaned = raw
            .map((c: any) => ({ name: String(c?.name ?? '').trim(), role: String(c?.role ?? '').toUpperCase() }))
            .filter((c: any) => c.name && chainRank(c.role) >= 0);
          return cleaned.length && isValidChain(cleaned.map((c: any) => c.role)) ? cleaned : null;
        })(),
        corrections: Array.isArray(p.corrections) ? p.corrections : [],
      };
      const dropped: string[] = [];
      if (p.companyCode && !fields.companyCode) dropped.push(`companyCode=${p.companyCode}`);
      if (p.category && !fields.category) dropped.push(`category=${p.category}`);
      if (p.stage && !fields.stage) dropped.push(`stage=${p.stage}`);

      /**
       * 🔴 **空值不许覆盖已经填好的值。**
       *
       * 一轮里可以调多次（后一次修正前一次），但**「没填」不等于「要清空」**。
       * 实测栽过（2026-08-03 场景验收 T01）：第一次填了在位品牌 Voltaro，
       * 查完 CRM 已有记录之后第二次把它交成了空串 —— 整包覆盖，
       * 于是这条记录的在位品牌没了，而且看起来像「这次客户没提」。
       *
       * jsonb_strip_nulls 去掉这一次的 null，再 || 合并：
       * 有值的键覆盖，没值的键保持原样。真要清空某一格，人在核对卡上改。
       *
       * ⚠️ 空字符串 jsonb_strip_nulls 不管，所以上面用 blank() 先把 "" 变成 null。
       *
       * ⚠️⚠️ **这段注释不能放进下面那个 sql 模板字符串里** ——
       * 里面一旦出现反引号就会提前结束模板串。这个坑仓库里已经踩过三次
       * （admin-page.ts、index.ts 的 SQL 注释、这里），所以注释一律写在外面。
       */
      const storedFields = continuationBasis ? legacyContinuationPatch(continuationBasis.extracted, p, fields) : fields;
      await sql`
        update staging set
          extracted = coalesce(extracted, '{}'::jsonb)
                      || jsonb_strip_nulls(${sql.json(storedFields as never)}),
          confidence = ${continuationBasis ? sql`coalesce(confidence,'{}'::jsonb) || ${sql.json((p.confidence ?? {}) as never)}` : sql`${sql.json((p.confidence ?? {}) as never)}`},
          error = null
        where id = ${ctx.stagingId}`;
      ctx.proposed = true;

      if (p.targetCandidateHandle) {
        try { await bindExplicitCandidate(ctx, String(p.targetCandidateHandle)); }
        catch (error) { return { text: `字段已保存；目标尚未绑定：${(error as Error).message}。`, details: { fields, dropped } }; }
      }
      return {
        text:
          (dropped.length
            ? `已记下。但这些值不在白名单里，被丢弃了：${dropped.join('、')}。` +
              `先调 list_enums 看合法值，或调 search_companies 拿正确的 code。`
            : '已记下，等人核对。') +
          (recordType === 'support' ? '（按**售后问题**入库）' : ''),
        details: { fields, dropped },
      };
    },
  },

  {
    name: 'ask_user',
    label: '问一句',
    description:
      '拿不准时在对话里问销售一句。' +
      '⚠️ 这是给「你确实需要一个答案才能往下走」用的，不是用来寒暄或确认已经清楚的事 —— ' +
      '展会现场每多问一句，销售就少录一条。一轮最多问一个。',
    parameters: Type.Object({
      question: Type.String({ description: '问题，中文，一句话' }),
      options: Type.Optional(
        Type.Array(Type.String(), { description: '给几个可点的选项，省得他打字' }),
      ),
      targetOptions: Type.Optional(Type.Array(Type.Object({
        label: Type.String({ description: '清楚的选项文字，包含候选编号/标题和区别' }),
        candidateHandle: Type.Optional(Type.String({ description: '来自本轮读工具的 candidateHandle；不要传自行编造的UUID' })),
        action: Type.Optional(Type.String({ description: '目标按类型用 append/update/continue；没有目标的出口只能 create（新问题）或 clarify（都不是/补充说明）' })),
      }), { description: '需要关联已有售后/项目/任务/待确认草稿时，传结构化选项；服务端绑定目标而非让下一轮模型猜UUID。' })),
      recommendedIndex: Type.Optional(Type.Integer({ minimum: 0, description: '推荐选项在 targetOptions 中的索引，从0开始。理由必须来自实际检索。' })),
      itemId: Type.Optional(Type.String({ description: '多事项时必须指定这道问题所属的稳定 itemId，来自 propose_records 的返回值。' })),
    }),
    execute: async (input: AgentQuestionInput) => {
      if (ctx.questions.length >= 1) {
        return { text: '这一轮已经问过一个问题了，先把手上的信息记下来吧。' };
      }
      createAgentQuestion(ctx, input);
      /**
       * D73②：字段已经交过一版的话，问出问题就**收工**（terminate）——
       * 剩下的就是等人，再跑几轮也只是空转烧钱。loop 会把这一轮如实记成
       * `waiting_user` 而不是 done；他答了之后带着完整消息史续跑（D73①）。
       *
       * ⚠️ 还没 propose_fields 就想问 → 不收工，并把铁律再顶到它眼前：
       * 「等答案」不是不交字段的理由（那正是 2026-08-03 空白记录事故的形状）。
       */
      if (ctx.proposed) {
        return {
          text: '问题已发给销售。字段交过一版了，这一轮先收在这里 —— 他答了会带着完整上下文继续。',
          terminate: true,
        };
      }
      return { text: '已经把这个问题放进对话里了。⚠️ 别忘了 propose_fields —— 等答案不是不交字段的理由。' };
    },
  },

  {
    name: 'flag_new_company',
    label: '提议新客户',
    description:
      '遇到原文明确提到的客户（OEM、distributor、dealer 或终端客户），但名单里查不到时，提议新建。' +
      '原文明说的国家和客户类型一起带入建议；没有提到就留空，不凭名字、语言或地址猜国家和类型。' +
      '🔴 **只提议，绝不建。** 建客户是人在界面上点的 —— 关系字段只能是已存在的 UUID（§4.2 第3条），' +
      '销售那份 Excel 就是因为用名字做关联键而散架的。',
    parameters: Type.Object({
      name: Type.String({ description: '照原文写，不要改写、不要补全法律后缀' }),
      country_hint: Type.Optional(Type.String({ description: '如果话里提到了国家' })),
      account_type_hint: Type.Optional(Type.String({ description: '仅原文明说的客户类型，取自 list_enums 的 accountType；未说明就留空' })),
      evidence: Type.Optional(Type.String({ description: '凭哪句话判断它是客户' })),
      itemKey: Type.Optional(Type.String({ description: '多事项时可明确指定 propose_records 的事项 key；其它项不继承这个建议。未指定时，事项必须用 suggested_company 明说同一客户名才能带入提示；sourceCompanyName只是消息来源，不代表客户。' })),
    }),
    execute: async ({ name, country_hint, account_type_hint, evidence, itemKey }: Record<string, any>) => {
      const suggestion = companySuggestion(name, { name: typeof name === 'string' ? name.trim() : '', country: country_hint, accountType: account_type_hint });
      if (!suggestion) return { text: '客户名称为空，未提议新建。', details: { rejected: true } };
      name = suggestion.name;
      if (itemKey !== undefined && (typeof itemKey !== 'string' || !itemKey.trim() || itemKey.length > 120)) {
        return { text: 'itemKey 必须是将要提交的明确事项 key（1–120 字）。建议未保存。', details: { rejected: true } };
      }
      if (itemKey && ctx.itemCompanySuggestions?.has(itemKey) && ctx.itemCompanySuggestions.get(itemKey)!.name !== name) {
        return { text: `事项 ${itemKey} 已有另一家客户建议；请明确各事项的归属，不覆盖原建议。`, details: { rejected: true } };
      }
      // 提议之前自己再查一遍 —— 免得它把 "Brückner" 当新客户提上来
      const hits = findSimilar(name, ctx.companies, { limit: 3 });
      if (hits.length) {
        return {
          text:
            `别急着提议新建 ——「${name}」很像名单里已有的：\n` +
            hits.map((h) => `${h.item.code} = ${h.item.name}（相似度 ${h.score.toFixed(2)}）`).join('\n'),
          details: { rejected: true, hits },
        };
      }
      ctx.suggestedCompany = name;
      rememberCompanySuggestion(ctx, suggestion, itemKey);
      // Persist the hints in the existing JSON proposal; no CRM write or schema migration.
      await sql`update staging set suggested_company = ${name},
        extracted = coalesce(extracted, '{}'::jsonb) || ${sql.json({ companySuggestion: suggestion } as never)}
        where id = ${ctx.stagingId}`;
      return {
        text: `已提议新客户「${name}」${country_hint ? `（${country_hint}）` : ''}，等人在界面上确认。` +
          (itemKey ? `多事项仅 ${itemKey} 使用此建议。` : `多事项中请在对应项 fields.suggested_company 写「${name}」；sourceCompanyName不代表客户，其它项不借用此建议。`),
        details: { name, country_hint, evidence },
      };
    },
  },
];
