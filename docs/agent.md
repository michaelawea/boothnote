# Agent —— 内部结构与排查手册

> 改 agent 之前读这份。上位文档：内部设计日志（未公开） D71（附件原生多模态，修订 D46b）· D72（SKILL.md 技能库）· D73（session 续跑）· D47（造字段权限）。重构方案全文：`services/gateway/agent/REDESIGN.md`
> 代码：**`services/gateway/agent/`**（2026-08-05 从 `src/agent/` 搬出来，issue #17 —— 那个目录还有一份自己的 README.md）

## 0. 三十秒版本

一句话进来，一条能入库的记录出去。中间没有任何东西能写 CRM。

```
音频/附件 ──预处理（agent 之外）──▶ 纯文字 ──▶ Pi agent ──▶ staging ──人核对──▶ Twenty
```

| | |
|---|---|
| 框架 | [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi) **0.83.0 锁死版本**（MIT · TypeScript） |
| 模型 | 抽取/视觉 `gpt-5.6-luna` · 转写 `gpt-transcribe`（都在 `.env`，不写死） |
| 上限 | **8 次工具调用 / 120 秒**（带附件 +6 步 +60 秒），超了写 `partial` 而不是失败 |
| 工具 | **PWA 默认 15 个，显式 `AGENT_MULTI_ITEMS=1` 时最多 17 个**；钉钉不注册多事项及即时情报写入工具，快照测试守着 |
| 附件 | **原生喂给模型**（D71）：图片 `input_image` · pdf/docx/pptx/xlsx `input_file`；超 10MB / 探测不支持才走本地解析 |
| 打法手册 | `agent/skills/` 四本标准 SKILL.md（D72），渐进披露；**改 playbook 不发版** |
| 多轮 | 同一条对话的消息史落 `agent-sessions/<threadId>.jsonl`，续写时恢复（D73）|
| 能写 CRM 吗 | **不能。** 一个能写的工具都没注册 |

---

## 1. 文件在哪

```
services/gateway/agent/          ← 2026-08-05 搬到这里（issue #17）
├── README.md             ← 给接手的人：三圈、改哪个文件、怎么测
└── src/
├── host.ts               ← 🔴 **唯一对外的口子**。agent 依赖了外面什么，全写在这一个文件里
├── runtime.ts            ← Pi 的唯一接触面。换框架只改这一个文件
├── prompt.ts             ← 系统提示词
├── transcribe.ts         ← 转写 + 看图（**跑在 agent 之外**）
├── attachments.ts        ← 附件 → 纯文字
├── attachment-worker.ts  ← worker_thread（整条链路唯一 CPU 密集的一步）
├── enums.ts              ← 白名单唯一来源
├── loop.ts               ← 取活 → 预处理 → 跑 agent → 写 staging
├── index.ts              ← 模块唯一出口
├── skills.ts             ← D72：SKILL.md 加载器（渐进披露的索引 / 拉取 / 推送）
└── tools/                ← 2026-08-05 从 skills/ 改名（那是工具定义，不是 skill）
    ├── context.ts        ← 一轮跑动的上下文
    ├── read.ts           ← Ring 1（read_skill + 6 个只读工具）
    ├── project.ts        ← D59：项目 / 任务线程 / 文档（1 读 + 3 写）
    ├── write.ts          ← Ring 2 前三个
    ├── intel-field.ts    ← Ring 2 第四个：当场造字段（D47）
    └── index.ts          ← 注册表 + TOOL_NAMES 快照
└── __tests__/            ← agent 的单元测试跟着 agent 走
agent/skills/             ← D72：标准 SKILL.md 技能库（**数据文件，改了不用发版**）
├── project/SKILL.md      ← 项目/跟进的完整打法（编号规则 · milestone 拆解 · 新旧判断）
├── support/SKILL.md      ← 售后（结构模板 · caseStatus/severity 判法）
├── fitment/SKILL.md      ← 选型（在位品牌只追加 · sourceConfidence 三档 · 渠道链）
└── attachment/SKILL.md   ← 附件（转录粒度 · 口述为主 · 内容去处）
```

⚠️ **它必须留在 `services/gateway/` 之下。** Node 只往祖先目录找 `node_modules`，
而依赖装在 `services/gateway/node_modules`。挪到仓库顶层要先把仓库改成 npm workspace，
那会动到 Dockerfile / CI / `deploy.sh` 三条已经烧过手的路径（D29 / D65）。
对应地 `Dockerfile` 里有一行 `COPY services/gateway/agent ./agent` —— 漏了它容器起不来。

**为什么 Pi 只出现在 `runtime.ts` 里**：规划文档 §2 记了一条实测风险 —— Pi 迭代极快
（82k 星、版本号已到 0.83，而且搜到过 `pi-agent-core@0.67.4` 依赖一个没发出来的
`pi-ai@^0.67.4`、装不上的真实 issue）。所以 `package.json` 锁死精确版本，
而且要换框架时只改一个文件，工具实现一行不动。

---

## 2. 能力边界靠什么实现

**靠工具清单里有没有，不靠 prompt 里写「请不要」。**

prompt 会被绕过、会被长文本冲掉、会被模型换代改变行为；而**没有的函数，它调不出来**。

### Ring 1 · 只读，随便用

| 工具 | 干什么 | 为什么做成工具而不是塞 prompt |
|---|---|---|
| `read_skill` | 按名取一本 playbook 全文（D72） | 渐进披露：索引每轮只占几行，全文只在任务匹配时才进上下文。**参数是名字不是路径** —— 路径类工具违反「工具清单=能力边界」 |
| `search_companies` | 去变音符的模糊匹配 | 56 家现在塞得下，并进 Lena 那 61 家就 100+，塞 prompt 迟早超，而且每次调用都在烧 token |
| `get_thread` | 这条对话之前说过什么 | 续写时必须先读，否则「他们年产 12000 台」会被当成一句孤零零的话 |
| `get_proposal_items` | 本人本对话的独立事项及当前版本 | 明确修订哪一项，避免把新事项当作整段改口 |
| `get_company_gaps` | 这家还缺哪些情报 | 需求1「情报清单」在采集端的落点 —— 也是这系统区别于一个录音笔的地方 |
| `get_company_records` | 这家在 CRM 里已有的项目（含当前阶段）· 在位品牌 · 没关掉的售后 | 「阶段往前推一格」的前提是知道现在在哪一格。没有它，模型只能从这一句话里读出一个绝对值，人在核对卡上看到的是一个凭空的阶段 |
| `read_attachment` | 取附件已经抽好的文本 | 长附件不必每轮都进上下文 |
| `get_projects` | 这家已有的项目、每个项目下的线程与文档 | **建项目前必须先调**：同一个编号只能有一条，「更新 HYM-BAT-2027-001」要接的是那一条 |
| `list_enums` | 全部合法值 | 枚举改了只改一处，不会出现「代码加了、prompt 忘了」 |

> ⚠️ `get_thread` **故意不收 `thread_id` 参数**（计划里原本写的是收）。
> 参数一旦可由模型指定，「读哪条对话」就变成模型说了算，而作用域必须在服务端（§4.2 第4条）。

### Ring 2 · 写提案 / 造字段

| 工具 | 落到哪 |
|---|---|
| `propose_fields` | `staging.extracted`，**服务端再白名单校验一次**（不指望它自觉）。含 `details`（长 markdown，D55）和 `chain`（结构化渠道链，D54） |
| `propose_records` | 多事项独立身份和不可变修订；明确事项及版本才能修订，逐项确认后才写 CRM（#64）。保留 `chain/corrections`；字段错误按事项 key + field 返回，不静默漏掉 |
| `ask_user` | 对话里回一句问话。**一轮最多一个** —— 展会现场每多问一句，销售就少录一条 |
| `flag_new_company` | 旧单条用 `staging.suggested_company`；多事项按明确公司名或 `itemKey` 带入提示，**只提议，绝不建** |
| `propose_intel_field` | 新的 `IntelItem` + 一条 `IntelValue`（见 §4） |
| `propose_project` | `staging.extracted.project`。**编号唯一，同编号 = 更新**（D59） |
| `propose_work_items` | `staging.extracted.workItems`。一次交一个数组 —— 四条线程要一起提 |
| `propose_document` | `staging.extracted.document`。🔴 `docSource` 如实填：AI 整理的一律落 `DRAFT` |

### Ring 3 · 压根不存在

```
create_company · write_twenty · confirm_to_crm · update_inbox · delete_anything
```

这不是「禁止调用」列表，是 `agent.state.tools` 里没有。
**执行机制只有一个**：`src/__tests__/agent.test.ts` 里那个快照测试，断言注册的工具名集合
**恰好**等于清单上的十七个（数量也写死了）。谁手滑加了个 `create_company`，那个测试立刻红。

> 这一条让「模型出错」的最坏后果，从「脏数据进了 CRM」降到「一条提案被人否掉」。

---

## 3. 附件与转写：什么在 agent 外，什么原生进模型（D71，修订 D46b）

**agent 只吃封装好的输入**：文字 + 原生多模态块。

- **音频仍在 agent 外**：网关直接调 OpenAI 转写 → 文本（D46b 对音频没变）。
  🔴 转写 prompt 里必须喂真实品牌名（实测：不带 → `Rozenfelt`，带 → `Rosenfeld` ✅）。
- **图片原生进模型**（`input_image`）：不再压成 200 字转述 —— `describeImage` 已删。
  `read_attachment` 能把原图再递一次（Pi 的工具结果原生支持图片）。
- **pdf/docx/pptx/xlsx 原生进模型**（`input_file`）：`runtime.ts` 用 pi-ai 的
  `onPayload` 钩子把 base64 拼进请求，**pi-ai 一行没改**。实测内容保真：
  PDF 正文里的合同号、终端电阻、波特率、SOP 日期全部进了提案。

### 三道护栏（护的是「任何一段挂掉，前一段的数据都还在」）

1. **字节门槛** `ATTACHMENT_INLINE_MAX_BYTES`（默认 10MB）：超了**整件降级**走本地解析 ——
   base64 的 PDF 没法按页截，不解析就不知道页在哪。
2. **格式探测三态**（同 `transcribe.ts` 的 `extendedParams` 模式）：模型报「不收这种文件」
   → 按扩展名记住、这一轮降级重跑；重启网关 = 重新探测。判据在 `rejectsInputFile()`，
   **宁可漏判也别错判** —— 错判会让那个格式重启前永远降级。
3. **降级路径 = 原 officeparser 链路**：坏文件、加密 PDF、空文件一律「只记文件名」，
   绝不让一个附件把整条速记拖成 failed。截断上限 `ATTACHMENT_MAX_CHARS`（只对降级路径）。

`attachment_text.status = 'native'`（migration 008）标记「原样喂过模型」——
它不算解析缓存：探测失败重跑时会被真实抽取覆盖。

### 成本

`store:false` 下每轮重发完整上下文 —— 所以 `sessionId`（→ `prompt_cache_key`）**必须设**
（按 thread 设，D71。2026-08-05 之前从没设过，等于每一轮 8 步的前缀全价重算）。

---

## 4. 当场造字段（D47）

维护者 2026-08-03 明确要给的权限：**装不下的东西，它当场造一个字段来装。**

落点是 `IntelItem`（清单项）+ 一条 `IntelValue`（这次的值），**不是**在 Company 上建列。

> 它的权限一点没少 —— 当场造出字段、立刻用它记录，销售那句话不会丢。
> 留给人的只有一步：「要不要升级成 Company 上的正式列」。
> **为什么那一步不给它：不是不信任，是它在处理单条速记的那一刻缺少做这个判断所需的信息。**
> 「值不值得占所有人界面上的一列」需要跨客户的证据，而它手上只有一句话。

**四条护栏，缺一条这个工具就会变成灾难：**

| # | 护栏 | 不做会怎样 |
|---|---|---|
| ① | 造之前必须查重，命中就复用 | 「年产量」会有五个变体 |
| ② | 一条速记最多造 1 个 | 它会把一句话拆成五个字段 |
| ③ | **新造的 `weight = 0`** | 分母变大 → **所有客户的完整度都往下掉**，造得越多掉得越狠，那个指标当场作废 |
| ④ | 带 `createdByAgent` + `sourceInboxId` | 人没法审，也查不回「当时为什么造这个」 |

护栏①有三层：本地 `intel_field_log` 查一遍 → Twenty 的清单查一遍（**还比问法，不只比 key**）
→ 数据库上的唯一索引兜底。

`AGENT_CAN_CREATE_COLUMNS=1` 那条路径**尚未实现**（开关在，行为不变，启动时会打印告警）。
理由写在 `tools/intel-field.ts` 底部：现在写一段没人跑过的 Metadata 建列代码，
等于在展会前往生产链路上放一段未验证、后果不可逆的东西（Twenty 删字段 = 删掉该字段所有数据）。

---

## 4.5 进度：它现在在干什么

Pi 自带事件流（`agent.subscribe`），`runtime.ts` 把它翻译成人话往上抛：

```
agent_start / turn_start / message_* / tool_execution_start|update|end / turn_end / agent_end
        ↓  runtime.ts 的 onProgress
   { stage: '查客户', steps: 3, tool: 'search_companies', done: [...] }
        ↓  loop.ts
   agent_run.stage / steps / trace          ← 每一步写一次库
        ↓  GET /threads/:id 的 running 字段
   界面上 1.2 秒拉一次
```

**为什么值得每一步都写一次库**：展会现场按下去之后转圈十几秒，人不知道它是在
干活还是已经死了 —— **不知道的那几秒里他会再按一次**。一轮最多二十来次小 UPDATE，
一天几十条速记，代价可以忽略。

预处理那两步（转写、读附件）也在里面 —— 它们恰恰是最慢的，藏起来的话
界面上就是十几秒没有任何解释的空白。所以 `agent_run` 是在**预处理之前**就建好的。

**实测形态**（一条真速记，7 步 / 11 秒）：

```
准备中            0/8   已完成 0 个工具
在想              1/8   已完成 0 个工具
在想              2/8   已完成 3 个工具
在想              3/8   已完成 4 个工具
…
```

`stage` 绝大多数时候显示「在想」是**正常的** —— 工具本身只要 3–60ms，
慢的是模型那一轮生成。所以界面上真正有信息量的是那个**已完成工具的列表**
（查客户 ✓ · 看可选值 ✓ · 整理成字段 ✓），`stage` 只是告诉人「它还活着」。

⚠️ 任何提前 return 的分支都要把 `agent_run` 从 `running` 改掉 ——
留一行 `running` 在库里，界面就永远转圈，而实际上早就结束了。

---

## 5. 出问题了怎么查

### 第一步：看这一轮到底发生了什么

```bash
node scripts/e2e-agent.mjs "刚跟 Istra 聊完，他们在看 200Ah 锂电"
```

它会把工具轨迹、抽出来的字段、对话、造过的字段全部摊开。
**只对本地跑**（会调 OpenAI、会往 Twenty 写情报项），非本地直接拒绝。

### 第二步：看库里的账

```sql
-- 最近几轮的轨迹（展会现场第一个要看的表）
select created_at, status, steps, duration_ms, stop_reason, left(error, 120)
from agent_run order by created_at desc limit 10;

-- 某一条速记具体调了什么
select jsonb_pretty(agent_trace) from staging where inbox_id = '…';

-- 卡住的活
select status, count(*) from staging group by status;
```

### 症状 → 原因

| 症状 | 多半是 |
|---|---|
| `stop_reason=done`、`trace=[]`、`extracted={}` | **模型调用本身失败了。** 看 `agent_run.error` —— Pi 不抛异常，它把 provider 的错误记在消息上（这个坑踩过：`400 Function tools with reasoning_effort are not supported … in /v1/chat/completions`，所以现在走 Responses API） |
| 全部 `status=failed`，error 里是 404 | 模型名不对。`node scripts/check-models.mjs` |
| `partial=true` 很多 | 8 步不够用。先看 trace 里它在重复调什么 —— 通常是 `search_companies` 反复试 |
| `stop_reason=max_steps` **而且 `extracted` 完全为空** | 它把步数花在读附件和查客户上，`propose_fields` 一次都没轮到。从外面看这和「什么都没抽出来」一模一样。有附件时上限已经是 `8+6`，prompt 里也写了「尽早调一次」—— 还撞到就把 `AGENT_MAX_STEPS` 调大 |
| trace 里 `read_attachment` 报 `invalid input syntax for type uuid` | 它把**文件名**当 id 传了。prompt 里的附件清单必须带 id（`· 文件名 — id: <uuid>`）—— 模型不会猜，也没地方猜 |
| 抽出了 `customerChain` 文本但 `chain` 是空的 | 顺序不合法被**整个丢弃**了（不排序，见 D54）。trace 里 `propose_fields` 的返回会写明 |
| 抽出来的 `companyCode` 总是 null | 白名单丢弃了。trace 里 `propose_fields` 的返回会写明「被丢弃了什么」 |
| 品牌名一直听错 | 转写 prompt 里的品牌名没喂进去，或者名单本身是空的（`GET /companies` 挂了） |
| `queued` 一直涨 | 队列积压。`GET /agent/health` 看 `lastError` |
| agent 造了一堆重复字段 | 护栏①失效。查 `intel_field_log` 上的唯一索引还在不在 |

### 第三步：把 agent 关掉也不影响采集

```bash
# .env
AGENT_ENABLED=0
```

速记照收、照存、照同步，只是不抽字段。`staging` 直接进 `ready` 并写明原因。
**这是三段解耦的服务端一半** —— 展会现场 OpenAI 挂了、余额没了，采集不受影响。
恢复之后重跑：把那些 staging 的 status 改回 `pending`，重启网关，`resumePending()` 会捡回来。

---

## 6. 改它的时候

| 想改什么 | 改哪 | 会不会红 |
|---|---|---|
| 加一个品类 / 阶段 | `agent/src/enums.ts` | 会 —— 顺手改 `scripts/twenty-schema.mjs`，两边不一致集成测试会抓到 |
| 改 prompt 的说法 | `agent/src/prompt.ts` | 不会。**但别在 prompt 里加「禁止…」** —— 边界靠工具清单 |
| 加一个工具 | `tools/*.ts` + `TOOL_NAMES` | 会 —— 快照测试。**这是故意的**：改那个常量本身就是一次有意的决定 |
| 改某类记录的打法 | `agent/skills/<类型>/SKILL.md` | 不会 —— 它是数据。但 `playbooks.test.ts` 断言四本都在、关键判据没丢 |
| 换模型 | `.env` 两行 | 不会。改完跑 `node scripts/check-models.mjs` |
| 换框架（Pi → 别的） | `agent/src/runtime.ts` 一个文件 | 单元测试用 pi-ai 的 `fauxProvider`，换框架时这几条要跟着改 |
| 调上限 | `.env` 的 `AGENT_MAX_STEPS` / `AGENT_TIMEOUT_MS` | 不会 |
