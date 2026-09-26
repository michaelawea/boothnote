-- ════════════════════════════════════════════════════════════════════
--  同一条对话只留一条待确认（issue #14）
--
--  维护者 2026-08-05 实测：同一条对话里让 agent 改了三轮，
--  看板上就出现了**三条待确认**。他的原话：
--
--    「同一个对话，在看版中，只用最新的待确认或者已确认就好了。」
--
--  他给的修法是「在这个 Inbox 的基础上去改，而不是生成一个新的 Inbox」。
--  方向对，但落点差一层 —— 🔴 **`inbox` 只增不改（§4.2 第 2 条），
--  库里有触发器挡着 UPDATE/DELETE。** 展会 10 天说过的话是全项目唯一
--  不可再生的资产，改第一句话去迁就第三句话，就是把它弄丢。
--
--  真正该「在已有基础上改」的是**派生层**：
--    · `inbox`   —— 三句话就是三行，一个字都不动（原文）
--    · `staging` —— 同一条对话只有**一条是活的**，后一轮在前一轮的结果上叠加（提案）
--
--  这样两个目标同时成立：原文完整可溯源，而人只看到一张卡、只按一次确认。
--
--  为什么这件事重要到值得一条 migration：三张卡如果都点了确认，
--  `confirm.ts` 会跑三遍完整入库 —— 项目那边因为 projectCode 幂等只更新，
--  但**拜访 / 选型情报 / 售后 / 项目文档这些没有自然键的对象会实打实写三份**
--  （confirm.ts 里那条注释自己写着这一点）。
--  也就是说：这不只是界面乱，**这个界面在邀请人产生重复数据**。
-- ════════════════════════════════════════════════════════════════════

-- 被后一轮取代的那些。**不删、不改内容** —— 只是不再是「活的那一条」。
alter table staging drop constraint if exists staging_status_check;
alter table staging add  constraint staging_status_check check (
  status in ('pending','transcribing','extracting','ready','confirming',
             'committing','confirmed','failed','superseded'));

-- 被谁取代的。留着是为了「看不见」和「不存在」能分得开 ——
-- 下次有人怀疑数据丢了，这一列就是答案。
alter table staging add column if not exists superseded_by uuid references staging(id);

comment on column staging.superseded_by is
  '被同一条对话里后一轮的 staging 取代（issue #14）。原文仍在 inbox 里，一个字没动。';

-- 看板按对话取最新一条：where status='ready' 之后按 thread_id 去重
create index if not exists staging_thread_idx on staging (thread_id, created_at desc)
  where thread_id is not null;
