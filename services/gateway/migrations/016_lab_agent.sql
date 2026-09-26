-- 实验室 agent（第二个钉钉 bot · docs/lab-agent.md）。两张新表，不动现有任何表。

-- ── 会话：同一个群 + 同一个人，窗口内沿用同一条对话 ──────────────────
--
-- 维护者 2026-08-17 定的形态：「同一个群组，多少分钟之内，沿用同一个对话」。
-- session_id 就是 Pi 那份 JSONL 消息史的文件名（agent-lab-sessions/<id>.jsonl），
-- 所以「沿用同一个对话」= 复用同一个文件 = 模型真的记得上一轮。
--
-- 🔴 窗口从**最后一条消息**起算（滑动），不是固定时间桶 ——
--    固定桶会在整点把一段正在进行的对话拦腰切断。
create table if not exists lab_session (
  id               uuid primary key default gen_random_uuid(),
  channel          text        not null,
  conversation_key text        not null,
  sender           text        not null,
  session_id       uuid        not null,
  turns            integer     not null default 0,
  last_at          timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  unique (channel, conversation_key, sender)
);

-- ── 每一轮的账：调 Skill 时第一个要看的就是它 ────────────────────────
--
-- 和 agent_run 分开：那张表挂在 inbox 上（外键），而实验室 agent 一条速记都不产生。
create table if not exists lab_run (
  id               uuid primary key default gen_random_uuid(),
  channel          text        not null,
  conversation_key text,
  sender           text,
  session_id       uuid,
  prompt           text,
  text             text,
  steps            integer     not null default 0,
  stop_reason      text,
  trace            jsonb,
  duration_ms      integer,
  error            text,
  -- 这一轮的回答**怎么送出去的**：同步那条 HTTP 回复 / 群 webhook /
  -- 没送出去（超时且群没配 webhook，或网关中途重启）。
  -- 🔴 `dropped` 必须能被查出来 —— 「人问了但没得到回答」不该是一片静默。
  delivery         text        not null default 'pending'
                   check (delivery in ('pending','sync','webhook','dropped')),
  created_at       timestamptz not null default now()
);
create index if not exists lab_run_convo_idx on lab_run (channel, conversation_key, created_at desc);
create index if not exists lab_run_session_idx on lab_run (session_id);
