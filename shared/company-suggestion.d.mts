import type { AccountType } from './company-types.mjs';
export type CompanySuggestion = { name: string; country: string | null; accountType: AccountType | null };
export function companySuggestion(name: unknown, hints?: unknown): CompanySuggestion | null;
