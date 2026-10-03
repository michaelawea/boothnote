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

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const transient = (error) => error?.retryable === true;

/** 这里只接受 GET 和写固定值的 PATCH；PATCH 的重试由回读核对决定。 */
export function createCountryMigrationRequest({ base, token, fetchImpl = fetch,
  timeoutMs = 10_000, maxAttempts = 3, pause = sleep } = {}) {
  return async (method, path, body) => {
    if (method !== 'GET' && method !== 'PATCH') throw new Error('Unsupported country migration request');
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(`${base}${path}`, {
          method, signal: AbortSignal.timeout(timeoutMs),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      } catch {
        const error = Object.assign(new Error(`${method} ${path}: network/timeout; result requires verification`), { retryable: true });
        if (method !== 'GET' || attempt + 1 >= maxAttempts) throw error;
        await pause(500 * 2 ** attempt);
        continue;
      }
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const error = Object.assign(new Error(`${method} ${path}: HTTP ${response.status}`), { status: response.status, retryable });
        if (method !== 'GET' || !retryable || attempt + 1 >= maxAttempts) throw error;
        await pause(500 * 2 ** attempt);
        continue;
      }
      try {
        return await response.json();
      } catch (caught) {
        const interrupted = caught instanceof TypeError || caught?.name === 'AbortError' || caught?.name === 'TimeoutError';
        // 非法 JSON 是未能验证的响应，不能按瞬时网络故障重试。
        if (!interrupted) throw caught;
        const error = Object.assign(new Error(`${method} ${path}: response body interrupted; result requires verification`), { retryable: true });
        if (method !== 'GET' || attempt + 1 >= maxAttempts) throw error;
        await pause(500 * 2 ** attempt);
      }
    }
  };
}

// 老 TEXT 里的 NA 常是「不适用」；受控 SELECT 的合法 NA（纳米比亚）不受这条限制。
const legacyCountry = (value) => typeof value === 'string' && ['NA', 'N/A', 'UNKNOWN', 'NONE', '不适用', '不详'].includes(value.trim().toUpperCase())
  ? null : normalizeCountry(value);

/** 回包丢失/5xx 后先回读，只有仍是原值时才有限重试固定值写入。 */
async function writeVerified(request, { path, body, read, expected, before, label, attempts, pause }) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const current = await read();
    if (current === expected) return;
    if (current !== before) throw new Error(`${label} changed concurrently; migration stopped`);
    let error;
    try { await request('PATCH', path, body); }
    catch (caught) { error = caught; }
    // 即使 PATCH 报 4xx，也先核对实际状态。回读失败则不继续盲写。
    const after = await read();
    if (after === expected) return;
    if (after !== before) throw new Error(`${label} changed concurrently; migration stopped`);
    if (!error) throw new Error(`${label} did not persist; migration stopped`);
    if (!transient(error) || attempt + 1 === attempts) throw error;
    await pause(500 * 2 ** attempt);
  }
}

export async function migrateCompanyCountries(request, { apply = false, writeAttempts = 3, pause = sleep } = {}) {
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
    const country = legacyCountry(row.hqCountry);
    if (country) updates.push({ id: row.id, country });
    else if (row.hqCountry != null && row.hqCountry !== '') invalid.push({ id: row.id, name: row.name, value: row.hqCountry, reason: 'unrecognized' });
  }

  const appliedUpdates = [];
  const skipped = [];
  if (apply) {
    for (const update of updates) {
      const path = `/rest/companies/${update.id}`;
      const original = records.find((row) => row.id === update.id);
      const readRow = async () => {
        const check = await request('GET', path);
        const row = check?.data?.company ?? check?.data;
        if (!row || row.id !== update.id) throw new Error(`Invalid country readback for ${update.id}`);
        return row;
      };
      const current = await readRow();
      if (current.hqCountryCode != null && current.hqCountryCode !== '') {
        if (!COUNTRY_CODES.includes(current.hqCountryCode)) throw new Error(`Invalid controlled country on ${update.id}`);
        skipped.push({ id: update.id, reason: 'already_selected' });
        continue;
      }
      if (current.hqCountry !== original.hqCountry) {
        invalid.push({ id: update.id, name: current.name, value: current.hqCountry, reason: 'changed_during_migration' });
        continue;
      }
      await writeVerified(request, {
        path, body: { hqCountryCode: update.country }, expected: update.country,
        before: current.hqCountryCode ?? null,
        read: async () => {
          const row = await readRow();
          if ((row.hqCountryCode == null || row.hqCountryCode === '') && row.hqCountry !== original.hqCountry) {
            throw new Error(`Legacy country changed concurrently for ${update.id}`);
          }
          return row.hqCountryCode ?? null;
        },
        label: `Country backfill for ${update.id}`, attempts: writeAttempts, pause,
      });
      appliedUpdates.push(update);
    }
    if (legacy?.isActive !== false && legacy) {
      await writeVerified(request, {
        path: `/rest/metadata/fields/${legacy.id}`, body: { isActive: false }, expected: false,
        before: legacy.isActive ?? true,
        read: async () => {
          const after = list(await request('GET', '/rest/metadata/objects')).find((o) => o.nameSingular === 'company');
          const field = list(after?.fields).find((f) => f.id === legacy.id);
          if (!field) throw new Error('Legacy country metadata readback is incomplete');
          return field.isActive ?? true;
        }, label: 'Legacy country input', attempts: writeAttempts, pause,
      });
    }
  }
  return { updates, invalid, appliedUpdates, skipped, complete: invalid.length === 0, applied: apply };
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
  const request = createCountryMigrationRequest({ base, token });
  try {
    const result = await migrateCompanyCountries(request, { apply: process.argv.includes('--apply') });
    console.log(result.applied
      ? `Applied: ${result.appliedUpdates.length} verified country backfills; ${result.skipped.length} new selections preserved; ${result.invalid.length} exceptions`
      : `Preview: ${result.updates.length} country backfills; ${result.invalid.length} legacy values need manual selection`);
    for (const row of result.invalid) console.warn(`Country needs manual selection [${row.reason}]: ${row.id} ${row.name} (${String(row.value)})`);
    console.log('Legacy values are preserved; no fields or records are deleted.');
    if (result.applied && !result.complete) {
      console.error('Country migration is incomplete; resolve listed exceptions in the controlled CRM field, then rerun.');
      process.exitCode = 2;
    }
  } catch (error) { console.error(error.message); process.exit(1); }
}
