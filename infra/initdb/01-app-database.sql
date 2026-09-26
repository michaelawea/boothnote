-- [本项目] 只在 Postgres 数据目录首次初始化时执行一次。
--
-- Twenty 用 `default` 库，由它自己的 migration 管理 —— 我们一个字都不碰（D8）。
-- 我们自己的表（inbox 原文 / staging 待确认 / IntelItem 配置 / 审计）放独立的 `boothnote` 库：
--   · 同一个 Postgres 实例 → 一个容器、一次 pg_dump 备份（R13）
--   · 不同数据库          → 永远不会和 Twenty 的 migration 撞车
--
-- 三段解耦的第二段就靠这个：Twenty 那边出任何问题，inbox / staging 照常读写。

CREATE DATABASE boothnote;

COMMENT ON DATABASE boothnote IS 'Boothnote：原文 inbox、待确认 staging、情报清单配置、审计。与 Twenty 的 default 库物理隔离。';
