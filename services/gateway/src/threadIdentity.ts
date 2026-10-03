import type postgres from 'postgres';
import { sql } from './db.ts';

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export class ThreadIdentityError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** Retries cannot create a second conversation or restore a deleted one. */
export const getOrCreateClientThread = async (
  input: { userId: string; clientThreadId: string; title?: string | null; companyCode?: string | null },
  connection: typeof sql | postgres.TransactionSql = sql,
): Promise<string> => {
  if (!isUuid(input.clientThreadId)) throw new ThreadIdentityError(400, 'invalid_client_thread_id');
  const [created] = await connection<Array<{ id: string; deleted_at: string | null }>>`
    insert into thread (user_id, client_id, title, company_code)
    values (${input.userId}, ${input.clientThreadId}, ${input.title ?? null}, ${input.companyCode ?? null})
    on conflict (user_id, client_id) where client_id is not null do nothing
    returning id, deleted_at`;
  const found = created ?? (await connection<Array<{ id: string; deleted_at: string | null }>>`
    select id, deleted_at from thread
    where user_id = ${input.userId} and client_id = ${input.clientThreadId}`)[0];
  if (!found) throw new ThreadIdentityError(409, 'thread_identity_conflict');
  if (found.deleted_at) throw new ThreadIdentityError(409, 'thread_deleted');
  return found.id;
};
