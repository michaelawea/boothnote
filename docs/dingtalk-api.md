# 钉钉渠道 · 生产接口文档

> 部署到服务器之后，钉钉流程怎么调这个接口。**设计与取舍见 [`dingtalk-channel.md`](dingtalk-channel.md)，这里只讲怎么用。**
> 适用版本：网关 migration ≥ 015（2026-08-17 起）。

## 0. 三个地址

`<DOMAIN>` = `.env` 里的 `CAPTURE_DOMAIN`（当前生产：`capture.example.com`）。
网关挂在 `/api/*` 下（Caddy 剥掉 `/api` 前缀转给网关）。

| 用途 | 地址 | 鉴权 |
|---|---|---|
| **钉钉流程调用**（速记 bot） | `https://<DOMAIN>/api/channels/dingtalk/events` | `X-Channel-Secret` 头 |
| 实验室 bot（第二个 bot，见 [`lab-agent.md`](lab-agent.md)） | `https://<DOMAIN>/api/channels/lab/events` | `X-Channel-Secret` 头（**同一个值**） |
| 管理台（配群 webhook / 改绑 / 补发密码） | `https://<DOMAIN><ADMIN_PATH>`（默认 `/console`） | `X-Admin-Token` 头 |
| 健康检查 | `https://<DOMAIN>/api/agent/health` | 免鉴权 |

---

## 1. 上线前的配置（一次性）

> 🟢 **D127 起一个 bot 就够了（服务端路由器）。**
> 用户 @ 一个机器人说任何话，网关自己分辨这句话的性质（D128 起三个去向）：
> **说事实** → 速记管道（录入 CRM）；**提产品/业务问题** → 实验室助手；
> **其他杂项**（测试、打招呼、翻译、闲聊）→ 日常助手**当场直答**（不进任何管道）。
> 前两类的同步 ack 立即说清转给了谁（「已转给速记 / 已转给实验室助手」），
> **具体回答一律走这个群登记的那条 webhook**（两个 agent 共用，§1.3）。
>
> 钉钉侧因此可以简化成：**一个机器人、一条流程、触发关键词留空、无分支** ——
> 原来靠关键词分流给两个 bot 的做法可以撤了。第二个 bot 的端点
> `/channels/lab/events` **过渡期照旧工作**（没撤第二条流程前一切不变），
> 撤完流程后它就是死代码，可删。
>
> 分错方向的逃生口：句首写 **「问：」强制实验室，「记：」强制速记**。
> 路由本身出问题的回滚开关：`.env` 里 `CHANNEL_ROUTER=off`（统一入口每条都进速记，
> 即 D127 之前的行为），改完照例 `--force-recreate`。

### 1.1 服务器 `.env`

```bash
# openssl rand -base64 32 —— 🔴 留空 = 渠道 503 关闭
CHANNEL_DINGTALK_SECRET=
# 可选：实验室 bot 单独一把钥匙。留空 = 和上面共用同一个值
CHANNEL_LAB_SECRET=
# 可选：单群试点时的兜底回执 webhook
DINGTALK_DEFAULT_WEBHOOK=
# 可选：L1 门卫的模型，留空 = 跟抽取同一个
GATE_MODEL=
# 可选：留空则由 CAPTURE_DOMAIN 推出 https://…
CAPTURE_URL=
# 可选：Agent 路由器（D127）。off = 统一入口每条都进速记（回滚开关）
CHANNEL_ROUTER=
# 可选：路由模型，留空 = 跟抽取同一个（Luna，不思考）；分类超时默认 4000ms
ROUTER_MODEL=
ROUTER_TIMEOUT_MS=
# 可选：日常助手（D128，杂项直答）的模型与超时，留空 = Luna / 8000ms
CHAT_MODEL=
CHAT_TIMEOUT_MS=
```

🔴 **注释必须单独占一行，不能跟在 `=` 后面** —— 上面这段就是照这个写法排的，可以直接抄。

原因是实测出来的（2026-08-17，`docker compose run` 验的）：

| `.env` 里写 | 进程拿到的值 |
|---|---|
| `KEY=real   # 尾注` | `real` ✅ 注释被剥掉了 |
| `KEY=   # 待填` | **`# 待填`** 🔴 注释**变成了值** |

**空键 + 行尾注释是最危险的那一种**：`CHANNEL_DINGTALK_SECRET=   # openssl rand -base64 32`
会让 secret 变成 `# openssl rand -base64 32` —— 非空，于是**渠道带着一个垃圾密钥开了**，
而你以为它还关着。（网关自己的解析器 `/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/` 两种情形都不剥，
本地直接 `node` 跑时更严格。）

改完 `.env` 后**必须重建网关容器**（改 `.env` 不会自动生效）：

```bash
docker compose --profile prod up -d --force-recreate gateway
```

**验证进程真的读到了**（`.env` 里写了 ≠ 容器里读得到，这个仓库踩过）：

```bash
docker compose exec gateway sh -c 'echo ${#CHANNEL_DINGTALK_SECRET}'   # 要打印非 0
```

或者直接看健康检查（下面 §5）里的 `channels.dingtalk` 是不是 `on`。

### 1.2 钉钉流程编排（四个节点）

**节点① 机器人被 @ 时** —— 触发关键词**留空**（收全部 @；命令路由在服务端做）。

**节点② 发起 HTTP 请求** —— 在你现有代码上只改两行：

```python
    response = requests.post(
        "https://<DOMAIN>/api/channels/dingtalk/events",   # ① 换成这个
        json=payload,
        headers={"X-Channel-Secret": "<CHANNEL_DINGTALK_SECRET 的值>"},   # ② 加这行
        timeout=30
    )
```

payload 保持你现在的形状（六个字段原样）：

```python
    payload = {"message": {
        "content":          _ctx_node_['''$.node_start.payload.content'''],
        "images":           _ctx_node_['''$.node_start.payload.images[*]'''],
        "sender":           _ctx_node_['''$.node_start.payload.sender'''],
        "send_time":        _ctx_node_['''$.node_start.payload.createAt'''],
        "group_name":       _ctx_node_['''$.node_start.payload.conversationTitle'''],
        "mentioned_users":  _ctx_node_['''$.node_start.payload.atUsers[*]''']
    }}
```

**节点③ 执行代码** —— 整段替换成透传（网关已经把整条钉钉消息拼好了）。
**这一份两条流程通用**（入站的节点③、§1.5 那条出站流程都用它），照抄即可：

```python
import json


def main(params):
    body = params.get("reqtext")          # ← 变量名以你流程里的实际映射为准

    # 入参可能是字符串，也可能平台已经解析成对象
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except Exception:
            # 不是 JSON —— 原样当一句话发出去，别吃掉变成「异常」
            return json.dumps(
                {"msgtype": "text", "text": {"content": str(body)[:1000]}},
                ensure_ascii=False,
            )

    if not isinstance(body, dict):
        return json.dumps(
            {"msgtype": "text", "text": {"content": "网关报文不是对象，查 /channels 日志"}},
            ensure_ascii=False,
        )

    # 🔴 两个方向的形状不一样，差别在**谁是主调方**（§1.5）：
    #   入站：{"ok":true,"kind":"ack","ding":{…}}   ← 网关是被调，回的是响应体
    #   出站：{"keyword":"agentwork","ding":{…}}    ← 网关是主调，包一层信封
    # 兜底再认一次「body 自己就是一条钉钉消息」，靠 msgtype 判，不靠猜。
    ding = body.get("ding")
    if not isinstance(ding, dict):
        ding = body if body.get("msgtype") else None

    if not isinstance(ding, dict):
        return json.dumps(
            {"msgtype": "text", "text": {"content": "网关响应异常（没找到消息体），查 /channels 日志"}},
            ensure_ascii=False,
        )

    return json.dumps(ding, ensure_ascii=False)
```

**节点④ 机器人回消息到该群** —— 用节点③的输出，无需改动。

### 1.3 每个启用的群：给它一个出站投递口

**一群只要一条 webhook，录入和实验室两个 bot 共用它**（D126）——
webhook 是「群」的投递口，不是某个 bot 的；哪个 agent 答的都从这个口出去
（代价：群里显示的是那个自定义机器人的名字头像，不区分是谁答的；@ 照常生效）。

配一个新群三步：

1. 把机器人拉进群，@ **任意一个**（录入或实验室）说一句 —— 群自动出现在管理台「钉钉渠道」里；
2. 群设置里添加「自定义机器人」，把 webhook 贴进管理台那一行 → 保存；
3. 点「**测试**」—— 网关用真实代码（`md()` + `outboundBody()`）发一条测试消息，
   🔴 然后**必须去群里用眼睛看**：回包 200 对「送达」和「被静默丢弃」说的是同一句话（§2.52）。
   测试时填一个钉钉 userid 能顺便验「@ 到人」。

**两种地址都行，网关按 URL 自动分辨形状**（D122）：

| 投递口 | 地址长相 | 网关发的报文 |
|---|---|---|
| **群自定义机器人** | `https://oapi.dingtalk.com/robot/send?access_token=…` | 原样一条钉钉消息 |
| **连接平台的流程 webhook** | `https://connector.dingtalk.com/webhook/flow/…` | `{"keyword":"…","ding":{…}}`，见 §1.5 |

自定义机器人在钉钉群设置里添加（安全设置随意，网关只发不收）。

**没填 webhook 会怎样**：机器人仍然照常记录，但**不会有后续回执** ——
同步 ack 会如实说「结果请去 PWA 看」，不会假装稍后有回执。

### 1.4 老同事预绑（重要）

已经有 PWA 账号的人，**第一次 @ 机器人之前**要在管理台把他的钉钉 ID 绑到已有账号，
否则系统会给他自动建一个新号，记录就散在两个账号下（改绑只影响之后的记录）。

拿到钉钉 ID 的办法：让他先 @ 一次机器人 → 管理台「钉钉渠道 · 身份」里会出现那个 ID
→ 在「改绑到」填他原来的账号代号 → 点改绑。之后的记录就都归原账号了。

### 1.5 用「流程 webhook」当投递口（关键词触发）

连接平台里建一条流程、触发器选 webhook，就得到一个
`https://connector.dingtalk.com/webhook/flow/<id>` 的地址。它和自定义机器人有三点不同：

**① 触发器的关键词是硬门槛。** 请求体里**找不到关键词就静默丢弃**：

```json
{"errorCode":"trigger_filter_break","errorMessage":"当前请求已被过滤, flow input not contain keywords "}
```

网关发的报文因此包一层信封，关键词进 `keyword`、消息进 `ding`：

```json
{"keyword": "agentwork", "ding": {"msgtype": "markdown", "markdown": {…}, "at": {…}}}
```

关键词放信封不放正文，是为了**不让「agentwork」出现在群里每一条消息上**
（那个过滤扫的是整个请求体，不认字段名 —— 塞进正文一样能过，但难看）。

🔴 **改了流程里的关键词，就必须同步改 `.env` 的 `CHANNEL_FLOW_KEYWORD` 并
`up -d --force-recreate gateway`。忘了 = 消息全部静默消失，而且没有任何报错。**

**② 流程里要有一个代码节点**，把 `ding` 取出来交给发消息节点 —— 用 §1.2 那份代码，
它两个方向通用（`body.get("ding")` 对入站响应和这个信封都成立）。

🔴 **@ 那个人靠的是正文里的 `@<userid>` 串，不是 `at` 列表。** 钉钉的 markdown 消息
只放 `at.atUserIds` 是**不会真 @ 到人**的（真群实测）。网关已经在每条带 sender 的消息
末尾自动拼上了，代码节点**原样透传即可，别去改正文**。
这条在异步补发上是承重的：回答可能一分钟后才回到群里，没有 @ 就等于没有通知。

**③ 🔴 回包不能用来判断成功。** 被关键词拦掉时钉钉返回的是：

```
HTTP 200    {"data":true,"success":true}
```

**和送达时逐字节相同**（响应头也一样）。`trigger_filter_break` 只写在钉钉的流程执行日志里，
网关这边**收不到任何信号**，库里照样记 `delivery = 'webhook'`。

所以：**第一次配好之后，必须有人在群里用眼睛确认收到了**，
不能只看 `lab_run.delivery` 或 `channel_event` 那几格。

---

## 2. 接口：`POST /api/channels/dingtalk/events`

### 2.1 请求

| 项 | 值 |
|---|---|
| Method | `POST` |
| Content-Type | `application/json` |
| 鉴权头 | `X-Channel-Secret: <CHANNEL_DINGTALK_SECRET>` |
| 超时建议 | ≥ 10s（服务端目标 < 3s 返回） |

```jsonc
{
  "message": {
    "content":         "@Boothnote 刚跟 Alpin 聊完，他们想把逆变器换成 3000W",  // 必填（或有 images）
    "images":          ["https://static.dingtalk.com/…jpg"],  // 可选，可下载的 URL，最多取前 5 张
    "sender":          "u_demo_0001",           // 🔴 必填。唯一稳定的钉钉用户 ID
    "send_time":       1755400000000,           // 毫秒时间戳。参与幂等键
    "group_name":      "Boothnote 项目群",           // 会话标识；缺省时按单聊处理
    "mentioned_users": ["Boothnote"]                // 当前不消费，仅日志留档
  }
}
```

字段说明：

- `content` 里的 `@xxx` 片段服务端会剥掉，不算作内容。
- `sender` **必须是稳定 ID**（不是昵称）—— 它同时是账号映射键、会话键、回执 @ 的对象。
- 未提供 `group_name` 时会话键归一成 `direct:<sender>`（单聊）。
- **改群名视同新群**：会话窗口重置，出站 webhook 需要在管理台重新登记。

### 2.2 响应

**除鉴权失败外永远 HTTP 200** —— 错误也是一条给人看的消息，不走流程平台的报错分支。

```jsonc
{
  "ok": true,
  "kind": "ack" | "final",   // ack = 已收下，稍后还有回执；final = 这条回复就是终局
  "noteId": "uuid" | null,   // 落库的 inbox id（被拒收/命令时为 null）
  "ding": {                  // ⭐ 完整的一条钉钉消息，节点③原样透传给节点④
    "msgtype": "markdown",
    "markdown": { "title": "Boothnote", "text": "…" },
    "at": { "atUserIds": ["u_demo_0001"], "isAtAll": false }
  }
}
```

| 状态码 | 含义 | 处理 |
|---|---|---|
| `200` | 一切正常（含业务侧拒收、限频、报文异常 —— 都在 `ding` 里说明） | 发 `ding` 到群里 |
| `401` | `X-Channel-Secret` 不对或缺失 | 检查 `.env` 与流程里的值是否一致 |
| `503` | `CHANNEL_DINGTALK_SECRET` 在**网关进程里**是空的 | 见 §1.1 的验证命令；改完要 `--force-recreate` |

### 2.3 `kind` 的两种情形

| 情形 | `kind` | 群里看到 |
|---|---|---|
| 路由到速记（陈述事实） | `ack` | 「✍️ 已转给速记，整理中，回执稍后发回群里。」→ 10–180 秒后**第二条**回执 |
| 路由到实验室（提问，D127） | `ack` | 「🧪 已转给实验室助手，答案稍后发回群里。」→ 答案走群 webhook（没配 webhook 时 ack 会当场说） |
| 路由到日常助手（杂项，D128） | `final` | 「💬 …」当场直答（测试/打招呼/翻译/闲聊）——不进 inbox、不烧实验室 agent、不依赖 webhook |
| 内容太空（L1 拒收） | `final` | 「我只能看到 @ 我的这一条消息…」+ 示例 |
| 命令（帮助 / 确认 / 撤销） | `final` | 对应的回复 |
| 重复投递（流程重试） | `final` | 「这条我已经收过了…」**不会重复记录**；路由决定也复用第一次的 |
| 限频（同一人 > 20 条/小时） | `final` | 「这一小时内记得有点多…」 |
| 账号被停用 | `final` | 「这个账号已被停用」 |

### 2.4 幂等

幂等键由 `(群名, sender, send_time, 正文+图片)` 合成，落 `inbox.client_id` 唯一约束。
**流程重试、节点重放、网络抖动导致的重复 POST 都不会产生第二条记录**，
第二次直接返回 `kind: "final"` + 「已经收过了」。

### 2.5 curl 自测（部署后跑一次）

```bash
curl -sS -X POST "https://<DOMAIN>/api/channels/dingtalk/events" \
  -H 'Content-Type: application/json' \
  -H "X-Channel-Secret: $CHANNEL_DINGTALK_SECRET" \
  -d '{"message":{"content":"接口自测：Alpin 想把逆变器换成 3000W，Q4 送样","images":[],"sender":"selftest-001","send_time":1755400000000,"group_name":"接口自测","mentioned_users":[]}}'
```

预期：`{"ok":true,"kind":"ack","noteId":"…","ding":{…}}`。
再跑**完全相同**的一条 → `kind` 变成 `final`、文案是「已经收过了」（幂等生效）。

⚠️ 自测会真的建一个账号和一条记录 —— 不想留就在管理台把那个账号停用；
记录属于 `inbox`（只增不改），留着无害。

**账号代号怎么来的**：`sender` 去掉所有非字母数字，**取后 8 位**再转小写，前面加 `dd-`。
所以上面那条自测（`sender=selftest-001`）建出来的是 **`dd-ftest001`**，不是 `dd-selftest001`
—— 在管理台按 `selftest` 搜是搜不到的，按 `dd-` 或 `ftest001` 找。
（撞代号时自动换成 `dd-<8 位随机>`。）

---

## 3. 群里的完整交互

```
[人]  @Boothnote 刚跟 Alpin 聊完，他们想把逆变器换成 3000W，Q4 送样
[bot] ✍️ 已转给速记，整理中，回执稍后发回群里。        ← 同步（路由 <1 秒 + ack）

[人]  @Boothnote VLC2430 的最大输入电压是多少？
[bot] 🧪 已转给实验室助手，答案稍后发回群里。          ← 同步；答案随后走群 webhook

      …（agent 抽取，10–180 秒）…

[bot] #### ✍️ 选型情报 · 待确认 @张三                  ← 异步，走群 webhook
      **客户** Alpin（名单里对上了）
      **要点** Alpin 逆变器升级 3000W
      逆变器 · ALPIN-2026-001
      **还缺** 他们现在用的是哪家的？（回复请 @我，30 分钟内有效）
      👉 [去确认入库](https://<DOMAIN>/)　回复「更正 …」可改这条
```

**支持的命令**（@ 机器人 + 这几个词）：

| 命令 | 行为 |
|---|---|
| `帮助` / `help` / `用法` | 返回用法说明 |
| `确认` / `撤销` | 当前提示去 PWA 确认（群内确认是 V2，未开通） |
| 以这 8 个词**开头**的任意一句：`更正` / `不对` / `改一下` / `改成` / `上一条` / `纠正` / `说错了` / `写错了` | 2 小时内接回你上一条，走改口 |
| 回答 bot 的追问 | 30 分钟内 @ 它回答，接回原对话 |

**多人同群**：状态按（群 + 人）各记各的，互不串线；
**A 不能更正 B 的记录**（权限只认本人，与 PWA 一致）。

---

## 4. 管理台

打开 `https://<DOMAIN><ADMIN_PATH>`（默认 `/console`），粘贴 `ADMIN_TOKEN` 进入。
「钉钉渠道」一节两张表：

| 表 | 能做什么 |
|---|---|
| **群** | 看每个群两个 bot 各自的消息数（录·研）和投递口类型（机器人/流程/未配回执）；填/清该群的回执 webhook（必须 `https://` 开头）；点「**测试**」发一条真消息自测投递口（然后去群里看） |
| **身份** | 看每个钉钉 ID 对应哪个账号、录了多少条；**改绑**到已有账号 |

账号表里还多了 **「补发密码」**：钉钉自动建的账号没有可用密码（登不了 PWA），
需要用 PWA 时点这里生成一个，**只显示一次**。

接口（都要 `X-Admin-Token` 头，`<ADMIN_PATH>` 会被 Caddy 改写成 `/admin`）：

```bash
GET  https://<DOMAIN><ADMIN_PATH>/channels                      # 群 + 身份列表（含 webhook_kind / lab_count）
POST https://<DOMAIN><ADMIN_PATH>/channels/conversations/:id    # {"webhookUrl":"https://…"}（空串=清掉）
POST https://<DOMAIN><ADMIN_PATH>/channels/conversations/:id/probe # {"sender":"钉钉userid，可选"} 发测试消息；回包 200 ≠ 送达，去群里看
POST https://<DOMAIN><ADMIN_PATH>/channels/identities/:id/rebind # {"userCode":"alex"}
POST https://<DOMAIN><ADMIN_PATH>/users/:code/password           # 补发密码，只回显一次
```

🔴 **token 只走请求头，绝不进 URL**（URL 会进访问日志、CDN 日志和浏览器历史）。

---

## 5. 健康检查与排障

```bash
curl -sS https://<DOMAIN>/api/agent/health | jq '{channels, queued, enabled, lastError}'
```

`channels.dingtalk` = `"on"` 表示渠道开着；`"off"` = secret 是空的。

| 症状 | 先查这一条 |
|---|---|
| 流程报 401 | `.env` 与流程里的 secret 不一致（注意别把换行/空格粘进去） |
| 流程报 503 | 容器里 secret 是空的：`docker compose exec gateway sh -c 'echo ${#CHANNEL_DINGTALK_SECRET}'` → 0 就是没传进去，`--force-recreate` 重建 |
| 群里没有任何回复 | 看流程节点②③的执行日志；节点③返回的必须是 `ding` 那一段的 JSON 字符串 |
| 只有 ack，没有后续回执 | 该群没配 webhook（管理台补上）；或 webhook 失效 —— 库里查：`select kind, created_at from channel_event where kind like 'receipt%' order by created_at desc limit 10;` |
| **路由分错方向**（情报被当问题答了 / 问题被录成了速记） | 先查账：`select raw, created_at from channel_event where kind='route' order by created_at desc limit 10;`（raw 里有 route/via/reason）。当事人救急：句首「问：」/「记：」强制指定。整体翻车：`.env` 配 `CHANNEL_ROUTER=off` + `--force-recreate`（回到全部进速记） |
| **库里记着 `delivery='webhook'` / `kind='receipt'`，群里却什么都没有** | 用的是流程 webhook（§1.5），消息被钉钉**静默丢了**，我们这边收不到信号。三种可能，去**钉钉的流程执行日志**里看：① 关键词对不上（`trigger_filter_break`）→ 核 `.env` 的 `CHANNEL_FLOW_KEYWORD` 和流程里的触发条件是不是同一个字，改完要 `--force-recreate`；② 流程里的代码节点发出了「网关响应异常」→ 换成 §1.2 那份两方向通用的代码；③ 消息超长（约 20000 字节）→ 网关侧已按 18000 截断，超了会自带「回答太长」那句话 |
| 回执里 @ 不响 | `sender` 传的不是 userId 级的稳定 ID |
| 记录归错人 | 管理台「身份」里改绑；**已录的留在原账号名下**（recordedBy 是历史事实，不改） |
| 说了话但没记上 | 多半被 L1 门卫拒了（群里会有教育话术）。原始报文仍在：`select * from channel_event where kind='reject' order by created_at desc limit 5;` |

日志：`docker compose logs -f gateway | grep -E '钉钉|channels'`。

---

## 6. 生产注意事项

- **数据边界不变**：钉钉进来的记录和 PWA 一样，**要人确认才进 CRM**；agent 没有任何写 CRM 的能力。
- **可见性**：回执发在群里对全员可见，内容只含「发送人刚说的那条」的结构化结果，不含别人的记录。
- **限频**：同一人 10 条/小时（网关内存计数，重启清零）。触发时如实回复，不静默丢弃。
- **图片**：只取前 5 张、单张 ≤ 10MB（`ATTACHMENT_INLINE_MAX_BYTES`），下载失败不影响文字部分。
- **语音**：群聊语音消息带不了 @，**进不到机器人**，只能用 PWA 录（或等 P2 的单聊 Stream 模式）。
- **关掉渠道**：把 `CHANNEL_DINGTALK_SECRET` 清空 + 重建容器，接口立刻 503，其余功能不受影响。
- **备份**：三张新表在 `boothnote` 库里，`pg_dump` 已覆盖；图片落 `GATEWAY_AUDIO_DIR`，**要单独同步**（同音频那条）。
