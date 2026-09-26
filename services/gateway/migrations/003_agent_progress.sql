-- 003：让 agent 的运行过程可见
--
-- 起因（维护者 2026-08-03 实测）：「agent 的运行就像盲盒一样，
-- 我看不到 agent 进行到哪一步了」。
--
-- 这不是体验问题，是**信任问题**：展会现场按下去之后转圈十几秒，
-- 人不知道它是在干活还是已经死了 —— 不知道的那几秒里，他会再按一次。

-- 当前进行到哪一步，人话。'转写中' / '在查客户' / '在想' / …
-- 跑完之后留最后一句，不清空 —— 出问题时它就是「卡在哪」的答案。
alter table agent_run add column if not exists stage text;

-- 这一轮总共允许几步。前端拿它显示 "3 / 8"，而不是一个没有尽头的转圈。
-- 存下来而不是让前端写死：上限是 .env 里可调的，两边不能各记一份。
alter table agent_run add column if not exists max_steps integer;

-- 按 inbox 找「正在跑的那一轮」。查询极频繁（前端 2.5 秒一次），
-- 而 running 的行永远只有个位数，部分索引最省。
create index if not exists agent_run_running_idx on agent_run (inbox_id)
  where status = 'running';
