export const COUNTRY_CODES: readonly string[];
export function countryName(code: string, locale?: string): string;
export function normalizeCountry(value: unknown): string | null;
export function companyCountry(company: Record<string, unknown>): string | null;
