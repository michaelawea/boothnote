-- Agent 路由器（D127）：channel_event 的 kind 白名单加 'route'。不动任何数据。
--
-- 统一入口对每条消息记一格「当时分给了谁、按什么理由」（kind='route'，
-- raw = {route, via, reason}，event_key = route:<clientId> 唯一）——
-- 分错方向时要查得出账，重放（流程重试）时直接复用第一次的决定，
-- 免得模型改主意让一条消息两边各答一次。
--
-- ⚠️ 015 里这个 check 是列内联写法，Postgres 自动命名 channel_event_kind_check。
alter table channel_event drop constraint if exists channel_event_kind_check;
alter table channel_event add constraint channel_event_kind_check
  check (kind in ('message','reject','receipt','receipt_skipped','receipt_failed','route'));
