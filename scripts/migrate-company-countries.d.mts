export type CountryMigrationRequest = (method: string, path: string, body?: Record<string, unknown>) => Promise<any>;
export function createCountryMigrationRequest(options: {
  base: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number; maxAttempts?: number;
  pause?: (ms: number) => Promise<unknown>;
}): CountryMigrationRequest;
export function migrateCompanyCountries(request: CountryMigrationRequest, options?: { apply?: boolean; writeAttempts?: number; pause?: (ms: number) => Promise<unknown> }): Promise<{
  updates: Array<{ id: string; country: string }>;
  invalid: Array<{ id: string; name: string; value: unknown; reason: string }>;
  appliedUpdates: Array<{ id: string; country: string }>;
  skipped: Array<{ id: string; reason: string }>;
  complete: boolean;
  applied: boolean;
}>;
