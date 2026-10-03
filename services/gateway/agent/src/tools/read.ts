import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Type } from '@earendil-works/pi-ai';

import { env, sql } from '../host.ts';
import { findSimilar } from '../host.ts';
import { playbook, playbookNames } from '../skills.ts';
import { contextualPlaybook } from '../prompt.ts';
import {
  getCompanyByCode,
  listIntelItems,
  listIntelValues,
  listOpportunities,
  listProductFitments,
  readCompanyTargetCandidates,
  registerCandidates,
  candidateText,
} from '../host.ts';
import { computeGaps } from '../host.ts';
import {
  ACCOUNT_TYPES,
  CASE_STATUSES,
  CATEGORIES,
  RECORD_TYPES_V2,
  RECORD_TYPE_LABELS,
  SEVERITIES,
  STAGES,
  VALUE_TYPES,
} from '../enums.ts';
import type { Skill } from '../runtime.ts';
import { projectEnumHelp } from './project.ts';
import type { SkillContext } from './context.ts';

/**
 * Ring 1 —— **只读，随便用**。
 *
 * 这一圈没有任何副作用，所以设计上不设配额、不劝它省着点用：
 * 让它把话说准，需要多少上下文就给多少。真正的边界在 Ring 2 和 Ring 3。
 */

export const readSkills = (ctx: SkillContext): Skill[] => [
  /**
   * 标准 SKILL.md 的「拉」半边（D72）。
   *
   * ⚠️ 参数是 **name 不是文件路径** —— 路径类工具违反「工具清单=能力边界」：
   * 参数一旦是路径，「读哪个文件」就变成模型说了算。这里只查内存里的 map，
   * 模型拿不到文件系统。
   */
  {
    name: 'read_skill',
    label: '翻手册',
    description:
      '读一本 playbook 的全文。系统提示词的 <available_skills> 列了有哪些 —— ' +
      '判断出记录类型后，**先读对应那本再动手**（project/followup 读 project，' +
      '售后读 support，选型读 fitment，带附件读 attachment）。参数是手册名，不是文件路径。',
    parameters: Type.Object({
      name: Type.String({ description: '手册名，如 "project"。来自 <available_skills> 的 <name>' }),
    }),
    execute: async ({ name }: { name: string }) => {
      if (!playbook(name)) {
        const have = playbookNames();
        return {
          text: have.length
            ? `没有叫「${name}」的手册。现有：${have.join(' / ')}。`
            : '手册库是空的（playbook 没加载成功）—— 按系统提示词里的铁律直接干。',
        };
      }
      return { text: contextualPlaybook(ctx, name) };
    },
  },

  {
    name: 'search_companies',
    label: '查客户',
    description:
      '按名字或代号模糊查已有客户。查得到就用返回的 code，查不到再考虑 flag_new_company。' +
      '匹配会自动折叠变音符与法律后缀（Brückner / Bruckner / Brueckner 是同一家）。',
    parameters: Type.Object({
      query: Type.String({ description: '客户名或代号，照你听到的原样写' }),
      limit: Type.Optional(Type.Number({ description: '最多返回几个，默认 5' })),
    }),
    execute: async ({ query, limit }: { query: string; limit?: number }) => {
      const hits = findSimilar(query, ctx.companies, { limit: Math.min(limit ?? 5, 10) });
      if (!hits.length) {
        return { text: `没有匹配「${query}」的客户。名单里一共 ${ctx.companies.length} 家。` };
      }
      // 「我记过几条」是给它判断熟不熟的：老客户可以直接补，新客户要问得细一点
      const codes = hits.map((h) => h.item.code);
      const counts = await sql<Array<{ company_code: string; n: string }>>`
        select company_code, count(*)::text as n from inbox
        where company_code = any(${codes}) group by company_code`;
      const seen = new Map(counts.map((c) => [c.company_code, c.n]));

      return {
        text: hits
          .map(
            (h) =>
              `${h.item.code} = ${h.item.name}` +
              `${h.item.group ? ` · 属于 ${h.item.group}` : ''}` +
              `${h.item.type ? ` · ${h.item.type}` : ''}` +
              ` · 已记 ${seen.get(h.item.code) ?? 0} 条` +
              ` · 相似度 ${h.score.toFixed(2)}`,
          )
          .join('\n'),
        details: hits,
      };
    },
  },

  {
    name: 'get_thread',
    label: '看这条对话之前说过什么',
    description:
      '读当前这条对话的全部历史。**续写时必须先读** —— 否则「他们年产 12000 台」会被当成一句孤零零的话。\n' +
      /**
       * 🔴 这段说明是这个工具的一半（D108 · issue #37）。
       * 模型看到「3000W」和「2000W」两句话时，**它没有任何办法知道第一句已经作废** ——
       * 而那正是 Movara 那次 CRM 里两版并存的直接原因：它同时用
       * `get_company_records` 读到 CRM 里那条 3000W 还活着，
       * 于是「追加一条」是**在两个信息源都说它还活着的前提下的合理推理**。
       */
      '标着 [已撤回] 的那几句，说话人**自己撤回了**（他后来改了口）：' +
      '不要把它们当成事实，凡是以它们为准的结论都要按最新那一句重算。' +
      '如果那句话此前已经进过 CRM，这一轮是**更正**不是追加 —— ' +
      '照常提出你的抽取结果，系统会去改写原来那几条记录，不会新建第二份。',
    // ⚠️ 故意不收 thread_id 参数。
    // 计划里原本写的是 get_thread(thread_id)，改掉的理由是作用域：
    // 参数一旦可由模型指定，「读哪条对话」就变成模型说了算，
    // 而作用域过滤必须在服务端（§4.2 第4条）。这里绑死当前这一条。
    parameters: Type.Object({}),
    execute: async () => {
      if (!ctx.threadId) return { text: '这是一条新对话，之前没有内容。' };
      /**
       * 🔴 **撤回的那几句要标出来，而不是过滤掉**（D108 · issue #37）。
       *
       * 两条路都试过，标出来严格更好：本地那次 Alpin→Rosenfeld，
       * 模型正因为看见了老消息才写出「更正：Alpin → Rosenfeld」——
       * 过滤掉的话它只看到最新一句，产出的是一条平铺直叙的新情报，
       * 「这是一次更正」这个信息就丢了。
       *
       * 缺的从来不是那句话，是那句话**旁边的一格状态**。
       *
       * ⚠️ 只对模型这样做。`GET /threads/:id`（给人看的那份）**照常返回全文**，
       *    D90 的判据没变：取代 ≠ 删除，原话一个字没动。
       */
      const rows = await sql<Array<{ role: string; text: string; retracted: boolean }>>`
        select m.role, m.text, (ms.message_id is not null) as retracted
        from thread_message m
        left join message_supersede ms on ms.message_id = m.id
        where m.thread_id = ${ctx.threadId} order by m.created_at limit 100`;
      if (!rows.length) return { text: '这条对话还没有内容。' };
      const retracted = rows.filter((r) => r.retracted).length;
      const body = rows
        .map((r) => `[${r.role === 'user' ? '销售' : 'AI'}${r.retracted ? ' · 已撤回' : ''}] ${r.text}`)
        .join('\n');
      return {
        // 末尾再说一次 —— 一句话的成本，换的是模型不把撤回的话当成事实
        text: retracted
          ? `${body}\n\n（上面有 ${retracted} 句标着「已撤回」：说话人自己改了口，不要按它们下结论。）`
          : body,
        details: { count: rows.length, retracted },
      };
    },
  },

  {
    name: 'get_company_gaps',
    label: '这家还缺哪些情报',
    description:
      '看这家客户的情报清单里哪些项从来没人填过。' +
      '用途：顺口提醒销售今天可以顺便问一句。这是这套系统区别于一个录音笔的地方。',
    parameters: Type.Object({
      code: Type.String({ description: '客户代号，来自 search_companies' }),
    }),
    execute: async ({ code }: { code: string }) => {
      const company = await getCompanyByCode(code);
      if (!company) return { text: `没有代号为 ${code} 的客户。` };

      // 🔴 和 `/gaps` 端点**共用同一个 computeGaps**。
      //    以前这里是自己抄了一遍，两份实现迟早算出两个不同的完整度，
      //    而分歧的表现是「界面说 40%、agent 说还缺 3 项」—— 两个都不报错。
      const items = await listIntelItems();
      const values = await listIntelValues(company.id);
      const g = computeGaps(items, values, company);

      if (!g.totalItems) return { text: '情报清单还没有配置任何项。' };
      if (!g.missing.length) return { text: `${code} 的情报清单已经填满了。` };
      return {
        text:
          `${code} 还缺 ${g.missing.length} 项（完整度 ${g.completeness ?? '—'}%），该问的排在前面：\n` +
          g.missing
            .slice(0, 12)
            .map((m) => `· ${m.key} —— ${m.question}（第 ${m.wave ?? '?'} 次拜访问）`)
            .join('\n'),
        details: { total: g.totalItems, missing: g.missing.length, completeness: g.completeness },
      };
    },
  },

  /**
   * 手册 P12：「**它认出这家跟过 · 历史它自己查 · 阶段往前推一格**」。
   *
   * 在这个工具之前，agent 手上没有任何办法看到这家客户在 CRM 里已经有什么 ——
   * `get_company_gaps` 只回答「情报清单还缺哪几项」。
   * 于是「阶段往前推一格」是**靠猜的**：它不知道现在在哪一格，
   * 只能从这一句话里读出一个绝对值。人在核对卡上看到的是一个凭空的阶段，
   * 而不是「从 RFQ 推到整车验证」。
   *
   * 只读，Ring 1。它看得到的是 CRM 里已经确认过的东西 ——
   * 别人还没确认的 staging 一概看不到（那些还不是事实）。
   */
  {
    name: 'get_company_records',
    label: '这家已经有什么记录',
    description:
      '看这家客户在 CRM 里**已经有的**记录：在推进的项目（含当前阶段）、' +
      '在位品牌与型号、还没关掉的售后问题。' +
      '用途：① 判断这次该把阶段往前推到哪一格（而不是凭空给一个）；' +
      '② 判断这条售后是不是已有问题的新进展；' +
      '③ 避免把已经记过的在位品牌再报一遍。' +
      '**跟过的客户，动 stage 之前先调它。**',
    parameters: Type.Object({
      code: Type.String({ description: '客户代号，来自 search_companies' }),
      query: Type.Optional(Type.String({ description: '已有工单/项目/任务编号、标题或关键词，缩小候选；明确编号允许查到已关闭工单并显示其实际状态。' })),
    }),
    execute: async ({ code, query }: { code: string; query?: string }) => {
      const company = await getCompanyByCode(code);
      if (!company) return { text: `没有代号为 ${code} 的客户。` };

      const [oppsRead, fitsRead, candidates] = await Promise.all([
        listOpportunities(company.id).then((rows) => ({ ok: true as const, rows })).catch(() => ({ ok: false as const, rows: [] })),
        listProductFitments(company.id).then((rows) => ({ ok: true as const, rows })).catch(() => ({ ok: false as const, rows: [] })),
        readCompanyTargetCandidates(company.id, code, ctx.userId, ctx.stagingId, query),
      ]);
      const opps = oppsRead.rows;
      const fits = fitsRead.rows;
      registerCandidates(ctx, Object.values(candidates));

      const lines: string[] = [];
      if (opps.length) {
        lines.push('在推进的项目：');
        for (const o of opps) {
          lines.push(
            `· ${o.category ?? '未分品类'} —— 当前阶段 **${o.stage || '未填'}**` +
              (o.nextDecisionWindow ? `，决策窗口 ${o.nextDecisionWindow}` : ''),
          );
        }
      }
      if (fits.length) {
        lines.push('已记过的在位品牌：');
        for (const p of fits.slice(0, 12)) {
          lines.push(
            `· ${p.category ?? '?'}：${p.supplier ?? '（没记品牌）'}${p.modelName ? ` ${p.modelName}` : ''}` +
              `（${p.confidence || '?'}）`,
          );
        }
      }
      if (!oppsRead.ok) lines.push('商机检索失败，不能据此认定没有项目。');
      if (!fitsRead.ok) lines.push('在位品牌检索失败，不能据此认定没有记录。');
      lines.push(candidateText('售后关联候选（先看故障差异，不按同SKU/最近一条自动合并）：', candidates.supportCases));
      lines.push(candidateText('项目关联候选：', candidates.projects));
      lines.push(candidateText('任务线程关联候选：', candidates.workItems));
      lines.push(candidateText('自己的待确认事项候选：', candidates.pending));
      lines.push('候选 handle 只能用于本轮。推荐但原话没指定编号时用 ask_user(targetOptions)，并提供 create/clarify 出口；明确编号用当前提案工具的 targetCandidateHandle 预填。选择只改提案，确认入库仍由人决定。');
      return {
        text: lines.join('\n'),
        details: { opportunities: opps.length, fitments: fits.length, searches: candidates, opportunityReadOk: oppsRead.ok, fitmentReadOk: fitsRead.ok },
      };
    },
  },

  {
    name: 'read_attachment',
    label: '读附件',
    description:
      '重看某个附件。原生附上的图片会**原图**再给你一次；' +
      '原生附上的文档内容已经在消息里，不用重取；走了本地解析的附件返回抽出的文字。',
    parameters: Type.Object({
      attachment_id: Type.String({ description: '附件 ID，来自这条速记的附件列表' }),
    }),
    execute: async ({ attachment_id }: { attachment_id: string }) => {
      const [row] = await sql<
        Array<{
          status: string | null;
          text: string | null;
          truncated: boolean | null;
          filename: string;
          path: string;
          mime: string | null;
        }>
      >`select t.status, t.text, t.truncated, a.filename, a.path, a.mime
        from attachment a left join attachment_text t on t.attachment_id = a.id
        where a.id = ${attachment_id} and a.inbox_id = ${ctx.inboxId}`;
      // 限定 inbox_id：附件 ID 是模型给的，不能让它读到别人那条速记的附件
      if (!row) return { text: '没有这个附件（或者它不属于这条速记）。' };

      /**
       * 原生直通的附件（D71）：图片原图重递一次（工具结果支持 ImageContent），
       * 文档没法经工具结果回传（Pi 的工具结果只有 text/image）——
       * 但它本来就随首条消息进去了，提示模型回头看即可。
       */
      if (row.status === 'native') {
        const isImage = !!row.mime?.startsWith('image/');
        if (isImage) {
          try {
            const buf = await readFile(join(env.audioDir, row.path));
            return {
              text: `【图片：${row.filename}】原图如下。`,
              images: [{ data: buf.toString('base64'), mimeType: row.mime || 'image/jpeg' }],
            };
          } catch {
            return { text: `图片 ${row.filename} 读不出来了（文件可能已被移走）。` };
          }
        }
        return { text: `${row.filename} 已随本条消息**原样附上**了 —— 内容就在你收到的输入里，直接用。` };
      }

      if (!row.text) return { text: `附件 ${row.filename} 还没解析出文字（状态 ${row.status ?? '未处理'}）。` };
      return {
        text: row.text + (row.truncated ? '\n（注意：这份附件被截断了，只有前面一部分）' : ''),
        details: { status: row.status, truncated: row.truncated },
      };
    },
  },

  {
    name: 'list_enums',
    label: '看有哪些可选值',
    description:
      '列出品类、阶段、客户类型、取值类型的**全部合法值**。' +
      'propose_fields 里的 category / stage 只能取自这里，别的一律会被服务端丢弃。',
    parameters: Type.Object({}),
    execute: async () => ({
      text: [
        /**
         * 🔴🔴 **必须是 `RECORD_TYPES_V2`，不是 `RECORD_TYPES`。**
         *
         * 2026-08-05 生产实测（issue #17）：这里原来用的是 V1（只有
         * `fitment / support`），而给人用的 `/enums` 端点用的是 V2（四种）。
         * 于是同一套系统里，**界面上选得到「项目」，agent 手上根本没有这个值**。
         *
         * 后果不是「偶尔判错」，是**必然判错**：系统提示词第一条就写着
         * 「先 list_enums 看合法值」，它照做，工具回答只有两种 ——
         * 而 `keepRecordTypeV2` 认不出的值一律静默还成 `fitment`。
         * 维护者 的原话：「我再三强调其项目属性，为什么还有这种问题？」
         * 答案是：**它没地方表达「这是项目」。**
         *
         * 这是 D65/D66「写了 ≠ 读得到」的第三次复发。
         * `__tests__/agent.test.ts` 现在逐值对账，改回去测试立刻红
         * （已反向验证过：改回 V1 → 22 例里红 1 例）。
         */
        `记录类型 recordType：${RECORD_TYPES_V2.join(' / ')}`,
        ...RECORD_TYPES_V2.map((v) => `  · ${v} = ${RECORD_TYPE_LABELS[v] ?? v}`),
        '  判据：定点之前=fitment；已交付的东西出毛病=support；已定点、要建带编号的项目=project；针对已有项目的一次跟进=followup。',
        '  🔴 project / followup 时**必须另外调 propose_project** —— propose_fields 装不下项目。',
        `售后状态 caseStatus：${CASE_STATUSES.join(' / ')}`,
        `严重度 severity：${SEVERITIES.join(' / ')}`,
        `品类 category：${CATEGORIES.join(' / ')}`,
        `阶段 stage：${STAGES.join(' / ')}`,
        `客户类型 accountType：${ACCOUNT_TYPES.join(' / ')}`,
        `取值类型 valueType：${VALUE_TYPES.join(' / ')}`,
        projectEnumHelp(),
        `已知供应商：${ctx.suppliers.map((s) => s.name).join(', ') || '（暂无）'}`,
      ].join('\n'),
    }),
  },
];
