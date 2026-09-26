-- 钉钉渠道（T93 / docs/dingtalk-channel.md）。三张全是新表，不动现有任何表。

-- ── 渠道身份：钉钉 sender ID → app_user ─────────────────────────────
--
-- 🔴 新 ID **自动建号**（维护者 2026-08-17 拍板，是「创建账号只有 维护者 能做」
--    的唯一例外）：群全是企业内部的，bot 被拉进群本身就是授权。
--    自动建的账号没有可用密码（password_hash 是一个随机散列，谁也登不进 PWA），
--    要用 PWA 时在管理台补发；管理台也能把身份**改绑**到已有账号（老用户预绑）。
create table if not exists channel_identity (
  id              uuid primary key default gen_random_uuid(),
  channel         text        not null,
  channel_user_id text        not null,
  app_user_id     uuid        not null references app_user(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (channel, channel_user_id)
);

drop trigger if exists channel_identity_touch on channel_identity;
create trigger channel_identity_touch before update on channel_identity
  for each row execute function touch_updated_at();

-- ── 渠道事件：只增日志 ──────────────────────────────────────────────
--
-- 进来的每条原始报文（含被 L1 拒收的 —— 「不进 inbox」不等于丢）、
-- 出去的每张回执的投递记录（receipt / receipt_skipped / receipt_failed），
-- 都落在这里。`(channel, event_key)` 唯一 —— 消息的幂等和回执的「只发一次」共用这一道。
create table if not exists channel_event (
  id               uuid primary key default gen_random_uuid(),
  channel          text        not null,
  event_key        text        not null,
  kind             text        not null
                   check (kind in ('message','reject','receipt','receipt_skipped','receipt_failed')),
  conversation_key text,
  sender           text,
  app_user_id      uuid references app_user(id),
  inbox_id         uuid references inbox(id),
  raw              jsonb,
  created_at       timestamptz not null default now(),
  unique (channel, event_key)
);
create index if not exists channel_event_inbox_idx on channel_event (inbox_id);
create index if not exists channel_event_convo_idx on channel_event (channel, conversation_key, created_at);

-- 和 thread_message / attachment 同一刀：日志是资产，只增不改（复用 002 的守卫函数）。
drop trigger if exists channel_event_no_update on channel_event;
create trigger channel_event_no_update before update or delete on channel_event
  for each row execute function append_only_guard();

-- ── 渠道会话：登记的群 + 出站 webhook ────────────────────────────────
--
-- 第一条消息进来就自动登记（维护者：bot 进群 = 他授权的，不做白名单工程）。
-- webhook_url 由管理台补填 —— 没填之前回执降级（ack 里明说「结果去 PWA 看」），
-- 绝不假装稍后有回执。
create table if not exists channel_conversation (
  id               uuid primary key default gen_random_uuid(),
  channel          text        not null,
  conversation_key text        not null,
  title            text,
  webhook_url      text,
  is_active        boolean     not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (channel, conversation_key)
);

drop trigger if exists channel_conversation_touch on channel_conversation;
create trigger channel_conversation_touch before update on channel_conversation
  for each row execute function touch_updated_at();
