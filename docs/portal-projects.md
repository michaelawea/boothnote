# 客户项目进度：Twenty ⇄ 网关 ⇄ 订单门户（D139–D142）

> 一句话：**项目以 Twenty 为准**。订单门户（order-portal）的 admin 在门户里管所有客户的项目，
> 客户账号只看到自己公司、已公开的项目进度。门户**服务端**经网关 `/portal/*` 读写 Twenty；
> 浏览器从不碰网关，Twenty key 仍只在网关手里（规则 4）。

## 1. 三段与各自的失败方式

```
门户浏览器 ──/api/*──▶ 门户服务端（作用域 + 字段白名单 + 最后一次好数据）
                         │ X-Portal-Secret，只走 127.0.0.1:4000
                         ▼
                      网关 /portal/*（校验 UUID / 阶段归属 / 幂等） ──▶ Twenty
```

| 挂掉的那段 | 客户看到什么 | admin 看到什么 |
|---|---|---|
| Twenty | 最后一次好数据 + 「数据截至 N 分钟前」 | 同上；写入回 502，界面提示稍后再试 |
| 网关 | 同上 | 同上 |
| 门户 | 门户整个不可用（和订单一样） | — |

## 2. 决策

| # | 决策 | 理由 | 代价 |
|---|---|---|---|
| D139 | **客户可见性开一个口子**（部分推翻 D5）：只经门户、只看已公开项目、只看显式写给客户的话 | 业务要求客户看进度；D5 当时「从未要求」 | 多一条必须守住的泄露边界 → 门户 verify 每个账号逐个核 |
| D140 | **阶段按项目类型配模板**（扩展 D59④）：`projectType` + `projectTypeStage` 两个对象；`projectStage` 枚举原样保留 | OEM 定点与经销商项目不是一条线；Twenty SELECT 是全局的，做不了按类型 | Twenty 原生看板不能按新阶段分组（旧 `projectStage` 看板照旧） |
| D141 | **门户→网关走本机 `127.0.0.1:4000`**，Caddy 对外 404 掉 `/api/portal/*` | Cloudflare Flexible 的回源段是明文，secret 不能过公网 | 门户必须和网关同机（现在就是） |
| D142 | **「哪个门户账号看哪家公司」存在门户**（`twentyCompanyIds`，写 overrides.json）；一家公司只能绑一个账号 | 访问控制是门户的事（同 netsuiteIds）；唯一性 = 「没有项目被两个登录看到」 | CRM 里看不到门户账号；要在门户管理台绑 |

**不做（V1）**：门户里建公司（公司先在 Twenty 建，门户只绑已存在的 UUID —— 规则 3）·
删项目（改状态 cancelled / 取消公开）· 附件 · 年度时间线给客户（客户看竖排时间线）。

## 3. Twenty 新增（`scripts/twenty-schema.mjs`）

| 对象 | 字段 | 说明 |
|---|---|---|
| `projectType` 项目类型 | `typeCode` TEXT **unique** · `description` TEXT · `isActive` BOOLEAN | 种子模板 `OEM-PROGRAM`（`seed-project-types.mjs`）：D59 的项目阶段 **Nominated → Sample Testing → Vehicle Validation → SOP → Mass Production**（`stageKey` = 枚举值；不是整条商机漏斗 —— 客户看得到）。对已在库的只报差异不改，预览即差异报告 |
| `projectTypeStage` 阶段 | `projectType` → projectType · `stageOrder` NUMBER · `nameZh` TEXT · `stageKey` TEXT · `isActive` BOOLEAN | `name` = 对客户显示的英文名；删阶段 = `isActive:false`，历史不丢名字 |
| `project`（加列） | `projectType` → projectType · `currentStage` → projectTypeStage · `projectStatus` SELECT active/onHold/done/cancelled（默认 active）· `portalVisible` BOOLEAN · `customerSummary` TEXT · `targetDate` DATE | 公开前必须有类型 + 当前阶段 |
| `projectUpdate` 项目进展 | `project` → project · `stage` → projectTypeStage · `kind` SELECT communication/milestone/stageChange/note · `occurredAt` DATE_TIME · `datePrecision` SELECT minute/day · `initiator` `recipient` `summary` `result` TEXT（内部）· `customerVisible` BOOLEAN · `customerMessage` TEXT（**客户唯一能看到的正文**）· `authorName` TEXT · `clientId` TEXT **unique** | `name` = 沟通节点（内部标题）。改阶段自动记一条 `stageChange` |

BOOLEAN 一律按 `=== true` 读：空值 = 不公开（失败即关闭）。
默认值（schema 里写死）：`isActive` true · `portalVisible` / `customerVisible` false · `projectStatus` `'ACTIVE'`。
2026-09-30 本地实测：新列加上时 Twenty **给已有项目回填了默认值**（ACTIVE / false）；没有默认值的 BOOLEAN 读回来是 `null`，没填的 TEXT 是 `""`。
反向关系名（Twenty 按中文 label 音译）：`projectType.xiangMu` / `.jieDuan` · `projectTypeStage.xiangMu` / `.jinZhan` · `project.xiangMuJinZhan`。

## 4. 网关契约 `/portal/*`

鉴权：头 `X-Portal-Secret`（等于 `PORTAL_SECRET`）；`PORTAL_SECRET` 为空 → 全部 **503** `portal_disabled`；
错 → **401** `bad_secret`。可选头 `X-Portal-Actor`（门户 admin 用户名 → `authorName`）。
错误体 `{error, detail?}`：400 `invalid` · 404 `not_found` · 409 `stage_in_use`/`type_in_use`/`needs_type` · **502 `twenty_unavailable`**（门户据此改用缓存）·
**502 `snapshot_too_large`**（某张表超过分页上限 10000 条；同样用缓存，但**这一种不会自己好** —— 门户要把它和 `twenty_unavailable` 分开报给 admin）。

| 方法 路径 | 请求 | 返回 |
|---|---|---|
| GET `/portal/snapshot` | — | 见下 |
| POST `/portal/project-types` | `{name, description?, stages:[{name, nameZh?}]}` | 201 `{projectType}`；中途失败 → 502，半成品是**停用**的（选不到），同一张表单 15 分钟内重试会把它建完（201），不是 400 |
| PATCH `/portal/project-types/:id` | `{name?, description?, isActive?, stages?:[{id?, name, nameZh?}]}` | `{projectType}`；`stages` = 期望的**在用**阶段有序全集：有 id 改、无 id 建、漏掉的置 `isActive:false`；漏掉的正是某项目当前阶段 → 409 `stage_in_use` |
| POST `/portal/projects` | `{clientId, name, companyId, projectTypeId, currentStageId?, status?, portalVisible?, customerSummary?, targetDate?}` | 201 `{project}`（同 clientId 15 分钟内重放 → 200 `duplicate:true`）；自动记一条 stageChange |
| PATCH `/portal/projects/:id` | 上面除 clientId 外任意子集；`targetDate:null` 清空 | `{project, stageChanged}`；换类型必须同时给**新类型下的** `currentStageId`（哪怕和当前阶段 id 相同也会核，旧类型的阶段 → 400） |
| POST `/portal/projects/:id/updates` | `{clientId, title, kind?, occurredAt?, datePrecision?, stageId?, initiator?, recipient?, summary?, result?, customerVisible, customerMessage?}` | 201 `{update}`（clientId 在 Twenty 里 unique → 重放 200 `duplicate:true`） |
| PATCH `/portal/updates/:id` | 同上除 clientId/kind；stageChange 只许改 `customerVisible` `customerMessage` `occurredAt` | `{update}` |
| DELETE `/portal/updates/:id` | — | `{deleted:true}`（**GraphQL 软删**，绝不 REST DELETE） |

`GET /portal/snapshot`（SELECT 值一律 camelCase，布尔一律 true/false）：

```jsonc
{ "generatedAt": "ISO",
  "companies":    [{ "id", "name", "accountCode", "accountType", "hqCountry" }],
  "projectTypes": [{ "id", "typeCode", "name", "description", "isActive",
                     "stages": [{ "id", "name", "nameZh", "stageKey", "order", "isActive" }] }],   // 按 order
  "projects":     [{ "id", "name", "projectCode", "companyId", "projectTypeId", "currentStageId",
                     "legacyStage", "status", "portalVisible", "customerSummary", "targetDate",
                     "primaryProductName", "ownerTeam", "createdAt", "updatedAt" }],
  "updates":      [{ "id", "projectId", "stageId", "kind", "title", "occurredAt", "datePrecision",
                     "initiator", "recipient", "summary", "result", "customerVisible",
                     "customerMessage", "authorName", "createdAt" }] }
```

校验（网关，规则 3）：所有关系都是**已存在的 UUID**；`currentStageId`/`stageId` 必须属于该项目的类型；
`portalVisible:true` 要求项目已有类型和当前阶段（否则 409 `needs_type`）；长度上限见 `src/portalModel.ts`。
日期：精度 `day` 存 `YYYY-MM-DDT12:00:00.000Z`（正午 UTC，任何欧洲时区都落在同一天）。

网关实现补充（契约之外多出来的，门户可以不理）：

| 项 | 行为 |
|---|---|
| 409 回包 | `stage_in_use` / `type_in_use` 多带 `projects:[{id,name,stageId?}]`；`stage_in_use` 时**整个计划一条都不写** |
| `type_in_use` | 「在跑」= 状态 active 或 onHold |
| `stageChangeLogged:false` | 建项目 / 换阶段成功了、但自动那条 stageChange 没记上（Twenty 当时出错）—— 项目不回滚 |
| 更严的 400 | 不认识的字段 · 超长（**拒，不截断**）· 布尔给字符串 · 同名类型 · `customerVisible:true` 却没有 `customerMessage`（stageChange 除外）· 只给 `datePrecision` 不给 `occurredAt` · 进展的 `clientId` 被一条已删进展占着 |
| PATCH `stages` | 没给 `nameZh` = 不改；`null`/`""` = 清空；带着已停用阶段的 id = 请它回来 |
| 快照里的 `status` | 空 = `active`（schema 默认）；认不出的值 = `cancelled`（失败即关闭） |
| `projectCode` | 客户有 `accountCode` → **门户自己一条序号** `HMG-HAVEL-P2026-003`（带 `P`，和速记管道的 `HMG-HAVEL-2026-003` 分开：门户的号不进速记那本账，同一条序号会被速记重发、确认时静默改写门户项目）；撞号就换 `PRJ-…` 再试一次；没有代号 → `PRJ-<年>-<6 位随机>` |
| 幂等 | 建项目：同 `clientId` 15 分钟内（进程内存）→ 200 `duplicate:true`；上一次 **POST 超时**（Twenty 可能已提交）→ 重试先按上次用过的编号认领，认到 → 200 `duplicate:true`；**网关重启后的重放仍会建第二个**；建进展：靠 Twenty 的 unique `clientId`，不受重启影响 |

## 5. 门户侧（order-portal）

| 项 | 做法 |
|---|---|
| 配置 | `config.json → projects {enabled, baseUrl:"http://127.0.0.1:4000", ttlSeconds, timeoutMs, …}`（入 git）；secret 在 `data/.projects-secret` —— **随门户私有仓库提交**（维护者 2026-10-01 定，同 config.json；`git pull` 就到，启动时收紧成 0600）；env `PORTAL_PROJECTS_SECRET` 可覆盖 —— 没 secret = 功能关、菜单不出现 |
| 读 | `lib/projects.js`：TTL + 单飞 + stale-while-revalidate + 磁盘缓存 `data/projects-cache.json`；冷启动且网关不通 → 503 `projects_unavailable`（不是空列表） |
| 作用域 | 客户：`companyId ∈ twentyCompanyIds` **且** `portalVisible===true` **且** 状态不是 cancelled；进展：`customerVisible===true` 且（stageChange 或有 customerMessage）；字段走白名单，嵌套数组逐个投影 |
| 语言 | 对客户可见的文字（项目名、摘要、阶段英文名、customerMessage）不许有中文 —— 公开时门户校验挡住 |
| 写 | 全是 `POST /api/admin/...`，门户消毒后转发网关；审计写 `logs/auth.log` |
| 验证 | `npm run verify` 起一个**假网关**（不碰真 Twenty）：每个账号逐个登录核作用域、白名单、金丝雀文本、两登录不共享、网关断了仍出旧数据 |

## 6. 上线要 维护者 做的

1. secret 已经生成并提交在门户私有仓库的 `data/.projects-secret`。门户合并后在服务器上 `git pull`，再把**同一个值**抄进 boothnote 的 `.env`（不打印）：
   `grep -q '^PORTAL_SECRET=' .env || echo "PORTAL_SECRET=$(cat <门户目录>/data/.projects-secret)" >> .env`
   这把钥匙在服务器外面没用：`/portal/*` 只在本机 `127.0.0.1:4000` 应答，公网域名上是 404（D141）。
2. boothnote：`git pull` → `./scripts/deploy-server.sh`（会 provision 新对象、种模板、`--force-recreate` 网关）。
   核：`docker compose exec gateway sh -c 'echo ${#PORTAL_SECRET}'` 非 0；`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4000/portal/snapshot` = **401**（不是 404/503）。
3. 门户：`git pull --ff-only` → `systemctl restart order-portal` → `journalctl -u order-portal` 里看到 `projects ON`。
4. 管理台 → Customer accounts → 给要看项目的账号绑 CRM 公司 → Projects 里建/公开项目 → **用那个客户账号登录亲眼看一次**。
