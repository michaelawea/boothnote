export type CountryMigrationRequest = (method: string, path: string, body?: Record<string, unknown>) => Promise<any>;
export function migrateCompanyCountries(request: CountryMigrationRequest, options?: { apply?: boolean }): Promise<{
  updates: Array<{ id: string; country: string }>;
  invalid: Array<{ id: string; name: string; value: unknown }>;
  applied: boolean;
}>;
