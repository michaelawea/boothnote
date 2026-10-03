export function companyIntelPatch(items: Array<Record<string, any>>, values: Array<Record<string, any>>, company: Record<string, any>): {
  intelCompleteness: number | null;
  missingIntel: string | null;
  nextAsk: string | null;
};
