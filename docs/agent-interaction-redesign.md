# Agent interaction changes (#64, #65, #66)

## Shared constraints

Both conversation interfaces use the same authenticated gateway, immutable inbox,
offline outbox and business confirmation cards. Changing the interface does not
create a separate CRM or authorize additional writes. Original messages and
attachments remain append-only; corrections produce new sources and revisions.

## #66: opt-in assistant-ui

The existing interface remains the default. An account-scoped, device-local setting
selects the developer test interface for the next conversation view. assistant-ui
renders the conversation list; the existing controller owns sending, recording,
attachments, editing, history, questions and confirmation. Only one runtime mounts.
`VITE_ASSISTANT_UI_ENABLED=0` hides the experimental setting at build time; rebuild
the PWA to apply it. Changing a local account preference takes effect on the next
conversation view.

Review changed the initial integration plan: library editing, cancellation and
branch management cannot own immutable business history. Those actions remain in
the business controller. A stable client message ID reconciles queued messages
with server receipts, and a stable client conversation ID groups offline replay.
Polling has one in-flight request and rejects results from a previous conversation.
Drafts survive renderer failures; the fallback never sends a message again.

## #65: explicit target selection

CRM reads return verified candidate handles with identifying facts. A structured
question binds its options to a source, proposal revision, account and conversation.
The server stores question state separately from immutable message metadata.
An answer creates a new immutable source and deterministically binds the chosen
target; it does not rely on a model interpreting a button label later.

Review added revision checks, idempotent answer receipts and target validation
again before commit. Missing/error/incomplete CRM reads are not evidence that no
old record exists. A closed target does not silently reopen. Cross-conversation
CRM discovery remains possible, while another user's draft or answer is inaccessible.
Offline answers retain their original binding; stale answers require a new choice.

## #64: independent proposal items

One source can propose several independent records, including identical-looking
complaints. Stable item IDs distinguish them; revisions preserve corrections.
The card submits an explicit list of selected item IDs and expected revisions.
Missing companies are allowed in a draft but must resolve to existing CRM IDs at
confirmation. A legacy single-record request cannot flatten a multi-item proposal.

Review rejected a simple loop over the old commit function: a partial failure
could replay successful creates. Each item instead has a durable operation ledger
and retains successful receipts immediately. Other items continue when one fails.
An ambiguous remote response is an unknown outcome and cannot be blindly retried.
The system does not claim remote exactly-once semantics without CRM support.
Known-target append operations validate ownership/type and serialize changes.
Corrections target a specific item rather than superseding every proposal in a thread.
The gateway holds an exclusive database worker lease before startup recovery.
A replacement starts after the old process stops; interrupted writes become unknown
and retain their successful receipts. Losing the lease stops the old process.
This implementation requires one gateway worker per database.

## Validation

Unit tests cover identity, selection, revision and state transitions. Isolated
Postgres plus a fake CRM exercises actual authenticated HTTP, persistence,
duplicate answers, partial commits and response loss. Browser checks exercise both
interfaces on mobile layouts in both languages. Fake CRM tests establish our
contract, not the behavior of a production Twenty instance. Real-service tests
requiring unavailable credentials remain explicitly skipped.

The final local checks pass 829 unit tests, 222 database integration tests and
25 isolated fake-CRM flows. Five Chromium mobile-layout scenarios cover Chinese
and English in both renderers plus renderer-load failure. Both container images
build and pass packaging checks. TypeScript, i18n and schema checks pass; 39
real-service integration cases remain skipped. Actual model behavior, production
Twenty behavior, Safari and physical-device microphone input are not validated
by these fixtures. No production migration or deployment was performed.

## 2026-10-03 合并后修复与下一阶段边界

上述验收数对应 PR #67 的初次实现，不能证明未覆盖的弱网边界或真实服务行为。后续复核确认发送等待 flush 和离线认领丢草稿、多事项问题落库失败、开关未透传、unknown 缺少核对入口等缺陷，本轮逐一修复并加回归。

多事项工具默认 `AGENT_MULTI_ITEMS=0`；启用需显式配置，已有事项仍可使用。实际 HTTP 写入前保存请求证据；核对只接受服务器对同一目标和请求的读回验证，未知创建无可信身份仍需人工处理，不自动重试。

当前 assistant-ui 仅替换消息容器。完整替换方案见 [assistant-ui-evaluation.md](assistant-ui-evaluation.md)：采用 ExternalStoreRuntime，复用唯一网关/Dexie 状态，下一阶段接管 Composer、附件、消息操作和会话列表。业务核对与 D108 改口保持原契约。
