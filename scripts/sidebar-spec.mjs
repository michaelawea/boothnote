/**
 * CRM 侧边栏上出现哪几项 —— **唯一真相源**（D114）。
 *
 * 两个脚本读它，所以它必须住在一个谁都能 import 的地方：
 *   `provision-nav.mjs`   照着它写侧边栏
 *   `verify-deploy.mjs`   部署出口回读，对不上就 exit 1
 *
 * ⚠️ **别抄第二份。** 抄一份则两份必然分叉，而分叉之后
 * 「配置」和「对账」会各自说自己是对的 —— 那正是这道对账要挡的东西。
 * （同样的理由让 `toEnumValue` 搬进了 `twenty-schema.mjs`，见那个文件的头部。）
 *
 * 顺序就是侧边栏上的顺序。往里加东西之前先答一句「谁每天要点它」——
 * 这一栏的全部价值在于短。
 *
 * 维护者 2026-08-13 定的十项（§00 的三个核心需求 + D59 的项目链）。
 */
export const SIDEBAR = [
  'company',      // 客户 —— 段1，所有东西都挂在它上面
  'person',       // 联系人 —— 段3
  'opportunity',  // 商机 —— 需求 2 机会地图的主对象
  'supplier',     // 竞品/供应商 —— 受控值域（D23a）
  'intelItem',    // 情报清单项 —— 需求 1 的清单本身（D17①）
  'visit',        // 拜访/事件 —— D32，「第几次拜访」全靠它
  'supportCase',  // 售后问题 —— 需求 3
  'contributor',  // 录入人 —— 「情报是谁报的」
  'project',      // 项目 —— D59 定点之后的执行体
  'workItem',     // 任务线程 —— D59
  'consumerSurvey', // 2C 问卷 —— D138，问卷统计就在这一屏（按选项分组 / 筛选 / 导出）
];

/**
 * **有意不在侧边栏上、但对象和字段一个字没动**的那些。
 *
 * 🔴 这些对象**必须仍然 `isActive`** —— 它们只是不出现在左边那一栏。
 * `verify-deploy.mjs` 会逐个回读它们的 `isActive`，为的是抓住
 * 「后来有人图省事，改用停用对象来隐藏」这种漂移。
 *
 * ⚠️ 实测（2026-08-13 · v2.25.1）：停用**不会**让 REST/GraphQL 失效
 * （`GET` 仍 200、`POST` 仍 201）。但它是关于对象本身的声明、副作用没查清，
 * 而且 **`check-schema-drift.mjs` 看不见它**（停用期间照样报「无危险漂移」）——
 * 这道回读补的正是那个盲区。判据与实测记在 `provision-nav.mjs` 头部。
 *
 * 写在这里也是为了让下一个人在「咦怎么少了一项」的时候，
 * 不用翻 git log 就知道是故意的、以及为什么。
 */
export const HIDDEN_ON_PURPOSE = {
  product:        'Voltline 产品 —— 0 条记录、代码零引用；supportCase 上那个关系字段还在',
  productFitment: '产品选型情报 —— 承重件，网关天天写；人不从这一屏看它，走客户页的关联区',
  intelValue:     '情报取值 —— D47 agent 造字段的落点，gaps.ts 要读；同上，不需要单独一屏',
  projectDoc:     '项目文档 —— 和「项目」在人眼里重合（维护者 2026-08-13）；docSource 那条安全性质保留',
  task:           'Twenty 自带 —— 我们用 workItem，不用它',
  note:           'Twenty 自带 —— 我们用 inbox/thread，不用它',
  dashboard:      'Twenty 自带 —— 没配过内容',
  workflow:       'Twenty 自带自动化 —— 没用；连带 workflowRun / workflowVersion 和那个文件夹',
};
