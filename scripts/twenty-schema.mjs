/**
 * EU Boothnote —— Twenty 数据结构定义（唯一真相源）
 *
 * 对应规划文档 §4.4「数据结构定案」。改结构请改这个文件，然后重跑 provision-twenty.mjs。
 * 它是幂等的：已存在的对象/字段会跳过，只补缺的。
 *
 * D8 硬纪律：只经 Metadata API，不改 Twenty 源码、不直写它的表。
 *
 * ── 三段式（D23）────────────────────────────────────────────────
 *   段1 公司+车辆信息 → 内置 company 的自定义字段（列）
 *   段2 产品选型      → productFitment 自定义对象（行，只追加）
 *   段3 联系人        → 内置 person 的自定义字段
 * ── 值域受控（D23a）─────────────────────────────────────────────
 *   竞品品牌只能指向 supplier 记录，我方产品只能指向 product 记录，禁止自由文本
 */

/**
 * Twenty 要求枚举 value 必须是 UPPER_SNAKE_CASE（内置的是 NEW / SCREENING）。
 * 本文件里一律用 camelCase 写（可读），写入时统一转换 —— 以后加枚举不必记这条规则。
 *   massProduction → MASS_PRODUCTION ·  acdcCharger → ACDC_CHARGER ·  aClass → A_CLASS
 *
 * ⚠️ 这个函数原来住在 `provision-twenty.mjs` 里，2026-08-10 搬到这儿。
 *    起因是 `check-schema-drift.mjs` 也要它 —— 快照里存的必须是**线上真正那串值**，
 *    而不是源码里的 camelCase 写法。但 `provision-twenty.mjs` 顶层会读 `.env`、
 *    缺 key 就 `process.exit(1)`，**导不进来**；抄一份则两份必然分叉，
 *    而分叉的后果正好是这个检查要挡的那类（同一个 value 在两处算出不同结果）。
 *    它本来就是「关于这份 schema 的枚举怎么写」的知识，放在数据旁边才对。
 */
export const toEnumValue = (v) =>
  String(v).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9_]+/g, '_').toUpperCase();

// ── 枚举：产品品类。先按销售表 Sheet1 的 8 类（Sheet5 的 6 类是其真子集）───
// ⚠️ batteryCharger 与 acdcCharger 的边界待业务方一句话定义（T15）
export const PRODUCT_CATEGORIES = [
  { value: 'battery',         label: 'Battery 电池',                 color: 'green'  },
  { value: 'inverter',        label: 'Inverter 逆变器',              color: 'blue'   },
  { value: 'monitorEiot',     label: 'Monitor / EIOT 显示屏',        color: 'purple' },
  { value: 'distributionBox', label: 'Distribution Box 配电盒',      color: 'orange' },
  { value: 'acdcCharger',     label: 'AC/DC Charger Controller',     color: 'sky'    },
  { value: 'dcdcCharger',     label: 'DC/DC Charger Controller',     color: 'turquoise' },
  { value: 'batteryCharger',  label: 'Battery Charger 充电器',       color: 'amber'  },
  { value: 'solarPanel',      label: 'Solar Panel 太阳能板',         color: 'yellow' },
];

// ── 枚举：项目阶段（挂 Opportunity，D24）。沿用汽车行业标准，§7.2 草稿 ──────
export const OPPORTUNITY_STAGES = [
  { value: 'notContacted',      label: 'Not Contacted 未接触',            color: 'gray'   },
  { value: 'contacted',         label: 'Contacted 已接触',            color: 'sky'    },
  { value: 'sampleTesting',     label: 'Sample Testing 样品/台架测试',      color: 'blue'   },
  { value: 'vehicleValidation', label: 'Vehicle Validation 整车验证',          color: 'purple' },
  { value: 'rfqQuote',          label: 'RFQ / 报价',        color: 'orange' },
  { value: 'nominated',         label: 'Nominated 定点',    color: 'yellow' },
  { value: 'sop',               label: 'SOP',               color: 'lime'   },
  { value: 'massProduction',    label: 'Mass Production 量产',              color: 'green'  },
  { value: 'dormant',           label: 'Dormant（须填原因）', color: 'red'    },
];

// ── 枚举：账户类型（D19 / D22，单对象 + parent 自引用装下被压平的树）────────
/**
 * 账户类型。**两根轴共用一张枚举**，因为它们描述的是同一批公司的不同身份：
 *
 *   集团轴（parentCompany）：oemGroup → oemSubGroup → oemBrand
 *   渠道轴（soldVia）：      distributor → subDistributor → dealer → subDealer → endUser
 *
 * 🔴 **两根轴不能混。**「Rovena 的上级是 KWR」在集团意义上是错的 ——
 * KWR 只是卖给终端客户的那家经销商，它不拥有 Rovena。
 * 混进一棵树之后，「这个集团下面有几个品牌」和「这家分销商下面有几个终端客户」
 * 两个问题会同时算错，而且**没有人会立刻发现**。
 */
export const ACCOUNT_TYPES = [
  { value: 'oemGroup',       label: 'OEM 集团',   color: 'purple' },
  { value: 'oemSubGroup',    label: 'OEM 子集团', color: 'violet' },
  { value: 'oemBrand',       label: 'OEM 品牌',   color: 'blue'   },
  { value: 'distributor',    label: 'Distributor 分销商',     color: 'amber'  },
  { value: 'subDistributor', label: 'Sub-Distributor 二级分销商', color: 'yellow' },
  { value: 'dealer',         label: 'Dealer 经销商',     color: 'orange' },
  { value: 'subDealer',      label: 'Sub-Dealer 二级经销商', color: 'red'    },
  { value: 'endUser',        label: 'End User 终端客户',   color: 'gray'   },
];

/**
 * 渠道链从上游到下游的顺序。**用来校验一条链是不是合法的** ——
 * 「终端客户的上游是分销商」允许（中间可以没有经销商），
 * 「分销商的上游是终端客户」不允许。
 */
export const CHAIN_ORDER = ['distributor', 'subDistributor', 'dealer', 'subDealer', 'endUser'];

// ── 枚举：2C 问卷（D138）。value 与 PWA 的 `apps/capture-pwa/src/survey.ts` 选项 id 逐个对应，
//    网关 `services/gateway/src/survey.ts` 再抄一份 —— 三处由 `survey.test.ts` 对账。
export const SURVEY_EQUIPMENT = [
  { value: 'lithium',  label: 'Lithium Battery 锂电池',   color: 'green'  },
  { value: 'solar',    label: 'Solar Panel 太阳能板',     color: 'yellow' },
  { value: 'inverter', label: 'Inverter 逆变器',          color: 'blue'   },
  { value: 'dcdc',     label: 'DC-DC Charger 充电器',     color: 'turquoise' },
  { value: 'none',     label: 'None 都没有',              color: 'gray'   },
];
export const SURVEY_APPLIANCES = [
  { value: 'ac',        label: 'Air Con 空调',            color: 'sky'    },
  { value: 'fridge',    label: 'Fridge 冰箱',             color: 'blue'   },
  { value: 'coffee',    label: 'Coffee Machine 咖啡机',   color: 'orange' },
  { value: 'hob',       label: 'Electric Hob 电炉灶',     color: 'red'    },
  { value: 'microwave', label: 'Microwave 微波炉',        color: 'amber'  },
  { value: 'hairdryer', label: 'Hair Dryer 吹风机',       color: 'pink'   },
  { value: 'tv',        label: 'TV 电视',                 color: 'purple' },
  { value: 'laptop',    label: 'Laptop 电脑',             color: 'gray'   },
  { value: 'ebike',     label: 'E-bike Charging 电动车充电', color: 'green' },
];
export const SURVEY_INSTALL = [
  { value: 'diy', label: 'DIY 自己装',           color: 'blue'   },
  { value: 'pro', label: 'Professional 专业人士', color: 'purple' },
];
export const SURVEY_BRAND_CHOOSER = [
  { value: 'me',        label: 'Themselves 自己', color: 'blue'   },
  { value: 'installer', label: 'Installer 安装商', color: 'orange' },
];
export const SURVEY_OVERNIGHT = [
  { value: 'camping',  label: 'Campsite 营地',          color: 'green' },
  { value: 'aire',     label: 'Motorhome Aire 房车停车区', color: 'blue' },
  { value: 'autonomy', label: 'Off-grid 离网露营',      color: 'amber' },
];

const yn = (v, l, c) => ({ value: v, label: l, color: c });

// ═══════════════════════════════════════════════════════════════════
//  一、要新建的自定义对象
// ═══════════════════════════════════════════════════════════════════
export const OBJECTS = [
  {
    nameSingular: 'supplier', namePlural: 'suppliers',
    labelSingular: 'Competitor / Supplier 竞品/供应商', labelPlural: 'Competitor / Supplier 竞品/供应商',
    icon: 'IconBuildingFactory2',
    description: '受控值域（D23a）：段2 的竞品品牌只能指向这里的记录，禁止自由文本。这是防止 Brückner/Bruckner 那类漂移的机制。',
  },
  {
    nameSingular: 'product', namePlural: 'products',
    labelSingular: 'Voltline 产品', labelPlural: 'Voltline 产品',
    icon: 'IconPackage',
    description: '我方 SKU。与 supplier（竞品）是两回事 —— 有了它，段2 可从「客户在用 Voltaro」升级为「用 Voltaro 某型号 ↔ 我方对位 SKU」。',
  },
  {
    nameSingular: 'productFitment', namePlural: 'productFitments',
    labelSingular: 'Product Fitment 产品选型情报', labelPlural: 'Product Fitment 产品选型情报',
    icon: 'IconPlugConnected',
    description: '段2（D23）：一项情报一行，只追加不覆盖。能看出「5 月说 Voltaro、7 月改口」，每条带来源与可信度。',
  },
  {
    nameSingular: 'intelItem', namePlural: 'intelItems',
    labelSingular: 'Intel Item 情报清单项', labelPlural: 'Intel Item 情报清单项',
    icon: 'IconChecklist',
    description: '需求1 的清单本身（D17①：清单是数据不是代码）。改问法、加问题 = 改这里的记录，不发版。',
  },
  {
    nameSingular: 'intelValue', namePlural: 'intelValues',
    labelSingular: 'Intel Value 情报取值', labelPlural: 'Intel Value 情报取值',
    icon: 'IconDatabaseEdit',
    description:
      'D47：承载「清单上有、但 Company 上还没有列可放」的那些答案。形态照抄 productFitment —— 一项情报一行，带来源与可信度。\n' +
      '⚠️ 这一条**扩展了 D17②**（原文：答案不存进清单，清单只指向答案的位置）。清单仍然不存答案，' +
      '答案存在这里；等某个字段被填够多次、值得升级成 Company 上的正式列时，值回填到列上，这里的行留作来源。\n' +
      'agent 当场造出来的字段就落在这里（createdByAgent=true），所以它有权立刻记录，' +
      '而「要不要占所有人界面上的一列」这个需要跨客户证据的判断留给人。',
  },
  {
    nameSingular: 'visit', namePlural: 'visits',
    labelSingular: 'Visit / Event 拜访/事件', labelPlural: 'Visit / Event 拜访/事件',
    icon: 'IconMapPin',
    description: 'D32：展会 ⊃ 客户拜访（parent 自引用）。每条速记挂一个 visit —— IntelItem.wave「第几次拜访」全靠它才算得出来。',
  },
  {
    nameSingular: 'contributor', namePlural: 'contributors',
    labelSingular: 'Contributor 录入人', labelPlural: 'Contributor 录入人',
    icon: 'IconUserEdit',
    description: '「情报是谁报的」的受控值域。⚠️ 不能用 Twenty 内置的 createdBy —— 那记录的是「记录是谁建的」，走网关时永远是 API 那一个身份；而 D18 规定外部录入者根本不会有 Twenty 账号，永远进不了 createdBy。三个溯源概念必须分开：createdBy（记录谁建的）· recordedBy（情报谁报的）· sourceInboxId（原话在哪）。',
  },
  {
    nameSingular: 'supportCase', namePlural: 'supportCases',
    labelSingular: 'Support Case 售后问题', labelPlural: 'Support Case 售后问题',
    icon: 'IconLifebuoy',
    description: 'D25：已成交/已交付之后出现、需闭环解决的问题。成交前的一切归 Opportunity —— 这条定义写死，否则它会变成杂物筐。',
  },

  // ═════════════════════════════════════════════════════════════════
  //  D59：定点之后的执行链（对着 docs/test_example 的 T02–T05 建的）
  //
  //  完整业务链：客户 → 商机 → **项目 → 跟进 → 任务线程 → 文档**
  //  后四段原来一个都没有，于是 T02–T05 五个用例里有三个跑不了。
  //
  //  🔴 **项目和商机是两个东西，不能合并。**
  //  商机回答「这单能不能做成」（阶段从没接触推进到定点），
  //  项目回答「做成之后怎么交付」（编号、里程碑、样品、SOP、技术问题）。
  //  合并的后果：定点那一刻要么丢掉售前的推进历史，要么让「阶段」同时表达两件事。
  // ═════════════════════════════════════════════════════════════════
  {
    nameSingular: 'project', namePlural: 'projects',
    labelSingular: 'Project 项目', labelPlural: 'Project 项目',
    icon: 'IconClipboardList',
    description:
      'D59：客户定点之后的执行体。**`projectCode` 唯一** —— 幂等全靠它：'
      + '同一个编号重复提交只更新不新建（test_example T02 的验收断言）。'
      + '来源商机用 `opportunity` 关联，双向可查。',
  },
  {
    nameSingular: 'workItem', namePlural: 'workItems',
    labelSingular: 'Work Item 任务线程', labelPlural: 'Work Item 任务线程',
    icon: 'IconSubtask',
    description:
      'D59：一条可独立分派、独立跟踪的工作线。**一次跟进可以拆出多条** —— '
      + 'test_example T04 的那句「按文档、硬件接口、通信协议、测试软件四条线程拆开记录，'
      + '但都要挂在同一个项目和本次跟进下面」就是这个对象存在的理由。'
      + '里程碑也是线程（threadType=milestone），不另开对象。',
  },
  {
    nameSingular: 'projectDoc', namePlural: 'projectDocs',
    labelSingular: 'Project Doc 项目文档', labelPlural: 'Project Doc 项目文档',
    icon: 'IconFileText',
    description:
      'D59：项目相关的文档。🔴 **`docSource` 必须能区分三种来源** —— '
      + '客户给的附件 / AI 生成的 / 按口述整理的。混在一起最危险：'
      + 'AI 整理的东西被当成客户书面确认过的规格，是这类系统最贵的一种错。',
  },

  // ═════════════════════════════════════════════════════════════════
  //  D138：2C 终端用户问卷（法国 VDL 展起）
  //
  //  维护者 2026-09-27：「全部进入后面的 Twenty 数据库里面，只是客户类型变成终端客户，
  //  以后看用户的时候，反正可以筛选。」→ 每份问卷 = 一家 accountType=END_USER 的客户
  //  + 这里一条问卷记录（答案 + 联系方式）。不走 AI：表单是固定的，网关直接写。
  // ═════════════════════════════════════════════════════════════════
  {
    nameSingular: 'consumerSurvey', namePlural: 'consumerSurveys',
    labelSingular: 'Consumer Survey 2C 问卷', labelPlural: 'Consumer Survey 2C 问卷',
    icon: 'IconClipboardCheck',
    description:
      'D138：展台上 2C 终端用户的问卷，一份一行。客户本身是一条 accountType=END_USER 的 company。'
      + '🔴 选项 value 收过数据之后不许改（统计靠它）—— 改文案只改 label。'
      + '联系方式只在客户同意时才有（consentAt）；要删一个人的信息，删这一行和那家客户即可。',
  },
];

// ═══════════════════════════════════════════════════════════════════
//  二、字段。rel() = 关系字段；其余按 FieldMetadataType
// ═══════════════════════════════════════════════════════════════════
const rel = (target, targetFieldLabel, icon = 'IconLink') => ({
  type: 'RELATION',
  relation: { type: 'MANY_TO_ONE', target, targetFieldLabel, targetFieldIcon: icon },
});

export const FIELDS = {
  // ── 段1：公司 + 车辆信息（内置 company 上加列）────────────────────
  company: [
    { name: 'accountCode', label: 'Account Code 账户代号', type: 'TEXT', icon: 'IconHash', isUnique: true,
      description: 'D30：人类可读的稳定代号（如 HMG-HAVEL）。关联一律用 UUID，这一列给人看、给 Excel 对账、给 Agent 匹配品牌名。' },
    { name: 'accountType', label: 'Account Type 账户类型', type: 'SELECT', icon: 'IconCategory', options: ACCOUNT_TYPES },
    { ...rel('company', '下级公司', 'IconSitemap'), name: 'parentCompany', label: 'Parent Company 上级公司', icon: 'IconSitemap',
      description: 'D19：29 集团 / 51 子集团 / 61 品牌本质是一棵被压平的树，用自引用装下（约 141 条记录）。\n' +
        '⚠️ 这是**集团轴**（谁拥有谁）。渠道链（谁卖给谁）用 soldVia，两根轴不能混。' },
    { ...rel('company', '下游客户', 'IconTruckDelivery'), name: 'soldVia', label: 'Sold Via (upstream) 上游（从谁买的）', icon: 'IconTruckDelivery',
      description: 'D54：渠道链。distributor → subDistributor → dealer → subDealer → endUser，中间层可以缺。\n' +
        '🔴 **和 parentCompany 是两根不同的轴。** 那份远程支持报告里的\n' +
        '`KESSEL GmbH（终端）→ KWR Reisemobile（经销商）→ Rovena（整车厂）→ Voltline`\n' +
        '是渠道链，不是集团树 —— KWR 并不拥有 Rovena。混在一起之后，\n' +
        '「这个集团下面有几个品牌」和「这家经销商下面有几个终端客户」会同时算错。\n' +
        '⚠️ 已知取舍：一家经销商可能同时从两家分销商进货，这里只记**主要**那一条。' },
    { name: 'hqCountry',        label: 'HQ Country 总部国家',   type: 'TEXT',   icon: 'IconFlag' },
    { name: 'productionSite',   label: 'Production Site 生产地',     type: 'TEXT',   icon: 'IconBuildingWarehouse' },
    { name: 'annualProduction', label: 'Annual Output 年产量(约)', type: 'TEXT',   icon: 'IconChartBar',
      description: '销售表里是区间字符串（如 "8,000-10,000"），故用 TEXT 而非 NUMBER，不做有损转换。' },
    { name: 'vehiclesSold2025',   label: 'Vehicles Sold 2025 实际销量', type: 'NUMBER', icon: 'IconCar' },
    { name: 'vehiclesTarget2026', label: 'Vehicles Target 2026 销量目标', type: 'NUMBER', icon: 'IconTarget' },
    { name: 'positioning', label: 'Positioning 市场定位', type: 'SELECT', icon: 'IconDiamond',
      options: [yn('low','Entry 入门','gray'), yn('mid','Mid 中端','blue'), yn('high','Premium 高端','purple')] },
    { name: 'vehicleTypes', label: 'Vehicle Types 车型类别', type: 'MULTI_SELECT', icon: 'IconBus',
      options: [ yn('motorhome','Motorhome 自行式','blue'), yn('caravan','Caravan 拖挂式','green'),
                 yn('campervan','Camper Van','turquoise'), yn('aClass','A-Class','purple'),
                 yn('bClass','B-Class','violet'), yn('cClass','C-Class','sky') ] },
    { name: 'productTypeRaw', label: 'Vehicle Type (raw) 车型描述(原文)', type: 'TEXT', icon: 'IconFileText',
      description: '销售表 Sheet3 的 Product Type 原文。vehicleTypes 是它的枚举映射，映射必然有损 —— 原文一律保留，任何时候都能重新映射。同 §4.2 第2条的精神。' },
    { name: 'chassisBrand', label: 'Chassis Brand / Model 底盘品牌/型号', type: 'TEXT', icon: 'IconTruck' },
    { name: 'groupRanking', label: 'Group Ranking 集团排名',      type: 'TEXT', icon: 'IconTrophy' },
    // 需求1 的三个存储字段 —— Twenty 无 FORMULA 字段（§2.9），必须写入时算好存进来（D17③）
    { name: 'intelCompleteness', label: 'Intel Completeness 情报完整度%', type: 'NUMBER', icon: 'IconProgressCheck',
      description: 'D17③：存储字段而非计算字段。Twenty 没有 FORMULA 类型，但存储字段才能在视图里排序筛选（「完整度<40% 且属 Top10 集团」= 一个保存视图）。' },
    { name: 'missingIntel', label: 'Missing Intel 尚缺情报',   type: 'TEXT', icon: 'IconQuestionMark' },
    { name: 'nextAsk',      label: 'Next Ask 下次该问',   type: 'TEXT', icon: 'IconMessageQuestion',
      description: 'D17④：每次只露 3 个。销售永远看不到「还差 27 项」那种让人直接放弃的界面。' },
  ],

  // ── 段3：联系人（内置 person 上加列）─────────────────────────────
  // ⚠️ R5：V1 只填职位，不填自然人姓名
  person: [
    { name: 'contactRole', label: 'Role 角色', type: 'SELECT', icon: 'IconUserCog',
      options: [ yn('purchasingLead', 'Purchasing Lead 采购负责人','blue'), yn('techLead', 'Tech Lead 技术负责人','purple'),
                 yn('decisionMaker', 'Decision Maker 决策人','red'), yn('other', 'Other 其他','gray') ],
      description: 'R5：V1 只写职位与角色，不写自然人姓名。迁公司服务器后再补。' },
  ],

  // ── 录入人（attribution 的受控值域）──────────────────────────────
  contributor: [
    { name: 'userCode', label: 'User Code 用户代号', type: 'TEXT', icon: 'IconId', isUnique: true,
      description: '网关用它把「我们自己的登录态」映射到这条记录。与 Twenty 的账号体系无关 —— 外部录入者在这里是一条数据，不是一个账号（D18）。' },
    { name: 'contributorType', label: 'Type 类型', type: 'SELECT', icon: 'IconUsersGroup',
      options: [ yn('internal', 'Internal 公司内部','blue'), yn('distributor', 'Distributor 分销商','amber'), yn('dealer', 'Dealer 经销商','orange') ] },
    { name: 'isActive', label: 'Is Active 在用', type: 'BOOLEAN', icon: 'IconToggleLeft' },
  ],

  // ── 受控值域：竞品/供应商 ─────────────────────────────────────────
  supplier: [
    { name: 'categories', label: 'Categories 涉及品类', type: 'MULTI_SELECT', icon: 'IconCategory2', options: PRODUCT_CATEGORIES },
    { name: 'website',    label: 'Website 官网',     type: 'LINKS',        icon: 'IconWorld' },
    { name: 'supplierNote', label: 'Notes 备注',   type: 'TEXT',         icon: 'IconNote' },
  ],

  // ── 我方产品 ─────────────────────────────────────────────────────
  product: [
    { name: 'sku',            label: 'SKU',   type: 'TEXT',   icon: 'IconBarcode', isUnique: true },
    { name: 'category',       label: 'Category 品类',  type: 'SELECT', icon: 'IconCategory2', options: PRODUCT_CATEGORIES },
    { name: 'productSummary', label: 'Summary 简介',  type: 'TEXT',   icon: 'IconNote' },
  ],

  // ── 段2：产品选型情报（一项一行，只追加）──────────────────────────
  productFitment: [
    { ...rel('company', '产品选型情报', 'IconPlugConnected'), name: 'company', label: 'Company 客户', icon: 'IconBuilding' },
    { name: 'category', label: 'Category 品类', type: 'SELECT', icon: 'IconCategory2', options: PRODUCT_CATEGORIES },
    { ...rel('supplier', '在位记录', 'IconPlugConnected'), name: 'supplier', label: 'Incumbent Brand 在位品牌', icon: 'IconBuildingFactory2',
      description: 'D23a：只能指向已存在的 supplier 记录。禁止自由文本 —— 否则会出现 Voltaro/voltaro/Voltaro Energy 四个版本，聚合永远失效。' },
    { name: 'modelName', label: 'Model Name 型号', type: 'TEXT', icon: 'IconTag' },
    { name: 'fitmentType', label: '标配 or 选装位', type: 'SELECT', icon: 'IconAdjustments',
      options: [ yn('standard', 'Standard 标配','green'), yn('option', 'Option Slot 选装位','amber'),
                 yn('noBrand', 'No Brand 无品牌选装位','sky'), yn('none', 'No Such Category 无此品类','gray') ],
      description: '§7.4：突破口往往在「无品牌选装位」—— 只有拆到品类级才看得出来。' },
    { name: 'integration', label: 'Integration 集成方式', type: 'SELECT', icon: 'IconPlugConnected',
      options: [ yn('ciBus','CI-Bus','red'), yn('lin','LIN','orange'), yn('can','CAN','amber'),
                 yn('proprietary', 'Proprietary 私有协议','purple'), yn('none', 'No Bus 无总线','green') ],
      description: '§7.4：切换难度不取决于价格，取决于它是否焊死在总线里。这是 维护者 CI-Bus 工作的直接变现。' },
    { name: 'confidence', label: 'Confidence 可信度', type: 'SELECT', icon: 'IconShieldCheck',
      options: [ yn('confirmed', 'Confirmed 已确认','green'), yn('likely', 'Likely 较可信','amber'), yn('rumor', 'Rumor 传闻','gray') ],
      description: '销售在 Excel 里自己就加了 "Confidence / Source Note" 一列 —— 直觉正确，这里把它变成结构。' },
    { name: 'sourceNote',    label: 'Source Note 来源说明', type: 'TEXT',      icon: 'IconNote' },
    { name: 'sourceInboxId', label: '原文 ID',  type: 'TEXT',      icon: 'IconFileText',
      description: '§4.2 第5条：每条正式记录可追溯到原文与录入人。inbox 表在 boothnote 库（D33），不是 Twenty 对象，故存 UUID 文本。' },
    { name: 'recordedAt',    label: 'Recorded At 获取时间', type: 'DATE_TIME', icon: 'IconCalendar' },
    { ...rel('visit', '产出的情报', 'IconPlugConnected'), name: 'visit', label: 'From Visit 来自哪次拜访', icon: 'IconMapPin' },
    { ...rel('contributor', '报过的情报', 'IconUserEdit'), name: 'recordedBy', label: 'Recorded By 录入人', icon: 'IconUserEdit',
      description: '情报是谁报的。**不是** Twenty 的 createdBy —— 后者走网关时永远是 API 那一个身份（实测 56 条全是 source=API/who=test）。由网关从我们自己的登录态写入。' },
  ],

  // ── 需求1：情报清单配置表 ────────────────────────────────────────
  intelItem: [
    { name: 'itemKey',  label: 'Item Key 字段键',  type: 'TEXT', icon: 'IconKey', isUnique: true },
    { name: 'question', label: 'Question 问法(中)', type: 'TEXT', icon: 'IconMessageQuestion' },
    { name: 'questionEn', label: '问法(EN)', type: 'TEXT', icon: 'IconMessage' },
    { name: 'appliesTo', label: 'Applies To 适用层级', type: 'SELECT', icon: 'IconLayersLinked',
      options: [ yn('company', 'Company-level 客户级','blue'), yn('opportunity', 'Project-level 项目级','purple') ],
      description: 'D24 的直接后果：阶段挂项目之后，情报分客户级与项目级两级，完整度也要分两级各算一份。' },
    { name: 'wave', label: 'Ask On Wave 第几次拜访问', type: 'NUMBER', icon: 'IconWaveSine',
      description: 'D17：「循序渐进」全靠这一列。1=首访就该问，3=关系够了才问。**依赖 visit 对象（D32）才算得出「第几次」**。' },
    { name: 'weight', label: 'Completeness Weight 完整度权重', type: 'NUMBER', icon: 'IconWeight' },
    { name: 'requiredForStage', label: 'Stage Gate 阶段门', type: 'SELECT', icon: 'IconLock', options: OPPORTUNITY_STAGES,
      description: 'D17⑤：推进到该阶段前必须有值。用一个机制同时满足需求1与需求4，不做两套东西。' },
    { name: 'valueType', label: 'Value Type 取值类型', type: 'SELECT', icon: 'IconAbc',
      options: [ yn('text', 'Text 文本','gray'), yn('number', 'Number 数字','blue'), yn('select', 'Select 枚举','purple'),
                 yn('relation', 'Relation 指向实体','green'), yn('boolean', 'Boolean 是/否','amber') ],
      description: 'D23a「值受控」的执行依据：Agent 抽字段时按这一列校验，relation 类型必须落到已存在的记录 ID。' },
    { name: 'isEnabled', label: 'Is Enabled 启用', type: 'BOOLEAN', icon: 'IconToggleLeft' },
    { name: 'createdByAgent', label: 'Agent 造的', type: 'BOOLEAN', icon: 'IconRobot',
      description: 'D47 护栏④：agent 当场造出来的清单项打这个标。管理台按它筛，人再决定哪些值得升级成 Company 上的正式列。' },
    { name: 'sourceInboxId', label: '首次来源原文 ID', type: 'TEXT', icon: 'IconFileText',
      description: '这个字段是被哪一句话逼出来的。没有它，「当时为什么造这个字段」在展会结束后就查不回来了。' },
  ],

  // ── D47：情报取值。清单不存答案，答案存这里 ──────────────────────
  intelValue: [
    { ...rel('intelItem', '取值记录', 'IconDatabaseEdit'), name: 'intelItem', label: 'Intel Item 情报项', icon: 'IconChecklist' },
    { ...rel('company', '情报取值', 'IconDatabaseEdit'), name: 'company', label: 'Company 客户', icon: 'IconBuilding' },
    { name: 'valueText',    label: 'Value (text) 值(文本)', type: 'TEXT',    icon: 'IconAbc' },
    { name: 'valueNumber',  label: 'Value (number) 值(数字)', type: 'NUMBER',  icon: 'IconNumbers' },
    { name: 'valueBoolean', label: 'Value (bool) 值(是否)', type: 'BOOLEAN', icon: 'IconToggleLeft' },
    { name: 'confidence', label: 'Confidence 可信度', type: 'SELECT', icon: 'IconShieldCheck',
      options: [ yn('confirmed', 'Confirmed 已确认','green'), yn('likely', 'Likely 较可信','amber'), yn('rumor', 'Rumor 传闻','gray') ] },
    { name: 'sourceInboxId', label: '原文 ID', type: 'TEXT', icon: 'IconFileText',
      description: '§4.2 第5条：每条正式记录可追溯到原文与录入人。' },
    /**
     * 手册 P18：「**说话的那家留作来源**」。
     *
     * 这条情报挂在**被说的那家**名下（Dellmanns），但话是 Voltaro 的人说的 ——
     * 挂反了这条情报以后就永远查不到了，而不留来源则三个月后没人说得清
     * 这句话是从哪来的、要不要信。
     *
     * 🔴 **是文本不是关系。** 来源常常是「隔壁展台一个工程师」这种不成公司的东西，
     * 做成关系就会逼出「为了记来源而新建一家客户」—— 那正是 §4.2 第3条要挡的。
     */
    { name: 'sourceName', label: 'Heard From 听谁说的', type: 'TEXT', icon: 'IconEar',
      description: '手册 P18：说话的那家只留痕，不作为归属。客户自己说的就留空。' },
    { name: 'recordedAt', label: 'Recorded At 获取时间', type: 'DATE_TIME', icon: 'IconCalendar' },
    { ...rel('contributor', '报过的取值', 'IconUserEdit'), name: 'recordedBy', label: 'Recorded By 录入人', icon: 'IconUserEdit' },
    { name: 'createdByAgent', label: 'Agent 写的', type: 'BOOLEAN', icon: 'IconRobot' },
  ],

  // ── D32：拜访/事件 ───────────────────────────────────────────────
  visit: [
    { name: 'visitType', label: 'Type 类型', type: 'SELECT', icon: 'IconCalendarEvent',
      options: [ yn('tradeShow', 'Trade Show 展会','purple'), yn('customerVisit', 'Customer Visit 客户拜访','blue'),
                 yn('onlineMeeting', 'Online Meeting 线上会议','sky'), yn('call', 'Call 电话','turquoise'),
                 // D59：项目跟进复用 visit，不另开一个「跟进记录」对象 ——
                 // 它和拜访是同一件事：一次和客户的接触，产出若干条要做的事。
                 yn('projectFollowup', 'Project Follow-up 项目跟进','indigo'),
                 yn('other', 'Other 其他','gray') ] },
    { ...rel('company', '拜访记录', 'IconMapPin'), name: 'company', label: 'Company 客户', icon: 'IconBuilding',
      description: '展会级事件此处留空（它覆盖多家客户）；客户拜访级必填。' },
    { ...rel('project', '跟进记录', 'IconMapPin'), name: 'project', label: 'Project 所属项目', icon: 'IconClipboardList',
      description: 'D59：项目跟进用的。可空 —— 展会上的普通拜访没有项目。' },
    { ...rel('visit', '下属拜访', 'IconMapPin'), name: 'parentVisit', label: 'Parent Visit 所属事件', icon: 'IconSitemap',
      description: 'Caravan Salon 2026（展会）⊃ 与 Istra 洽谈（客户拜访）。本项目第三次用「单对象 + type + parent」这个模式。' },
    { name: 'startedAt', label: 'Started At 开始', type: 'DATE_TIME', icon: 'IconClockPlay' },
    { name: 'endedAt',   label: 'Ended At 结束', type: 'DATE_TIME', icon: 'IconClockStop' },
    { name: 'location',  label: 'Location 地点', type: 'TEXT',      icon: 'IconMapPin' },
    { name: 'visitSummary', label: 'Summary 小结', type: 'TEXT',   icon: 'IconNote' },
    { ...rel('contributor', '记录的拜访', 'IconUserEdit'), name: 'recordedBy', label: 'Recorded By 录入人', icon: 'IconUserEdit',
      description: '情报是谁报的。**不是** Twenty 的 createdBy —— 后者走网关时永远是 API 那一个身份（实测 56 条全是 source=API/who=test）。由网关从我们自己的登录态写入。' },
  ],

  // ── D25：售后问题 ────────────────────────────────────────────────
  supportCase: [
    { ...rel('company', '售后问题', 'IconLifebuoy'), name: 'company', label: 'Company 客户', icon: 'IconBuilding' },
    { ...rel('opportunity', '售后问题', 'IconLifebuoy'), name: 'opportunity', label: 'Opportunity 关联项目', icon: 'IconTargetArrow',
      description: '可空 —— 不是每个售后问题都能追溯到某个具体项目。' },
    { ...rel('product', '相关售后', 'IconLifebuoy'), name: 'primaryProduct', label: 'Products Involved 涉及的主要产品', icon: 'IconPackage',
      description: '⚠️ Twenty 的 RelationType 只有 MANY_TO_ONE / ONE_TO_MANY，没有多对多。你的原话是「涉及的**主要**产品」，故落成单选关系；将来要多对多再加一张中间对象。' },
    { name: 'caseStatus', label: 'Status 状态', type: 'SELECT', icon: 'IconProgress',
      options: [ yn('new', 'New 新建','red'), yn('acknowledged', 'Acknowledged 已响应','orange'), yn('inProgress', 'In Progress 处理中','amber'),
                 yn('waitingCustomer', 'Waiting Customer 待客户确认','sky'), yn('resolved', 'Resolved 已解决','green'), yn('closed', 'Closed 已关闭','gray') ],
      description: 'D25：与 Opportunity 的 stage 是两条方向不同的生命周期（推进到成交 vs 从发生到关闭），所以必须是两个对象、两个看板。' },
    { name: 'severity', label: 'Severity 严重度', type: 'SELECT', icon: 'IconAlertTriangle',
      options: [ yn('low', 'Low 低','gray'), yn('medium', 'Medium 中','amber'), yn('high', 'High 高','orange'), yn('critical', 'Critical 紧急','red') ] },
    { name: 'issueDescription', label: 'Issue Description 问题描述', type: 'RICH_TEXT', icon: 'IconFileDescription' },
    /**
     * 这两列是**使用手册先画了、字段没建**的那两个（`产品使用手册.pptx` P22 那张售后卡，
     * P25 脚注里自己写着「界面先画了，字段随后补」）。补上，不然手册在说谎。
     *
     * 交付批次是自由文本：现场听到的是「2025 年 3 月那批」「MY2025 第一批」这种，
     * 强行结构化只会让人填不进去。影响台数是数字，因为它要能求和排序 ——
     * 「哪个问题影响面最大」是售后看板上唯一会被问的排序。
     */
    { name: 'deliveryBatch', label: 'Delivery Batch 交付批次', type: 'TEXT', icon: 'IconPackages',
      description: '原话照抄，如「2025-03 批次」「MY2025 首批」。不要换算成日期 —— 现场说的就是批次。' },
    { name: 'affectedUnits', label: 'Affected Units 影响台数', type: 'NUMBER', icon: 'IconCar',
      description: '手册 P22「台数留给你填」：模型基本猜不准，留空进核对卡由人填。' },
    { name: 'reportedAt',      label: 'Reported At 报告时间',   type: 'DATE_TIME', icon: 'IconClockPlay' },
    { name: 'firstResponseAt', label: 'First Response At 首次响应',   type: 'DATE_TIME', icon: 'IconClockCheck' },
    { name: 'resolvedAt',      label: 'Resolved At 解决时间',   type: 'DATE_TIME', icon: 'IconClockStop',
      description: '「解决时间线」= 状态 + 这三个时间戳 + 内置 Note/timeline 承载过程。不自造活动日志。' },
    { ...rel('contributor', '报过的售后', 'IconUserEdit'), name: 'recordedBy', label: 'Recorded By 录入人', icon: 'IconUserEdit',
      description: '情报是谁报的。**不是** Twenty 的 createdBy —— 后者走网关时永远是 API 那一个身份（实测 56 条全是 source=API/who=test）。由网关从我们自己的登录态写入。' },
  ],

  // ── D59：项目 / 任务线程 / 项目文档 ────────────────────────────────
  project: [
    /**
     * 🔴 **幂等的支点。** test_example T02 的验收断言：
     * 「项目编号唯一；重复提交时不创建第二个相同编号的项目」。
     * 网关按它查重 —— 有就更新，没有才建。
     */
    { name: 'projectCode', label: 'Project Code 项目编号', type: 'TEXT', icon: 'IconHash', isUnique: true,
      description: 'D59：如 HYM-BAT-2027-001。**唯一** —— 重复提交靠它认出「是同一个项目」。' },
    { ...rel('company', '项目', 'IconClipboardList'), name: 'company', label: 'Company 客户', icon: 'IconBuilding' },
    /**
     * 来源商机。**双向可查**（T02 断言：「项目与 Havel、T01 商机形成可双向查看的关系」）。
     * 定点之后商机不删也不改写 —— 它记录的是「怎么赢的」，那段历史有独立价值。
     */
    { ...rel('opportunity', '产生的项目', 'IconClipboardList'), name: 'opportunity', label: 'Opportunity 来源商机', icon: 'IconTargetArrow',
      description: 'D59：定点之后商机保留不动 —— 它是「怎么赢的」那段历史，项目是「怎么交付」。' },
    /**
     * 阶段**复用 OPPORTUNITY_STAGES**，不另开一套。
     * 项目阶段（客户定点 → 样品测试 → 整车验证 → SOP → 量产）本来就是那条枚举的后半段，
     * 再定义一套只会出现「两边的『样品测试』是不是同一个」这种没人答得上来的问题。
     */
    { name: 'projectStage', label: 'Project Stage 项目阶段', type: 'SELECT', icon: 'IconProgress', options: OPPORTUNITY_STAGES,
      description: 'D59：复用商机的阶段枚举 —— 项目阶段就是它的后半段，不另立一套。' },
    { name: 'ownerTeam', label: 'Owner Team 项目负责团队', type: 'TEXT', icon: 'IconUsersGroup' },
    { name: 'budget', label: 'Budget 项目预算', type: 'CURRENCY', icon: 'IconCoin' },
    { name: 'primaryProductName', label: 'Primary Product Name 核心产品型号', type: 'TEXT', icon: 'IconPackage',
      description: 'D59：如 VLB12150-CIBUS。**TEXT 不是 product 关系** —— 测试/样品型号未必已经在我方 SKU 表里，'
        + '做成关系就会逼出「为了记一个型号先建一条 product」，那是 §4.2 第3条要挡的。' },
    { name: 'sampleQty', label: 'Sample Qty 样品数量', type: 'NUMBER', icon: 'IconBoxMultiple' },
    { name: 'plannedSop', label: '计划 SOP', type: 'DATE', icon: 'IconRocket' },
    { name: 'specSummary', label: 'Spec Summary 关键参数摘要', type: 'RICH_TEXT', icon: 'IconListDetails',
      description: 'D59：从需求文档里摘出来的电气/通信/机械/环境参数。**可检索**是 T02 的断言之一。' },
    /**
     * 🔴 **待确认事项单独一栏，不能混进正文。**
     * T02 的规格书 §9 有 5 条待确认；T03 明确要求「未提及的重要参数单独列为待客户确认，
     * 不能编造为已确认值」。混在正文里，三个月后没人分得清哪些是确认过的。
     */
    { name: 'openQuestions', label: 'Open Questions 待确认事项', type: 'RICH_TEXT', icon: 'IconQuestionMark',
      description: 'D59：客户还没给的、双方还没定的。**绝不能编成已确认值** —— test_example T03 的核心断言。' },
    { ...rel('contributor', '记录的项目', 'IconUserEdit'), name: 'recordedBy', label: 'Recorded By 录入人', icon: 'IconUserEdit' },
    { name: 'sourceInboxId', label: '原文 ID', type: 'TEXT', icon: 'IconFileText' },
  ],

  workItem: [
    { name: 'itemCode', label: 'Item Code 线程编号', type: 'TEXT', icon: 'IconHash', isUnique: true,
      description: 'D59：如 HYM-CIBUS-02。唯一 —— 重复提交不产生第二条，依赖也靠它指。' },
    { ...rel('project', '任务线程', 'IconSubtask'), name: 'project', label: 'Project 所属项目', icon: 'IconClipboardList' },
    /**
     * 挂在哪次跟进下。T04 的原话：「四条线程必须共同关联本次跟进记录和附件，
     * 不能拆成四条无来源的孤立事项」。
     */
    { ...rel('visit', '拆出的线程', 'IconSubtask'), name: 'followup', label: 'From Follow-up 来自哪次跟进', icon: 'IconMapPin',
      description: 'D59：跟进记录复用 visit（visitType=projectFollowup）。四条线程挂同一条，父记录才能汇总进度。' },
    { ...rel('company', '任务线程', 'IconSubtask'), name: 'company', label: 'Company 客户', icon: 'IconBuilding' },
    { name: 'threadType', label: 'Thread Type 线程类型', type: 'SELECT', icon: 'IconCategory2',
      options: [ yn('doc', 'Doc 文档','blue'), yn('hardware', 'Hardware 硬件接口','orange'), yn('protocol', 'Protocol 通信协议','purple'),
                 yn('software', 'Software 测试软件','green'), yn('milestone', 'Milestone 里程碑','sky'), yn('other', 'Other 其他','gray') ],
      description: 'D59：T04 要求「按文档、硬件接口、通信协议、测试软件四条线程拆开」。里程碑也走这里，不另开对象。' },
    { name: 'body', label: 'Body 内容', type: 'RICH_TEXT', icon: 'IconFileDescription' },
    { name: 'priority', label: 'Priority 优先级', type: 'SELECT', icon: 'IconFlag',
      options: [ yn('urgent', 'Urgent 紧急','red'), yn('high', 'High 高','orange'), yn('medium', 'Medium 中','amber'), yn('low', 'Low 低','gray') ] },
    { name: 'ownerRole', label: 'Owner Role 负责角色', type: 'TEXT', icon: 'IconUsersGroup',
      description: 'D59：如「硬件工程团队」。是角色不是具体人 —— 展会现场没人知道该派给谁。' },
    { name: 'dueDate', label: 'Due Date 截止日期', type: 'DATE', icon: 'IconCalendarTime' },
    { name: 'customerDueDate', label: 'Customer Due Date 客户期望日期', type: 'DATE', icon: 'IconCalendarUser',
      description: 'D59：和内部截止分开 —— T04 断言「客户要求日期、内部截止日期和待确认项均被保留」。' },
    { name: 'itemStatus', label: 'Status 状态', type: 'SELECT', icon: 'IconProgress',
      options: [ yn('open', 'Open 待处理','gray'), yn('inProgress', 'In Progress 处理中','amber'),
                 yn('waiting', 'Waiting 等对方','sky'), yn('done', 'Done 已完成','green'), yn('cancelled', 'Cancelled 已取消','red') ] },
    /**
     * 依赖。⚠️ **Twenty 没有多对多**，而 T04 里 04 同时依赖 02 和 03。
     * 所以：主依赖做成自引用（可点、可反查「我挡住了谁」），其余写进 `blockedByCodes`。
     * 代价写明：多依赖时只有第一条是结构化的，其余靠编号文本 —— 编号唯一，搜得到。
     */
    { ...rel('workItem', '挡住了', 'IconSubtask'), name: 'blockedBy', label: 'Blocked By 主要依赖', icon: 'IconArrowBackUp' },
    { name: 'blockedByCodes', label: 'Blocked By (codes) 全部依赖(编号)', type: 'TEXT', icon: 'IconLink',
      description: 'D59：Twenty 无多对多，多依赖时在这里列全部编号，如「HYM-CIBUS-02, HYM-CIBUS-03」。' },
    { name: 'openQuestions', label: 'Open Questions 待确认', type: 'TEXT', icon: 'IconQuestionMark' },
    { ...rel('contributor', '记录的线程', 'IconUserEdit'), name: 'recordedBy', label: 'Recorded By 录入人', icon: 'IconUserEdit' },
    { name: 'sourceInboxId', label: '原文 ID', type: 'TEXT', icon: 'IconFileText' },
  ],

  projectDoc: [
    { name: 'docCode', label: 'Doc Code 文档编号', type: 'TEXT', icon: 'IconHash' },
    { ...rel('project', '项目文档', 'IconFileText'), name: 'project', label: 'Project 所属项目', icon: 'IconClipboardList' },
    { ...rel('workItem', '交付文档', 'IconFileText'), name: 'workItem', label: 'Work Item 对应线程', icon: 'IconSubtask',
      description: 'D59：T04 的交付物分别挂到各自线程上。可空 —— 需求基线这类是项目级的。' },
    { ...rel('company', '项目文档', 'IconFileText'), name: 'company', label: 'Company 客户', icon: 'IconBuilding' },
    { name: 'version', label: 'Version 版本', type: 'TEXT', icon: 'IconVersions',
      description: 'D59：客户给的基线是 v1.0，AI 按口述整理的是 v0.1 —— 版本号本身就在说这份东西有多硬。' },
    /**
     * 🔴🔴 **这一栏是整个对象存在的理由。**
     *
     * 客户给的规格书、AI 生成的整理稿、按口述记的需求，三者在 CRM 里长得一样的话，
     * 迟早有人拿 AI 整理的参数去下单。test_example 的跨用例断言写着：
     * 「输入附件、Agent 生成文档和原始口述能清楚区分来源」。
     */
    { name: 'docSource', label: 'Source 来源', type: 'SELECT', icon: 'IconFileImport',
      options: [ yn('customerAttachment', 'Customer Attachment 客户提供的附件','green'),
                 yn('agentGenerated','AI 生成','amber'),
                 yn('dictation', 'Dictation 按口述整理','orange'),
                 yn('internal', 'Written In-house 我方内部编写','blue') ],
      description: 'D59：**AI 整理的东西被当成客户书面确认过的规格，是这类系统最贵的一种错。**' },
    { name: 'reviewStatus', label: 'Review Status 审核状态', type: 'SELECT', icon: 'IconChecks',
      options: [ yn('draft', 'Draft 草稿','gray'), yn('inReview', 'In Review 评审中','amber'),
                 yn('customerConfirmed', 'Customer Confirmed 客户已确认','green'), yn('superseded', 'Superseded 已被新版取代','red') ],
      description: 'D59：**默认 draft**。AI 生成的东西一律 draft，只有人明确点过才能是「客户已确认」。' },
    { name: 'isBaseline', label: 'Is Requirement Baseline 是需求基线', type: 'BOOLEAN', icon: 'IconAnchor',
      description: 'D59：T02 要求把附件标记为项目需求基线 v1.0。' },
    { name: 'content', label: 'Content 正文', type: 'RICH_TEXT', icon: 'IconFileDescription',
      description: 'D59：AI 生成的文档正文进这里；客户附件的原件在网关磁盘上，这里放解析出的正文。' },
    { name: 'attachmentId', label: '原件附件 ID', type: 'TEXT', icon: 'IconPaperclip',
      description: 'D59：Twenty 这一版没有文件上传接口，原件只在网关。凭这个 id 走 GET /attachments/:id/file 取。' },
    { name: 'generatedAt', label: 'Generated At 生成时间', type: 'DATE_TIME', icon: 'IconCalendar' },
    { ...rel('contributor', '记录的文档', 'IconUserEdit'), name: 'recordedBy', label: 'Recorded By 录入人', icon: 'IconUserEdit' },
    { name: 'sourceInboxId', label: '原文 ID', type: 'TEXT', icon: 'IconFileText' },
  ],

  // ── 需求4：项目（内置 opportunity 上补字段）───────────────────────
  opportunity: [
    /**
     * D56：**「同一家客户 + 同一个品类」= 同一个项目。**
     *
     * 没有这一列的时候，「阶段往前推一格」（手册场景 B）无处落脚 ——
     * 一家客户下面的多个 Opportunity 分不出谁是电池的、谁是逆变器的，
     * 于是要么每次新建（阶段就失去意义），要么全并成一条（品类就丢了）。
     * 有了它，复用的键是可查询的，而不是靠名字里的字符串约定。
     */
    { name: 'category', label: 'Category 品类', type: 'SELECT', icon: 'IconCategory2', options: PRODUCT_CATEGORIES,
      description: 'D56：与 company 一起构成「同一个项目」的键。同一家同一品类只保留一条在推进的记录。' },
    /**
     * D59：test_example T01 明确要求「价格接受度」和「产品组合占比」不能丢 ——
     * 原话是「如果系统无法承载…应新增合适的字段或明细对象，而不是把信息丢弃」。
     *
     * ⚠️ 三个都是 **TEXT 不是 NUMBER**：现场说的是「约 500 欧元」「大约 20,000 台」
     * 「100Ah 约占 30%」—— 那个「约」和「左右」本身就是可信度信息，
     * 转成数字就丢了，而且会让人以为是确认过的值。
     */
    { name: 'annualDemand', label: 'Annual Demand 年需求量', type: 'TEXT', icon: 'IconPackages',
      description: 'D59：客户对这个品类一年要多少件。原话照抄。⚠️ 不是客户的整车年产量 —— 那个在 company.annualProduction。' },
    { name: 'demandBreakdown', label: 'Demand Breakdown 需求明细/占比', type: 'TEXT', icon: 'IconChartPie',
      description: 'D59：产品组合与占比，如「100Ah 约 30%、150Ah 约 70%」。'
        + '🔴 **系统算出来的参考数量必须标明是算的**，例：「参考：100Ah 约 6,000 台（20,000×30%，系统计算）」——'
        + 'test_example T01 的断言：派生值不能冒充客户原话。' },
    { name: 'targetPrice', label: 'Price Acceptance 价格接受度', type: 'TEXT', icon: 'IconTag',
      description: 'D59：客户能接受的价格，如「约 EUR 500/台」。'
        + '⚠️ **这不是成交价** —— 写成成交价会让后面所有的毛利测算失真。' },
    { name: 'ownerTeam', label: 'Owner Team 负责团队', type: 'TEXT', icon: 'IconUsersGroup',
      description: 'D59：如「欧洲 OE 销售团队」。是团队不是人，所以是 TEXT 不是 contributor 关系。' },
    { ...rel('visit', '相关项目', 'IconTargetArrow'), name: 'originVisit', label: 'Origin Visit 源自哪次拜访', icon: 'IconMapPin' },
    { name: 'dormantReason', label: 'Dormant 原因', type: 'TEXT', icon: 'IconPlayerPause',
      description: '§7.2：聚合起来就是「为什么不是我们」的全量答案，比地图本身更有战略价值。' },
    { name: 'nextDecisionWindow', label: 'Next Decision Window 下个决策窗口', type: 'DATE', icon: 'IconCalendarTime',
      description: '§7.3：RV OEM 是车型年周期，「现在没机会」几乎总是「MY2027 已锁」。有了它，大领导要的第 2 类分类就是一个视图。' },
    { name: 'intelCompleteness', label: 'Intel Completeness 项目情报完整度%', type: 'NUMBER', icon: 'IconProgressCheck' },
    { name: 'nextAsk', label: 'Next Ask 下次该问', type: 'TEXT', icon: 'IconMessageQuestion' },
  ],

  // ── 2C 问卷（D138）──────────────────────────────────────────────
  consumerSurvey: [
    // ⚠️ 反向字段名是 Twenty 从这个中文 label 音译出来的（contributor 上那列就叫 `jiLuDeXiangMu`），
    //    **别以数字开头**（「2C 问卷」→ `2CWenJuan` 不是合法字段名）
    { ...rel('company', '终端客户问卷', 'IconClipboardCheck'), name: 'company', label: 'End User 终端客户', icon: 'IconBuilding',
      description: '答问卷的那个人，落成一家 accountType=END_USER 的客户（网关建，不查重 —— 消费者不会和 56 家 OEM 撞名）。' },
    { ...rel('contributor', '做过的问卷', 'IconUserEdit'), name: 'recordedBy', label: 'Recorded By 录入人', icon: 'IconUserEdit' },
    { name: 'eventName', label: 'Event 展会', type: 'TEXT', icon: 'IconCalendarEvent',
      description: '哪一场展会收的（如 VDL 2026）。以后别的展会用同一套题，按这一列分开统计。' },
    { name: 'clientId', label: 'Client ID 幂等键', type: 'TEXT', icon: 'IconKey', isUnique: true,
      description: '手机上生成的那份问卷 id。网关重试写入前先按它查 —— 有就不再建，所以重试永远不会多出一份。' },
    { name: 'surveyedAt', label: 'Surveyed At 填写时间', type: 'DATE_TIME', icon: 'IconClock' },
    { name: 'equipment', label: 'Equipment 现有电力设备', type: 'MULTI_SELECT', icon: 'IconBattery', options: SURVEY_EQUIPMENT },
    { name: 'appliancesInUse', label: 'Appliances In Use 在用电器', type: 'MULTI_SELECT', icon: 'IconPlug', options: SURVEY_APPLIANCES },
    { name: 'appliancesWanted', label: 'Appliances Wanted 想加的电器', type: 'MULTI_SELECT', icon: 'IconPlus', options: SURVEY_APPLIANCES },
    { name: 'installPreference', label: 'Install 自己装还是找专业', type: 'SELECT', icon: 'IconTool', options: SURVEY_INSTALL },
    { name: 'brandChooser', label: 'Brand Chosen By 品牌谁选', type: 'SELECT', icon: 'IconTag', options: SURVEY_BRAND_CHOOSER },
    { name: 'overnight', label: 'Overnight 过夜方式', type: 'MULTI_SELECT', icon: 'IconMoon', options: SURVEY_OVERNIGHT },
    { name: 'campingPain', label: 'Campsite Pain Points 营地不满', type: 'TEXT', icon: 'IconMoodSad' },
    { name: 'wish', label: 'Wish 想做但做不到', type: 'TEXT', icon: 'IconBulb' },
    // 联系方式用 TEXT 不用 Twenty 的 EMAILS / PHONES：展台上记的是「06 12 34 56 78」这种，
    // 那两个类型会做格式校验，一次校验失败就是整份问卷写不进去 —— 答案比格式值钱。
    { name: 'contactEmail', label: 'Email 邮箱', type: 'TEXT', icon: 'IconMail' },
    { name: 'contactPhone', label: 'Phone 电话', type: 'TEXT', icon: 'IconPhone' },
    { name: 'postcode', label: 'Postcode 邮编', type: 'TEXT', icon: 'IconMapPin' },
    { name: 'consentAt', label: 'Consent At 同意时间', type: 'DATE_TIME', icon: 'IconShieldCheck',
      description: 'R20：客户同意保存联系方式的时间。没有这一格就不会有姓名/电话/邮箱（网关挡）。' },
  ],
};

// 内置 opportunity.stage 的选项换成本行业阶段枚举（更新而非新建）。
// ⚠️ defaultValue 必须一起换 —— 内置默认是 'NEW'，而我们的枚举里没有 NEW。
// 注：写入器会自动把 value 转成 UPPER_SNAKE_CASE（Twenty 的硬要求），此处照常写 camelCase。
export const FIELD_UPDATES = [
  {
    object: 'opportunity', field: 'stage',
    patch: { options: OPPORTUNITY_STAGES, defaultValue: 'notContacted' },
  },
  {
    // 渠道链需要 subDistributor / subDealer / endUser 三个新身份（D54）。
    // ⚠️ 只**加**不删 —— 删掉一个已经在用的枚举值 = 那些记录的字段当场失效。
    object: 'company', field: 'accountType',
    patch: { options: ACCOUNT_TYPES },
  },
  {
    // D59：项目跟进也是一次「和客户的接触」，复用 visit 而不是另开对象。
    // visitType 已经建过了，所以走更新而不是新建。
    object: 'visit', field: 'visitType',
    patch: { options: [
      yn('tradeShow', 'Trade Show 展会','purple'), yn('customerVisit', 'Customer Visit 客户拜访','blue'),
      yn('onlineMeeting', 'Online Meeting 线上会议','sky'), yn('call', 'Call 电话','turquoise'),
      yn('projectFollowup', 'Project Follow-up 项目跟进','indigo'), yn('other', 'Other 其他','gray'),
    ] },
  },
];
