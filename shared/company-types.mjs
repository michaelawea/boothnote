export const ACCOUNT_TYPES = Object.freeze([
  'OEM_GROUP', 'OEM_SUB_GROUP', 'OEM_BRAND', 'DISTRIBUTOR', 'SUB_DISTRIBUTOR',
  'DEALER', 'SUB_DEALER', 'END_USER',
]);

export const ACCOUNT_TYPE_LABELS = Object.freeze({
  OEM_GROUP: 'OEM 集团', OEM_SUB_GROUP: 'OEM 子集团', OEM_BRAND: 'OEM 品牌',
  DISTRIBUTOR: 'distributor', SUB_DISTRIBUTOR: 'sub-distributor',
  DEALER: 'dealer', SUB_DEALER: 'sub-dealer', END_USER: '终端客户',
});

export function normalizeAccountType(value) {
  if (typeof value !== 'string') return null;
  const type = value.trim().replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toUpperCase();
  return ACCOUNT_TYPES.includes(type) ? type : null;
}
