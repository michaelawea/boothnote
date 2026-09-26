# 实验室 agent —— 群里的第二个 bot

> **一句话**：同一套 Pi runtime，空工具表，自己的一份 skill 目录。
> 装配好了机器，功能那一格留空 —— 往 `agent/skills-lab/` 丢一本 SKILL.md，它就有本事了。
> 决策：D121 · 任务 T94 · 2026-08-17。

## 1. 它和录入 bot 的关系：零共用

群里**两个 bot，两条流程，两个 secret**。

| | 速记 bot（录入） | 实验室 bot |
|---|---|---|
| 端点 | `/api/channels/dingtalk/events` | `/api/channels/lab/events` |
| secret | `CHANNEL_DINGTALK_SECRET` | **共用同一个**（`CHANNEL_LAB_SECRET` 是可选覆盖） |
| 工具 | 15 个 | **4 个**（见下，一个能写的都没有） |
| skill 目录 | `agent/skills/`（4 本） | `agent/skills-lab/`（现在 1 本：example-products） |
| 消息史 | `agent-sessions/` | `agent-lab-sessions/` |
| 会不会写 CRM | 人确认后写 | **一条路径都没有** |
| 关掉一个 | 另一个不受影响 | 同左 |

🔴 **底座 prompt 里写死了「我不负责录入」** —— 人把要存档的客户情报说给这个 bot 的话，
它会明确让你去 @ 速记 bot，而不是假装记下了。搞错对象 = 那句话只是聊天记录，
不进 inbox、不进 CRM，而这种失败**没有任何东西会提醒你**。

## 2. 交互形态

```
[人]  @实验室 我们对 Alpin 的报价口径是什么？
[bot] （12 秒内答完 → 一条消息直接回答）
      （超过 12 秒 → 先回「🤔 这个问题要想一会儿」，答完走群 webhook 补一条）
```

> ⚠️ 上面是**旧端点** `/channels/lab/events` 的形态（过渡期仍然有效）。
> D127 之后统一入口（`/channels/dingtalk/events`）路由过来的提问**不再同步等**：
> ack 立即回「🧪 已转给实验室助手」，答案一律走群 webhook。核心同一份（`runLabForEvent`），
> 会话/账本/幂等不分入口。

- **会话**：同一个群 + 同一个人，**30 分钟内算同一段对话**（`LAB_SESSION_WINDOW_MIN`）。
  窗口从最后一条消息起算（滑动）—— 连着聊两小时不会被拦腰切断。
  超过窗口自动重开一段，模型不会记得之前的。
- **两个人各聊各的**：会话键是（群 + 人），互不串线。
- `帮助` 会说清它是谁、窗口多久、以及它不负责录入。
- 限频：每人 20 条/小时。

**为什么是「先同步等一会儿」而不是一律异步**：一律异步的话群里每次都是两条消息，很吵；
一律同步又会撞钉钉流程 HTTP 节点的 30 秒超时（公网还隔着 Cloudflare 的 100 秒硬超时）。
所以等 12 秒，等到就一条答完，等不到才转 webhook 那条腿。

## 2.5 已装的 skill：example-products（T95 · D124）

Voltline 产品专家 —— 选型、规格、认证、文档查询与调取。**一个 Microsoft 凭据都没有。**

| 工具 | 干什么 | 碰网吗 |
|---|---|---|
| `read_skill` | 读 SKILL.md 全文（渐进披露） | 否 |
| `search_specs(关键词)` | 搜 10 份产品资料（目录/电池/板/逆变器/控制器/充电器/IoT/配件/认证/文档索引） | 否 |
| `find_document(sku, 类型)` | 查 560 个文件的索引：有哪些文档、多大、什么时候更新 | 否 |
| `fetch_document(路径)` | 下载并读出文档文字（PDF/Office） | **是，唯一一个** |

### 🔴 为什么没用 Microsoft Graph

原 skill 包里带的是 维护者 **本人账号的委托令牌 + client secret**，已授权 scope 含
`mail.send` / `mail.readwrite` / `files.readwrite.all` / `sites.readwrite.all` ——
拿到它就能用他的身份收发邮件。**那套东西一个字节都没进这个仓库。**

改用 SharePoint 的**匿名共享链接**（`Anyone with the link`）。2026-08-17 实测：

| 测试 | 结果 |
|---|---|
| 打开共享链接 | 302 + `FedAuth` cookie（`urn:spo:tenantanon`） |
| 带 cookie 按路径取文件 | 200 · `application/pdf` · 字节数与索引分毫不差 |
| **不带 cookie** | **403** |
| 端到端（真下载 1.2MB datasheet + 解析） | 2.8 秒出 3270 字规格文字；第二次 0.1 秒走缓存 |

它的能力**只有那一个文件夹、只读**；撤销 = 在 SharePoint 里删掉那条链接。

⚠️ 那条链接存 `.env`（`PRODUCT_DOCS_SHARE_URL`）。**它对公司内所有人开放**
（维护者 2026-08-17：「SharePoint 的链接是开放给所有人用的，不存在信息敏感」），
所以 bot **可以把它发进群里** —— `find_document` 的结果就带着它，
人点开能自己看原件（尤其是扫描的认证件、图纸这种解析不出文字的）。
留空 = `fetch_document` **整个不注册**，只剩本地查询。

🔴 **能发的是共享链接（文档库入口），不是拼出来的直连文件地址** ——
实测直连地址在没有那个匿名会话 cookie 时是 **403**，发给人点不开。

### 三道闸门（都有变异测试）

1. **路径必须逐字命中索引** —— 模型自由拼的路径一律拒（`../`、别的库、`.bak` 后缀都试过）
2. **拼出来的地址必须落在那一个库底下**，逐段百分号编码，host 写死
3. **单文件上限 25MB** · 图片/3D 模型不下（读不了内容，只报告存在）· 下过的进磁盘缓存

### 定价：默认全开（维护者 2026-08-17 定）

> 「定价是都可以询问的，因为钉钉都是我们内部用的，不存在定价泄漏的问题。」

`LAB_PRICING_GROUPS` **留空 = 所有群都能问**；填了群名 = **收窄**到那几个群。

定价资料本身仍然**不进 git**（`PRODUCT_PRICING_FILE` 指向服务器上的一个文件）——
那是因为这个 skill 可能整个公开，**和群里给不给看是两回事**。

⚠️ 我第一版做成了「不配就一个群都不给」，那是我自己加的保守假设，被推翻了。
开关留着只为「哪天某个群里进了经销商或外部人」时改一行能收窄。

## 3. 再装一个 skill

```
agent/skills-lab/<名字>/SKILL.md
```

```markdown
---
name: pricing
description: 报价口径 —— 有人问折扣/价格/MOQ 时按这本回答
---

# 报价口径
- 经销商价按 … 折
- MOQ 低于 20 台要走 维护者 审批
```

**改这里不用发版**（D72：它是数据不是代码）。放好之后 `docker compose --profile prod restart gateway`，
启动日志里会打 `📖 实验室 playbook ×1：pricing`。

`description` 那一行是承重的：系统提示词里只出现 name + description，
模型据此判断相关才用 `read_skill` 拉全文（渐进披露）。写得含糊 = 它永远不会被翻开。

## 4. 上线配置

**secret 不用另配** —— 默认和速记 bot 共用 `CHANNEL_DINGTALK_SECRET`（两条流程填同一个值）。

```bash
# .env —— 这三行都是可选的
CHANNEL_LAB_SECRET=            # 留空 = 和速记 bot 共用。只有想给它单独一把钥匙时才填
LAB_SESSION_WINDOW_MIN=30
LAB_SYNC_WAIT_MS=12000         # 要小于钉钉流程 HTTP 节点的超时
```

```bash
docker compose --profile prod up -d --force-recreate gateway
curl -s https://<CAPTURE_DOMAIN>/api/agent/health | jq .channels   # lab 要是 "on"
```

**钉钉侧**：新建第二个 bot 的流程，四个节点和速记 bot 完全一样，**只改一处** ——
节点② 的 URL 换成 `https://<CAPTURE_DOMAIN>/api/channels/lab/events`。
`X-Channel-Secret` 填的是**同一个值**，节点③ 的透传代码一字不改。

⚠️ 共用钥匙意味着**两个端点同开同关**：`CHANNEL_DINGTALK_SECRET` 一配，两个 bot 都活。
想只留一个的话，在钉钉那边把另一条流程停掉（或把那个 bot 移出群）——
服务端要单独关的话，就给实验室那个配一把自己的钥匙、把共用那把留给速记。

**群 webhook**：慢回答要靠它。这个 bot **会自动复用该群已经登记的那个 webhook**
（投递口就是个投递口，两个 bot 共用完全正常），所以速记 bot 配过的群不用配第二遍。

两种地址都能填，网关按 URL 自动决定报文形状（D122）—— 群自定义机器人
（`oapi.dingtalk.com/robot/send`）原样发；连接平台的流程 webhook
（`connector.dingtalk.com/webhook/flow/…`）包一层 `{"keyword","ding"}`。
**用后者的话先读 `docs/dingtalk-api.md` §1.5**：关键词对不上会被静默丢弃，
而钉钉照样回 `200 {"success":true}` —— `delivery` 记着 `webhook` 也不代表群里真收到了。

## 5. 排障

```bash
# 最近十轮：问了什么、跑了几步、怎么结束的、答案怎么送出去的
docker compose exec db psql -U postgres -d boothnote -c \
  "select created_at, sender, left(prompt,30) p, steps, stop_reason, delivery, left(coalesce(error,''),40) err
     from lab_run order by created_at desc limit 10;"
```

`delivery` 那一格是关键：

| 值 | 含义 |
|---|---|
| `sync` | 12 秒内答完，那条 HTTP 回复就是答案 |
| `webhook` | 慢回答，投递口收下了 —— ⚠️ **不等于群里收到了**（流程 webhook 会静默过滤，见 `docs/dingtalk-api.md` §1.5） |
| `dropped` | 🔴 **答案没送出去** —— 群没配 webhook，或投递失败（日志里有 warn） |
| `pending` | 还在跑（或网关中途重启了） |

`/api/agent/health` 里的 `channels.lab` = `on`/`off`。

## 6. 边界（刻意不做的）

- **没有执行 shell、读写文件的工具**。SKILL.md 里写「运行这个脚本」它做不到 ——
  那是另一个量级的暴露面，真要做单独立项。
- **不能读客户数据**：起点只有 `read_skill`。要让它查真数据得挂只读工具（改 `agent/src/lab.ts`，发版动作）。
- **不能写 CRM**：整个模块不 import `tools/`，单元测试逐字对账工具清单 + 禁用名单。
- **不接图片/语音**：只吃 @ 它那句话的文字。
