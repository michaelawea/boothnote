# agent —— 把一句现场速记变成一份提案

> 2026-08-05 从 `services/gateway/src/agent/` 搬到这里（issue #17）。
> 目的只有一个：**它是一整块可以单独审查、单独改的东西**，不再散在网关的源码树里。

## 一句话

销售在展会上说一句话 → 这里把它变成结构化提案 → **落 `staging` 表，等人在核对卡上按一下**。
**它从头到尾没有能力把任何东西写进 CRM。**

## 🔴 先分清两个 `skills`

这两个名字长得一样，管的事完全不同。**2026-08-05 的改名就是为了消除这次撞车**
（`src/skills.ts` 的文件注释里也写着）：

| 路径 | 是什么 | 改它要不要发版 |
|---|---|---|
| **`src/tools/`** | **工具定义** —— agent 能调用的函数。以前叫 `src/skills/` | 要 |
| **`agent/skills/`** | **playbook** —— 四本标准 `SKILL.md`，写的是「某类记录该怎么打」 | **不要**（D72，它是数据） |
| `src/skills.ts` | 上面那个 playbook 库的**加载器**（索引 / 按名取全文） | 要 |

## 边界：三圈

**最多 17 个工具**（`src/tools/index.ts` 的 `TOOL_NAMES` 是唯一真相源）。
多事项默认停用；`AGENT_MULTI_ITEMS=1` 才向 PWA 注册 `propose_records` 和 `get_proposal_items`，
停用时仍保留原 15 个工具。钉钉不注册这两个工具及 `propose_intel_field`。

| 圈 | 工具 | 在哪 |
|---|---|---|
| **Ring 1** 只读（9） | `read_skill` · `search_companies` · `get_thread` · `get_proposal_items` · `get_company_gaps` · `get_company_records` · `get_projects` · `read_attachment` · `list_enums` | `src/tools/read.ts` · `project.ts` · `records.ts` |
| **Ring 2** 写提案（8） | `propose_fields` · `propose_records` · `ask_user` · `flag_new_company` · `propose_intel_field` · `propose_project` · `propose_work_items` · `propose_document` | `src/tools/write.ts` · `project.ts` · `records.ts` · `intel-field.ts` |
| **Ring 3** 压根没注册（5） | `create_company` · `write_twenty` · `confirm_to_crm` · `update_inbox` · `delete_anything` | 不存在 —— 这就是它的实现方式 |

🔴 **能力边界靠「工具清单里有没有」，不靠 prompt 里写「请不要」。**
prompt 会被长文本冲掉、会被模型换代改变行为；而没有的函数，它调不出来。
`src/tools/index.ts` 底部的 `TOOL_NAMES` / `FORBIDDEN_TOOL_NAMES` 有测试逐字对账 ——
谁手滑加了个 `create_company`，`src/__tests__/agent.test.ts` 立刻红。

多事项字段保留 `chain` 和 `corrections`；非法业务字段返回具体事项 key 和 field，
关系 UUID 及内部字段会剥除并在工具文本明确报告。新客户提示必须按同名
`suggested_company` 或明确 `itemKey` 带入，不能复制最后一家建议；
`sourceCompanyName` 是消息来源，不能据此绑定客户。

`ask_user` 与 `propose_records` 两种调用顺序都校验问题归属。先问再产生多项而没有
itemId 的问题会被撤出本轮待发送问题，提案保留，模型可按工具返回的稳定身份重问。
最终已知 `QuestionError` 用数据库 savepoint 保留正常回复和事项；数据库故障仍然报错。

旧单条提案与新原话的关系不明确时，先请用户选择准确旧候选的 `continue` 或
独立新事项 `create`。该问题的来源暂不可确认，网关重启也不会自动重跑等人任务。
只有持久化答案解除边界：`create` 保留旧卡并清旧客户/业务字段；`continue`
只消费精确旧卡，其他待确认事项保留。模型自报选择不能解除这道边界。

本轮的兼容边界：选 `continue` 后只走 `propose_fields` 的补丁合并，原字段与原详情保留，
不能再转多项清掉旧基底；选 `create` 才可生成新的多事项。把旧单条统一迁到事项状态机
仍是后续工作。答案续跑按已验证的问题来源重新提供原话及附件，每项 `evidenceRefs`
保存原始问题来源和本次答案。CRM 的 `sourceNote` / 附件出处目前仍按本次答案 inbox
生成；真实原始来源可从网关证据及问题台账追溯，CRM 出处展示增强留待后续。

## 文件地图

```
agent/
├── README.md              ← 你在读的这份
├── REDESIGN.md               D71/D72/D73 重构方案全文 + 实施状态
├── skills/                ⭐ **playbook（数据，改了不发版）** —— D72
│   ├── project/SKILL.md      项目/跟进：编号规则 · milestone 拆解 · 新旧判断
│   ├── support/SKILL.md      售后：结构模板 · caseStatus / severity 判法
│   ├── fitment/SKILL.md      选型：在位品牌只追加 · sourceConfidence 三档 · 渠道链
│   └── attachment/SKILL.md   附件：转录粒度 · 口述为主 · 内容去处
└── src/
    ├── host.ts            🔴 唯一对外的口子。agent 依赖了外面什么，完整写在这一个文件里
    ├── index.ts              对网关暴露的函数（enqueue / resumePending / agentHealth / …）
    ├── loop.ts               后台队列：预处理 → 跑 agent → 落 staging。重试预算与 session 续跑也在这
    ├── prompt.ts          ⭐ 系统提示词。~90 行核心 + playbook 索引（**渐进披露**，D72）
    ├── skills.ts             playbook 加载器：给索引、按名取全文
    ├── runtime.ts            Pi 框架的唯一接触面。换框架只动这一个文件，工具清单一行不动
    ├── enums.ts           🔴 枚举的唯一真相源（agent / 网关 /enums / 核对卡 四处共用）
    │                         中英两份标签 + `labelsFor()`（D80）
    ├── transcribe.ts         语音 → 文字。**跑在 agent 之外**（D46b）
    ├── attachments.ts        附件 → **原生喂给模型**（`input_image` / `input_file`，D71）
    │                         超 10MB 或探测不支持才走 officeparser 降级
    ├── attachment-worker.ts
    ├── title.ts              自动标题（D69 / issue #15）
    ├── tools/             ⭐ **工具定义**。**改「它能做什么」改这里**（2026-08-05 从 `skills/` 改名）
    │   ├── index.ts          TOOL_NAMES / FORBIDDEN_TOOL_NAMES = 能力边界的执行机制
    │   ├── context.ts        一轮的上下文
    │   ├── read.ts           Ring 1
    │   ├── write.ts          Ring 2 · 字段提案
    │   ├── project.ts        Ring 2 · 项目 / 任务线程 / 文档（D59）
    │   └── intel-field.ts    Ring 2 · 当场造一个情报字段（D47）
    └── __tests__/            零依赖，7 个文件 1 秒跑完
```

## 想改什么，改哪个文件

| 你想做的事 | 改哪 | 要发版吗 |
|---|---|---|
| **改某类记录的打法**（怎么拆 milestone、怎么判 severity…） | **`skills/<类型>/SKILL.md`** | **不用** —— 它是数据。但 `playbooks.test.ts` 断言四本都在、关键判据没丢 |
| 它判断错了记录类型 / 阶段 / 可信度 | `src/prompt.ts` —— 用**判据**写，不要用形容词（见下） | 要 |
| 给它一个新工具 | `src/tools/*.ts` + `src/tools/index.ts` 的 `TOOL_NAMES` + 测试 | 要 |
| 改某个工具收什么参数 | 那个工具的 `parameters`（TypeBox schema）。**描述就是给模型看的文档** | 要 |
| 加一个枚举值 | `src/enums.ts` —— ⚠️ 同时要改 `scripts/twenty-schema.mjs`，**网关的标签必须是 schema 标签的后缀**（D78 之后是双语 label） | 要 |
| 换模型 / 换 provider | `src/runtime.ts` + `.env` 的 `OPENAI_EXTRACT_MODEL` | 要 |
| 转写听错品牌名 | `src/transcribe.ts` + `data/stt-terms.json`（改词表不发版） | 不用 |
| 它步数 / 时间不够用 | `.env` 的 `AGENT_MAX_STEPS`（默认 **8**）、`AGENT_TIMEOUT_MS`（默认 **120000**）。**带附件时步数自动 +6**（`src/loop.ts`） | 不用 |

### prompt 的写法（这个仓库的经验）

**用判据，不要用形容词。** 有效的长这样：

> 只要句子里出现「售后」两个字，就是 support。

无效的长这样：

> 请仔细判断这条记录的类型。

原因很实在：形容词无法被检查，也无法被测试。判据可以。
`docs/agent.md` 记了每一条判据是被哪次实测逼出来的。

⚠️ D72 之后 `prompt.ts` 只放**核心 + playbook 索引**（221 行瘦到 ~90 行）。
某一类记录的详细打法写进对应的 `SKILL.md` —— 索引每轮只占几行，
全文只在任务匹配、模型主动 `read_skill` 时才进上下文。

### 一条硬规矩

**不要在 prompt 里写「不许做 X」来当安全边界。** 那是 Ring 3 的活。
prompt 只回答「怎么把活干好」，能力边界只由工具清单回答。
唯一的例外是「不要输出自然人姓名」—— 那是合规要求，而且工具层没有执行点。

## session 续跑（D73）

同一个对话的消息史落在 `data/audio/agent-sessions/`（`env.audioDir` 之下，
所以**备份的增量镜像一并覆盖**，见 D79）。续写时只改该改的格；
`ask_user` 问完如实记 `waiting_user`；跑完欠产出会先**追问一轮**再兜底。

## 怎么跑 / 怎么测

```bash
# 零依赖单元测试（1 秒）
cd services/gateway && node --test agent/src/__tests__/*.test.ts
# 或者跟着整套跑
./scripts/test.sh
```

⚠️ **新增测试文件必须同时往 `scripts/test.sh` 的 `units()` 里加一行** ——
单元档是逐个列文件的（通配符会把要真库的 `api.test.ts` 卷进来），漏一个它就永远不跑。

```bash
# 让一句真话穿过整条链路并摊开每一步（只对本地，会真的调模型）
node scripts/e2e-agent.mjs "刚跟 Alpin 聊完，他们逆变器现在用 Voltaro，明年想换"

# 业务场景验收（慢、花钱，改完 prompt / SKILL.md / 数据模型跑一次）
./scripts/test.sh scenarios

# 转写效果打分（需要 docs/test_example/audio/ 里的真音频）
node scripts/stt-eval.mjs
```

## ⚠️ 位置约束

这个文件夹必须留在 `services/gateway/` 之下。
Node 只往**祖先目录**找 `node_modules`，而依赖装在 `services/gateway/node_modules`。
挪到仓库顶层就得先把仓库改成 npm workspace —— 那会动到 Dockerfile / CI / `deploy.sh`
三条已经烧过手的路径（D29 / D65）。真要挪，那是一次单独的、有自己 PR 的改动。

对应地，`Dockerfile` 里有一行 `COPY services/gateway/agent ./agent` ——
**漏了它容器起不来**（启动即崩，不是静默失败，这一点是刻意的）。
`agent/skills/` 的四本 SKILL.md 也是靠这一行进镜像的。

## 延伸阅读

- `docs/agent.md` —— 最多 17 个工具三圈、为什么转写在它之外、造字段的四条护栏、出问题怎么查
- `REDESIGN.md` —— D71 / D72 / D73 的方案全文与实施状态
- `docs/gateway-contract.md` —— 提案落到 `staging` 之后，前后端怎么约定
- 内部设计日志（未公开） §3 —— D31 / D46b / D47 / D48 / D59 / D71–D73 的理由和代价
