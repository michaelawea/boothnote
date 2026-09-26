# 钉钉渠道接入 —— 技术方案

> 📘 **要在生产上用它（配置 / 调接口 / 排障）看 [`dingtalk-api.md`](dingtalk-api.md)。这一份讲的是为什么这么设计。**
>
> ⚠️ **D127（2026-08-18）之后入口形态变了**：一个 bot、一个端点，服务端路由器分辨
> 「记录/提问」再分给速记或实验室（`channels/router.ts`）。本文里「两个 bot 各一条流程」
> 的部分是历史设计；ack 话术也改成了「已转给速记/实验室助手」。以 `dingtalk-api.md` §1 为准。
>
> 状态：**P1 已实现（2026-08-17，D117–D120），未部署。** 生产开关 `CHANNEL_DINGTALK_SECRET`
> 留空到展会后。上线前 维护者 的四件事：流程节点②改 URL + 加 secret 头 ·
> 每个启用群拉自定义机器人、webhook 填进管理台 · 老用户钉钉 ID 预绑 · 真群走一遍。

## 1. 定位（一句话）

**钉钉 Bot = 写入端的第二个实例。** 现有管道（inbox → staging → agent → 人确认 → 入库）
全部复用，新写的只有一层「渠道适配」。**新增可写 CRM 的路径：0 条。**

| | PWA | 钉钉 |
|---|---|---|
| 主场 | 展会现场（离线优先、录音是资产） | 日常办公（信息本来就在群里） |
| 断网 | 本地排队，回网补传 | ❌ 没有离线队列，展馆里指望不上 |

⚠️ 群聊语音进不来（钉钉语音消息带不了 @，而群里只有 @bot 的消息才投递）。
语音走单聊（P2 的 Stream 模式）或继续用 PWA。

## 2. 整条链路

```
群里 @bot「Alpin 想把逆变器换成 3000W」
 │ 流程节点② POST /channels/dingtalk/events（带 X-Channel-Secret）
 ▼
网关（同步，<3 秒）：识别身份（新 ID 自动建号）→ 幂等去重
 → L1 完整性门卫：这条内容够不够记？
     ├─ 不够 → 回「请提供完整信息（我只能看到 @ 我的这一条）」，到此为止
     └─ 够   → 落 inbox，回 ack「已记下，整理中」（流程节点④原样发回群）
 │ L2 录入 agent 照旧：staging → 转写 → 抽取 → ready（10~180 秒）
 ▼
回执 / 追问：走该群的自定义机器人 webhook（markdown + @发送人）
 ▼
确认入库：V1 点回执里的链接去 PWA；V2 回复「确认」（走同一个 confirm.ts）
```

**两层 agent（2026-08-17，维护者 定）：**

- **L1 完整性门卫** —— 专治「以为 bot 看得见前面聊天，只 @ 一句『记录一下相关信息』」。
  三级：规则先挡（太短 / 无实词 → 直接拒，不花钱）→ 小模型快判（2 秒超时）→ 放行。
  🔴 **超时 / 出错一律放行** —— 宁可让 L2 多跑一次，不许把好内容卡在门口。
  拒掉的**不进 inbox**（只留 `channel_event` 日志），回复固定教育话术。
- **L2 录入 agent** —— 现有 Pi agent 原样不动，只有过了 L1 的才进。

回执模板（≤8 行，「已入库」三个字只在 confirm 后出现）：

```markdown
#### ✍️ 选型情报 · 待确认 @张三
**客户** Alpin（名单里对上了）
**要点** 逆变器 · 意向 3000W · 项目 ALPIN-2026-001
**还缺** 现在在位的是哪家？
👉 [去确认入库](https://capture.<域名>/#/note/<id>)　回复「更正 …」可以改这条
```

## 3. 流程侧怎么配（四个节点）

原则：**流程只做透传，渲染和判断全在网关**（流程代码没版本没测试，规则放那边必漂移）。

**节点① 触发**：关键词留空，收全部 @（命令也走这条流程，路由在服务端）。

**节点②（2026-08-17 定版：你已写好的请求代码就是契约）** —— 六个字段是平台支持的全部
（没有 senderStaffId / conversationId / msgId），网关的 payload.ts 按这个形状收。只改两处：

```python
    response = requests.post(
        "https://<SITE>/channels/dingtalk/events",   # ① URL 换成网关
        json=payload,
        headers={"X-Channel-Secret": "<secret>"},    # ② 加鉴权头
        timeout=30
    )
```

| 流程字段 | 网关用途 |
|---|---|
| `content` | 正文（剥掉 @ 后）→ L1 门卫 → inbox |
| `images[*]` | 附件（值是不是可下载 URL 待验，§10） |
| `sender` | **唯一的 ID 字段**（已确认稳定）：自动建号 · 会话键 · @回执 |
| `send_time` | `device_created_at` · 会话窗口计时 |
| `group_name` | 会话键另一半 · 群登记匹配（改名视同新群） |
| `mentioned_users` | 暂不消费，日志留档 |

**网关响应**（永远 HTTP 200 —— 错误也是一条给人看的消息，不交给流程的报错分支）：

```jsonc
{ "ok": true,
  "kind": "final" | "ack",   // final=这条就是终局；ack=稍后还有异步回执
  "noteId": "uuid" | null,
  "ding": { "msgtype": "markdown", "markdown": {…}, "at": {…} } }  // 整条钉钉消息，直接发
```

**节点③ 代码**（drop-in 替换）：

```python
import json

def main(params):
    body = params["reqtext"]          # 变量名现场对一下
    if isinstance(body, str):
        body = json.loads(body)
    ding = body.get("ding") or {"msgtype": "text",
                                "text": {"content": "网关响应异常，查 /channels 日志"}}
    return json.dumps(ding, ensure_ascii=False)
```

**出站（第二条腿）**：每个群拉一个自定义机器人，webhook 在管理台登记 ——
**登记过的群才算启用**，没登记的回「此群未启用」。格式和上面 `ding` 同一族 →
render 一份实现喂两条腿。频控 20 条/分，够用。
登记了没填 webhook → ack 降级成「已记下，结果去 PWA 看」（不许假装稍后有回执）。

**agent 的追问也走这条腿**（信息不够时回群里问）。问题末尾固定
「回复请 @我（30 分钟内有效）」—— bot 只看得见 @ 它的消息，不 @ 它就收不到答案。

**同步 vs 异步**：只有 L2 的回执和追问必须异步。L1 拒收、群未启用、
幂等命中（复述上次回执）、帮助、**V2 的确认/撤销**（纯库操作）—— 全部同步终局。

## 4. 会话路由（同群多人）

状态按 `(会话, 发送人)` 各记各的。每条 @ 进来：

**⓪ 命令层**：`确认 / 撤销 / 帮助` → 直接执行，同步回复，不落 inbox。

其余按序取第一个命中：

| # | 条件 | 路由 |
|---|---|---|
| ① | bot 追问过，且 < 30 分钟 | 续写原对话（回答问题） |
| ② | 引用 bot 回执再 @（报文拿得到才有） | 续写被引那条的对话 |
| ③ | 更正词开头（更正/不对/改一下…）且 < 2 小时 | 续写，走改口（D90/D108） |
| ④ | 其余 | **新开（新速记）** |

默认新开的理由：**分错方向代价不对称** —— 错开新条只是多一张待确认卡；
错并线会把不相干的话灌进上一条提案、当场改写它。
（反例：A 录完 Alpin 两分钟后又录 Heron，按时间续写就并错了。）

多人情形：各录各的不串线（键里有发送人）；**B 更正 A 的记录不放行**（D76 只能碰自己的，
但 bot 要说出来「要改 A 那条得 A 自己来」）；同项目两人分头报 → projectCode（D91）跨用户
给同一个号，入库第二条走 update 不新建。

## 5. 身份

- **新 ID 自动建号**（2026-08-17，维护者 定）：没见过的 sender ID → 自动建 `app_user`
  （代号 `dd-<ID 尾段>`、名字用群昵称、默认角色 `staff`）+ `channel_identity` 记映射。
  **零绑定动作，新同事张口就能用。** sender ID 已确认稳定唯一，映射不进 Twenty。
- 两个代价，各有出口：
  ① 已有 PWA 账号的老用户从钉钉进来会多出一个新号 → 管理台「改绑」到原账号
  （早改省事；改绑只影响之后的记录）。现有几位老用户上线前先预绑一遍，就没有这个问题。
  ② 自动建的号没有密码，登不了 PWA → 要用 PWA 时管理台补发一次；
  V2 群内确认落地后，纯钉钉用户可以完全不碰 PWA。
- 权限零新增：记录归自动建的账号，确认只认本人（D76）。
- 会话键 = sender + 群名（**定版** —— 平台没有会话 ID 字段）。⚠️ **改群名视同新群**
  （webhook 重配、会话窗口重置）—— 你们不改名，可接受。

## 6. 防错、防垃圾、防重复

| 层 | 机制 |
|---|---|
| 消息重复 | 流程报文没 msgId → 幂等键 = UUIDv5(会话+发送人+createAt+正文哈希) → `inbox.client_id` 唯一键，重试天然去重 |
| 垃圾/空心输入 | **L1 门卫**同步拒收 + 教育话术（§2），不进 inbox；原文在 `channel_event` 日志留档 |
| 真伪 | 不做自动测谎。系统保证**每句话查得到谁说的、何时说的、进没进库**（inbox 只增 + recordedBy）；确认闸门在人手里 |
| 重复项目 | projectCode 预约（D91，跨用户 + 客户级锁）+ 入库撞号走 update；回执亮编号，群自身成为查重面 |
| 遗留缺口 | 两人对同一项目报了**不同品类**仍会开两个号 —— 钉钉没引入这个洞也没堵上，单独立项 |

## 7. 风险与部署

| 风险 | 对策 |
|---|---|
| 流程/钉钉挂了 | bot 沉默是**可见**失败；消息还在群里可补 @。健康检查 + 冒烟加渠道项 |
| 回执发不出 | 数据已在库；重试 + 降级；看板兜底可查 |
| 垃圾 @ 烧模型 | 只服务登记过的群 + L1 先挡一道 + 按人限频（10 次/小时）+ AGENT_ENABLED 总闸 |
| 群里全员可见 | 回执只含发送人自己的话 + 客户级缺口，不查别人的记录；敏感查询走单聊 |
| **展会前 13 天** | 全部增量 + `DINGTALK_ENABLED` 默认关（不配=不存在）。**代码先合，展会后再开** |

## 8. 要做的东西（✅ 2026-08-17 全部做完 —— 下述即实际形状）

- **migration 015**（三张新表，不动现有任何表）：`channel_identity`（身份映射）·
  `channel_event`（只增日志 + 幂等唯一索引）· `channel_conversation`（登记的群 + 出站 webhook）
- **管理台**加一小块：渠道账号列表 + 改绑 · 群登记。**PWA 零改动**
- **代码**：`src/channels/`（types / ingest / outbound / **gate（L1 门卫）** /
  dingtalk 的 payload+render 两个纯函数）；
  把 `POST /inbox` 核心抽成 `ingest()` 共用（唯一动现有代码处，行为零变化，有集成测试守着）
- **.env**：`DINGTALK_ENABLED`（默认关）· `CHANNEL_DINGTALK_SECRET` ·
  `GATE_MODEL`（L1 的小模型，缺省复用抽取模型）
- **测试**：payload/render/gate 单测（记得进 test.sh 的 units()）；集成走一次性环境；
  幂等/自动建号/群登记门/L1 超时放行各做一次变异；守卫上岗先红一次

## 9. 阶段

| 阶段 | 内容 | 依赖 |
|---|---|---|
| P0 | 拍板 + 发一张图实测 `images` 的值 + 流程三小口（§10） | 维护者 |
| P1 ✅ | 适配层 + 流程传输 + **L1 门卫** + 自动建号 + 文本/图片 + 回执 + 深链确认。**不需要企业应用凭据**（2026-08-17 实现，待部署） | P0 |
| P2 | Stream 模式升级：企业内部应用（维护者 建）+ 单聊语音 + 真 msgId + 引用信号 | P1 |
| P3 | 群内确认（限 fitment/support 且客户高置信）+ 单聊查缺口 | P1 |
| P4 | actionCard 卡片 · 第二个渠道（企业微信/Slack） | P3 |

每阶段验收含真钉钉群走一遍（测试全绿 ≠ 群里是对的）。

## 10. 待你回答

**已答（2026-08-17）**：sender ID 稳定唯一 ✅；全内部群 + 新 ID **自动建号**；
agent 分两层（L1 门卫 / L2 录入）；**节点② 六字段就是全部** —— 没有
senderStaffId / conversationId / msgId，sender 即唯一 ID，会话键定为 sender + 群名。

**还剩一问**：`images[*]` 的值是什么 —— 可下载的 URL 吗（时效/鉴权）？发一张图实测即知。

**流程三小口**：节点② 报错后流程走哪个分支（`raise_for_status` 抛出后会不会重试）·
节点④ 发 markdown + at 时 @ 响不响（`atUserIds` 填 `sender` 的值）· 触发关键词能不能留空。

**三个拍板**：回执全群可见 OK 吗、先开哪几个群？展会后才开开关，同意吗？
V2 群内确认的范围认不认？

---

来源：[机器人接收消息](https://open-dingtalk.github.io/developerpedia/docs/learn/bot/appbot/receive/) ·
[Stream 模式](https://open-dingtalk.github.io/developerpedia/docs/learn/stream/overview/) ·
[机器人回复](https://open-dingtalk.github.io/developerpedia/docs/learn/bot/appbot/reply/) ·
[下载接收的文件](https://open.dingtalk.com/document/development/download-the-file-content-of-the-robot-receiving-message)
