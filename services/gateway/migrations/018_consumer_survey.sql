-- 2C 问卷的中转表（D138）。手机 → 这里 → Twenty 的 consumerSurvey + 一家 END_USER 客户。
--
-- 为什么不进 inbox：inbox 只增不改（触发器挡住删除），而这张表里有消费者的
-- 姓名 / 电话 / 邮箱 —— 客户要求删除时必须删得掉（GDPR · R20）。所以**这张表没有触发器**。
--
-- 三段解耦照旧：Twenty 挂了，问卷先落在这里（status='pending'），心跳每 30 秒重试。
-- 重试是安全的：Twenty 那边先按 client_id 查（它在 consumerSurvey 上是 unique），
-- 客户建好后 id 立刻记进 twenty_company_id —— 所以自动重试不会多建（和 staging 的
-- 「committing 不自动重试」不同，那边没有这样的幂等键）。
create table if not exists survey_response (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid        not null unique,        -- 手机生成，断网重传不产生重复
  user_id            uuid        not null references app_user(id),
  survey_key         text        not null,               -- 哪一套题（'vdl2026'）
  answers            jsonb       not null default '{}'::jsonb,
  contact            jsonb       not null default '{}'::jsonb,   -- {name,email,phone,postcode}
  consent_at         timestamptz,                         -- 有姓名/电话/邮箱时必有（网关挡）
  device_created_at  timestamptz,
  created_at         timestamptz not null default now(),
  status             text        not null default 'pending'
                     check (status in ('pending','committing','committed','failed')),
  attempts           integer     not null default 0,
  next_try_at        timestamptz not null default now(),
  last_error         text,
  twenty_company_id  uuid,
  twenty_survey_id   uuid,
  committed_at       timestamptz
);
-- 心跳只捡「该写还没写」的那几条
create index if not exists survey_response_due_idx
  on survey_response (next_try_at) where status in ('pending','failed');
