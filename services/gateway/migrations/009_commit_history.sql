-- D75：入库之后仍可修改并重新入库。
--
-- commit_history 是重录的审计轨迹：每次重录前，把上一次提交的
-- { at, by, fields, refs } 推进数组 —— 改了什么、原来是什么，三个月后查得回。
-- 撤销一次重录 = 弹出最后一条恢复回去（cancelConfirm 的 recommit 分支）。
--
-- ⚠️ 判据（§2.26）：这列**不是**「新代码启动时就要用的」——
--    旧代码不读它，新代码读到默认空数组也完全正常，先起后迁不会死锁。
--    但部署顺序仍按惯例：迁移 → 起网关。

alter table staging add column if not exists commit_history jsonb not null default '[]'::jsonb;
