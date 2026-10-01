# 网关接口契约 · `boothnote` 数据模型

> **这是前端与后端之间唯一的约定。** 改这里要同时改两边。
> 上位文档：内部设计日志（未公开）（§4.2 写入边界契约 / D33 库隔离 / D35 账号与角色）
> 最近一次大改：**2026-08-03**（阶段 B + P：对话线程 · 附件 · Pi agent · 5 秒延迟提交）

## 0. 它在架构里的位置

```
PWA (capture.域名)  ──只认网关，永不直连 Twenty──▶  网关  ──▶  boothnote 库（原文/派生/账号）
                                                      ├──▶  OpenAI（转写 · 抽取）
                                                      └──▶  Twenty Core API（人确认之后的正式数据）
```

**四条不可协商的规则**

1. **唯一写入闸门**：只有网关持有 Twenty API key。PWA 拿不到，外部录入者更拿不到。（§4.2 第 1 条 / D35④）
2. **原文不可变**：`inbox` 只增不改。转写、抽取都是**派生**，落在 `staging`，永不回写 `inbox`。（§4.2 第 2 条）
   2026-08-03 起，这条纪律扩展到 `thread_message` 和 `attachment` —— 判据是「这行东西丢了能不能再生」。
3. **作用域在服务端，而且只认自己的**：按 `recordedBy` 过滤由网关执行，前端只负责显示。
   前端过滤 = 开一下开发者工具就全看见。（D35 / 质疑三）
   ⚠️ **2026-08-07 收紧（D76①）**：**任何角色都只能碰自己写的内容，admin 也一样。**
   原来读速记/确认入库/下载附件三处对 `canSeeBoard`（`role !== 'user'`）是开的，现在全关掉。
   `canSeeBoard` 只剩两个用处：发不发 `boardUrl`，和 `GET /records` 能不能进。
4. **写 Twenty 只发生在一个函数里**：`src/confirm.ts` 的 `commitToTwenty()`。
   agent 的工具清单里没有任何能写 CRM 的东西 —— 不是「禁止调用」，是没注册（Ring 3）。
   **被允许的例外只有这三条**（每一条都是「人明确点过、没有待确认这一层可挂」的写入）：
   · 2C 问卷 `POST /surveys` → `src/surveys.ts`（D138，经 `survey_response` 中转表）
   · 管理台建账号时的 `upsertContributor`（`src/admin.ts`，只写 contributor 投影 —— 规则 5）
   · 订单门户 `/portal/*` → `src/portal.ts`（D139–D142，只写 projectType / projectTypeStage /
     projectUpdate 和 project 上门户那几列；见下面「订单门户」一节）
   **第四条例外出现之前，先改这一段。**

---

## 1. `boothnote` 数据模型

一共 9 张表。**按「丢了能不能再生」分成两类** —— 这一刀决定了哪些有只增不改的触发器：

| 只增不改（资产） | 可覆盖（派生） |
|---|---|
| `inbox` · `thread_message` · `attachment` | `staging` · `attachment_text` · `agent_run` · `thread` · `intel_field_log` |

`app_user` 两边都不算 —— 它是配置，可改但不可删（`inbox.user_id` 外键挡着，撤权靠 `is_active`）。

### 1.1 `app_user` —— 账号（凭据的真相源）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `user_code` | text UNIQUE | 与 Twenty 的 `contributor.userCode` 一一对应 |
| `display_name` | text | |
| `password_hash` | text | **scrypt**（Node 内置，无原生依赖 → x86 构建不出岔子） |
| `role` | text | `admin` / `management` / `staff` / `user`（D35②） |
| `is_active` | bool | 撤权开关 |
| `token_version` | int | **改这个数字 = 该用户所有已签发 token 立即失效** |

> 🔴 **密码哈希永不进 Twenty。** Twenty 里的 `contributor` 只是投影（代号 + 名字），由网关单向同步。（D35④）

### 1.2 `inbox` —— 原文，只增不改

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `client_id` | uuid UNIQUE | **幂等键**。断网重传不产生重复（§4.2 第 6 条） |
| `user_id` | uuid FK | 录入人 |
| `company_code` | text NULL | **可空**（D28 修订：录入时不必定，入库时必须定） |
| `text` | text NULL | 用户敲进去的字。纯语音时为空 |
| `audio_path` / `audio_mime` / `audio_seconds` | | iOS 给 `audio/mp4`，Chrome 给 `audio/webm` —— **不要写死只收一种**（§2.9c） |
| `visit_label` | text NULL | 当前事件（D32），如 `Caravan Salon 2026` |
| `thread_id` | uuid NULL | **续写靠它串起来**（002 新增） |
| `source` | text NULL | `note` / `followup` / `import`（002 新增） |
| `device_created_at` / `created_at` | timestamptz | 设备本地时间 / 服务端接收时间 |

> **数据库层面强制不可变**：`inbox` 上有触发器挡住 `UPDATE` / `DELETE`。
> 🔴 **续写不是 UPDATE。** 同一条对话的第二句话是**一条新的 inbox 行**，靠 `thread_id` 串起来。
> 集成测试第 ① 条逐字段比对原行，确保它一个字节都没变。

### 1.3 `staging` —— 派生结果，待人工确认

| 列 | 类型 | 说明 |
|---|---|---|
| `inbox_id` | uuid UNIQUE FK | 一条原文一条 staging |
| `status` | text | `pending` / `transcribing` / `extracting` / `ready` / **`confirming`** / `confirmed` / `failed` |
| `transcript` | text NULL | 转写结果。**独立于 `inbox.text`**，重跑转写不动原文 |
| `edited_text` / `edited_at` | text NULL | 007：**人事后改定的正文**（D68）。见下面那张「三层文字」的表 |
| `title` | text NULL | 007：自动标题（D70）。**装饰** —— 生成失败退回首句启发式 |
| `extracted` / `confidence` | jsonb | agent 抽出来的字段与逐字段置信度 |
| `suggested_company` | text NULL | agent 认为是新客户 → **只提议，不自动建**（§4.2 第 3 条） |
| `resolved_company_id` | uuid NULL | 人工确认时定下的 Twenty company id |
| `twenty_refs` | jsonb NULL | 确认后写进 Twenty 的记录 id，用于追溯 |
| `partial` | bool | 002：agent 到了 8 步 / 60 秒上限，结果可能不全 |
| `agent_steps` / `agent_trace` | int / jsonb | 002：调了几步、调了哪些工具 |
| `confirm_after` / `confirm_payload` / `confirm_by` | | 002：**5 秒延迟提交**（D48）。到点由心跳提交 |

#### 🔴 一条速记的三层文字（D68）—— 前后端都按这个优先级来

| 层 | 是什么 | 谁写 | 可变吗 |
|---|---|---|---|
| `inbox.text` | 人当时打的字 | 手机上传 | 🔴 **永不可变**（触发器挡着） |
| `staging.transcript` | 机器听出来的 | 转写队列 | 重转会覆盖 |
| `staging.edited_text` | 人事后改定的 | `PATCH /inbox/:id/text` | 人说了算 |

**显示、喂给 agent，都用最靠下那层（有就用）；上面两层原样留着。**

改的动机几乎总是「转录把品牌名听错了」（实测 Rosenfeld → Rozenfelt）。
合成一层的话，「这句是他打的、机器听的、还是他改的」永久分不清 ——
而三个月后回头看一条记录时，这个区别决定了它有多可信。

### 1.4 `thread` / `thread_message` —— 对话

一条速记 = 一条对话。晚上想起补一句，落在同一个 `thread` 上。
`thread_message` **只增不改**：人说的和 agent 回的都在里面。

### 1.5 `attachment` / `attachment_text` —— 附件

`attachment` 是原件（只增不改），`attachment_text` 是解析出来的纯文字（可重跑）。
这一刀和 inbox/staging 是同一刀：解析器换代、模型换代都会想重跑，重跑不能有任何机会碰到原件。

`kind` 只有三个：`photo`（拍照）· `image`（相册）· `file`（什么格式都收）。

### 1.6 `agent_run` —— agent 每一轮的轨迹

**展会现场出问题时第一个要看的表**：它调了什么、几步、多久、为什么停。
`stop_reason` ∈ `done` / `max_steps` / `timeout` / `error`。

### 1.7 `intel_field_log` —— agent 当场造的情报字段（D47）

本地留一份账，三个用途：查重（不用每次问 Twenty）、护栏②「一条速记最多造 1 个」的判据、管理台看它造了什么。
`item_key` 上有唯一索引 —— 那是护栏①的最后一道。

### 1.8 `survey_response` —— 2C 问卷中转表（D138）

手机交上来的问卷先落这里，心跳写进 Twenty（`consumerSurvey` + 一家 `END_USER` 客户）。
**没有只增不改的触发器**：里面有消费者的姓名电话，要求删除时必须删得掉（R20）。
`status` ∈ `pending` / `committing` / `committed` / `failed`；失败按 30s 起翻倍、封顶 1 小时重试，不设上限。
重试安全：Twenty 那边先按 `clientId`（unique）查，客户 id 建完立刻记进 `twenty_company_id`。

### 1.9 音频与附件文件

落磁盘 `${GATEWAY_AUDIO_DIR}/YYYY/MM/<uuid>-<原名>`，容器卷挂载。

> ⚠️ **`pg_dump` 不含这些文件。** 备份脚本必须**另外**把这个目录同步走，否则 R13 的备份是残缺的。

---

## 2. 接口

所有接口（除 `/auth/login`、`/health`、`/agent/health`）都要 `Authorization: Bearer <jwt>`。

**JWT 载荷只有 `sub`（user_id）+ `tv`（token_version）+ `exp`。角色不写进 token** —— 每次请求查库，否则 90 天有效期内撤不掉任何人的权限（D35⑤）。

### `POST /auth/login`

```jsonc
// →  { "userCode": "alex", "password": "…" }
// ←  200
{ "token": "eyJ…",                        // HS256，90 天
  "user": { "userCode":"alex", "displayName":"Alex", "role":"admin",
            "canSeeBoard":true, "canManageUsers":true,
            "boardUrl":"https://crm.域名" } }   // ← 只发给 canSeeBoard 的人
// ← 401 { "error": "invalid_credentials" }   ← 用户不存在与密码错误返回**同一个**错误
```

### `GET /me`

返回同上的 `user` 对象。前端每次启动调一次 —— 这也是**撤权立即生效**的检查点。

> 🔴 `boardUrl` **由服务端按 role 决定发不发**。`user` 角色的响应里根本没有这个字段 ——
> 不是「前端拿到了但藏起来」。集成测试第 ⑥ 条断言这一点。

### `PATCH /me` —— 改自己的界面语言（D84）

```jsonc
// →  { "locale": "en" }              // 只认 "zh" | "en"
// ←  200  { "user": { …同上，locale 已是新值… } }
// ←  400  { "error": "bad_locale", "hint": "只认 'zh' 或 'en'" }
```

**`app_user.locale` 唯一的写入口。** 三条约束，每条都有具体理由：

> 🔴 **只能改自己的。** 没有 `?userCode=`，路径里也没有别人的位置 ——
> 和 `GET /records` 不接受 `scope` 参数同一条判据（§4.2 第 4 条的最强形式：
> **没有参数就没有传错的可能**）。管理员要替别人改，走管理台，不是这里。
>
> 🔴 **不接受 `Accept-Language`，也不认 `zh-CN` 这类。** 语言是账号上的属性（D80），
> 而且这个值会被拼进 agent 的 prompt（「用什么语言写小结」）——
> 一个没人认识的值传到那里，模型会自己发挥。库里还有 `check` 约束兜底。
>
> **不动 `token_version`。** 语言不是权限，改个语言不该把自己踢下线。

⚠️ **客户端改完必须重拉 `GET /enums`** —— 那些标签是服务端按用户语言给的，
不重拉的话核对卡上会一直是上一种语言（离线时尤其明显，缓存里那份就是唯一那份）。

### `GET /agent/health` · 免鉴权

```jsonc
{ "enabled": true, "queued": 0, "draining": false, "processed": 12,
  "lastFinishedAt": "…", "lastError": null,
  "model": "gpt-5.6-luna", "transcribeModel": "gpt-transcribe",
  "maxSteps": 8, "timeoutMs": 60000 }
```

冒烟脚本盯着 `queued` —— **队列积压是典型的「等你发现时已经影响所有人」**：
手机端一切正常、速记照收，但没有一条抽出字段，而没有人会主动去看 staging 的状态分布。

### `POST /inbox` · multipart/form-data

**D90 新增一个可选字段**：`payload.supersedesMessageId` —— 这一句是**改口重发**，
取代对话里的那条消息。服务端做的事全在派生层：

1. 校验它属于**自己这条对话**、且是 `role='user'`；对不上 → 201 里带 `supersedeFailed: true`
   （🔴 **不回滚**：这一句是人真说过的话，`inbox` 已经落库；但**必须说出来**，
   否则人以为老的那条被撤回了，其实两版都还是活的）；
2. 把**它 + 它之后的全部**记进 `message_supersede`（migration 011，`edited` / `stale_reply`）——
   🔴 `thread_message` 也只增不改，所以取代关系只能落在旁边一张派生表上；
3. 这些消息对应的 `staging` 里 `status in ('ready','failed')` 的标成 `superseded`
   （**已 `confirmed` 的一个都不碰** —— 东西在 Twenty 里了，要改走 D75 的 reconfirm）；
4. 归档这条对话的 agent 消息史，下一轮从零开始 —— 否则 D73① 的续跑会把撤回的那句话
   原样灌回模型，改口就只做了一半。

响应里多四格：`superseded`（取代掉几条）· `supersedeFailed` ·
`rewriting`（**这一轮会改写 CRM 里哪几条已入库的记录**，D108）· `otherCommitted`。

| 字段 | 说明 |
|---|---|
| `payload` | JSON 字符串，见下 |
| `audio` | 可选，二进制。⚠️ **只有速记页会带它**（D111）：AI 那一屏的录音是一次听写，<br>转完就丢，一个字节都不上传 —— 要保存的录音只在速记里（维护者 2026-08-11 定）。<br>服务端这一侧没变：给了就存，不给就没有。 |
| `photo` / `image` / `file` | 可选，可重复。**fieldname 就是附件类型** —— 自描述，不依赖数组顺序对齐 |

```jsonc
{
  "clientId": "uuid",              // 幂等键
  "companyCode": "ISTRA" | null,   // 可空
  "text": "…" | null,
  "visitLabel": "Caravan Salon 2026",
  "createdAt": 1753977000000,      // 设备本地毫秒时间戳
  "audioSeconds": 23 | null,
  "threadId": "uuid" | null,       // 002：给了就是续写，没给就新开一条
  "transcript": "…" | null         // 007：客户端已经转好了（POST /transcribe），
                                   //      服务端存进 staging.transcript 并**跳过转写**。
                                   //      老版本 PWA 不发这个字段 → 照旧自己转，新旧共存
}
// ← 201 { "inboxId","stagingId","threadId","attachments":[{id,kind,name,mime,bytes}],"duplicate":false }
//    attachments 是**清单**不是数量（issue #53）：客户端传成功就丢原件，之后靠它显示 📎 和缩略图，
//    原件走 GET /attachments/:id/file。幂等重传（200 duplicate:true）也带。
// ← 200 { …, "duplicate": true }   ← clientId 已存在，不重复创建
```

**响应必须快** —— 转写与抽取在后台跑，不阻塞手机。集成测试第 ③ 条断言它 < 3 秒返回。
**旧形状必须一直能用**（第 ④ 条）：不带 `threadId` / 附件的旧版 PWA 发上来照样 201。

### `GET /inbox?since=<iso8601>&limit=100`

**跨设备同步靠它。** 返回当前用户自己的记录，按 `created_at` 升序。
比 001 多了 `thread_id` / `staging_id` / `partial` / `attachments`（清单 `[{id,kind,name,mime,bytes}]`，issue #53 起；之前是数量），
007 起还带 `edited_text` / `edited_at` / `title`。

### `PATCH /inbox/:id/text` —— 改一条速记的正文（D68）

```jsonc
// 请求
{ "text": "集成测试：Rosenfeld 想换逆变器" }   // 允许空串；非字符串 → 400
// 响应
{ "ok": true, "stagingId": "…", "editedAt": "2026-08-05T…" }
```

🔴 **它只写 `staging.edited_text`，不碰 `inbox`。** 原话和原始转录一个字不动。

| 情况 | 状态码 |
|---|---|
| 不是自己的速记 | `404`（作用域在服务端，不看前端传什么） |
| `status ∈ {confirming, committing, confirmed}` | **`409`** —— 已经在写/写完 Twenty 了，改这里没用 |

**409 那一条必须让人看见**：返回成功而实际没生效的话，人以为改上了，
CRM 里还是错的，他不会再改第二次。要改已入库的只能去 CRM 里改。

### `POST /transcribe` · multipart/form-data —— 只转写（D69）

一个 `audio` 文件进，`{ "text": "…" }` 出。**不建 inbox、不建 staging、不跑 agent。**

AI 那一屏的流程因此变成三步：**转写 → 人改 → 发送**。
音频留在手机上，按发送时才随 `POST /inbox` 一起上来 ——
所以「录了又不想发」在服务端不留任何东西。

⚠️ 发送时要把这里拿到的文字放进 `payload.transcript`：
服务端存进 `staging.transcript` 并**跳过转写**。不带的话同一段音频会转两遍，
而两次结果不一定一样 —— **人在输入框里看到的和 agent 读到的就对不上了**。

转写失败返回 **`502`**（不是空字符串）。客户端应退回老路：
音频直接发走，服务端稍后自己转。展馆断网是常态，
而为了「让人先改一遍」这个便利把录音卡在手机里是本末倒置。

### `POST /title` —— 给一段文字起个标题（D70）

`{ "text": "…" }` → `{ "title": "…" }`。**永不失败** ——
模型不可用时返回首句启发式的结果。

### `GET /companies` · `GET /companies/search?q=`

`/companies` 供 PWA **缓存到 IndexedDB 离线使用**（展馆断网时下拉不能是空的），额外返回 `accountTypes` 白名单。
`/companies/search` 是查重接口，走和 agent 同一套 `src/match.ts` —— **两处必须是同一套规则**，
否则会出现「agent 说没找到、建的时候被拒」。

### `POST /companies` —— 新建客户

```jsonc
// →  { "name":"…", "country":"Germany", "accountType":"OEM_BRAND",
//      "parentCode":"…"?, "confirmedUnique": false }
// ← 201 { "id","code","name","country","accountType" }
// ← 422 { "error":"missing_fields", "missing":["country","accountType"] }
// ← 409 { "error":"possible_duplicate", "candidates":[ {…, "score":0.9} ] }
```

三样必填（维护者 2026-07-30）。**查重是强制的，而且在服务端** ——
命中相似项时回 409 + 候选，客户端必须显式带 `confirmedUnique: true` 才放行，那一下是**人**看过候选之后按的。

### `POST /chain/resolve` · `POST /chain/link` —— 渠道链（D54）

「客户的客户的客户」：`DISTRIBUTOR → SUB_DISTRIBUTOR → DEALER → SUB_DEALER → END_USER`，
**中间层可以缺，但不能倒**。

```jsonc
// POST /chain/resolve —— 只读，把名字对到名单
// →  { "chain": [ {"name":"KWR Reisemobile","role":"DEALER"},
//                 {"name":"KESSEL GmbH","role":"END_USER"} ] }
// ← 200 { "levels": [ { "name","role",
//                       "matched": {"id","code","name"} | null,
//                       "candidates": [ {"id","code","name","score"} ] } ] }
// ← 422 { "error":"empty" }

// POST /chain/link —— 写，逐级把下游的 soldVia 指向上游
// →  { "levels": [ {"companyId":"…"}, {"companyId":"…"} ] }   // 从上游排到下游
// ← 200 { "linked": 2, "chain":[ {"id","name","type"} ] }
// ← 404 { "error":"unknown_company" }
// ← 422 { "error":"need_at_least_two" }
// ← 422 { "error":"bad_order", "hint":"…", "got":["END_USER","DEALER"] }
```

**两个端点分开是刻意的。** `resolve` 对不上的那几层要由**人**点新建（走上面 `POST /companies`
那条强制查重的路），建客户不可逆，不可逆的动作必须有单独的一次确认。

**顺序校验在任何写入之前。** 逐级挂上游是 N 次 `PATCH`；校验放中间的话，
一条非法链会留下**半截关系** —— 比整条不写更糟，因为它看起来是对的。

🔴 **`soldVia` 不是 `parentCompany`。** 前者是渠道链（货从谁那买的），
后者是集团树（谁是谁的子公司，D19）。同一家公司可以既属于某集团又从某分销商进货 ——
**用一个字段表达两件事，两棵树会一起烂掉，而且烂了之后拆不回来。**

### `GET /enums` —— 枚举 + 中文标签

```jsonc
// ← 200 { "recordType":[{"value","label"}], "category":[…], "stage":[…],
//         "caseStatus":[…], "severity":[…], "confidence":[…], "accountType":[…] }
```

核对卡上「改一格」（手册 P8）弹出的选项就是它。**PWA 必须缓存进 IndexedDB** ——
展馆断网时那个弹层不能是空的，而改字段恰恰是现场最需要的动作。
值和标签都从 `agent/enums.ts` 来，**前端不许自己维护一份**
（自己维护 = 加了新品类界面上永远选不到）。

### 项目执行链（D59）—— 没有新端点，走同一条确认路径

`project` / `workItem` / `projectDoc` **不需要新的 HTTP 端点**：
agent 把提案写进 `staging.extracted` 的 `project` / `workItems` / `document` 三个键，
人在核对卡上点确认，`commitToTwenty()` 一次性写完。

```jsonc
// staging.extracted 里多出来的三块
{
  "recordType": "project" | "followup",     // 另外两种仍是 fitment / support
  "project":  { "projectCode","name","projectStage","ownerTeam","budgetEur",
                "primaryProductName","sampleQty","plannedSop","specSummary","openQuestions" },
  "workItems":[{ "itemCode","title","threadType","priority","ownerRole",
                 "dueDate","customerDueDate","blockedByCodes","openQuestions" }],
  "document": { "name","version","docSource","docCode","isBaseline","content","attachmentId" }
}
```

写入顺序在 `commitToTwenty()` 里是固定的，**顺序本身是正确性的一部分**：

```
项目 → 跟进（visit 回填 project + 改 visitType）→ 线程 → 依赖 → 文档
```

依赖必须**等全部线程建完再补** —— 一条线程可能依赖后建出来的那条，
先建的那时候还不知道对方的 id。

🔴 **幂等**：`projectCode` / `itemCode` 撞了就复用，不新建
（`test_example` T02 的验收断言）。编号是人给的，大小写和空格都不可靠，所以先规范化再比。

🔴 **`project.projectCode` 在提案那一刻就有值了**（D91，2026-08-07 起 · issue #18）。
以前它到「确认入库」那一刻才由网关兜底生成，于是**待确认阶段没有任何稳定的项目标识**，
看板没法把同一个项目的多条对话并起来（用项目名当键是 §4.2 第 3 条明令禁止的）。
现在 `propose_project` 落提案时就向网关取号（`src/projectCode.ts`，`suggest`/`reserve` 两个入口，
和 `GET /staging/:id/targets` 的建议编号、`commitToTwenty` 的兜底**共用同一份判断**）。
两条不变式：**同一个项目（D56：客户 + 品类）问两次给同一个号**；
**不同项目绝不给同一个号**（撞号 = 入库时第二条 update 掉第一条，两个项目静默并成一个）。
⚠️ 客户还没对上号、或 Twenty 连不上时**不发号** —— 编号前缀就是客户代号，
拿不准就让它继续空着，人在核对卡上还能拿到一个建议编号。

### `GET /threads` · `POST /threads` · `GET /threads/:id`

只返回自己的。读别人的 → **404 而不是 403**（不确认它存在）。
`GET /threads/:id` 把每条消息和它对应的 staging 一起返回，前端才能在 agent 那条消息底下挂核对卡。
D74 起每条 agent 消息还带**工作日志**：`agent_trace`（逐步轨迹）· `agent_steps` ·
`run_stop_reason` / `run_duration_ms`（最近一轮的收尾）· `staging_error`（重录失败原因）·
`confirmed_fields`（上次确认时人改过的格子 —— 重录界面显示的必须是入库的值）。
轨迹**跑完也一直在** —— 前端的 `WorkLog` 组件收起成一行标题（D88 起是「思考了 12.3s ›」，
挂在 agent 那条消息的**第一个子元素**），点开看逐步日志。

D90 起每条消息还带两格：

| 字段 | 含义 |
|---|---|
| `superseded_by` | 非空 = 这条已被改口取代，值是取代它的那条消息 id |
| `supersede_reason` | `edited` 人改了这句 · `resent` 原话重跑 · `stale_reply` 它是对被撤回那句的回应 |

🔴 **被取代的消息照样返回。** 取代 ≠ 删除，原话一个字没动 ——
前端淡一档 + 一句人话，「看不见」和「不存在」必须分得开。

### `POST /threads/:id/abort` —— 手动叫停这条对话上正在跑的那一轮（D89）

无 body。响应：

```json
{ "stopped": 1, "candidates": 1 }
```

- `stopped` = **真的递进去了停止信号的条数**。`0` 表示它已经跑完了或本来就没在跑 ——
  🔴 **前端必须把这件事说出来**，「点了停止但其实什么都没停」不许假装成功。
- 别人的对话 → **404**（和 `GET /threads/:id` 一致）。
- 排队中（`pending` / `transcribing`）和正在跑（`extracting`）**都能停** ——
  把手在 `enqueue()` 那一刻就登记，不是开跑那一刻。

**停下来之后留下什么**（issue #22 的硬要求，不需要新路径）：

| 落点 | 值 |
|---|---|
| `staging.status` | `ready`（**不是** failed）· `partial = true` |
| `staging.extracted` | 已经 `propose_fields` 过的字段**原样都在**（partial-first） |
| `staging.error` | 以「你叫停了」开头 —— `ReviewCard` 按它说话，不说成「到了处理上限」 |
| `staging.agent_trace` | 已跑完的每一步原样写入 |
| `agent_run` | `status='partial'` · `stop_reason='aborted'` · `stage='你叫停了'` |
| `thread_message` | 插一条 agent 收尾消息 —— 否则前端的 `waiting` 永远不落地 |

⚠️ 和 `DELETE /staging/:id/confirm` **完全不是一回事**：那个撤的是 D48 的 5 秒延迟入库，
这个撤的是模型这一轮。两者一个字都不共用。

⚠️ 把手在**网关进程的内存里**。网关重启 = 正在跑的那一轮变孤儿（和重启前一样，`resumePending` 会捡回来）。

### `GET /staging?status=ready`

**只返回自己的，没有 `scope` 参数**（D76②，2026-08-07 起）。

以前它接受 `scope=all`，`canSeeBoard` 的角色传了就能翻出全公司的待确认队列。
维护者 2026-08-07 把权限定成「无论是 admin 还是其他任何权限，你都只能访问自己写的内容」，
于是这个参数**整个删掉**了 —— 没有参数就没有传错参数的可能。
响应里的 `scope` 保留成常量 `"own"`，让调用方一眼看出这件事，而不是靠读文档相信它。

### `GET /records` —— 我的记录表格（D76 · 看板）

```jsonc
// ← 403 { "error":"board_forbidden" }        // role === 'user'，这一屏对他整个关闭
// ← 200 { "items":[…], "scope":"own" }
```

**和 `GET /staging` 的区别是一个参数，而那个参数决定了整屏的性质：**
`/staging?status=ready` 只回答「还有什么没确认」，确认完一条那条就从结果里消失；
`/records` **不按状态过滤**，回答「我到底记了些什么、哪些进去了哪些没进去」。
失败的、被取代的、还在跑的都在里面 —— 不返回的话，一条录了却没进 CRM 的记录
在人这边彻底不存在，而那是这个仓库最贵的一类 bug。

每行（`staging` ⨝ `inbox`，按 `inbox.created_at` 倒序，上限 300）：

| 字段 | 说明 |
|---|---|
| `id` · `inbox_id` · `status` | `status` 是全部九档，不只 `ready` |
| `text` | 三层里最靠下那层：`edited_text` → `transcript` → `inbox.text`（空串不算） |
| `title` | 自动标题（issue #15）。表格上优先显示它 |
| `extracted` · `confirmed_fields` | 显示要 `{...extracted, ...confirmed_fields}`，顺序和 `commitToTwenty` 一致 |
| `twenty_refs` · `confirm_after` · `confidence` · `partial` · `suggested_company` · `error` | 已入库的行点开就是核对卡的重录模式，这几个是它的入参 |
| `resolved_company_id` · `company_code` | **客户名不在服务端解析** —— PWA 用缓存的客户名单对，断网时表格照样有客户名 |
| `thread_id` | `coalesce(inbox, staging)`：补送给 AI 的对话记在 staging 上 |
| `captured_at` · `updated_at` · `audio_seconds` · `visit_label` · `supersedes` · `attachments` | |

**两道口子都在服务端**：① `role === 'user'` → 403（不是空列表 —— 「没权限」和
「你还没记过东西」必须分得开）；② 没有 `scope` 参数，`where inbox.user_id = 当前用户` 写死。

⚠️ **搜索没有服务端接口，是刻意的。** PWA 在这 300 行上做纯前端匹配 ——
数据已经全在手上并缓存进 Dexie，走服务端只会让**断网时搜不了**，而展馆断网是常态。
代价是搜索范围就是这 300 条，**PWA 在表尾明说这件事**（不许有静默的上限）。
哪天真要搜全部，再加服务端搜索，那时这个前端搜索就是它的离线降级。

⚠️ **首次确认不走这个接口。** 看板上 `ready` 的行点开是只读的，出口是「去对话里确认」——
确认要看 agent 整轮的工作日志，那是 `GET /threads/:id` 的事。
这一屏能写的只有**已入库之后的重录**（`POST /staging/:id/reconfirm`）。

### `POST /staging/:id/confirm` —— 确认入库（5 秒延迟提交，D48）

```jsonc
// →  { "companyId":"…",                       // 必填（D28 修订的闸门在这里）
//      "fields": { "stage":"RFQ_QUOTE" }?,     // 人「改一格」改过的（手册 P8）
//      "supportCaseId":"…"? }                  // 人选的「接在这条售后上」（D57）
// ← 422 { "error":"company_required" }
// ← 422 { "error":"bad_field_value", "rejected":["stage=我瞎编的"] }
```

🔴 **`fields` 和 agent 走同一套白名单。** 「不指望模型自觉」对客户端同样成立 ——
而且客户端更不该信：agent 至少在我们自己的进程里跑。
只认六个键（`recordType` / `category` / `stage` / `caseStatus` / `severity` / `sourceConfidence`），
非法值 **422 拒掉整次请求**（悄悄当成「没改」入库最糟：人看到「已入库」，
CRM 里躺着的还是他刚亲手改掉的那个值），不认识的键静默丢弃。

```jsonc
// →  { "companyId": "twenty-uuid",     // 必填 —— D28 修订的闸门就在这里
//      "fields": { … } }
// ← 200 { "queued": true, "commitAt": "…", "undoMs": 5000 }
// ← 422 { "error":"company_required" }
```

**不立即写 Twenty。** 落 `staging.confirm_after = now()+5s`，由 1 秒一跳的心跳提交。
状态在**库里**而不是内存里的 `setTimeout` —— 网关重启不会丢掉一次已经点过的确认。

### `GET /staging/:id/targets?companyId=&category=&supplierName=` —— 这条会接到哪

```jsonc
// ← 200 {
//   "openCases": [ { "id","name","caseStatus","statusLabel","severity","reportedAt" } ],
//   "opportunity": { "id","name","stage","stageLabel" } | null,
//   "supplierUnmatched": "Norvolta" | null
// }
```

**纯只读。** 核对卡在入库之前拿它把落点摆出来（D57）：

- `openCases` —— 这家还没关掉的售后。人点了「接在这条上」，确认时才带 `supportCaseId`。
  **默认是新开一条** —— 自动接最近那条看着聪明，但一家客户同时有两个未结案时猜错，
  就是把两件不相干的事并成一条，而看板上它仍然只是一条正常记录。
- `opportunity` —— 该品类在推进的项目（D56：同一家 + 同一品类 = 同一个项目）。
- `supplierUnmatched` —— 🔴 在位品牌对不上受控名单（D23a/D58）。**界面必须说出来**：
  那一格不会进 CRM，原话会写进「来源说明」。不说就是安静的失败。

`companyId` 由客户端传 —— 它是人**刚在卡片上选的**那家，还没写进 staging。

### `DELETE /staging/:id/confirm` —— 撤销

```jsonc
// ← 200 { "cancelled": true }
// ← 409 { "error": "too_late" }   ← 已经过了窗口，Twenty 里已经有了
```

🔴 **撤销不是删记录。** 这 5 秒里撤销 = 那次写入从来没有发生过。
整个系统里**不存在删 Twenty 记录的路径** —— 这正是当初把「撤销」改成延迟提交的原因。
D75 起它还兼管**重录的撤销**：那时恢复的是「上一次提交后的样子」
（字段弹回、`commit_history` 弹出最后一条、状态回 `confirmed`）。

### `POST /staging/:id/reconfirm` —— 重录（D75，入库之后改字段重新提交）

```jsonc
// →  { "fields": { "severity":"HIGH", … } }   // 只发改过的格子；白名单同 confirm
// ← 200 { "commitAt":"…", "undoMs":5000 }     // 沿用同一个 5 秒撤销窗
// ← 409 { "error":"not_confirmed" }           // 只有已入库（confirmed）的才能重录
// ← 409 { "error":"code_conflict", "message":"…" }   // 编号已属于另一个项目 —— 当场说
// ← 422 { "error":"record_type_locked", "message":"…" } // 类型锁：选型↔售后是两条生命周期
// ← 422 { "error":"company_locked", "message":"…" }     // 客户锁：换归属去 CRM 里做
// ← 422 { "error":"bad_field_value", "rejected":[…] }
```

🔴 **「替代」= `commitToTwenty` 的 update 模式按 `twenty_refs` 逐条 PATCH，绝不新建第二份。**
系统里没有删除路径，新建一份旧的还在 —— 那不是替代是复制。
每次重录前，上一次的 `{at, by, fields, refs}` 推进 `staging.commit_history`（审计，migration 009）。
追加型售后只 PATCH 状态/严重度，不重复追加正文（正文是 append-only 的时间线）。

### `POST /staging/confirm-batch`

```jsonc
// →  { "items": [ { "id":"…", "companyId":"…" } ] }   // 最多 100 条
// ← 200 { "results":[{ "id","ok","reason"? }], "undoMs": 5000 }
```

没定客户的一条都不放行 —— D28 的闸门对批量同样成立，不能因为「批量」就松口。

### `GET /gaps/:code` —— 情报缺口

```jsonc
{ "code":"ALPIN", "completeness": 62,
  "missing":[ { "key":"annual_production","question":"年产量是多少","wave":1,"weight":3 } ] }
```

完整度只按**有权重**的项算。agent 造的那些 `weight=0`，不进分母 ——
否则它造得越多，所有客户的完整度看起来越低，那个指标当场作废（D47 护栏③）。

### `POST /surveys` —— 交一份 2C 问卷（D138）· JSON

**不走 agent、不进 inbox、没有确认卡**：表单本身就是结构化的，网关直接写 Twenty。

```jsonc
{ "clientId": "<uuid，幂等键>", "surveyKey": "vdl2026",
  "answers": { "equipment": ["solar"], "appliances": { "fridge": "have", "ac": "want" },
               "install": "pro", "brand_chooser": "installer", "overnight": ["aire"],
               "camping_pain": "…", "wish": "…" },
  "contact": { "name": "…", "phone": "…", "email": "…", "postcode": "…" },   // 都可空
  "consentAt": "2026-09-27T10:00:00Z",   // 有 name/phone/email 时必填
  "createdAt": 1790518882646 }           // 手机上填的时间（ms）
```

| 回包 | 意思 |
|---|---|
| `201 {id,status}` | 收下了；进 Twenty 是网关自己的事，不等 |
| `200 {id,status,duplicate:true}` | 同一个 `clientId` 交过了（断网重传），不多一行 |
| `400 missing_client_id` · `422 unknown_survey / consent_required / empty` · `409 client_id_taken` | 见 `src/survey.ts` |

答案按白名单清洗：不认识的题、选项、状态一律丢掉。选项 id 三处对账（PWA `survey.ts` · 网关 `survey.ts` · `twenty-schema.mjs`），
`src/__tests__/survey.test.ts` 红了就是对不上。写 Twenty 进不去时 `GET /agent/health` 的 `surveys.failed` 会涨。

### 订单门户 · `/portal/*`（D139–D142）· 独立的 `X-Portal-Secret`

**完整契约在 [`docs/portal-projects.md`](portal-projects.md) §4**（请求体、快照形状、错误码）；这里只记和别的端点不一样的地方。

| 项 | 规则 |
|---|---|
| 谁调 | **只有订单门户的服务端**，走本机 `http://127.0.0.1:4000`（compose 里 gateway 只绑回环）。Caddy 对外把 `/api/portal/*` 回 **404** —— Cloudflare Flexible 的回源段是明文，secret 不能过公网（D141） |
| 鉴权 | 头 `X-Portal-Secret` = `PORTAL_SECRET`。**留空 = 整组 503 `portal_disabled`**；错/缺 → 401 `bad_secret`（故意慢 400ms）；**放进 URL 一律不认** |
| 操作人 | 可选头 `X-Portal-Actor`（门户 admin 用户名）→ 进展的 `authorName`。门户账号不进 CRM（规则 5） |
| Twenty 出错 | 一律 **502 `twenty_unavailable`，不回显 Twenty 原文** —— 门户据此改用它的缓存 |
| 关系 | 只收已存在的 UUID（规则 3）：公司 / 类型 / 阶段逐个回读；阶段必须属于项目的类型 |
| 删除 | `DELETE /portal/updates/:id` 只走 GraphQL 软删（§2.38）。项目不删（改状态 / 取消公开） |
| 快照缓存 | 进程内约 15 秒，**任何一次写都作废** |

路由：`GET /portal/snapshot` · `POST /portal/project-types` · `PATCH /portal/project-types/:id` ·
`POST /portal/projects` · `PATCH /portal/projects/:id` · `POST /portal/projects/:id/updates` ·
`PATCH /portal/updates/:id` · `DELETE /portal/updates/:id`。`GET /agent/health` 多一格 `portal: "on"|"off"`。

核对上线：`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4000/portal/snapshot` 应为 **401**
（503 = secret 没进容器，404 = 路由没注册或打到了 Caddy）。

### 管理控制台 · 独立的 `X-Admin-Token`，不是 PWA 的 JWT

| 路由 | 鉴权 | 说明 |
|---|---|---|
| `GET /admin` | 无 | 只是个 HTML 壳，数据全靠下面的接口。**页面路径不是秘密，token 才是** |
| `GET /admin/users` | `X-Admin-Token` | 列表，带每个人录过多少条 |
| `POST /admin/users` | `X-Admin-Token` | **密码由服务端随机生成并只回显一次**，不接受客户端传入 |
| `POST /admin/users/:code/deactivate` | `X-Admin-Token` | 停用 + `token_version+1` → 本人当场下线 |
| `POST /admin/users/:code/activate` | `X-Admin-Token` | 密码不变 |
| `DELETE /admin/users/:code` | `X-Admin-Token` | **只允许删一条速记都没有的账号**（原文只增不改，有外键挡着） |

🔴 **`ADMIN_TOKEN` 只走请求头，绝不进 URL。** 留空 = 整个控制台 503 关闭（安全默认，不是故障）。

⚠️ **网关的路由永远是 `/admin`，它不认识 `ADMIN_PATH`。**
对外那个不好猜的路径由 **Caddy**（线上）和 **vite proxy**（本地）负责重写，
默认 `/console`。改 `ADMIN_PATH` 之后要重起的是 caddy / vite，不是网关。

管理台 2026-08-17 起多四条（T93）：`POST /admin/users/:code/password`（补发密码，只回显一次）·
`GET /admin/channels`（渠道账号 + 群列表）· `POST /admin/channels/conversations/:id`（配出站 webhook）·
`POST /admin/channels/identities/:id/rebind`（改绑到已有账号，只影响之后的记录）。

### 钉钉：两个 bot，两个端点，**一把钥匙**

| 端点 | 是谁 | 干什么 | 设计文档 |
|---|---|---|---|
| `POST /channels/dingtalk/events` | 速记 bot | 群里 @ 一句话 → 走完整管道进 CRM | `docs/dingtalk-channel.md` |
| `POST /channels/lab/events` | 实验室 bot | 空 agent，问答；**一条写 CRM 的路径都没有** | `docs/lab-agent.md` |

两个都走 `X-Channel-Secret` 头，而且**默认是同一个值**：
`CHANNEL_DINGTALK_SECRET`。`CHANNEL_LAB_SECRET` 是可选覆盖 ——
配了实验室那个端点就只认它，不配就回退到共用的那个（`env.ts` 里那一行）。
**两个都空 = 两个端点都 503**（D66 式安全默认，展会前就该是这样）。

> ⚠️ **共用钥匙的含义要说清**：拿到 secret 的人两个端点都打得到。
> 两条流程都是内部钉钉工作台里自己建的，这个代价是明知道并且接受的
> （维护者 2026-08-17：「两个入口共用一个 secret 吧」）。
> 真要拆成两把，配上 `CHANNEL_LAB_SECRET` 即可，代码不用动。

### `POST /channels/dingtalk/events` —— 钉钉渠道入口（T93 · D117–D120）

**设计全文见 `docs/dingtalk-channel.md`。**

```jsonc
// →（钉钉流程节点②的形状就是契约 —— 六字段是平台支持的全部）
{ "message": { "content": "…", "images": ["https://…"], "sender": "唯一稳定 ID",
               "send_time": 1755400000000, "group_name": "群名", "mentioned_users": [] } }
// ← 永远 200（除 401/503）：
{ "ok": true, "kind": "ack" | "final",   // final = 这条同步回复就是终局
  "noteId": "inboxId" | null,
  "ding": { "msgtype": "markdown", … } } // 完整的一条钉钉消息，流程节点③原样透传
```

同步半边：自动建号（D118）→ 幂等（合成 `client_id`）→ 命令层 → L1 门卫（D119）→
`ingest()` 落 inbox（`source='dingtalk'`，每条都开对话走 agent）。
异步半边：`channels/outbound.ts` 轮询 ready/终局 failed → 回执发到该群的
自定义机器人 webhook（管理台登记；投递账在 `channel_event`，只发一次，D120）。
新表三张：`channel_identity` / `channel_event`（只增）/ `channel_conversation`（migration 015）。

### `POST /channels/lab/events` —— 实验室 agent 入口（T94 · D121）

**设计全文见 `docs/lab-agent.md`。** 群里的第二个 bot：同一套 Pi runtime，
**空工具表**（只有 `read_skill`）、自己的 skill 目录（`agent/skills-lab/`）、
自己的消息史目录。**它不写任何业务表** —— 不落 `inbox`、不落 `staging`，
整个模块不 import `agent/src/tools/`。

```jsonc
// → 报文形状和速记 bot 完全一样（同一个流程编排平台，同样六个字段）
{ "message": { "content": "…", "images": [], "sender": "…",
               "send_time": 1755500000000, "group_name": "…", "mentioned_users": [] } }
// ← 永远 200（除 401/503）：
{ "ok": true,
  "kind": "final" | "ack",   // final = 这条同步回复就是答案；ack = 稍后走群 webhook 补一条
  "runId": "uuid" | null,    // lab_run 那一行，排障看它
  "ding": { "msgtype": "markdown", … } }   // 整条钉钉消息，流程节点③原样透传
```

| 行为 | 说明 |
|---|---|
| 会话 | `(群, 人)` + **滑动**窗口（`LAB_SESSION_WINDOW_MIN`，默认 30 分钟）→ `lab_session`；窗口内沿用同一份 Pi 消息史 |
| 投递 | 先同步等 `LAB_SYNC_WAIT_MS`（默认 12s）→ 一条答完；等不到回 `ack`，答案随后走该群的 webhook（**自动复用速记 bot 已登记的那个**） |
| 记账 | 每轮一行 `lab_run`；`delivery` ∈ `sync` / `webhook` / **`dropped`**（没送出去）/ `pending` |
| 幂等 | 同一份报文重放不重跑（复用 `payload.ts` 的合成键，落 `channel_event`） |
| 限频 | 每人 20 条/小时（内存计数） |

新表两张：`lab_session` / `lab_run`（migration 016）。

---

## 3. 后台处理链

```
POST /inbox 落库并立即返回 201
      │
      ├─ 预处理（**在 agent 之外**，D46b）
      │    音频 → OpenAI 转写（gpt-transcribe）→ staging.transcript
      │    附件 → officeparser（worker_thread）/ 视觉模型 → attachment_text
      │
      └─ agent（Pi · src/agent/）—— 输入类型只有一个：字符串
             ├ Ring 1 只读：search_companies · get_thread · get_company_gaps · read_attachment · list_enums
             ├ Ring 2 写提案：propose_fields · ask_user · flag_new_company · propose_intel_field
             └ Ring 3 压根没注册：create_company · write_twenty · confirm_to_crm · update_inbox · delete_anything
             上限 8 步 / 60 秒，超了写 partial
      →  staging.extracted + confidence，status = ready
      →  人在界面上核对、定客户、点确认 → 5 秒后 commitToTwenty()
```

**失败不丢数据**：任何一步炸了，`inbox` 那条原文都还在，`staging.status = failed` + `error`，可重跑。
这是「三段解耦」的服务端一半。细节见 [`agent.md`](agent.md)。

---

## 4. 已知缺口（明确记下，不假装解决了）

| # | 缺口 |
|---|---|
| 1 | **音频与附件不在 `pg_dump` 里** —— 备份脚本要单独同步那个目录 |
| 2 | `POST /inbox` 目前没有限速 —— 外部录入者开放前（D20）必须加（R9） |
| 3 | 转写语言未固定。展会现场是德/英/意混杂，先让模型自动判定，实测后再决定要不要指定 |
| 4 | `AGENT_CAN_CREATE_COLUMNS=1` 那条路径**尚未实现**（开关在，行为不变）。理由见规划文档 D47 |
| 5 | 附件走的是 `GATEWAY_AUDIO_DIR` 同一个卷。量大之后要分开，现在没必要 |
