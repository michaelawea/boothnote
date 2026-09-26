import { Type } from '@earendil-works/pi-ai';

import { sql } from '../host.ts';
import { env } from '../host.ts';
import { similarity } from '../host.ts';
import {
  createIntelItem,
  createIntelValue,
  getCompanyByCode,
  listIntelItems,
  upsertContributor,
} from '../host.ts';
import { keepConfidence, keepValueType } from '../enums.ts';
import type { Skill } from '../runtime.ts';
import type { SkillContext } from './context.ts';

/**
 * D47（维护者 2026-08-03 明确要给的权限）：
 * **装不下的东西，它当场造一个字段来装。**
 *
 * 落点是 `IntelItem`（清单项）+ 一条 `IntelValue`（这次的值），
 * 不是在 Company 上建列。这不是打折扣 —— 它的权限一点没少：当场造出字段、
 * 立刻用它记录，销售那句话不会丢。留给人的只有一步：「要不要升级成正式列」。
 *
 * 为什么那一步不给它：**不是不信任，是它在处理单条速记的那一刻缺少做这个
 * 判断所需的信息。**「值不值得占所有人界面上的一列」需要跨客户的证据，
 * 而它手上只有一句话。
 *
 * 四条护栏（缺一条这个工具就会变成灾难）：
 *   ① 造之前必须查重，命中就复用   → 不然「年产量」会有五个变体
 *   ② 一条速记最多造 1 个           → 不然它会把一句话拆成五个字段
 *   ③ 新造的 weight = 0            → 见 twenty.ts createIntelItem 里的长注释
 *   ④ createdByAgent + sourceInboxId → 可追溯，人才有得审
 */

/** 键名规范化：模型给什么写法都行，落库统一成 snake_case。 */
const normKey = (raw: string) =>
  String(raw ?? '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);

export const intelFieldSkill = (ctx: SkillContext): Skill => ({
  name: 'propose_intel_field',
  label: '造一个新字段来装',
  description:
    '销售说了一件现有字段装不下的事时，当场造一个情报字段并把值记进去。' +
    '⚠️ 先想清楚：能塞进 propose_fields 的就别造新的。' +
    '**一条速记最多造一个** —— 如果一句话里有好几件装不下的事，挑最重要的那件。',
  parameters: Type.Object({
    key: Type.String({ description: '字段键，英文 snake_case，如 annual_chassis_quota' }),
    question: Type.String({ description: '这个字段在清单上的问法，中文，如「底盘年度配额是多少」' }),
    valueType: Type.String({ description: 'text / number / select / boolean' }),
    appliesTo: Type.Optional(Type.String({ description: 'company（默认）或 opportunity' })),
    why: Type.String({ description: '为什么现有字段装不下这件事，一句话' }),
    value: Type.String({ description: '这次听到的值' }),
    companyCode: Type.Optional(Type.String({ description: '这个值属于哪家客户' })),
    /**
     * 手册 P18 整页在讲这两个（配图 PC3 的底部弹层）：
     * **挂被说的那家，说话的那家留作来源，可信度留低。**
     * 之前 `createIntelValue` 把可信度写死成 LIKELY —— 隔壁展台听来的一句话
     * 和客户当面说的一句话，进 CRM 之后长得一模一样。
     */
    sourceConfidence: Type.Optional(
      Type.String({
        description:
          '这条消息离事实有几手 —— 判的是**录入的人当时在不在场**：' +
          'CONFIRMED = 本人在场；LIKELY = 不在场但有据（邮件/官网/印刷品）；RUMOR = 听第三方说的。' +
          '🔴 **不要因为「这是销售记的」就判 RUMOR** —— 销售在场就是一手。',
      }),
    ),
    sourceName: Type.Optional(
      Type.String({ description: '听谁说的（公司名）。只留痕，不改这条挂在谁名下。' }),
    ),
  }),
  execute: async (p: Record<string, any>) => {
    // ── 护栏②：一条速记最多造 1 个 ──────────────────────────────
    if (ctx.intelFieldsCreated >= 1) {
      return {
        text: '这条速记已经造过一个字段了。剩下的信息请用 propose_fields 的 summary 记下来，人看得到。',
        details: { rejected: 'one_per_note' },
      };
    }

    const key = normKey(p.key);
    if (!key) return { text: 'key 不合法。用英文 snake_case，例如 annual_chassis_quota。' };
    const valueType = keepValueType(p.valueType);
    const appliesTo = p.appliesTo === 'opportunity' ? 'opportunity' : 'company';
    const value = String(p.value ?? '').trim();
    if (!value) return { text: '没有值就不用造字段 —— 先问清楚，或者用 ask_user。' };

    // ── 护栏①：查重。本地账先查（快），再查 Twenty 的清单（准）──
    const [local] = await sql<Array<{ item_key: string; question: string; twenty_item_id: string | null }>>`
      select item_key, question, twenty_item_id from intel_field_log where item_key = ${key}`;

    let itemId = local?.twenty_item_id ?? null;
    let reused = Boolean(itemId);

    if (!itemId) {
      const existing = await listIntelItems();
      // 不只比 key，也比问法 —— 「年产量」和「年产多少台」是同一个问题、不同的 key
      const hit =
        existing.find((i) => i.itemKey === key) ??
        existing.find((i) => similarity(i.question, p.question) >= 0.85);
      if (hit) {
        itemId = hit.id;
        reused = true;
        await sql`
          insert into intel_field_log (item_key, question, value_type, applies_to, twenty_item_id, created_by)
          values (${hit.itemKey}, ${hit.question}, ${hit.valueType}, ${hit.appliesTo}, ${hit.id}, 'agent')
          on conflict (item_key) do nothing`;
      }
    }

    // ── 没有就造一个 ─────────────────────────────────────────────
    if (!itemId) {
      itemId = await createIntelItem({
        itemKey: key,
        question: String(p.question ?? key),
        valueType,
        appliesTo,
        sourceInboxId: ctx.inboxId, // 护栏④
      });
      await sql`
        insert into intel_field_log (item_key, question, value_type, applies_to, inbox_id,
                                     company_code, value, twenty_item_id, created_by)
        values (${key}, ${String(p.question ?? key)}, ${valueType}, ${appliesTo}, ${ctx.inboxId},
                ${p.companyCode ?? null}, ${value}, ${itemId}, 'agent')
        on conflict (item_key) do nothing`;
    }

    // ── 写这次的值 ───────────────────────────────────────────────
    const code = p.companyCode as string | undefined;
    const company = code ? await getCompanyByCode(code) : null;
    const contributorId = await upsertContributor(ctx.userCode, ctx.displayName).catch(() => null);

    const valueId = await createIntelValue({
      intelItemId: itemId!,
      companyId: company?.id ?? null,
      value,
      valueType,
      sourceInboxId: ctx.inboxId,
      recordedById: contributorId,
      // 认不出就 LIKELY —— 但 agent 说了 RUMOR 就必须是 RUMOR（手册 P18）
      confidence: keepConfidence(p.sourceConfidence) ?? 'LIKELY',
      sourceName: p.sourceName ?? null,
    });

    await sql`
      update intel_field_log set twenty_value_id = ${valueId},
        value = coalesce(value, ${value}), company_code = coalesce(company_code, ${code ?? null})
      where item_key = ${key}`;

    ctx.intelFieldsCreated++;

    return {
      text:
        (reused ? `复用了已有的情报项「${key}」` : `已造出新情报项「${key}」（权重 0，不参与完整度算分）`) +
        `，并记下这次的值：${value}。` +
        (company ? '' : '⚠️ 没有绑定客户 —— 人在核对时定了客户之后才好用。'),
      details: { key, itemId, valueId, reused, valueType, appliesTo, why: p.why },
    };
  },
});

/**
 * 🔴 D47 留给 维护者 的开关，默认关（`AGENT_CAN_CREATE_COLUMNS=0`）。
 *
 * 打开之后，上面那个工具的描述里会多一句、行为不变 —— **建列这条路径本身
 * 没有实现在这里，而是留成一个显式的 TODO**。理由是诚实：
 * 现在写一段没人跑过的 Metadata 建列代码，等于在展会前 25 天往生产链路上
 * 放一段未验证的、后果不可逆的代码（Twenty 删字段 = 删掉该字段所有数据）。
 *
 * 开关打开时启动会打印一行告警，让人知道它是空的 —— 比默默降级好。
 */
export const warnIfColumnSwitchOn = () => {
  if (env.agentCanCreateColumns) {
    console.warn(
      '\n⚠️  AGENT_CAN_CREATE_COLUMNS=1，但「直接建列」这条路径尚未实现。\n' +
        '   agent 仍然会把新字段落成 IntelItem + IntelValue（D47 的默认行为）。\n' +
        '   真要建列请先读规划文档 D47 的代价表，再动 scripts/twenty-schema.mjs。\n',
    );
  }
};
