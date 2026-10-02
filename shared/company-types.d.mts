export type AccountType = 'OEM_GROUP' | 'OEM_SUB_GROUP' | 'OEM_BRAND' | 'DISTRIBUTOR' | 'SUB_DISTRIBUTOR' | 'DEALER' | 'SUB_DEALER' | 'END_USER';
export const ACCOUNT_TYPES: readonly AccountType[];
export const ACCOUNT_TYPE_LABELS: Readonly<Record<AccountType, string>>;
export function normalizeAccountType(value: unknown): AccountType | null;
