import { Type } from '@earendil-works/pi-ai';

import { sql } from '../host.ts';
import {
  findProjectByCode,
  getCompanyByCode,
  listProjectDocs,
  listProjects,
  listWorkItems,
  pendingProjectProposals,
  reserveProjectCode,
  searchProjects,
} from '../host.ts';
import {
  DOC_SOURCES,
  DOC_SOURCE_LABELS,
  ITEM_STATUSES,
  PRIORITIES,
  THREAD_TYPES,
  keepDocSource,
  keepItemStatus,
  keepPriority,
  keepStage,
  keepThreadType,
} from '../enums.ts';
import type { Skill } from '../runtime.ts';
import type { SkillContext } from './context.ts';

/**
 * D59 —— 定点之后那条链：**项目 · 任务线程 · 项目文档**。
 *
 * 🔴 **仍然全在 Ring 2：只写 `staging`，一个字都不进 CRM。**
 * 加了三个对象不等于放松边界 —— 人在核对卡上按那一下之前，
 * Twenty 里什么都不会发生（Ring 3 的清单一条没变）。
 *
 * 为什么要单独一个文件：这三个工具是一组，改「项目怎么建」时
 * 不该翻到「怎么造情报字段」那段代码里去。
 */

/** 把一份提案存进 `staging.extracted` 的某个键下。后一次覆盖前一次。 */
const stash = async (ctx: SkillContext, key: string, value: unknown) => {
  await sql`
    update staging
    set extracted = coalesce(extracted, '{}'::jsonb) || ${sql.json({ [key]: value } as never)}
    where id = ${ctx.stagingId}`;
};

export const projectSkills = (ctx: SkillContext): Skill[] => [
  // ── Ring 1 · 只读 ────────────────────────────────────────────────
  {
    name: 'get_projects',
    label: '这家有哪些项目',
    description:
      '看已有的项目：编号、名称、阶段，以及每个项目下面的任务线程和文档。' +
      '🔴 **要建项目之前必须先调它** —— 同一个项目编号只能有一条记录，' +
      '客户说「更新 HYM-BAT-2027-001」时你要接的是那一条，不是新开一个。' +
      '**客户还没对上号也照样调** —— 这时候把 `query` 填上（项目名或编号的一部分），' +
      '它会全库找。「这是新项目还是已有项目」是必须回答的问题，不能靠猜。',
    parameters: Type.Object({
      code: Type.Optional(Type.String({ description: '客户代号，来自 search_companies。对不上号就别填' })),
      query: Type.Optional(
        Type.String({ description: '项目名或编号的一部分，如「CI-Bus」「HYM-BAT」。没有客户代号时用它全库找' }),
      ),
    }),
    /**
     * 🔴 **`code` 从必填改成可选**（issue #17 根因 C，2026-08-05）。
     *
     * 原来它要一个**已经匹配上的**客户代号。而 维护者 实测的那条 CI-Bus 速记
     * 恰恰是「新项目 + 客户没对上号」—— 于是 agent **没有任何办法**判断
     * 这是不是新项目，只能猜。而 prompt 里明明写着「先 get_projects 看编号在不在」。
     *
     * **指令给了、能力没给**，是这个仓库反复踩的形状。
     * 现在两条路都通：有代号看这家的，没代号按名字/编号全库找。
     * 两条都没有时，工具**自己把下一步说出来**（去问一句）——
     * 比在 prompt 里多写一段有效得多。
     */
    execute: async ({ code, query }: { code?: string; query?: string }) => {
      let projects: Awaited<ReturnType<typeof listProjects>> = [];
      let scope = '';
      /**
       * 🔴 **还没入库的提案也要交出去**（D91 · issue #18）。
       * CRM 里查不到不等于不存在 —— 同一个项目的上一条对话可能还在等人确认，
       * 它已经拿到编号了（`propose_project` 提案时就取号）。
       * 不给的话，这一轮只能开一个新号，或者（实测过）抓一个名字沾边的
       * **别家客户**的项目编号来用。
       */
      const pending = code
        ? await pendingProjectProposals(code, ctx.stagingId).catch(() => [])
        : [];
      const pendingLines = pending.length
        ? [
            '',
            '⏳ **这家还有还没入库的项目提案**（上一条对话提的，正等人确认）：',
            ...pending.map(
              (p) =>
                `· **${p.code}** ${p.name ?? '（没写名字）'}` +
                (p.category ? ` —— 品类 ${p.category}` : '') +
                '（**待确认，CRM 里还没有**）',
            ),
            '🔴 说的是同一个项目就**传同一个编号**，别开新的 —— 同一家客户 + 同一个品类 = 同一个项目。',
          ]
        : [];
      if (code) {
        const company = await getCompanyByCode(code);
        if (!company) return { text: `没有代号为 ${code} 的客户。` };
        projects = await listProjects(company.id).catch(() => []);
        scope = `${code} 名下`;
      } else if (query) {
        projects = await searchProjects(query).catch(() => []);
        scope = `全库匹配「${query}」的`;
      } else {
        return {
          text:
            '两个参数都没给 —— 要么给 code（客户对上号了），要么给 query（项目名/编号的一部分）。\n' +
            '🔴 如果客户和项目名你都不确定，**用 ask_user 问一句**「这是新项目还是要更新已有项目？」——' +
            '这个问题猜错的代价是：新项目被记成对已有项目的修改，或者反过来多出一个重复项目。',
        };
      }
      if (!projects.length) {
        return {
          text:
            [
              `${scope}CRM 里没有项目。`,
              ...pendingLines,
              pending.length
                ? '和上面那些都对不上才是新项目 —— 编号留空，`propose_project` 会向网关要一个（D91）。'
                : '**按新项目处理**：原话里给了编号就照抄，没给就留空，`propose_project` 会当场向网关要一个（D91）。',
            ].join('\n'),
          details: { projects: 0, pending: pending.length, isNew: !pending.length },
        };
      }
      const lines: string[] = [];
      /**
       * 🔴 全库模糊查出来的项目必须标明**属于哪家客户**（T51 场景实测）：
       * 不标的话，模型看到一个名字相近的项目就把编号拿来复用 ——
       * 而那可能是**另一家客户**的项目。编号只在同一家客户名下才意味着同一个项目。
       */
      const companyById = new Map(ctx.companies.map((c) => [c.id, c.code || c.name]));
      if (query && !code) {
        lines.push(
          '⚠️ 下面是**全库**按名字/编号模糊匹配的结果 —— 先看每条属于哪家客户：',
          '**属于别家客户的项目不是同一个项目，绝不要复用它的编号。**',
          '这条速记的客户名下没有匹配时，按新项目处理（编号留空）。',
        );
      }
      for (const p of projects) {
        const owner = companyById.get(p.companyId ?? '') ?? '归属未知';
        lines.push(`· **${p.projectCode}** ${p.name} —— 阶段 ${p.projectStage || '未填'} · 客户：${owner}`);
        const [items, docs] = await Promise.all([
          listWorkItems(p.id).catch(() => []),
          listProjectDocs(p.id).catch(() => []),
        ]);
        for (const w of items) {
          lines.push(`    ↳ ${w.itemCode} ${w.name}（${w.threadType}·${w.itemStatus}）`);
        }
        for (const d of docs) {
          lines.push(`    📄 ${d.name} ${d.version}（${DOC_SOURCE_LABELS[d.docSource] ?? d.docSource}）`);
        }
      }
      lines.push(...pendingLines);
      return { text: lines.join('\n'), details: { projects: projects.length, pending: pending.length } };
    },
  },

  // ── Ring 2 · 写提案 ──────────────────────────────────────────────
  {
    name: 'propose_project',
    label: '提议建/更新项目',
    description:
      '客户定点之后要建项目，或者要更新一个已有项目时用它。' +
      '**先 get_projects 看编号在不在** —— 在就是更新（传同一个 projectCode），不在才是新建。' +
      '⚠️ 只提议，人在核对卡上确认之后才真的进 CRM。',
    parameters: Type.Object({
      projectCode: Type.String({
        description:
          '项目编号，如 HYM-BAT-2027-001。**原话里给了就照抄**，没给就留空 —— ' +
          '网关会当场给一个真编号并写在回复里（D91），**不要自己编**。',
      }),
      name: Type.String({ description: '项目名称，照原话' }),
      companyCode: Type.Optional(Type.String({ description: '客户代号，来自 search_companies' })),
      projectStage: Type.Optional(
        Type.String({ description: '项目阶段，取自 list_enums 的 stage（定点=NOMINATED）' }),
      ),
      ownerTeam: Type.Optional(Type.String({ description: '负责团队，如「欧洲 OE 项目团队」' })),
      budgetEur: Type.Optional(Type.Number({ description: '项目预算，欧元整数（840 万 → 8400000）' })),
      primaryProductName: Type.Optional(Type.String({ description: '核心产品型号，如 VLB12150-CIBUS' })),
      sampleQty: Type.Optional(Type.Number({ description: '样品数量。只有明确说了数字才填' })),
      plannedSop: Type.Optional(Type.String({ description: '计划 SOP，YYYY-MM-DD' })),
      specSummary: Type.Optional(
        Type.String({
          description:
            '关键参数摘要，markdown。附件里的电气/通信/机械/环境/测试参数**逐条转录**，别压缩。',
        }),
      ),
      /**
       * 🔴 test_example T03 的核心断言：
       * 「未提供的通信波特率、连接器、尺寸、重量、认证等被列为待确认」
       * 「不要自行补成客户已确认参数」。
       */
      openQuestions: Type.Optional(
        Type.String({
          description:
            '**待确认事项**，一行一条。客户没说、双方没定的都放这里。' +
            '🔴 **绝不要把没说的东西编成已确认的参数** —— 宁可这一栏长，也不要正文里出现一个客户没说过的数。',
        }),
      ),
    }),
    execute: async (p: Record<string, any>) => {
      const codes = new Set(ctx.companies.map((c) => c.code));
      const name = String(p.name ?? '').trim() || null;
      // 名字都没有就别往下走 —— 下面要去取一个真编号，不能为一份空提案占号
      if (!name) return { text: '项目至少要有个名字。' };

      /**
       * 🔴 **「不要自己编编号」的执行机制**（T51 场景 T07 实测：光写在手册里拦不住，
       * 模型两轮都用「客户代号-001」编了一个）。判据 —— 同时满足四条才算「编的」：
       *   ① 编号非空；② CRM 里不存在（存在 = 合法的更新场景，比如阶段推进）；
       *   ③ 原文（正文/转写/人改稿/本地解析的附件文本）里找不到；
       *   ④ 没有原生直通的附件（那些内容本地看不见，验证不了的不冤枉）。
       * 判成「编的」→ 置空 + 回复里明说。留空是正确行为：网关会生成建议编号。
       * ⚠️ 合法编号**逐字照抄，连大小写都不动**（T02 断言）：编号是幂等的支点。
       */
      let projectCode = String(p.projectCode ?? '').trim() || null;
      let inventedNote = '';

      /**
       * 🔴 **别家客户的编号，一律不许用**（D91 追加，2026-08-07 浏览器实测抓到）。
       *
       * 实测那一轮：Havel 的第二条速记（补时间线），CRM 里查不到 Havel 的项目
       * （第一条还在待确认），模型就把一个名字沾边的**测试客户**的项目编号
       * `SC-BAT-…-001` 拿来用了。手册里那句「属于别家客户的项目不是同一个项目」
       * 一个字没错，但它只是**写着**，没有任何东西执行它。
       *
       * 判据是硬的：编号在 CRM 里存在，但那个项目挂在**另一家客户**名下 → 置空，
       * 然后走下面的取号。挂在同一家 = 合法的更新（阶段推进、补参数），照原样放行。
       * 客户还没对上号时不判（比不出来，不冤枉）。
       *
       * ⚠️ 这条比「编号是编的」那条更狠：编一个不存在的编号，后果只是多一个项目；
       * 用**别人的**编号，后果是这条速记入库时 **PATCH 掉别人的项目** —— 数据被改，
       * 而界面上一路绿色。
       */
      const hit = projectCode ? await findProjectByCode(projectCode).catch(() => null) : null;
      if (hit) {
        const [cur] = await sql<Array<{ company_code: string | null }>>`
          select nullif(extracted->>'companyCode', '') as company_code
            from staging where id = ${ctx.stagingId}`;
        const mineCode =
          (p.companyCode && codes.has(p.companyCode) ? String(p.companyCode) : null) ??
          cur?.company_code ??
          null;
        const mineId = mineCode ? ctx.companies.find((c) => c.code === mineCode)?.id : null;
        if (mineId && hit.companyId && hit.companyId !== mineId) {
          const owner =
            ctx.companies.find((c) => c.id === hit.companyId)?.name ?? '另一家客户';
          inventedNote =
            `\n⚠️ 编号「${projectCode}」在 CRM 里属于**${owner}**的项目「${hit.name}」，` +
            `而这条速记记在 ${mineCode} 名下 —— 那不是同一个项目，已留空并另取了一个。`;
          projectCode = null;
        }
      }

      if (projectCode && !hit) {
        const [src] = await sql<
          Array<{ blob: string | null; natives: number }>
        >`select concat_ws(' ', i.text, s.transcript, s.edited_text,
                   (select string_agg(t.text, ' ') from attachment a
                     join attachment_text t on t.attachment_id = a.id
                    where a.inbox_id = i.id and t.status <> 'native')) as blob,
                 (select count(*)::int from attachment a
                   join attachment_text t on t.attachment_id = a.id
                  where a.inbox_id = i.id and t.status = 'native') as natives
          from inbox i join staging s on s.inbox_id = i.id
          where i.id = ${ctx.inboxId}`;
        const norm = (s: string) => s.toUpperCase().replace(/[\s-]+/g, '');
        const seen = norm(src?.blob ?? '').includes(norm(projectCode));
        if (!seen && !(src?.natives ?? 0)) {
          inventedNote =
            `\n⚠️ 你给的编号「${projectCode}」原话里没有、CRM 里也不存在 —— 看起来是编的，已留空。` +
            '人在核对卡上会看到网关生成的建议编号。';
          projectCode = null;
        }
      }

      /**
       * 🔴 **没有编号就当场要一个 —— 在提案这一刻，不是入库那一刻**（D91 · issue #18）。
       *
       * 以前留空是有意的：编号由网关在 `commitToTwenty` 里兜底生成。
       * 代价是**待确认阶段没有任何稳定的项目标识**，于是「早上录一条需求、
       * 下午另开一条对话补时间线」这两条 staging，在看板上没有键可以并成一个项目。
       * 而用项目名当键是 §4.2 第 3 条明令禁止的（销售那份 Excel 就是这么散架的）。
       *
       * 判「是不是同一个项目」用 D56：**客户 + 品类**。品类从这条速记已经抽出来的
       * 字段里读（`propose_fields` 可能已经跑过），读不到就退回同名 ——
       * 全部判断在 `src/projectCode.ts` 里，三个调用点共用同一份。
       *
       * ⚠️ **客户还没对上号就不发号。** 编号的前缀就是客户代号，
       * 这时候发出去的号迟早是错的；人在核对卡上选完客户还能拿到一个建议编号。
       */
      let reused = false;
      if (!projectCode) {
        const [cur] = await sql<Array<{ company_code: string | null; category: string | null }>>`
          select nullif(extracted->>'companyCode', '') as company_code,
                 nullif(extracted->>'category', '')    as category
            from staging where id = ${ctx.stagingId}`;
        const companyCode =
          (p.companyCode && codes.has(p.companyCode) ? String(p.companyCode) : null) ??
          cur?.company_code ??
          null;
        const got = await reserveProjectCode(ctx.stagingId, {
          companyCode,
          category: cur?.category ?? null,
          name,
        }).catch(() => null);
        if (got) {
          projectCode = got.code;
          reused = got.reused;
        }
      }

      const proposal = {
        projectCode,
        name,
        companyCode: p.companyCode && codes.has(p.companyCode) ? p.companyCode : null,
        projectStage: keepStage(p.projectStage),
        ownerTeam: p.ownerTeam ?? null,
        budgetEur:
          Number.isFinite(p.budgetEur) && p.budgetEur > 0 ? Math.round(p.budgetEur) : null,
        primaryProductName: p.primaryProductName ?? null,
        sampleQty: Number.isInteger(p.sampleQty) && p.sampleQty > 0 ? p.sampleQty : null,
        plannedSop: /^\d{4}-\d{2}-\d{2}$/.test(String(p.plannedSop ?? '')) ? p.plannedSop : null,
        specSummary: p.specSummary ?? null,
        openQuestions: p.openQuestions ?? null,
      };
      await stash(ctx, 'project', proposal);
      ctx.proposed = true;
      return {
        text:
          `已记下项目提案「${proposal.name}」` +
          (proposal.projectCode
            ? `（编号 ${proposal.projectCode}${reused ? ' —— 这家客户这个品类已经有一条提案在用它，接到同一个项目上' : ''}）`
            : '（**没有编号** —— 客户还没对上号，人在核对卡上选完客户会拿到一个）') +
          '，等人核对。' +
          inventedNote,
        details: { ...proposal, codeReused: reused },
      };
    },
  },

  {
    name: 'propose_work_items',
    label: '拆成可分派的任务线程',
    description:
      '把一次跟进里的复合需求拆成几条**可以分别派给不同人、分别跟踪**的线程。' +
      '典型场景（test_example T04）：客户要「端口说明 + Pin 定义 + 协议说明 + 测试代码」，' +
      '这是四条线 —— 文档、硬件接口、通信协议、测试软件，负责人和截止日期都不同。' +
      '🔴 **一次全部提交**（这个工具接数组），不要一条一条调。' +
      '里程碑也用它（threadType=milestone）。',
    parameters: Type.Object({
      items: Type.Array(
        Type.Object({
          itemCode: Type.String({ description: '线程编号，如 HYM-CIBUS-01。原话给了就照抄，没给就按 <项目编号>-01 这样编' }),
          title: Type.String({ description: '一句话标题' }),
          threadType: Type.String({ description: 'doc / hardware / protocol / software / milestone / other' }),
          body: Type.Optional(Type.String({ description: '具体要做什么，markdown。把客户原文里的要求逐条列出来' })),
          priority: Type.Optional(Type.String({ description: 'URGENT / HIGH / MEDIUM / LOW' })),
          ownerRole: Type.Optional(Type.String({ description: '负责角色，如「硬件工程团队」。是角色不是人名' })),
          dueDate: Type.Optional(Type.String({ description: '内部截止日期 YYYY-MM-DD' })),
          customerDueDate: Type.Optional(
            Type.String({ description: '客户期望日期 YYYY-MM-DD。**和内部截止分开** —— 两个都要留' }),
          ),
          blockedByCodes: Type.Optional(
            Type.String({ description: '依赖哪几条，写编号，逗号分隔，如「HYM-CIBUS-02, HYM-CIBUS-03」' }),
          ),
          openQuestions: Type.Optional(
            Type.String({ description: '这条线上客户还没给的东西。**未知就写未知，不要编**' }),
          ),
        }),
        { description: '一次跟进拆出来的全部线程' },
      ),
      projectCode: Type.Optional(
        Type.String({ description: '这些线程挂在哪个项目下（编号）。来自 get_projects' }),
      ),
    }),
    execute: async (p: Record<string, any>) => {
      const raw = Array.isArray(p.items) ? p.items : [];
      const items = raw
        .map((it: any) => ({
          itemCode: String(it?.itemCode ?? '').trim(),
          title: String(it?.title ?? '').trim(),
          threadType: keepThreadType(it?.threadType),
          body: it?.body ?? null,
          priority: keepPriority(it?.priority),
          ownerRole: it?.ownerRole ?? null,
          dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(it?.dueDate ?? '')) ? it.dueDate : null,
          customerDueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(it?.customerDueDate ?? ''))
            ? it.customerDueDate
            : null,
          itemStatus: keepItemStatus(it?.itemStatus),
          blockedByCodes: it?.blockedByCodes ?? null,
          openQuestions: it?.openQuestions ?? null,
        }))
        .filter((it: any) => it.itemCode && it.title);

      if (!items.length) return { text: '没有可用的线程 —— 每条至少要有编号和标题。' };
      // 编号重复的只留第一条：同一个编号出现两次，后面那条一定是模型手滑
      const seen = new Set<string>();
      const uniq = items.filter((it: any) => !seen.has(it.itemCode) && seen.add(it.itemCode));

      await stash(ctx, 'workItems', uniq);
      await stash(ctx, 'projectCode', String(p.projectCode ?? '').trim() || null);
      ctx.proposed = true;
      return {
        text:
          `已拆成 ${uniq.length} 条线程：\n` +
          uniq
            .map((it: any) => `· ${it.itemCode} ${it.title}（${it.threadType} · ${it.priority}）`)
            .join('\n'),
        details: { count: uniq.length },
      };
    },
  },

  {
    name: 'propose_document',
    label: '生成一份文档',
    description:
      '客户没给文档、但说了一堆参数时，把它整理成一份**可以继续维护的文档**。' +
      '也用于把客户给的附件登记成项目的需求基线。' +
      '🔴 **`docSource` 必须如实填** —— AI 整理的写 DICTATION/AGENT_GENERATED，' +
      '客户给的附件写 CUSTOMER_ATTACHMENT。' +
      '把 AI 整理的标成客户提供的，是这套系统里最贵的一种错：' +
      '后面会有人拿这份参数去下单。',
    parameters: Type.Object({
      name: Type.String({ description: '文档名，如「Havel 口述需求整理」' }),
      docSource: Type.String({
        description:
          'CUSTOMER_ATTACHMENT = 客户给的附件；DICTATION = 按销售口述整理；' +
          'AGENT_GENERATED = 你自己生成的；INTERNAL = 我方内部写的。**如实填**。',
      }),
      version: Type.Optional(
        Type.String({ description: '版本。客户基线一般 v1.0，你整理的一般 v0.1' }),
      ),
      docCode: Type.Optional(Type.String({ description: '文档编号，附件里有就照抄' })),
      isBaseline: Type.Optional(
        Type.Boolean({ description: '是不是项目需求基线（客户正式给的规格书才是）' }),
      ),
      content: Type.String({
        description:
          '文档正文，markdown。' +
          '🔴 按口述整理的，**开头必须写明「根据口述整理，未经客户书面确认」**，' +
          '并且把没提到的项单列一段「待客户确认」——**不要补成已确认参数**。',
      }),
      attachmentId: Type.Optional(
        Type.String({ description: '如果这份文档就是某个附件，填那个附件的 id' }),
      ),
    }),
    execute: async (p: Record<string, any>) => {
      const content = String(p.content ?? '').trim();
      if (!content) return { text: '文档没有正文就不用建。' };
      const docSource = keepDocSource(p.docSource);
      const doc = {
        name: String(p.name ?? '').trim() || '未命名文档',
        docSource,
        version: String(p.version ?? '').trim() || (docSource === 'CUSTOMER_ATTACHMENT' ? 'v1.0' : 'v0.1'),
        docCode: p.docCode ?? null,
        isBaseline: p.isBaseline === true,
        content,
        attachmentId: p.attachmentId ?? null,
      };
      await stash(ctx, 'document', doc);
      ctx.proposed = true;
      return {
        text:
          `已生成文档「${doc.name}」${doc.version}（来源：${DOC_SOURCE_LABELS[docSource]}）。` +
          (docSource === 'CUSTOMER_ATTACHMENT'
            ? ''
            : '**入库时会标成草稿** —— 「客户已确认」只有人能给。'),
        details: doc,
      };
    },
  },
];

/** 给 `list_enums` 用：D59 这几个枚举的合法值。 */
export const projectEnumHelp = (): string =>
  [
    `线程类型 threadType：${THREAD_TYPES.join(' / ')}`,
    `优先级 priority：${PRIORITIES.join(' / ')}`,
    `线程状态 itemStatus：${ITEM_STATUSES.join(' / ')}`,
    `文档来源 docSource：${DOC_SOURCES.join(' / ')}`,
  ].join('\n');
