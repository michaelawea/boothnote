-- #65: questions are durable snapshots; original messages remain append-only.
create table if not exists agent_question (
  id uuid primary key,
  user_id uuid not null references app_user(id),
  thread_id uuid not null references thread(id),
  staging_id uuid not null references staging(id),
  source_message_id uuid not null references thread_message(id),
  item_id uuid,
  revision_id uuid,
  proposal_fingerprint text not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);
create index if not exists agent_question_thread_idx on agent_question(thread_id, created_at);
create index if not exists agent_question_item_idx on agent_question(item_id) where item_id is not null;

create table if not exists agent_question_answer (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null unique references agent_question(id),
  client_id uuid not null unique,
  user_id uuid not null references app_user(id),
  inbox_id uuid not null references inbox(id),
  staging_id uuid not null references staging(id),
  option_id text,
  text text not null,
  target jsonb,
  requires_agent boolean not null,
  created_at timestamptz not null default now()
);
drop trigger if exists agent_question_no_update on agent_question;
create trigger agent_question_no_update before update or delete on agent_question
  for each row execute function append_only_guard();
drop trigger if exists agent_question_answer_no_update on agent_question_answer;
create trigger agent_question_answer_no_update before update or delete on agent_question_answer
  for each row execute function append_only_guard();
