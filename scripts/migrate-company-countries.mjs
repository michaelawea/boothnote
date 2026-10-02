#!/usr/bin/env node
/** Preserve legacy TEXT data; backfill a new SELECT and only then deactivate the old field. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { COUNTRY_CODES, normalizeCountry } from '../shared/countries.mjs';

const list = (v) => {
  if (Array.isArray(v)) return v.map((x) => x.node ?? x);
  for (const key of ['objects', 'fields', 'data', 'edges']) if (v?.[key]) return list(v[key]);
  return [];
};

export async function migrateCompanyCountries(request, { apply = false } = {}) {
  const metadata = await request('GET', '/rest/metadata/objects');
  const company = list(metadata).find((o) => o.nameSingular === 'company');
  const fields = list(company?.fields);
  const controlled = fields.find((f) => f.name === 'hqCountryCode');
  const legacy = fields.find((f) => f.name === 'hqCountry');
  const values = new Set((controlled?.options ?? []).map((o) => o.value));
  if (!company || controlled?.type !== 'SELECT' || controlled.isActive === false ||
      values.size !== COUNTRY_CODES.length || COUNTRY_CODES.some((code) => !values.has(code))) {
    throw new Error('hqCountryCode must be an active SELECT with the ISO country list; run provision-twenty first');
  }
  if (legacy && (!legacy.id || legacy.type !== 'TEXT')) throw new Error('Unexpected legacy hqCountry metadata');

  const records = [];
  const cursors = new Set();
  let cursor = '';
  for (;;) {
    const page = await request('GET', `/rest/companies?limit=60${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ''}`);
    const rows = page?.data?.companies;
    if (!Array.isArray(rows) || typeof page.pageInfo?.hasNextPage !== 'boolean') throw new Error('Invalid companies response; migration stopped');
    records.push(...rows);
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor) || cursors.size >= 1000) throw new Error('Incomplete/repeated companies pagination');
    cursors.add(cursor);
  }

  const updates = [];
  const invalid = [];
  for (const row of records) {
    if (row.hqCountryCode != null && row.hqCountryCode !== '') {
      if (!COUNTRY_CODES.includes(row.hqCountryCode)) throw new Error(`Invalid controlled country on ${row.id}`);
      continue; // Never overwrite a user's selection, even if the old text differs.
    }
    const country = normalizeCountry(row.hqCountry);
    if (country) updates.push({ id: row.id, country });
    else if (row.hqCountry != null && row.hqCountry !== '') invalid.push({ id: row.id, name: row.name, value: row.hqCountry });
  }

  if (apply) {
    for (const update of updates) {
      await request('PATCH', `/rest/companies/${update.id}`, { hqCountryCode: update.country });
      const check = await request('GET', `/rest/companies/${update.id}`);
      const row = check?.data?.company ?? check?.data;
      if (row?.hqCountryCode !== update.country) throw new Error(`Country backfill did not persist for ${update.id}; legacy field remains active`);
    }
    if (legacy?.isActive !== false && legacy) {
      await request('PATCH', `/rest/metadata/fields/${legacy.id}`, { isActive: false });
      const after = list(await request('GET', '/rest/metadata/objects')).find((o) => o.nameSingular === 'company');
      if (list(after?.fields).find((f) => f.id === legacy.id)?.isActive !== false) throw new Error('Legacy country input was not deactivated');
    }
  }
  return { updates, invalid, applied: apply };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const config = {};
  try {
    for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (match) config[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* Environment variables are sufficient in CI/containers. */ }
  const base = (process.env.SERVER_URL || config.SERVER_URL || 'http://localhost:3000').replace(/\/$/, '');
  const token = process.env.TWENTY_API_KEY || config.TWENTY_API_KEY;
  if (!token) { console.error('Missing TWENTY_API_KEY'); process.exit(1); }
  const request = async (method, path, body) => {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${base}${path}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 429 && attempt < 5) {
        await new Promise((done) => setTimeout(done, 500 * 2 ** attempt));
        continue;
      }
      if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
      return response.json();
    }
  };
  try {
    const result = await migrateCompanyCountries(request, { apply: process.argv.includes('--apply') });
    console.log(`${result.applied ? 'Applied' : 'Preview'}: ${result.updates.length} country backfills; ${result.invalid.length} legacy values need manual selection`);
    for (const row of result.invalid) console.warn(`Country not recognized; choose in CRM: ${row.id} ${row.name} (${String(row.value)})`);
    console.log('Legacy values are preserved; no fields or records are deleted.');
  } catch (error) { console.error(error.message); process.exit(1); }
}
