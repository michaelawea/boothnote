# 架构总览

> 新人接手先读这一份，再读 [`gateway-contract.md`](gateway-contract.md)（接口）和 [`agent.md`](agent.md)（AI 那半）。
> 「为什么这么设计」在 内部设计日志（未公开） §3 的决策表里，每条都带理由和代价。

## 1. 三个面，互不依赖

```
apps/capture-pwa/     写入端  展会现场手机速记 PWA，离线优先
services/gateway/     网关    PWA 与 Twenty 之间唯一的写入闸门（含 agent）
（Twenty 官方镜像）    内核台  数据与领域模型，零改源码
```

**这不是分层，是分段。** 分层的东西一起挂，分段的东西各自还能活：

```
速记 ──▶ 本地 IndexedDB ──▶ 网关 inbox ──▶ 确认后进 Twenty
      不依赖 Agent      不依赖 Twenty    不依赖现场网络
```

任何一段挂掉，**前一段的数据都还在**。这条性质是整个架构里最重要的一件事 ——
展会 10 天说过的话是全项目唯一不可再生的资产。

## 2. 一条速记的完整旅程

```
① 手机上按一下说话
      │  写进 IndexedDB，标 queued        ← 到这里就算「成功」了，有没有网都一样
      ▼
② sync.ts 前台重试（iOS 没有 Background Sync，所以必须前台跑）
      │  multipart：payload + audio + photo/image/file
      ▼
③ POST /inbox                              ← **< 3 秒返回 201**，不等 AI
      │  inbox（只增不改）+ staging + thread_message + attachment
      ▼
④ 预处理（**在 agent 之外**，D46b 修订为「agent 只吃封装好的输入」）
      │  音频 → gpt-transcribe → staging.transcript
      │  附件 → **原生喂给模型**（input_image / input_file，D71）；
      │        超 10MB 或探测不支持才降级 officeparser(worker_thread)
      ▼
⑤ Pi agent
      │  **15 个工具**（含 read_skill）· 上限 8 步（带附件 +6）/ **120 秒**
      │  · 打法走 agent/skills/ 的 SKILL.md（D72，改 playbook 不发版）
      │  · 同对话可续跑（D73）· 超了写 partial 而不是失败
      ▼
⑥ staging.status = ready
      │  手机上那条 agent 消息底下浮出一张核对卡
      ▼
⑦ 人核对、定客户、点确认        ← D28 修订的闸门：录入时可空，入库时必填
      │  排队，staging.status = confirming
      ▼
⑧ 5 秒后 commitToTwenty()       ← D48：这 5 秒里撤销 = 从来没写过
         按 recordType 分流：选型情报 / 售后问题 / 项目+线程+文档
         每条都带 sourceInboxId，可追溯回原话
```

**第 ⑦ 步之前，没有任何东西进 CRM。** agent 的工具清单里一个能写的都没有。

## 3. 模块地图

### `apps/capture-pwa/`（React + Vite + Dexie，打包 ~111 KB gzip）

| 文件 | 干什么 |
|---|---|
| `App.tsx` | 五槽：速记 · 客户 · **[AI]** · 看板 · 我的。中间那个不是页面，是弹起一整屏对话。**手机是底栏、≥900px 是左侧栏 —— 纯 CSS 二选一，零 JS 分支**（D77）。界面语言跟账号走（`locale`，D80） |
| `pages/QuickNote.tsx` | 默认屏。录音 / 打字 / 三类附件 / 我的速记列表 |
| `pages/Chat.tsx` | AI 全屏对话（ChatGPT 形态）。agent 那条消息底下挂核对卡 —— **这是它和聊天机器人的分界** |
| `pages/Companies.tsx` | 客户 + 情报缺口 |
| `pages/Board.tsx` | **「我的记录」表格**（D76，不是 inbox）：`GET /records` 不按状态过滤，三列 + 分组（项目/时间/客户）+ 筛选搜索收在漏斗下。**作用域一律只有自己写的，admin 也一样**；`user` 角色 403。首次确认只走对话页，这里只有已入库的行能改（走 D75 的 reconfirm） |
| `pages/Onboarding.tsx` | 两屏，各自对应一个不可逆的失败（装主屏幕 / iOS 麦克风只问一次） |
| `components/ReviewCard.tsx` | 核对卡 —— 人和 agent 唯一的交接点 |
| `components/ChainCard.tsx` | 渠道链（D54）。逐级显示「对上了 / 名单里没有」，人点了才建、才连 |
| `components/ProjectCard.tsx` | 项目 / 任务线程 / 文档三块提案（D59）。**确认之前必须看得见** |
| `components/PickSheet.tsx` | 底部弹层。「改一格」「接在哪条上」共用它 |
| `components/CompanyPicker.tsx` | 选客户 + 新建（强制查重） |
| `db.ts` | 本地库 = 采集端的真相源。`myNotes()` **所有读速记的地方都必须走它**（T30） |
| `sync.ts` | 上行 + 下行。前台重试，不用 Background Sync（iOS 没有） |
| `auth.ts` | 缓存放行 + 后台 `/me` 校验，**只有 401 才登出**（D36） |
| `update.ts` | **注册 Service Worker + 换版本，只有这一份实现**（D83）。切回前台就检查；自动刷新有闸门（录音/草稿/上传/对话开着一律不刷） |
| `i18n.ts` | 中文原文当 key 的字典（D80）。`t()` **绝不能在模块级求值** |
| `attach.ts` | 附件准入（纯逻辑，好测） |
| `recorder.ts` | 容器协商。iOS 18.4 之前只能 mp4，所以**不能写死** |

### `services/gateway/`（Fastify + postgres.js，无构建步骤）

| 文件 | 干什么 |
|---|---|
| `index.ts` | 全部端点。鉴权钩子**每次请求查库** —— 撤权立即生效 |
| `confirm.ts` | **整个系统里唯一往 CRM 写东西的地方**。5 秒延迟提交 + 心跳 |
| `match.ts` | 名字匹配。agent 查客户和新建查重**共用同一套规则** |
| `twenty.ts` | Twenty 客户端。只走 REST API，绝不直连它的表（D8） |
| `agent/` | 见 [`agent.md`](agent.md) |
| `admin.ts` / `admin-page.ts` | 管理控制台。独立的 `X-Admin-Token`，与 PWA 完全分开 |
| `migrations/` | 编号 .sql，按序执行、记在 `schema_migrations` |

### `scripts/` 里三个「唯一真相源」

| 脚本 | 管什么 | 什么时候跑 |
|---|---|---|
| `twenty-schema.mjs` + `provision-twenty.mjs` | Twenty 上**有哪些对象和字段** | 改 schema 后 · `deploy.sh` 自动 |
| `provision-views.mjs` | 人打开 CRM **看到什么**（列 / 排序 / 筛选 / 看板分栏）| 改视图后 · `deploy.sh` 自动 |
| `backfill-timeline.mjs` | Timeline 对账：**补**历史记录的事件 · **清**指向已删记录的孤儿 | 部署后 · `deploy.sh` 自动 |

三个都是**声明式 + 幂等**的。**不要在 Twenty 界面上手点配置** ——
手点的东西换个环境（或者重建工作区）就没了，而且没有人记得当初为什么那么配。

### Timeline 为什么要我们自己写（D61）

Twenty **只给「记录自己」写事件**：建一条 Visit → 写一条 `visit.created` 挂在那条 Visit 上，
它关联到的客户、录入人、项目身上**一行都没有**。于是最该有履历的三个页面全是空的。

我们在 `commitToTwenty()` 的最后补一条 `linked-<对象>.created`，一次 POST 挂多个 target。
**这是装饰不是资产** —— 写失败一律吞掉：到那一步记录已经建好了，
为一行 timeline 把整条 commit 推回 `ready`，人会再点一次确认，那才是真事故。

### 那条最容易被违反的纪律

**不改 Twenty 的源码，不 fork，不直连它的数据库表。**（D8）
内部设计日志（未公开） §4.1「Upstream 改动清单」预期**永久为空** ——
那张表里出现第一行，意味着 D8 被推翻了，必须先改文档再动代码。

### 一条记录会长成什么（D25 / D59）

```
Company 客户
 └─ Opportunity 商机 ────── 成交之前：这单能不能做成（阶段、决策窗口、预算、竞品）
      └─ Project 项目 ───── 定点之后：怎么交付（编号唯一、里程碑、样品、SOP）
           ├─ Visit 跟进 ── 一次接触（visitType=projectFollowup）
           │    └─ WorkItem 任务线程 ── 可独立分派、有依赖、有两个日期
           └─ ProjectDoc 文档 ──────── 🔴 来源必须分得开
 └─ SupportCase 售后 ────── 已交付之后：从发生到关闭（和商机方向相反，D25）
 └─ ProductFitment 选型 ─── 只追加的日志：能看出「5 月说 Voltaro、7 月改口」
```

**商机和项目不能合并。** 商机回答「这单能不能做成」，项目回答「做成之后怎么交付」——
合并的后果是定点那一刻要么丢掉售前的推进历史，要么让「阶段」同时表达两件事。

**`ProjectDoc.docSource` 是那个对象存在的全部理由**：客户给的规格书、AI 整理的稿子、
按口述记的需求，三者在 CRM 里长得一样的话，**迟早有人拿 AI 整理的参数去下单**。
所以 AI 生成的一律落 `DRAFT`，「客户已确认」这个状态只有人能给。

### 客户之间的两根轴，**不能混**

| 字段 | 回答的问题 | 定案 |
|---|---|---|
| `Company.parentCompany` | 谁是谁的**子公司** —— 集团树 | D19（29 集团 / 51 子集团 / 61 品牌） |
| `Company.soldVia` | 货是**从谁那买的** —— 渠道链 | D54（`DISTRIBUTOR → SUB_DISTRIBUTOR → DEALER → SUB_DEALER → END_USER`，中间可缺、不能倒） |

同一家公司可以既属于某集团、又从某分销商进货。
**用一个字段表达两件事，两棵树会一起烂掉，而且烂了之后没有任何办法拆回来** ——
集成测试里专门有一条断言：建完渠道链之后 `parentCompany` 仍然是 null。

## 4. 数据在哪

| 放哪 | 什么 | 备份 |
|---|---|---|
| `boothnote` 库（9 张表） | 账号 · 原文 · 派生 · 对话 · 附件元信息 · agent 轨迹 | `pg_dump` |
| `${GATEWAY_AUDIO_DIR}` | 音频与附件**原件** | 🔴 **不在 pg_dump 里**，要单独同步 |
| Twenty 的 `default` 库 | 确认之后的正式数据 | `pg_dump`（另一个库，D33 物理隔离） |

## 5. 三条会反复用到的判据

1. **「这行东西丢了能不能再生？」** —— 决定它要不要只增不改的触发器。
   人说的话、拍的照片：再生不了。转写、解析文本、抽取结果：随时能重跑。
2. **「这个判断需要多少证据？」** —— 决定它归 agent 还是归人。
   「这句话说的是哪家客户」一句话就够，给 agent；
   「这个字段值不值得占所有人界面上的一列」需要跨客户的证据，留给人（D47）。
3. **「这个检查在本地会不会永远是红的？」** —— 决定它进哪一层测试。
   一个在本地永远红的检查，很快就会被人无视，那时它连线上也保不住了。
