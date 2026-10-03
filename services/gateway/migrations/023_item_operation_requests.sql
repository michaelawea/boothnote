-- Freeze the request before a mutation, so recovery compares what was actually
-- sent rather than recomputing timestamps, summaries or derived defaults.
alter table item_operation add column if not exists request_evidence jsonb not null default '[]'::jsonb;
-- Rebinding is authorized before ANY step is applied, for one frozen payload.
alter table item_operation add column if not exists input_reset jsonb;
