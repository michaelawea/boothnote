#!/usr/bin/env node
/**
 * Twenty 的视图配置 —— **唯一真相源**，幂等，随便重跑。
 *
 * 和 `provision-twenty.mjs` 的分工：那个管**有哪些字段**，这个管**人打开 CRM 看到什么**。
 * 两个都是声明式的：改这个文件、重跑，不要在 Twenty 界面上手点 ——
 * 手点的东西下次换个环境（或者重建工作区）就没了，而且没有人记得当初为什么那么配。
 *
 * ⚠️ 视图不在 REST API 里，只在 `/metadata` 的 GraphQL 里（getViews / createView / …）。
 *
 * 🔴 **只动我们自己声明的视图。** Twenty 自带的 "All XXX" 索引视图会被补上字段列，
 * 但绝不删除；我们新建的视图靠名字认领，重跑时先清掉它的字段/排序/筛选再重建 ——
 * 那是配置不是数据，重建没有代价。
 *
 * 用法：
 *   node scripts/provision-views.mjs         # 预览
 *   node scripts/provision-views.mjs --yes   # 真写
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const YES = process.argv.includes('--yes');

const envFile = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);
// ⚠️ SERVER_URL 是 .env 里实际存在的那个键（provision-twenty.mjs 读的也是它）。
// 只认 TWENTY_API_URL 的话，在 `docker run --network boothnote_default` 的一次性容器里
// 会回退到 localhost:3000 —— 那里什么都没有，于是 deploy.sh 绿着跑完但一步都没生效。
const URL_ =
  process.env.TWENTY_API_URL ??
  process.env.SERVER_URL ??
  envFile.TWENTY_API_URL ??
  envFile.SERVER_URL ??
  'http://localhost:3000';

const KEY = process.env.TWENTY_API_KEY ?? envFile.TWENTY_API_KEY;
if (!KEY) {
  console.error('🔴 .env 里没有 TWENTY_API_KEY。');
  process.exit(1);
}

const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GraphQL。视图那套 API 的参数形状和别处不一样，全是实测出来的（`__schema` 内省）：
 *
 * | 调用 | 参数 | 返回 |
 * |---|---|---|
 * | `getView*(viewId:)` | **String**，不是 UUID | 列表 |
 * | `updateView(id:, input:)` | id 也是 **String** | `View!` |
 * | `createManyViewFields(inputs:)` | **`inputs`**，直接一个数组，没有外层包装 | `[ViewField!]!` |
 * | `destroyViewField/Filter/Group(input:{id})` | 包一层 `input`，**不是** `id:` | 对象 |
 * | `destroyViewSort(input:{id})` | 同上，但返回 **Boolean** —— 不能带选择集 |
 *
 * 最后一行是唯一的例外，也是唯一会让「统一写个循环」翻车的地方。
 */
const gql = async (query, variables, attempt = 0) => {
  const res = await fetch(`${URL_}/metadata`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429 && attempt < 5) {
    await sleep(500 * 2 ** attempt);
    return gql(query, variables, attempt + 1);
  }
  const j = await res.json().catch(() => ({}));
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  await sleep(40);
  return j.data;
};

// ═══════════════════════════════════════════════════════════════════
//  视图声明
//
//  每一条都对着 §00 的三个核心需求或 D59 的项目链，**不为好看而配**。
//  `fields` 的顺序就是列的顺序；第一列一般是 name（Twenty 的标题列）。
// ═══════════════════════════════════════════════════════════════════
const SPEC = {
  // ── 需求 2 · 机会地图 ───────────────────────────────────────────
  opportunity: {
    indexFields: ['name', 'stage', 'category', 'nextDecisionWindow', 'amount', 'company', 'ownerTeam'],
    views: [
      {
        name: '机会地图 · 按阶段',
        type: 'KANBAN',
        icon: 'IconLayoutKanban',
        groupBy: 'stage',
        fields: ['name', 'company', 'category', 'nextDecisionWindow', 'amount'],
        sorts: [['nextDecisionWindow', 'ASC']],
        why: '需求 2 的主视图：一眼看出「谁走到哪了」。',
      },
      {
        name: '决策窗口临近',
        type: 'TABLE',
        icon: 'IconCalendarTime',
        fields: ['name', 'company', 'category', 'nextDecisionWindow', 'stage', 'amount'],
        filters: [['nextDecisionWindow', 'IS_NOT_EMPTY', null]],
        sorts: [['nextDecisionWindow', 'ASC']],
        why: '§7.3：RV OEM 是车型年周期，「现在没机会」几乎总是「MY2027 已锁」。窗口排序 = 什么时候该动手。',
      },
    ],
  },

  // ── 需求 3 · 售后 ───────────────────────────────────────────────
  supportCase: {
    indexFields: ['name', 'caseStatus', 'severity', 'company', 'deliveryBatch', 'affectedUnits', 'reportedAt'],
    views: [
      {
        name: '没关掉的',
        type: 'TABLE',
        icon: 'IconAlertTriangle',
        fields: ['name', 'company', 'severity', 'caseStatus', 'affectedUnits', 'deliveryBatch', 'reportedAt'],
        // 手册 P24 原话：「没关掉的一直在看板上 · 关掉的不在这儿」
        filters: [
          ['caseStatus', 'IS_NOT', ['RESOLVED', 'CLOSED']],
        ],
        sorts: [['reportedAt', 'ASC']],
        why: '手册 P24：「最常见的失败是被忘了」。最早报的排最前 —— 拖最久的先看见。',
      },
      {
        name: '按状态',
        type: 'KANBAN',
        icon: 'IconLayoutKanban',
        groupBy: 'caseStatus',
        fields: ['name', 'company', 'severity', 'affectedUnits'],
        why: '售后是「从发生到关闭」的生命周期（D25），天然是看板。',
      },
    ],
  },

  // ── D59 · 项目执行链 ────────────────────────────────────────────
  project: {
    // D139/D140：门户那几列跟在后面 —— 前七列是 D59 的执行链，顺序不动
    indexFields: [
      'projectCode', 'name', 'projectStage', 'company', 'plannedSop', 'budget', 'ownerTeam',
      'projectType', 'currentStage', 'projectStatus', 'portalVisible', 'targetDate',
    ],
    views: [
      {
        name: '按阶段',
        type: 'KANBAN',
        icon: 'IconLayoutKanban',
        groupBy: 'projectStage',
        fields: ['name', 'projectCode', 'company', 'plannedSop', 'budget'],
        sorts: [['plannedSop', 'ASC']],
        why: '定点之后的执行看板。和商机那个是两回事：这里是「怎么交付」。',
      },
    ],
  },

  // ── D139/D140 · 客户项目进度（门户管；侧边栏上不出现，从项目记录点进来）──
  // 只列正向字段。反向关系名是 Twenty 从中文 label 音译的，没回读过的一个都不写。
  projectUpdate: {
    // 🔴 customerVisible 紧挨着 customerMessage —— 一眼分得清哪句话客户看得见
    indexFields: ['name', 'project', 'kind', 'stage', 'occurredAt', 'customerVisible', 'customerMessage', 'authorName'],
    views: [],
  },
  projectType: {
    indexFields: ['name', 'typeCode', 'description', 'isActive'],
    views: [],
  },
  projectTypeStage: {
    indexFields: ['name', 'projectType', 'stageOrder', 'nameZh', 'stageKey', 'isActive'],
    views: [],
  },

  workItem: {
    indexFields: ['itemCode', 'name', 'threadType', 'priority', 'itemStatus', 'ownerRole', 'customerDueDate', 'dueDate', 'project'],
    views: [
      {
        name: '待办',
        type: 'TABLE',
        icon: 'IconChecklist',
        fields: ['name', 'itemCode', 'priority', 'ownerRole', 'customerDueDate', 'dueDate', 'project', 'blockedBy'],
        filters: [['itemStatus', 'IS_NOT', ['DONE', 'CANCELLED']]],
        // 客户日期优先 —— 内部截止是我们自己定的，客户那个才是承诺
        sorts: [['customerDueDate', 'ASC']],
        why: '没做完的按客户期望日期排。客户日期优先于内部截止 —— 后者是我们自己定的。',
      },
      {
        name: '按线程类型',
        type: 'KANBAN',
        icon: 'IconSubtask',
        groupBy: 'threadType',
        fields: ['name', 'priority', 'ownerRole', 'customerDueDate'],
        why: 'T04 的四条线（文档/硬件/协议/软件）分别派给不同的人 —— 按类型分栏就是按人分栏。',
      },
    ],
  },

  projectDoc: {
    // 🔴 docSource 放第二列（紧挨着名字）—— 这一栏是这个对象存在的理由
    indexFields: ['name', 'docSource', 'version', 'reviewStatus', 'isBaseline', 'project', 'company'],
    views: [
      {
        name: '按来源',
        type: 'TABLE',
        icon: 'IconFileImport',
        fields: ['name', 'docSource', 'version', 'reviewStatus', 'isBaseline', 'project'],
        sorts: [['docSource', 'ASC']],
        why: '🔴 客户给的规格书和 AI 整理的稿子混在一起，迟早有人拿 AI 写的参数去下单（D59）。',
      },
    ],
  },

  // ── 需求 1 · 情报 ───────────────────────────────────────────────
  company: {
    /**
     * Twenty 自带的 Companies 索引视图默认摆的是 domainName / employees / linkedin ——
     * 那是给 SaaS 销售用的。我们这张表回答的是另一组问题：
     * 这是谁 · 什么类型 · 谁的子公司 · 从谁进货 · 在哪 · 多大 · 我们对它了解多少。
     */
    indexFields: [
      'name',
      'accountCode',
      'accountType',
      'parentCompany',
      'soldVia',
      'hqCountry',
      'positioning',
      'annualProduction',
      'intelCompleteness',
    ],
    views: [
      {
        name: '情报最缺的',
        type: 'TABLE',
        icon: 'IconQuestionMark',
        fields: ['name', 'accountCode', 'accountType', 'intelCompleteness', 'annualProduction', 'nextAsk'],
        filters: [['accountType', 'IS', ['OEM_BRAND', 'OEM_GROUP', 'OEM_SUB_GROUP']]],
        sorts: [['intelCompleteness', 'ASC']],
        why: '需求 1：下次去之前先看这屏。完整度低的排前面。',
      },
      {
        name: '渠道链上的客户',
        type: 'TABLE',
        icon: 'IconTruckDelivery',
        fields: ['name', 'accountCode', 'accountType', 'soldVia', 'hqCountry'],
        filters: [['accountType', 'IS', ['DISTRIBUTOR', 'SUB_DISTRIBUTOR', 'DEALER', 'SUB_DEALER', 'END_USER']]],
        why: 'D54：渠道链和集团树是两根轴。这个视图只看渠道那根，免得和 OEM 名单混在一起。',
      },
      {
        name: '终端客户',
        type: 'TABLE',
        icon: 'IconUser',
        fields: ['name', 'accountType', 'soldVia', 'hqCountry'],
        filters: [['accountType', 'IS', ['END_USER']]],
        why: 'D138：维护者「客户类型变成终端客户，以后看用户的时候，反正可以筛选」—— 这一屏就是筛好的。展台问卷建的消费者都在这里，答了什么点进去看关联的 2C 问卷。',
      },
    ],
  },

  productFitment: {
    indexFields: ['name', 'company', 'category', 'supplier', 'modelName', 'confidence', 'recordedAt'],
    views: [
      {
        name: '在位品牌分布',
        type: 'TABLE',
        icon: 'IconBuildingFactory2',
        fields: ['name', 'company', 'category', 'supplier', 'modelName', 'confidence', 'recordedAt'],
        filters: [['supplier', 'IS_NOT_EMPTY', null]],
        sorts: [['recordedAt', 'DESC']],
        why: '需求 2 的另一半：「这家在用谁」。只看对上受控名单的那些 —— 没对上的说明名单要补（T40）。',
      },
    ],
  },

  /**
   * 🔴 录入人：维护者 2026-08-03 截图问「timeline 怎么都是白的」。
   *
   * Twenty 的 Timeline 是**这条记录本身的变更日志**，而我们所有写入都走 API，
   * `timelineActivity` 挂不到记录上（它只有 `workspaceMember` 一个关系字段）——
   * 所以那一栏对我们这套用法永远是空的，改不了（D8：不动 Twenty 源码）。
   *
   * 他真正想看的「这个人记了什么」在**反向关系**里。把那几列放进索引视图，
   * 打开录入人列表就直接看得到，不用点进去翻标签页。
   */
  contributor: {
    indexFields: [
      'name',
      'userCode',
      'contributorType',
      'isActive',
      'jiLuDeBaiFang',
      'baoGuoDeQingBao',
      'baoGuoDeShouHou',
      'jiLuDeXiangMu',
    ],
    views: [],
  },

  visit: {
    indexFields: ['name', 'visitType', 'company', 'project', 'startedAt', 'recordedBy'],
    views: [],
  },
  intelValue: {
    indexFields: ['name', 'intelItem', 'company', 'valueText', 'confidence', 'sourceName', 'recordedAt'],
    views: [],
  },
  intelItem: {
    indexFields: ['name', 'itemKey', 'question', 'appliesTo', 'wave', 'weight', 'isEnabled'],
    views: [],
  },

  // ── 2C 问卷（D138）——「问卷统计」就是这张表：按任一列分组 / 筛选 / 导出 ──
  consumerSurvey: {
    indexFields: [
      'name',
      'equipment',
      'appliancesInUse',
      'appliancesWanted',
      'installPreference',
      'brandChooser',
      'overnight',
      'campingPain',
      'wish',
      'postcode',
      'eventName',
      'surveyedAt',
      'recordedBy',
      'company',
    ],
    views: [],
  },
};

// ═══════════════════════════════════════════════════════════════════
// ⚠️ 这个端点的返回形状不稳：有时是 `data.objects`，有时直接是 `data` 数组。
// 而且**必须带 limit** —— 不带只回一页，我们的自定义对象会被截掉（实测）。
const objRes = await (await fetch(`${URL_}/rest/metadata/objects?limit=200`, { headers: H })).json();
const objs = objRes?.data?.objects ?? (Array.isArray(objRes?.data) ? objRes.data : []);
if (!objs.length) {
  console.error('🔴 一个对象都没读到 —— Twenty 起来了吗？API key 对吗？');
  process.exit(1);
}
const objByName = Object.fromEntries(objs.map((o) => [o.nameSingular, o]));

const views = (await gql(`{ getViews { id name objectMetadataId type } }`)).getViews ?? [];

const fieldId = (obj, fname) => {
  const f = (obj.fields ?? []).find((x) => x.name === fname);
  return f?.id ?? null;
};

/** 清掉排序与筛选。⚠️ `destroyViewSort` 返回 Boolean，**不能**带 `{ id }`。 */
const clearSortsAndFilters = async (viewId) => {
  const sorts = (await gql(`query($id:String!){ getViewSorts(viewId:$id){ id } }`, { id: viewId })).getViewSorts ?? [];
  for (const r of sorts) {
    await gql(`mutation($id:UUID!){ destroyViewSort(input:{id:$id}) }`, { id: r.id }).catch(() => {});
  }
  const filters = (await gql(`query($id:String!){ getViewFilters(viewId:$id){ id } }`, { id: viewId })).getViewFilters ?? [];
  for (const r of filters) {
    await gql(`mutation($id:UUID!){ destroyViewFilter(input:{id:$id}){ id } }`, { id: r.id }).catch(() => {});
  }
};

/**
 * 按声明顺序铺列 —— **对账，不是清空重建**。
 *
 * 一开始写的是「全删了重建」，实测撞上两堵墙：
 *   ① 标题列（label identifier）**根本删不掉** —— `destroyViewField` 直接报
 *      `Label identifier view field cannot be deleted`；
 *   ② 删一半再 create，剩下那一列会以 `already exists` 让整批失败，
 *      于是视图停在残缺状态 —— 比不动还糟。
 *
 * 所以：在的改位置、缺的新建、多出来的**隐藏**（不是删）。
 * 隐藏也正是 Twenty 界面上那颗按钮做的事，人后面想调回来是可逆的。
 */
const putFields = async (viewId, ok) => {
  const existing =
    (await gql(`query($id:String!){ getViewFields(viewId:$id){ id fieldMetadataId } }`, { id: viewId }))
      .getViewFields ?? [];
  const byField = new Map(existing.map((f) => [f.fieldMetadataId, f]));
  const want = new Set(ok.map(([, id]) => id));
  const setField = (id, update) =>
    gql(`mutation($id:UUID!,$u:UpdateViewFieldInputUpdates!){ updateViewField(input:{id:$id,update:$u}){ id } }`, {
      id,
      u: update,
    });

  const toCreate = [];
  for (const [i, [, fid]] of ok.entries()) {
    const cur = byField.get(fid);
    if (cur) await setField(cur.id, { isVisible: true, position: i, size: 150 });
    else toCreate.push({ fieldMetadataId: fid, viewId, isVisible: true, position: i, size: 150 });
  }
  if (toCreate.length) {
    await gql(`mutation($in:[CreateViewFieldInput!]!){ createManyViewFields(inputs:$in){ id } }`, { in: toCreate });
  }

  let n = 0;
  for (const f of existing) {
    if (want.has(f.fieldMetadataId)) continue;
    await setField(f.id, { isVisible: false, position: 100 + n++ }).catch(() => {});
  }
  return { added: toCreate.length, hidden: n };
};

let created = 0;
let updated = 0;
const missing = [];

for (const [objName, spec] of Object.entries(SPEC)) {
  const obj = objByName[objName];
  if (!obj) {
    console.log(`  ⚠️ 对象 ${objName} 不存在，跳过`);
    continue;
  }
  console.log(`\n\x1b[1m【${obj.labelPlural ?? objName}】\x1b[0m`);

  // ── 索引视图（Twenty 自带的 "All XXX"）：只补列，不删视图 ──────────
  if (spec.indexFields?.length) {
    const idx = views.find((v) => v.objectMetadataId === obj.id && v.type === 'TABLE' && /^All /.test(v.name));
    if (!idx) {
      console.log('  ⚠️ 找不到索引视图，跳过列配置');
    } else {
      const ids = spec.indexFields.map((n) => [n, fieldId(obj, n)]);
      const bad = ids.filter(([, id]) => !id).map(([n]) => n);
      if (bad.length) missing.push(`${objName}.indexFields: ${bad.join(', ')}`);
      const ok = ids.filter(([, id]) => id);
      console.log(`  ${idx.name} → 列：${ok.map(([n]) => n).join(' · ')}`);
      if (YES) {
        // 索引视图是 Twenty 自带的：只重排列，**不碰**上面可能有的排序和筛选
        const r = await putFields(idx.id, ok);
        if (r.added || r.hidden) console.log(`      新增 ${r.added} 列 · 隐藏 ${r.hidden} 列`);
        updated++;
      }
    }
  }

  // ── 我们自己声明的视图 ──────────────────────────────────────────
  for (const v of spec.views ?? []) {
    const fids = v.fields.map((n) => [n, fieldId(obj, n)]);
    const bad = fids.filter(([, id]) => !id).map(([n]) => n);
    if (bad.length) missing.push(`${objName} / ${v.name}: ${bad.join(', ')}`);
    const okFields = fids.filter(([, id]) => id);

    const groupById = v.groupBy ? fieldId(obj, v.groupBy) : null;
    if (v.groupBy && !groupById) {
      missing.push(`${objName} / ${v.name}: groupBy=${v.groupBy}`);
      continue;
    }

    const exists = views.find((x) => x.objectMetadataId === obj.id && x.name === v.name);
    console.log(`  ${exists ? '↻' : '＋'} ${v.name}（${v.type}）`);
    console.log(`      ${v.why}`);
    if (!YES) continue;

    let viewId = exists?.id;
    if (exists) {
      // 排序和筛选是纯配置，清掉重建最省事；列走 putFields 对账（标题列删不掉）
      await clearSortsAndFilters(viewId);
      await gql(
        `mutation($input:UpdateViewInput!,$id:String!){ updateView(input:$input,id:$id){ id } }`,
        { id: viewId, input: { icon: v.icon, ...(groupById ? { mainGroupByFieldMetadataId: groupById } : {}) } },
      ).catch((e) => console.log('      ⚠️ 更新视图属性失败：', String(e).slice(0, 80)));
    } else {
      const r = await gql(
        `mutation($input:CreateViewInput!){ createView(input:$input){ id } }`,
        {
          input: {
            name: v.name,
            objectMetadataId: obj.id,
            type: v.type,
            icon: v.icon,
            visibility: 'WORKSPACE',
            ...(groupById ? { mainGroupByFieldMetadataId: groupById } : {}),
          },
        },
      );
      viewId = r.createView.id;
      created++;
    }

    await putFields(viewId, okFields);

    for (const [fname, dir] of v.sorts ?? []) {
      const id = fieldId(obj, fname);
      if (!id) continue;
      await gql(`mutation($input:CreateViewSortInput!){ createViewSort(input:$input){ id } }`, {
        input: { fieldMetadataId: id, viewId, direction: dir },
      }).catch((e) => console.log('      ⚠️ 排序：', String(e).slice(0, 80)));
    }

    for (const [fname, operand, value] of v.filters ?? []) {
      const id = fieldId(obj, fname);
      if (!id) continue;
      // ⚠️ `value` 是 **JSON!**，非空。IS_NOT_EMPTY 这类不带值的操作符也必须给个空串，
      //    传 null 会被 GraphQL 直接拒掉。
      await gql(`mutation($input:CreateViewFilterInput!){ createViewFilter(input:$input){ id } }`, {
        input: { fieldMetadataId: id, viewId, operand, value: value ?? '' },
      }).catch((e) => console.log('      ⚠️ 筛选：', String(e).slice(0, 100)));
    }

    // 看板需要 viewGroup（每个枚举值一栏）—— 没有它分栏是空的
    if (v.type === 'KANBAN' && groupById) {
      const gf = (obj.fields ?? []).find((x) => x.name === v.groupBy);
      const opts = gf?.options ?? [];
      const had = (await gql(`query($id:String!){ getViewGroups(viewId:$id){ id } }`, { id: viewId })).getViewGroups ?? [];
      for (const g of had) {
        await gql(`mutation($id:UUID!){ destroyViewGroup(input:{id:$id}){ id } }`, { id: g.id }).catch(() => {});
      }
      if (opts.length) {
        await gql(`mutation($in:[CreateViewGroupInput!]!){ createManyViewGroups(inputs:$in){ id } }`, {
          in: opts.map((o, i) => ({
            viewId,
            fieldValue: o.value,
            isVisible: true,
            position: i,
          })),
        }).catch((e) => console.log('      ⚠️ 分栏：', String(e).slice(0, 100)));
      }
    }
  }
}

if (missing.length) {
  console.log('\n\x1b[33m⚠️ 这些字段在 Twenty 里找不到（视图里已跳过）：\x1b[0m');
  for (const m of missing) console.log('   ·', m);
  console.log('   多半是 schema 还没 provision，或者字段名写错了。');
}

console.log(
  YES
    ? `\n✅ 新建视图 ${created} 个 · 更新索引列 ${updated} 处\n`
    : `\n这是预览。真要写加 \x1b[1m--yes\x1b[0m。\n`,
);
