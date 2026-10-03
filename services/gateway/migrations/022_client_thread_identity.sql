-- An offline conversation has a stable client identity before a server ID exists.
-- Existing threads remain unchanged; identities are scoped to the authenticated user.
alter table thread add column if not exists client_id uuid;
create unique index if not exists thread_user_client_identity
  on thread(user_id, client_id) where client_id is not null;
