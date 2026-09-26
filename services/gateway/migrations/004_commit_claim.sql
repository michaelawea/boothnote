-- ════════════════════════════════════════════════════════════════════
--  提交心跳的「认领」状态（issue #1）
--
--  2026-08-04 生产实测：点一次「确认入库」，CRM 里写了两份 ——
--  拜访 2 条、选型情报 2 条，同名同客户，时间戳同一秒。
--
--  根因是 confirm.ts 的心跳「先 select 再提交」：
--    · commitToTwenty() 直到最后一行才把 status 改成 confirmed，
--      中间要跑十几次 Twenty REST 往返
--    · setInterval 不管上一轮跑没跑完，1 秒后照样再跳一次
--    → 同一行 status 还是 confirming，被第二次选中、再提交一遍
--
--  修法是把 select 换成「原子认领」（update … returning），
--  于是需要一个介于 confirming 和 confirmed 之间的状态：
--
--    confirming  已点确认，还在 5 秒撤销窗口里 —— **撤得掉**
--    committing  已被某一轮心跳认领，正在写 Twenty —— **撤不掉了**
--    confirmed   写完了
--
--  ⚠️ `committing` 这一档同时让「撤销」的边界变得诚实：
--     在它之前撤销 = 从来没写过；在它之后 Twenty 里已经在写了，撤销是句谎话。
-- ════════════════════════════════════════════════════════════════════

alter table staging drop constraint if exists staging_status_check;
alter table staging add  constraint staging_status_check check (
  status in ('pending','transcribing','extracting','ready',
             'confirming','committing','confirmed','failed'));

-- 认领查询走这条索引：where status = 'confirming' and confirm_after <= now()
create index if not exists staging_due_idx on staging (confirm_after)
  where status = 'confirming';
