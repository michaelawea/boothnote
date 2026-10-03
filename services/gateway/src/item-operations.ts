import { createHash, randomUUID } from 'node:crypto';

export type ItemOperationState = 'planned' | 'running' | 'succeeded' | 'failed' | 'unknown';
export type ItemOperation = {
  id: string;
  revision_id: string;
  role: string;
  input_hash: string;
  input: unknown;
  state: ItemOperationState;
  result: unknown;
  error: string | null;
  attempt_id: string | null;
};
export type ItemOperationResolution =
  | { outcome: 'succeeded'; result: unknown }
  | { outcome: 'not_applied' };

/** Store methods must perform state transitions atomically, including in tests. */
export interface ItemOperationStore {
  getOrCreate(revisionId: string, role: string, hash: string, input: unknown, at: Date): Promise<ItemOperation>;
  get(revisionId: string, role: string): Promise<ItemOperation | null>;
  claim(id: string, hash: string, at: Date, attemptId: string): Promise<boolean>;
  succeed(id: string, result: unknown, at: Date, attemptId: string): Promise<boolean>;
  fail(id: string, state: 'failed' | 'unknown', error: string, at: Date, attemptId: string): Promise<boolean>;
  markInterrupted(at: Date): Promise<number>;
  resolve(revisionId: string, role: string, resolution: ItemOperationResolution, actorId: string, at: Date): Promise<boolean>;
}
export type ItemOperationOptions = { store?: ItemOperationStore; now?: () => Date };

/** JSON semantics, with sorted object keys. Arrays retain their meaningful order. */
export const canonicalItemOperationInput = (value: unknown): string => {
  const ancestors = new Set<object>();
  const normalize = (v: unknown, inArray = false): unknown => {
    if (v === null) return null;
    if (typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new TypeError('Item operation input must contain finite numbers');
      return v;
    }
    if (typeof v === 'undefined' || typeof v === 'function' || typeof v === 'symbol') {
      return inArray ? null : undefined;
    }
    if (typeof v !== 'object') throw new TypeError('Item operation input must be JSON serializable');
    if (v instanceof Date) return v.toISOString();
    if (ancestors.has(v)) throw new TypeError('Item operation input cannot contain cycles');
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
      throw new TypeError('Item operation input must contain plain JSON objects');
    }
    ancestors.add(v);
    try {
      if (Array.isArray(v)) return Array.from(v, (child) => normalize(child, true));
      const result: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(v).sort()) {
        const child = normalize((v as Record<string, unknown>)[key]);
        if (child !== undefined) result[key] = child;
      }
      return result;
    } finally {
      ancestors.delete(v);
    }
  };
  return JSON.stringify(normalize(value) ?? null);
};

export const hashItemOperationInput = (value: unknown): string =>
  createHash('sha256').update(canonicalItemOperationInput(value)).digest('hex');

export class UnknownItemOperationError extends Error {
  readonly code = 'item_operation_unknown';
  readonly statusCode = 409;
  readonly operationId: string;
  readonly revisionId: string;
  readonly role: string;
  constructor(operation: ItemOperation, cause?: unknown) {
    super(`Operation ${operation.role} has an unknown outcome; reconcile it before retrying.`, { cause });
    this.name = 'UnknownItemOperationError';
    this.operationId = operation.id;
    this.revisionId = operation.revision_id;
    this.role = operation.role;
  }
}

export class ItemOperationConflictError extends Error {
  readonly code = 'item_operation_input_conflict';
  readonly statusCode = 409;
  constructor() {
    super('This revision already has an operation with different inputs. Create a new revision.');
    this.name = 'ItemOperationConflictError';
  }
}

/** Use only when there is evidence that the remote mutation was never applied. */
export class DefiniteItemOperationError extends Error {
  readonly code = 'item_operation_not_applied';
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DefiniteItemOperationError';
  }
}

const briefError = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 500);

/** Loaded lazily so injected-store unit tests do not need database configuration. */
export const postgresItemOperationStore: ItemOperationStore = {
  async getOrCreate(revisionId, role, hash, input, at) {
    const { sql } = await import('./db.ts');
    const [inserted] = await sql<ItemOperation[]>`
      insert into item_operation (id, revision_id, role, input_hash, input, state, created_at, updated_at)
      values (${randomUUID()}, ${revisionId}, ${role}, ${hash}, ${sql.json(input as never)}, 'planned', ${at}, ${at})
      on conflict (revision_id, role) do nothing
      returning id, revision_id, role, input_hash, input, state, result, error, attempt_id`;
    const operation = inserted ?? await this.get(revisionId, role);
    if (!operation) throw new Error('Item operation disappeared after creation');
    return operation;
  },
  async get(revisionId, role) {
    const { sql } = await import('./db.ts');
    const [row] = await sql<ItemOperation[]>`
      select id, revision_id, role, input_hash, input, state, result, error, attempt_id
      from item_operation where revision_id = ${revisionId} and role = ${role}`;
    return row ?? null;
  },
  async claim(id, hash, at, attemptId) {
    const { sql } = await import('./db.ts');
    const rows = await sql`
      update item_operation set state = 'running', updated_at = ${at}, attempt_id = ${attemptId}
      where id = ${id} and input_hash = ${hash} and state in ('planned', 'failed') returning id`;
    return rows.length > 0;
  },
  async succeed(id, result, at, attemptId) {
    const { sql } = await import('./db.ts');
    const rows = await sql`
      update item_operation set state = 'succeeded', result = ${sql.json(result as never)}, error = null, updated_at = ${at}
      where id = ${id} and state = 'running' and attempt_id = ${attemptId} returning id`;
    return rows.length > 0;
  },
  async fail(id, state, error, at, attemptId) {
    const { sql } = await import('./db.ts');
    const rows = await sql`
      update item_operation set state = ${state}, error = ${error}, updated_at = ${at}
      where id = ${id} and state = 'running' and attempt_id = ${attemptId} returning id`;
    return rows.length > 0;
  },
  async markInterrupted(at) {
    const { sql } = await import('./db.ts');
    const rows = await sql`
      update item_operation set state = 'unknown', error = 'Gateway stopped while the remote operation was running', updated_at = ${at}
      where state = 'running' returning id`;
    return rows.length;
  },
  async resolve(revisionId, role, resolution, actorId, at) {
    const { sql } = await import('./db.ts');
    return sql.begin(async (tx) => {
      const [previous] = await tx<ItemOperation[]>`
        select id, revision_id, role, input_hash, input, state, result, error, attempt_id
        from item_operation where revision_id = ${revisionId} and role = ${role} and state = 'unknown' for update`;
      if (!previous) return false;
      const audit = {
        actorId, at: at.toISOString(), outcome: resolution.outcome,
        previousState: previous.state, previousError: previous.error, previousAttemptId: previous.attempt_id,
      };
      const result = resolution.outcome === 'succeeded' ? resolution.result : null;
      const rows = await tx`
        update item_operation set state = ${resolution.outcome === 'succeeded' ? 'succeeded' : 'planned'},
          result = ${tx.json(result as never)}, error = null, updated_at = ${at}, attempt_id = null,
          audit = audit || ${tx.json([audit] as never)}
        where id = ${previous.id} and state = 'unknown' returning id`;
      return rows.length > 0;
    });
  },
};

/**
 * Persist each remote step independently. A rejected request or a lost reply is
 * not evidence that no mutation happened. Unknown outcomes never auto-retry.
 * Callers supply stable semantic inputs, excluding request timestamps.
 */
export const durableItemOperation = async <T>(
  revisionId: string,
  role: string,
  input: unknown,
  execute: () => Promise<T>,
  options: ItemOperationOptions = {},
): Promise<T> => {
  if (!role.trim() || role.length > 180) throw new TypeError('Item operation role is required and must be at most 180 characters');
  const store = options.store ?? postgresItemOperationStore;
  const now = options.now ?? (() => new Date());
  const canonical = canonicalItemOperationInput(input);
  const hash = createHash('sha256').update(canonical).digest('hex');
  const operation = await store.getOrCreate(revisionId, role, hash, JSON.parse(canonical), now());
  if (operation.input_hash !== hash) throw new ItemOperationConflictError();
  if (operation.state === 'succeeded') return operation.result as T;
  if (operation.state === 'running' || operation.state === 'unknown') throw new UnknownItemOperationError(operation);
  const attemptId = randomUUID();
  if (!(await store.claim(operation.id, hash, now(), attemptId))) {
    const current = await store.get(revisionId, role);
    if (current?.state === 'succeeded') return current.result as T;
    throw new UnknownItemOperationError(current ?? operation);
  }

  let result: T;
  try {
    result = await execute();
  } catch (error) {
    const definite = error instanceof DefiniteItemOperationError;
    try {
      const recorded = await store.fail(operation.id, definite ? 'failed' : 'unknown', briefError(error), now(), attemptId);
      if (!recorded) throw new UnknownItemOperationError(operation, error);
    } catch (recordError) {
      throw new UnknownItemOperationError(operation, recordError);
    }
    if (definite) throw error;
    throw new UnknownItemOperationError(operation, error);
  }

  // JSON null is the durable representation of a void result.
  try {
    const persisted = JSON.parse(canonicalItemOperationInput(result));
    if (!(await store.succeed(operation.id, persisted, now(), attemptId))) throw new Error('Operation state changed before its receipt was saved');
  } catch (error) {
    // The remote step already completed. Failure to save its receipt is unknown,
    // not a safe retry; even a database outage leaves a blocking running row.
    await store.fail(operation.id, 'unknown', briefError(error), now(), attemptId).catch(() => false);
    throw new UnknownItemOperationError(operation, error);
  }
  return result;
};

/** Invoke once during startup, before admitting workers; never while other instances still own live operations. */
export const markInterruptedItemOperationsUnknown = async (options: ItemOperationOptions = {}): Promise<number> =>
  (options.store ?? postgresItemOperationStore).markInterrupted((options.now ?? (() => new Date()))());

/** Trusted control path only: result must come from a server-side CRM readback. */
export const resolveUnknownItemOperation = async (
  revisionId: string,
  role: string,
  resolution: ItemOperationResolution,
  actorId: string,
  options: ItemOperationOptions = {},
): Promise<boolean> => {
  if (!actorId.trim()) throw new TypeError('Reconciliation requires an identified operator');
  if (resolution.outcome !== 'succeeded' && resolution.outcome !== 'not_applied') {
    throw new TypeError('Reconciliation must establish succeeded or not_applied');
  }
  const normalized = resolution.outcome === 'succeeded'
    ? { outcome: 'succeeded' as const, result: JSON.parse(canonicalItemOperationInput(resolution.result)) }
    : resolution;
  return (options.store ?? postgresItemOperationStore).resolve(
    revisionId, role, normalized, actorId, (options.now ?? (() => new Date()))(),
  );
};
