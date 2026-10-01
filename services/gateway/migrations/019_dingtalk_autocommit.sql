-- ════════════════════════════════════════════════════════════════════
--  钉钉来源：自动入库 + 60 秒撤回 + 二轮对话（T107 · D143–D148 · docs/dingtalk-confirm-pool.md）
--
--  全部是新增（列 / 表 / 序列 / check 白名单），inbox / thread_message / channel_event
--  三张只增表**一行都不 UPDATE**。
--
--  🔴 **先迁移再起服务**：新代码往 channel_event 写新 kind，没迁移时会撞下面那个 check，
--     而入口的 catch 会把整条消息回成「这条先没记上」—— 等于入口整个拒收（§2.26 的形状）。
-- ════════════════════════════════════════════════════════════════════

-- ── 撤回（D143）────────────────────────────────────────────────────
-- 「这一版被人撤回了，没写进 CRM」。status 照旧回 `ready`（cancelConfirm 的现有行为），
-- 这一列只是让出站知道「别再给它排队」—— 不加 status 值：那要改 9 处写死的状态清单，
-- 漏一处就是一个静默 bug；而 loop 的继承 / 取代认 `ready`，一行不改就对撤回的版本生效。
alter table staging add column if not exists withdrawn_at timestamptz;

-- ── `#N`：人说的「那一条」（D146）──────────────────────────────────
-- 挂在 thread 上而不是 staging 上：staging 每改一次就换一行，人说的 #128 跨版本不变。
-- 全局递增、不按群：conversationKey 就是群名，按群编号的话改一次群名就从 1 重来。
create sequence if not exists thread_ref_no_seq start 100;
alter table thread add column if not exists ref_no bigint;
create unique index if not exists thread_ref_no_uq on thread (ref_no) where ref_no is not null;

-- ── 撤回链接（D148）────────────────────────────────────────────────
-- 只存 token 的 sha256：库被读走也拿不到能用的链接。一条链接 = 一版 staging × 「撤回」一个动作。
--
-- 🔴 链接绑的是**某一次排队**（`queue_id` = 排队时写进 confirm_payload 的那个随机串），
--    不是「这一版」：撤回之后人说「入库 #N」重新排队，旧汇报里那条链接不能撤掉新的倒计时。
create table if not exists action_link (
  token_hash  text        primary key,
  staging_id  uuid        not null references staging(id),
  queue_id    text        not null,
  action      text        not null check (action in ('withdraw')),
  owner_id    uuid        not null references app_user(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists action_link_staging_idx on action_link (staging_id);

-- ── 待回答问题（D146）──────────────────────────────────────────────
-- 一条 thread 一行（再问就覆盖那一条自己的）。**只有恰好一个没过期的问题时**，
-- 下一句才会被直接当成回答；同时有两个（#101 和 #102 都在等）就不猜 ——
-- 原话先存下，请人带 #编号再说一遍。早先的汇报上印着「直接回答」，
-- 不能因为后来又问了一个，就把那句回答悄悄接到另一条上（60 秒后自动入库）。
-- 这是会话状态不是资产：答完就删，过期的读的时候按 expires_at 过滤。
create table if not exists channel_open_question (
  channel          text        not null,
  conversation_key text        not null,
  app_user_id      uuid        not null references app_user(id),
  thread_id        uuid        not null references thread(id),
  staging_id       uuid        not null references staging(id),
  question         text        not null,
  asked_at         timestamptz not null default now(),
  expires_at       timestamptz not null,
  primary key (channel, conversation_key, app_user_id, thread_id)
);

-- ── channel_event 新 kind ─────────────────────────────────────────
--   follow   这条 @ 接到了哪一条上（raw = {threadId, refNo, via}），重放复用
--   park     接不上（上一句还在整理 / 正在写入 / 别人的 #N），原话已存下
--   queued   出站给某一版排了自动入库（event_key = queued:<stagingId>，只排一次）
--   notice   入库成功 / 入库失败 / 撤回 的群回声（event_key = notice:<kind>:<stagingId>）
--   click    撤回链接被点了（审计：哪一版、结果、UA）
--   command  整句命令（待办 / #N / 入库 #N）
alter table channel_event drop constraint if exists channel_event_kind_check;
alter table channel_event add constraint channel_event_kind_check
  check (kind in ('message','reject','receipt','receipt_skipped','receipt_failed','route',
                  'follow','park','queued','notice','click','command'));
