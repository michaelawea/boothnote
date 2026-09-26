-- ════════════════════════════════════════════════════════════════════
--  agent 处理的尝试次数
--
--  2026-08-04 本地实测：网关每次重启都打印「↻ 捡回 50 条未完成的处理任务」，
--  把它们标成 failed 之后再启动**还是 50 条** —— 因为 `resumePending`
--  的状态列表里就**包含 `failed`**：
--
--      where status in ('pending','transcribing','extracting','failed')
--        and created_at > now() - interval '24 hours'
--
--  于是一条永久失败的记录（实测有一条报 `unsupported Unicode escape sequence`）
--  会在 24 小时内**每次重启都重跑一遍**，每次烧一次模型调用。
--  实测后果不是浪费钱那么简单：50 条积压把模型占满，
--  新来的那一条 agent 直接 60 秒超时、走兜底 —— 人以为是 agent 不行。
--
--  但「失败就再也不重试」也是错的：上游过载
--  （`Our servers are currently overloaded`）是临时故障，重试一次就好了，
--  而现场那一句话是不可再生的资产，不该因为模型抖了一下就永远停在半路。
--
--  所以要的是**次数预算**，不是开关：临时故障自愈，永久故障不会一直烧。
-- ════════════════════════════════════════════════════════════════════

alter table staging add column if not exists attempts int not null default 0;

comment on column staging.attempts is
  '处理尝试次数。resumePending 只捡 attempts < 3 的行 —— 上游抖一下能自愈，真坏了不会一直重试。';

-- resumePending 的查询走这条部分索引
create index if not exists staging_resume_idx on staging (created_at)
  where status in ('pending', 'transcribing', 'extracting', 'failed');
