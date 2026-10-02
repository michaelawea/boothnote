import { normalizeCountry } from './countries.mjs';
import { normalizeAccountType } from './company-types.mjs';

/** Only explicit hints from the chosen suggestion belong in the creation form. */
export function companySuggestion(name, hints) {
  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (!cleanName) return null;
  const matching = hints && typeof hints === 'object' && hints.name === cleanName;
  return {
    name: cleanName,
    country: matching ? normalizeCountry(hints.country) : null,
    accountType: matching ? normalizeAccountType(hints.accountType) : null,
  };
}
