-- 002：对话线程 · 附件 · agent 轨迹 · 延迟提交
--
-- 对应实施计划 §4 阶段 B1 与阶段 P。三条设计约束在这个文件里落成 DDL：
--
--   1. §4.2 第2条「只增不改」从 inbox 扩展到本次新增的两张资产表
--      （thread_message、attachment）—— 判据是「这行东西丢了能不能再生」：
--      销售说的话和他拍的照片再生不了，派生出来的转写和解析文本随时能重跑。
--   2. 续写不是 UPDATE。同一条对话的第二句话是**一条新的 inbox 行**，
--      靠 thread_id 串起来。所以这里只给 inbox 加列，不动它的触发器。
--   3. 确认入库改成「5 秒延迟提交」（D48）。延迟状态是**库里的一行**，
--      不是内存里的 setTimeout —— 网关重启也不会丢掉一次已经点过的确认。

-- ── inbox 加两列 ────────────────────────────────────────────────────
-- ALTER TABLE 是 DDL，不触发行级触发器；已有数据不受影响（都为 null）。
alter table inbox add column if not exists thread_id uuid;
alter table inbox add column if not exists source     text;   -- note | followup | import
create index if not exists inbox_thread_idx on inbox (thread_id, created_at);

-- ── 对话线程 ────────────────────────────────────────────────────────
-- 一条速记 = 一条对话。晚上回酒店想起补一句，就落在同一个 thread 上。
create table if not exists thread (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid        not null references app_user(id),
  title           text,                                  -- 首句截断，人看的
  company_code    text,                                  -- 冗余一份，列表页不用回表
  created_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create index if not exists thread_user_idx on thread (user_id, last_message_at desc);

-- 对话里的每一句 —— 人说的和 agent 回的都在这。**只增不改**。
create table if not exists thread_message (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid        not null references thread(id) on delete cascade,
  role       text        not null check (role in ('user','agent','system')),
  text       text        not null default '',
  inbox_id   uuid        references inbox(id),           -- 这句话对应哪条原文（agent 回复为空）
  meta       jsonb       not null default '{}'::jsonb,   -- 工具调用摘要 / 核对卡引用
  created_at timestamptz not null default now()
);
create index if not exists thread_message_idx on thread_message (thread_id, created_at);

create or replace function append_only_guard() returns trigger language plpgsql as $$
begin
  raise exception '% 只增不改（§4.2 第2条）：% 被拒绝。派生结果请写各自的派生表。',
    tg_table_name, tg_op;
end $$;

drop trigger if exists thread_message_no_update on thread_message;
create trigger thread_message_no_update before update or delete on thread_message
  for each row execute function append_only_guard();

-- ── 附件：原件只增不改，解析结果单独一张表 ──────────────────────────
-- 这一刀和 inbox / staging 是同一刀：原件是资产，解析文本是派生。
-- 解析器换代、模型换代都会想重跑一遍，重跑不能有任何机会碰到原件。
create table if not exists attachment (
  id         uuid primary key default gen_random_uuid(),
  inbox_id   uuid        not null references inbox(id),
  kind       text        not null check (kind in ('photo','image','file')),
  filename   text        not null,
  mime       text,
  bytes      integer     not null default 0,
  path       text        not null,                       -- 相对 GATEWAY_AUDIO_DIR 的路径
  created_at timestamptz not null default now()
);
create index if not exists attachment_inbox_idx on attachment (inbox_id);

drop trigger if exists attachment_no_update on attachment;
create trigger attachment_no_update before update or delete on attachment
  for each row execute function append_only_guard();

-- 派生：解析出来的纯文字。agent 只吃字符串（D46b），吃的就是这一列。
create table if not exists attachment_text (
  attachment_id uuid        primary key references attachment(id),
  status        text        not null default 'pending'
                check (status in ('pending','ready','failed','skipped')),
  text          text,
  truncated     boolean     not null default false,      -- 超 8000 token 被截断过
  chars         integer     not null default 0,
  error         text,
  updated_at    timestamptz not null default now()
);

drop trigger if exists attachment_text_touch on attachment_text;
create trigger attachment_text_touch before update on attachment_text
  for each row execute function touch_updated_at();

-- ── staging：agent 轨迹与延迟提交 ───────────────────────────────────
alter table staging add column if not exists thread_id     uuid;
alter table staging add column if not exists partial       boolean not null default false;
alter table staging add column if not exists agent_steps   integer not null default 0;
alter table staging add column if not exists agent_trace   jsonb   not null default '[]'::jsonb;
-- 延迟提交（D48）：点了确认之后先落这三列，到点才写 Twenty；撤销就是清掉它们。
alter table staging add column if not exists confirm_after   timestamptz;
alter table staging add column if not exists confirm_payload jsonb;
alter table staging add column if not exists confirm_by      uuid;

-- status 多一个中间态 confirming（已点确认、还没到 5 秒）
alter table staging drop constraint if exists staging_status_check;
alter table staging add  constraint staging_status_check check (
  status in ('pending','transcribing','extracting','ready','confirming','confirmed','failed'));

create index if not exists staging_confirm_idx on staging (confirm_after)
  where confirm_after is not null;

-- ── agent 每一轮的轨迹 ──────────────────────────────────────────────
-- 展会现场出问题时第一个要看的表：它调了什么、几步、多久、为什么停。
create table if not exists agent_run (
  id          uuid primary key default gen_random_uuid(),
  inbox_id    uuid        not null references inbox(id),
  thread_id   uuid,
  status      text        not null check (status in ('running','ok','partial','failed')),
  steps       integer     not null default 0,
  duration_ms integer     not null default 0,
  stop_reason text,                                      -- done | max_steps | timeout | error
  trace       jsonb       not null default '[]'::jsonb,  -- [{tool, ms, ok, summary}]
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists agent_run_inbox_idx on agent_run (inbox_id, created_at desc);

-- ── agent 当场造出来的情报字段（D47）───────────────────────────────
-- 本地留一份账，用途有三：查重（不用每次问 Twenty）、
-- 「一条速记最多造 1 个」这条护栏的判据、管理台那一页看它造了什么。
create table if not exists intel_field_log (
  id              uuid primary key default gen_random_uuid(),
  item_key        text        not null,
  question        text        not null,
  value_type      text        not null,
  applies_to      text        not null,
  inbox_id        uuid        references inbox(id),
  company_code    text,
  value           text,
  twenty_item_id  text,
  twenty_value_id text,
  created_by      text        not null default 'agent',
  created_at      timestamptz not null default now()
);
-- item_key **就是**身份。唯一约束放在这里，是护栏①「造之前必须查重」的最后一道 ——
-- agent 忘了查、或者两条速记同时造同一个 key，撞在这个索引上而不是造出两个变体。
create unique index if not exists intel_field_key_idx on intel_field_log (item_key);
create index if not exists intel_field_inbox_idx on intel_field_log (inbox_id);
