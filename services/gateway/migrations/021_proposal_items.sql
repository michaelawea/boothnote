-- #64: original input remains one append-only inbox + one staging batch.
-- Items identify independently closed business matters; revisions never use list position as identity.
create table if not exists proposal_item (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id),
  thread_id uuid references thread(id),
  current_revision integer not null default 0,
  company_id uuid,
  twenty_refs jsonb not null default '{}'::jsonb,
  created_records jsonb not null default '[]'::jsonb,
  deleted_at timestamptz,
  deleted_refs jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists proposal_item_thread_idx on proposal_item(thread_id, created_at);

create table if not exists proposal_revision (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references proposal_item(id),
  staging_id uuid not null references staging(id),
  revision integer not null check (revision > 0),
  parent_revision_id uuid references proposal_revision(id),
  proposal_key text not null,
  proposal_input_hash text not null,
  record_type text not null check (record_type in ('support','fitment','project','followup')),
  action text not null default 'create' check (action in ('create','append','update')),
  company_id uuid,
  company_code text,
  target jsonb,
  fields jsonb not null default '{}'::jsonb,
  confidence jsonb not null default '{}'::jsonb,
  evidence_refs jsonb not null default '[]'::jsonb,
  status text not null default 'ready' check
    (status in ('ready','confirming','committing','confirmed','failed','unknown','withdrawn','superseded')),
  confirm_after timestamptz,
  confirm_payload jsonb,
  confirm_by uuid references app_user(id),
  twenty_refs jsonb,
  created_records jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(item_id, revision),
  unique(staging_id, proposal_key)
);
create index if not exists proposal_revision_batch_idx on proposal_revision(staging_id, created_at);
create index if not exists proposal_revision_due_idx on proposal_revision(confirm_after) where status = 'confirming';

-- Prepared before an HTTP mutation; successful results are recorded immediately.
-- running/unknown never mean "safe to retry". Reconciliation decisions are audited.
create table if not exists item_operation (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references proposal_revision(id),
  role text not null,
  input_hash text not null,
  input jsonb not null,
  state text not null default 'planned' check (state in ('planned','running','succeeded','failed','unknown')),
  attempt_id uuid,
  result jsonb,
  error text,
  audit jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(revision_id, role)
);

-- Ownership and usage are separate: an item may use a record created by another item.
create table if not exists item_record_link (
  item_id uuid not null references proposal_item(id),
  object_type text not null,
  record_id uuid not null,
  created_here boolean not null default false,
  name text,
  created_at timestamptz not null default now(),
  primary key(item_id, object_type, record_id)
);
create index if not exists item_record_link_record_idx on item_record_link(object_type, record_id);
