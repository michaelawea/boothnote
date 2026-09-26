-- boothnote 库初始结构。对应 docs/gateway-contract.md §1
-- 迁移是编号 .sql 文件，按序执行、记录在 schema_migrations —— 部署到 VPS 时同一套照跑。

create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- ── 账号：凭据的真相源，永不进 Twenty（D35④）────────────────────────
create table if not exists app_user (
  id             uuid primary key default gen_random_uuid(),
  user_code      text        not null unique,
  display_name   text        not null,
  password_hash  text        not null,            -- scrypt$N$r$p$salt$hash（Node 内置，无原生依赖）
  role           text        not null default 'user'
                 check (role in ('admin','management','staff','user')),
  is_active      boolean     not null default true,
  -- 改这个数字 = 该用户所有已签发 token 立即失效。
  -- 没有它，90 天有效期意味着 90 天内撤不掉任何人的权限（D35⑤）。
  token_version  integer     not null default 1,
  created_at     timestamptz not null default now()
);

-- ── 原文：只增不改（§4.2 第2条）─────────────────────────────────────
create table if not exists inbox (
  id                uuid primary key default gen_random_uuid(),
  -- 幂等键。前端 sync.ts 已在发，断网重传不产生重复（§4.2 第6条）
  client_id         uuid        not null unique,
  user_id           uuid        not null references app_user(id),
  company_code      text,                          -- 可空（D28 修订）
  text              text,                          -- 纯语音时为空
  audio_path        text,
  audio_mime        text,                          -- iOS 给 mp4、Chrome 给 webm，不写死
  audio_seconds     integer,
  visit_label       text,
  device_created_at timestamptz,                   -- 设备本地时间（离线时录的）
  created_at        timestamptz not null default now()
);
create index if not exists inbox_user_created_idx on inbox (user_id, created_at);

-- 数据库层面强制不可变。展会 10 天说过的话是全项目唯一不可再生的资产 ——
-- 不靠"大家记得别改"，靠这个触发器。
create or replace function inbox_is_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'inbox 只增不改（§4.2 第2条）：% 被拒绝。转写与抽取属于派生，请写 staging。', tg_op;
end $$;

drop trigger if exists inbox_no_update on inbox;
create trigger inbox_no_update before update or delete on inbox
  for each row execute function inbox_is_append_only();

-- ── 派生结果：待人工确认 ────────────────────────────────────────────
create table if not exists staging (
  id                  uuid primary key default gen_random_uuid(),
  inbox_id            uuid        not null unique references inbox(id),
  status              text        not null default 'pending'
                      check (status in ('pending','transcribing','extracting','ready','confirmed','failed')),
  transcript          text,                        -- 独立于 inbox.text，重跑转写不动原文
  extracted           jsonb       not null default '{}'::jsonb,
  confidence          jsonb       not null default '{}'::jsonb,
  resolved_company_id uuid,                        -- 确认时定下的 Twenty company id
  suggested_company   text,                        -- 只提议，不自动建（§4.2 第3条）
  twenty_refs         jsonb,
  error               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists staging_status_idx on staging (status, created_at);

create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists staging_touch on staging;
create trigger staging_touch before update on staging
  for each row execute function touch_updated_at();
