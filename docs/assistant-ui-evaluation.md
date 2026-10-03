# assistant-ui 完整聊天界面替换评估（2026-10-03）

用户目标：让持续维护的开源组件承担 Agent 聊天界面的通用交互，减少重复消息、输入与编辑状态的维护成本。现行界面继续默认，在设置中切换开发测试版。此次先修已确认缺陷，完整替换另一个阶段实施。

## 判断与范围

建议采用 **assistant-ui + ExternalStoreRuntime**，覆盖消息列表、输入框、附件预览、消息操作、滚动和会话列表。保持 React/Vite、网关、Twenty、Dexie 离线队列，不需要引入 Next.js 或迁移模型服务。

assistant-ui 是聊天框架，不覆盖客户管理、看板、设置与速记工具等整个 PWA。若希望这些业务页面也统一组件，需要单独评估业务组件体系。

本次核查了当前安装的 `@assistant-ui/react@0.15.23`、官方仓库及官方文档源码（快照 `314c781ce225f8dc669d53b320ae9bf4e7f349a3`）。项目仍有持续更新，官方线程组件包含完整输入和消息交互。现有 `AssistantThreadView` 仅替换消息容器，输入框、编辑、附件和主控制器仍自写，因此还没有完成用户要求。

## 能替换什么，哪些必须适配

| 部分 | 库承担的内容 | 本项目保留的业务契约 |
|---|---|---|
| Thread / Message | 消息布局、滚动、状态显示、Markdown 与操作入口 | 稳定消息身份；相同正文的两次主动发送不能去重 |
| Composer | 输入框、尺寸、键盘交互、发送入口 | 成功落入 Dexie 才清除草稿；上传在后台运行 |
| Attachments | 添加、预览、移除及粘贴入口 | iOS 文件立即读取为字节；限制、压缩、持久化与上传由适配器处理 |
| ThreadList | 会话选择、新建与列表交互 | 当前账号作用域、离线会话身份及服务器 ID 认领 |
| Edit / Cancel | 编辑与停止按钮、输入交互 | D108 新增改口原文与预检确认；停止调用网关中止接口 |
| Voice | 可接语音适配器的界面 | D111 光标位置插入、失败音频留存和现有转写服务 |
| 业务卡 | 自定义内容插槽 | 客户建议、结构化问题、逐项确认、CRM 回执和未知写入核对 |

业务卡是销售录入语义，不能用通用聊天组件的「重生成」「截断消息历史」代替。模型和网关仍是服务器状态的来源，Dexie 是未上传内容和草稿的来源；库负责即时交互状态。

## 候选比较

| 方案 | 适配情况 | 判断 |
|---|---|---|
| **assistant-ui** | MIT；提供聊天运行时、完整交互与外部状态适配 | 最贴合当前 React 项目，建议采用 |
| CopilotKit | MIT；完整 Agent UI，偏 AG-UI / Runtime 协议和应用内 Agent 平台 | 可行，但当前网关接入与状态适配成本更高 |
| Vercel AI Elements + AI SDK | Apache-2.0；聊天组件与传输工具，组件源码复制进项目 | 更适合组装界面，仍需承担较多业务控制器维护 |
| chatscope | MIT；聊天展示组件 | 对运行时、离线与 Agent 状态的支持较薄，不优先选 |

上述方案都不能自行修好网关结果不明、问答事务回滚或本地草稿迁移。引入库能够减少通用交互的维护面，业务适配仍需回归测试。

## 维护、服务与代价

- MIT 开源包可自行部署和升级。活跃维护不等于无 bug，也不代表免费提供响应时间保证。
- 官方 CLI 的完整样式组件会**复制源码到项目**。运行时与 primitives 可通过依赖升级获得修复，复制的组件需要记录上游版本、比较更新并回归，不能声称全部自动获得维护。
- 当前固定 `0.15.23`，会话列表部分 API 标为 unstable。适配层应隔离版本变化，升级先在开发测试版验证。
- Assistant Cloud 的线程、文件、反馈和评测等服务可选；付费支持与 SLA 属于另外的商业服务。本项目已有网关和离线存储，不必为了 UI 接入而将客户数据搬到 Cloud。
- 测试版按需加载；构建期 `VITE_ASSISTANT_UI_ENABLED=0` 时不生成对应包。启用构建保留现行界面默认，首次打开测试版才下载并缓存，第一次离线打开可能回退现行界面。

## 实施顺序与验收

1. 修好共用业务层的明确缺陷，确保旧界面也得到修复；多事项工具默认关闭，已有事项仍可读取、核对和确认。
2. 抽取唯一 ConversationStore，将网关快照、Dexie 待发消息与草稿投影给 ExternalStoreRuntime。消息发送在持久入队后返回，不等全部上传。
3. 开发测试版完整接管 Thread、Message、Composer、Attachments、ActionBar、ThreadList。保留业务卡插槽，删除被替代的旧输入、滚动与消息操作代码，避免两份控制器。
4. 映射 edit/cancel 到现有网关契约；不启用库的客户端改写历史、独立工具执行或重复消息队列。库的内存队列不能取代持久离线队列。
5. 两种界面通过同一套回归，再逐步启用测试版；加载失败回退不得重新发送已有消息。

现有离线草稿仍共用 `user:new` 入口，尚未认领时点击新对话会复用它；支持多份离线新会话应随 ConversationStore 迁移按 conversationId 分开存储，不以清空当前草稿作为临时修法。

验收必须包含：弱网时连续发消息及切换会话；多份尚未认领的离线新会话各自保留身份和草稿；离线第一条消息认领后保留后续草稿与附件；刷新后恢复队列字节；同文两次发送保留两次意图；账号和会话切换隔离迟回包；D108 原文不可变；未知 CRM 写入不盲重试；旧界面与禁用构建保持可用。还需 iPhone/Safari 实测中文输入法、附件、麦克风及键盘；Chromium 手机尺寸测试不能替代这些。

## 官方依据

- [assistant-ui 仓库、MIT 许可及维护记录](https://github.com/assistant-ui/assistant-ui)
- [0.15.23 发布记录](https://github.com/assistant-ui/assistant-ui/releases/tag/%40assistant-ui/react%400.15.23)
- [ExternalStoreRuntime](https://github.com/assistant-ui/assistant-ui/blob/314c781ce225f8dc669d53b320ae9bf4e7f349a3/apps/docs/content/docs/runtimes/custom/external-store.mdx)
- [Thread 组件](https://github.com/assistant-ui/assistant-ui/blob/314c781ce225f8dc669d53b320ae9bf4e7f349a3/apps/docs/content/elements/thread.mdx)
- [Runtime API 稳定性](https://github.com/assistant-ui/assistant-ui/blob/314c781ce225f8dc669d53b320ae9bf4e7f349a3/apps/docs/content/docs/runtimes/concepts/stability.mdx)
- [Cloud 服务与定价](https://github.com/assistant-ui/assistant-ui/blob/314c781ce225f8dc669d53b320ae9bf4e7f349a3/apps/docs/content/docs/cloud/pricing.mdx)
- [CopilotKit](https://github.com/CopilotKit/CopilotKit)、[AI Elements](https://github.com/vercel/ai-elements)、[chatscope](https://github.com/chatscope/chat-ui-kit-react)
