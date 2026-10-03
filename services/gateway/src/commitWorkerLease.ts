import postgres from 'postgres';
import { env } from './env.ts';

/** Startup recovery may inspect abandoned writes only under an exclusive worker lease. */
export const acquireCommitWorkerLease = async (): Promise<() => Promise<void>> => {
  let owned = false;
  // Pool lifetime rotation must not silently release the session-level lock.
  const leaseSql = postgres(env.databaseUrl, {
    max: 1, max_lifetime: 0, idle_timeout: 0, onnotice: () => {},
    onclose: () => {
      if (owned) {
        console.error('Commit worker lease was lost; stopping this gateway before another worker takes over.');
        process.kill(process.pid, 'SIGTERM');
      }
    },
  });
  const connection = await leaseSql.reserve();
  try {
    const [row] = await connection<Array<{ held: boolean }>>`
      select pg_try_advisory_lock(hashtext('boothnote:gateway:commit-worker')) as held`;
    if (!row?.held) throw new Error('Another gateway commit worker owns this database. Stop it before starting a replacement.');
    owned = true;
  } catch (error) {
    connection.release();
    await leaseSql.end({ timeout: 5 });
    throw error;
  }
  return async () => {
    owned = false;
    try { await connection`select pg_advisory_unlock(hashtext('boothnote:gateway:commit-worker'))`; }
    finally { connection.release(); await leaseSql.end({ timeout: 5 }); }
  };
};
