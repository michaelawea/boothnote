# Agent 新架构规划

> 状态:**已实施**(2026-08-05 深夜,D71/D72/D73 · T51)。Phase 0–4 全部落地:
> 场景验收 8/8 · 单元 72 · 集成全绿;三条真实案例 e2e 通过(CI-Bus 项目速记 /
> 同对话两轮修正 / 真 PDF 走 input_file 内容保真 5/5)。
> 与提案的偏差:① 超时默认 60s→120s(实测项目类 5 轮吃满 60s);② §5 的
> waiting_user 落在 `agent_run.stop_reason` 而非 staging.status(不动看板状态机);
> ③ 追加了「编号是编的就置空」执行机制(propose_project 三重核验)。
> 「观望」的 AgentHarness 整机替换维持展会后再议。实现细节见 CHANGELOG 2026-08-05(十三)。
>
> 以下为原提案,回应 issue #17 与 维护者 的三点要求:
> ① 附件走 gpt-5.6-luna 的原生多模态,别在本地 parse 成纯文本;
> ② 能砍的本地复杂度都砍掉;
> ③ 把「skills」升级成标准的 agent skill,最大化复用 pi-agent-core 已有的 harness。
> 采纳的条目要落进 内部设计日志（未公开） §3 拿决策编号,本文档随后降级为实现参考。

---

## 0. 一句话

**我们只用了 Pi 的 5%。** 现在的 agent 是「裸 `Agent` 类 + 自己拼的一切」:
自己 parse 附件、自己拼 200 行独白 prompt、自己用浅拷贝模拟多轮、自己伪造兜底。
而锁定的 `pi-agent-core@0.83.0` 里躺着一整个 `harness/` 层 —— 标准 SKILL.md 技能系统、
会话持久化(带分叉与摘要)、请求体改写钩子、steering/followUp 队列 —— 一样都没用。
这份规划的主线就是:**把自己造的轮子换成 Pi 已经造好的,顺路把附件链路换成原生多模态。**

## 1. 调查结论(全部实测自 node_modules,带出处)

动手前先把「Pi 到底有什么」查清 —— 这个项目的判据:事实能查就别猜。

| # | 能力 | 出处(均在 `services/gateway/node_modules/`) | 现状 |
|---|---|---|---|
| 1 | **标准 Skill 系统**:递归扫目录加载 `SKILL.md`(YAML frontmatter `name`/`description` + 正文),`formatSkillsForSystemPrompt()` 生成 agentskills.io 风格的 `<available_skills>` 块(只列名字和描述,**渐进披露**),`formatSkillInvocation()` 显式注入全文 | `pi-agent-core/dist/harness/skills.js` · `system-prompt.js` | ❌ 没用。我们的 `skills/` 只是工具定义,名字撞车 |
| 2 | **Session 持久化**:JSONL 存储、会话树(可分叉、可打标签)、`buildContext()` 恢复上下文、compaction 条目 | `harness/session/*.js` | ❌ 没用。多轮靠 `loop.ts` 浅拷贝上一轮 `extracted` |
| 3 | **`onPayload` 钩子**:发请求前可整体改写 provider 请求体 | `pi-ai/dist/types.d.ts:78`,在 `api/openai-responses.js:100` 生效 | ❌ 没用。这是 `input_file` 的注入点 |
| 4 | **工具结果可以带图片**:`ToolResultMessage.content` 收 `ImageContent`,Responses 绑定映射成 `input_image`(条件:model 声明 image 输入 —— 我们声明了) | `pi-ai/dist/types.d.ts:307` · `api/openai-responses-shared.js:35-57` | ❌ 没用。`read_attachment` 只会回预抽好的文字 |
| 5 | **用户消息原生带图**:`agent.prompt(text, [{type:'image',data,mimeType}])` | pi-agent-core README | ❌ 没用。图片被 `describeImage` 预降解成 200 字中文 |
| 6 | **OpenAI SDK 自带 `input_file` 类型**:`file_data`(base64)/`file_id`/`file_url` + `filename` | `openai/resources/responses/responses.d.ts:2675` | 未接。SDK 类型齐全,payload 层拼上即可 |
| 7 | **Prompt 缓存**:`buildParams` 把 `options.sessionId` 写成 `prompt_cache_key`(`store:false`) | `pi-ai/dist/api/openai-responses.js:208` | 🔴 **runtime.ts 从没设 sessionId —— 每一轮 8 步对话的前缀都在全价重算** |
| 8 | **steering / followUp 队列**:跑动中插话、跑完追加一轮 | `Agent.steer()` / `Agent.followUp()`,裸 Agent 就有 | ❌ 没用。这是「出口契约兜底重试」的正确机制 |
| 9 | **`toolChoice` 透传** | `api/openai-responses.d.ts` `OpenAIResponsesOptions` | ❌ 没用。可强制首轮调用某个工具 |
| 10 | **AgentHarness 整机**:以上全家桶 + 事件钩子矩阵 + `setActiveTools` 动态工具集 | `harness/agent-harness.d.ts` | ❌ 没用 |

## 2. 设计原则(不变的 + 新增的)

继承不动的:
- **三圈能力边界**照旧:Ring 3 靠「没注册」实现,`TOOL_NAMES` 快照测试照守。
- **Pi 只在 runtime 层出现**:上层依然只见我们自己的类型。SKILL.md 是**数据文件**不是代码,不构成耦合。
- **inbox 只增不改**、PWA 永不直连 Twenty、agent 永远写不了 CRM —— 一个字不动。

新增两条:
- **N1 · 模型的眼睛优先于本地解析器。** 附件先原样给模型;本地解析(officeparser)降级为
  「模型看不了的时候」的退路,而不是必经之路。D46b 相应修订(见 §9)。
- **N2 · 接口能力靠探测,不靠假设。** `input_file` 收不收 docx、大文件收不收,
  一律「带上去试,被拒记下来退回去」—— `transcribe.ts` 的 `extendedParams` 三态已经验证过这个模式。

## 3. P0 · 附件原生多模态直通

### 现状链路(要被替换的)

```
图片 ──describeImage(chat/completions!)──▶ ≤200字中文描述 ─┐
PDF/Office ──officeparser(worker 线程)──▶ 纯文本 clip 32k ──┼──▶ 拼进 prompt 字符串
纯文本 ──readFile──▶ clip 32k ─────────────────────────────┘
```

三个真实损耗:图片上的规格表被压成一段转述;PDF 里的表格/图纸/版式全丢;
扫描件 officeparser 解析出空串直接降级成「只记文件名」。issue #17 那类「附件里的时间线没进结构」,
一部分根源就是模型从没见过原件。

### 新链路

```
图片   ──▶ agent.prompt(text, images) 原生 input_image(能力 5)
PDF/docx/pptx/xlsx ──▶ 消息里放占位符,onPayload 把 input_file{file_data:base64,filename} 拼进首条 user 消息(能力 3+6)
纯文本 ──▶ 照旧拼文字(它本来就是文字,没有「原生」可言)
音频   ──▶ 照旧走 transcribe.ts(Responses API 不做转写,D46b 对音频仍然成立)
```

实现落点全在 `runtime.ts`(它本来就是 provider 唯一接触面):
`RunInput` 加 `files: Array<{filename, mime, bytes: Buffer}>`,包装 streamFn 时挂 `onPayload`,
在 params.input 的首条 user 消息里把占位符展开成 `input_file` 项。**pi-ai 一行不改,不 fork。**

### 三道护栏(维护者 点名的截断问题)

1. **字节门槛**:`ATTACHMENT_INLINE_MAX_BYTES`(建议默认 10MB,进 `env.ts` + preflight 对账)。
   超了不 inline,直接走降级路径。⚠️ base64 后的 PDF 没法「按页截断」——
   不解析就不知道页在哪,解析了就回到老路。所以截断的语义是**整件降级**,不是砍半件。
2. **格式探测三态**(N2):按扩展名记「支持 / 不支持 / 没试过」。400 报「格式不收」→ 记下来,
   这一条当场用降级路径重跑;下一条同格式不再撞。PDF 按 维护者 给的信息应当直接可用;
   docx/pptx/xlsx 让探测说话 —— **接口参数猜不得**(`check-models.mjs` 的判据)。
3. **降级路径 = 现在的整条链路**:officeparser + clip 保留,但只在「超门槛 / 探测不支持 / 模型 4xx」时走。
   任何一段挂掉,前一段的数据都还在 —— 这条哲学不因为多模态就丢。

### 成本账(必须先算,不然多轮重发会吓一跳)

Responses API `store:false` 下,每一轮工具往返都重发完整上下文 —— 一个 5MB PDF × 8 轮就是 8 次输入。
解法就是能力 7:**给 agent 设 `sessionId = inboxId`,`prompt_cache_key` 生效后,
第 2 轮起文件前缀走缓存价**。这行代码独立于其他一切,**今天就该加**(见 §8 Phase 0)。
不采用 Files API(`file_id` 上传复用):省的钱有限,换来文件生命周期管理(上传、删除、隐私、key 权限)
一整套新复杂度 —— 和「减少本地复杂度」背道而驰。

## 4. P1 · 标准 SKILL.md 技能库(回应「根本不是标准的 agent skill」)

### 先正名

现在 `agent/src/skills/` 里的东西是**工具**(TypeBox schema + execute),Pi 管这叫 `AgentTool`。
标准 agent skill(agentskills.io,Pi 原生支持)是**带元数据的 markdown 指令包,渐进披露**:
系统提示词里只出现 name + description 一行,模型判断相关才去读全文。
两个概念都要,但要各归各位:

- `agent/src/tools/` ←(改名)现在的 skills/,继续是工具,三圈不动
- `agent/skills/` ←(新增)SKILL.md 技能库,**数据文件,改了不用发版**(和 `data/intel-items.json` 同哲学)

### 技能库切法 —— 正好治 issue #17 的病根

200 行独白 prompt 的问题上一轮已经定性:所有指令在同一段里争抢压强,项目链 30 行对一条纯选型速记是纯噪声。
SKILL.md 的渐进披露就是为这个生的:

```
agent/skills/
├── project/SKILL.md      # 项目/跟进 playbook:判据词表、propose_project 义务、
│                         #   get_projects 先行、milestone 逐条拆(dueDate 必填)
├── support/SKILL.md      # 售后 playbook:## 车辆与合同 那套结构模板、caseStatus/severity 判法
├── fitment/SKILL.md      # 选型 playbook:在位品牌只追加、sourceConfidence 三档、渠道链
└── attachment/SKILL.md   # 长附件转录规范:宁可长不要漏、冲突以口述为准
```

主 prompt 瘦身到 ~60 行只留:场景设定、通用铁律(propose_fields 强制、companyCode 可空、
不输出人名、日期注入)、`formatSkillsForSystemPrompt()` 生成的技能索引。

### 披露机制:推拉结合

- **拉**(标准路径):注册一个 `read_skill(name)` 工具 —— 从 `loadSkills()` 的结果 map 里取全文,
  **不开文件系统**(不用 Pi 的 createReadTool,路径类工具违反本仓库「工具清单=能力边界」)。
- **推**(省步数):上一轮评估定过「先分类再路由」—— 分类初判出 recordType 后,
  用 `formatSkillInvocation(skill)` 把对应 playbook 全文直接 append 进消息,省掉一步拉取。
  两者不冲突:推是快路径,拉是兜底(模型中途改判时自己能翻到正确的册子)。

`loadSkills()` 需要一个 `ExecutionEnv` —— 用 `pi-agent-core/node` 的 `NodeExecutionEnv`,
只在启动时加载一次并缓存(技能库是只读数据),不把 env 交给模型。

## 5. P2 · Session 化:多轮与 ask_user 的正解

现状的两个替身都该退役:
- issue #14 的「继承」= 浅拷贝上一轮 `extracted` JSON(`loop.ts`)。上一轮的**推理过程**全丢,
  只剩结论,于是「把优先级改成紧急」之外的微调经常改错格。
- `ask_user` = 往 ctx 塞一条问题然后照常收工。答案回来是一轮全新跑动,options 到不了屏幕,
  统计里「等人回答」和「完成」分不开。

用能力 2 的 Session(JSONL 落 `env.audioDir` 同级的 `agent-sessions/`,备份脚本顺带,T35 一并解决):

- **一条 thread 一个 session**。续写时 `session.buildContext()` 恢复完整消息史,
  `agent.state.messages` 灌回去接着跑 —— 模型记得自己上一轮为什么这么填。
- **ask_user 变成真的暂停**:问了问题 → run 以新增的 `stopReason: 'waiting_user'` 结束
  (不再谎报 done),staging 状态同名新增;人在核对卡上点了选项(前端把 options 渲染成 chips)→
  同一 session `followUp(答案)` 续跑。重启不怕:JSONL 在盘上。
- `superseded` 链、`agent_run` 落库照旧 —— session 是**过程**的真相源,staging 仍是**结论**的真相源。

## 6. 出口契约(上一轮评估的落点,机制换成 Pi 的)

- 兜底重试用 **followUp 而不是伪造**:跑完发现 `!ctx.proposed` → `followUp('你还没调 propose_fields,现在调')`
  再给 2 步预算,还不调才走现在的原文兜底。比静默拼一个假 extracted 诚实,也便宜(一次追问几分钱)。
- `recordType ∈ {project,followup}` 而无 project 提案 → 同样先 followUp 点名,再走 loop.ts 现有的标黄。
- 首轮可用能力 9 的 `toolChoice` 强制 `list_enums`,把「第一步先看合法值」从 prompt 恳求变成结构保证。

## 7. 本地复杂度削减清单(维护者 问的「还有什么能减」)

| 动作 | 对象 | 依据 |
|---|---|---|
| **删** | `describeImage()`(transcribe.ts 里那段 chat/completions 看图) | 被原生 input_image 取代;它还是全库唯一残留的旧端点调用 |
| **降级化** | `attachment-worker.ts` + officeparser | 只在 §3 三道护栏触发时跑;若上线一个月探测显示全格式直通,连依赖一起删 |
| **简化** | `attachment_text` 表和 clip 逻辑 | 只服务降级路径;正常路径文件本身就是缓存,少一层「解析结果对不对」的对账 |
| **删** | `loop.ts` 的继承浅拷贝(inheritedFrom 那段) | 被 session 续跑取代(§5) |
| **简化** | `read_attachment` 工具 | 图片附件直接回 `ImageContent`(能力 4);文档类正常路径下不再需要它重看 |
| **瘦身** | `prompt.ts` 200 行 → ~60 行 | 分册进 SKILL.md(§4) |
| **不动** | `transcribe.ts` 音频转写、`title.ts` | 转写不走 Responses;标题链独立且兜底完善,为统一而统一不值 |
| **不动** | 队列/attempts/resumePending | 与本次无关,且每一行都是花钱买来的 |

## 8. 分期(距 8/28 还有 23 天,每期独立可上线可回退)

| 期 | 内容 | 量 | 风险 |
|---|---|---|---|
| **Phase 0** | `sessionId = inboxId` 开 prompt 缓存 | **半小时** | 无。纯省钱,今天就该做 |
| **Phase 1** | 图片直通(prompt images + read_attachment 回图),删 describeImage | 1 天 | 低。faux binding 不受影响 |
| **Phase 2** | input_file 注入 + 三道护栏 + 探测三态 | 1–2 天 | 中。护栏各配单测;降级路径就是老路径,回退=永远走降级 |
| **Phase 3** | SKILL.md 技能库 + prompt 瘦身 + read_skill | 2 天 | 中。**必须过 CI-Bus 回归**(issue #17 案例进 scenarios,断言 extracted 结构) |
| **Phase 4** | Session 化 + waiting_user + followUp 出口契约 | 2–3 天 | 偏高。动状态机,集成测试要加「问答续跑」链路 |
| 观望 | AgentHarness 整机替换(能力 10) | — | 收益主要是我们自己拼的钩子/队列管理可以删,但要把测试注入从 streamFn 改成 Models 注入。**零件先行,整机等 Phase 3/4 站稳再评估** —— 展会前不换发动机 |

## 9. 对既有决策的修订(采纳后要进规划文档)

- **D46b 修订**:「agent 只吃字符串」→「agent 只吃**封装好的输入**(文字 + 原生多模态块);
  转写仍在 agent 之外」。原决策买到的三件事(测试喂字符串、预处理失败不拖垮 agent、换模型不碰 agent)
  在新链路下分别由 faux binding、降级路径、runtime.ts 单点承接,一件没丢。
- **步数预算连带**:附件不再消耗 read_attachment 往返,「有附件 +6 步」可以降;但 Phase 3 的
  分型预算(project 链更长)仍按上一轮评估执行。
- **新 env 键**(`ATTACHMENT_INLINE_MAX_BYTES` 等)必须同步进 compose + preflight 对账 —— D66 的教训。

## 10. 要 维护者 拍板的 —— ✅ 已随实施定案(2026-08-05)

1. Phase 顺序:**按表实施了**(P0→P1→P2→P3→P4)。
2. session JSONL 落盘:`data/audio/agent-sessions/`(audioDir 下,唯一挂 volume 的持久化目录,备份顺带)。
3. 目录命名:`agent/skills/`(SKILL.md)与 `agent/src/tools/`(工具)并存,已沿用。
4. AgentHarness 整机替换:维持**展会后再议**。
