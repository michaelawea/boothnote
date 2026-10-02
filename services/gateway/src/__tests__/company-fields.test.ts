import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { COUNTRY_CODES, companyCountry, normalizeCountry } from '../../../../shared/countries.mjs';
import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPES } from '../../../../shared/company-types.mjs';
import { companySuggestion } from '../../../../shared/company-suggestion.mjs';
import { migrateCompanyCountries } from '../../../../scripts/migrate-company-countries.mjs';
import { createCompany, getCompanyByCode } from '../twenty.ts';

afterEach(() => mock.restoreAll());

describe('受控国家与客户建议（#60–#62）', () => {
  it('国家代码、不同语言的名称都归到同一个值，非法值不猜', () => {
    for (const [input, expected] of [['de', 'DE'], [' Germany ', 'DE'], ['德国', 'DE'], ['Allemagne', 'DE'], ['France', 'FR'], ['UK', 'GB'], ['United States', 'US']]) {
      assert.equal(normalizeCountry(input), expected);
    }
    for (const value of ['NotARealCountry', 'ZZ', 'EU', '德国附近', {}, [], 42, null, '']) assert.equal(normalizeCountry(value), null);
    assert.equal(COUNTRY_CODES.length, 249);
    assert.equal(new Set(COUNTRY_CODES).size, 249);
  });

  it('显式的受控国家（含 null）优先于旧文本，不能从旧格复活已清空的国家', () => {
    assert.equal(companyCountry({ hqCountryCode: 'FR', hqCountry: 'Germany' }), 'FR');
    assert.equal(companyCountry({ hqCountryCode: null, hqCountry: 'Germany' }), null);
    assert.equal(companyCountry({ hqCountry: 'Germany' }), 'DE');
  });

  it('建议提示归一化；不匹配的旧建议、未知国家和类型不能串进表单', () => {
    assert.deepEqual(companySuggestion('Example Caravan', { name: 'Example Caravan', country: 'France', accountType: 'subDealer' }), {
      name: 'Example Caravan', country: 'FR', accountType: 'SUB_DEALER',
    });
    assert.deepEqual(companySuggestion('Example Caravan', { name: 'Other Company', country: 'DE', accountType: 'DEALER' }), {
      name: 'Example Caravan', country: null, accountType: null,
    });
    assert.deepEqual(companySuggestion('Example Caravan', { name: 'Example Caravan', country: 'NotARealCountry', accountType: 'OTHER' }), {
      name: 'Example Caravan', country: null, accountType: null,
    });
  });

  it('所有渠道身份显示英文，已有身份值仍然是同一套', async () => {
    const schemaPath = '../../../../scripts/twenty-schema.mjs';
    const { FIELDS, ACCOUNT_TYPES: schemaTypes, toEnumValue } = await import(schemaPath);
    assert.deepEqual(schemaTypes.map((type: { value: string }) => toEnumValue(type.value)), [...ACCOUNT_TYPES]);
    for (const type of ['DISTRIBUTOR', 'SUB_DISTRIBUTOR', 'DEALER', 'SUB_DEALER'] as const) {
      assert.doesNotMatch(ACCOUNT_TYPE_LABELS[type], /经销商|分销商/);
      assert.equal(schemaTypes.find((value: { value: string }) => toEnumValue(value.value) === type).label, ACCOUNT_TYPE_LABELS[type]);
    }
    const country = FIELDS.company.find((field: { name: string }) => field.name === 'hqCountryCode');
    assert.equal(country.type, 'SELECT');
    assert.deepEqual(country.options.map((option: { value: string }) => option.value), COUNTRY_CODES);
  });

  it('最后的 CRM 写入也验证国家；不会把自由文本写入旧格', async () => {
    const bodies: Record<string, unknown>[] = [];
    mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
      bodies.push(JSON.parse(options.body as string));
      return new Response(JSON.stringify({ data: { createCompany: { id: 'new-id' } } }));
    });
    await assert.rejects(createCompany({ name: 'Example', accountCode: 'EX', accountType: 'DEALER', hqCountry: 'NotARealCountry' }), /invalid_country/);
    assert.equal(bodies.length, 0);
    assert.equal(await createCompany({ name: 'Example', accountCode: 'EX', accountType: 'DEALER', hqCountry: 'France' }), 'new-id');
    assert.equal(bodies[0]?.hqCountryCode, 'FR');
    assert.equal(Object.hasOwn(bodies[0]!, 'hqCountry'), false);
  });

  it('CRM 回读以新国家为准，情报清单继续读得到原 hqCountry 契约', async () => {
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: { companies: [{ id: 'c1', hqCountryCode: 'FR', hqCountry: 'Germany' }] } })));
    assert.equal((await getCompanyByCode('EXAMPLE'))?.hqCountry, 'FR');
  });
});

const migrationFixture = () => {
  const legacy = { id: 'legacy-id', name: 'hqCountry', type: 'TEXT', isActive: true };
  const controlled = { name: 'hqCountryCode', type: 'SELECT', isActive: true, options: COUNTRY_CODES.map((value) => ({ value })) };
  const rows = [
    { id: 'a', name: 'Example A', hqCountry: 'Germany', hqCountryCode: null },
    { id: 'b', name: 'Example B', hqCountry: 'Italy', hqCountryCode: 'FR' },
    { id: 'c', name: 'Example C', hqCountry: 'NotARealCountry', hqCountryCode: null },
  ];
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  let dropWrites = false;
  const request = async (method: string, path: string, body?: Record<string, unknown>): Promise<any> => {
    if (method === 'GET' && path === '/rest/metadata/objects') return { data: { objects: [{ nameSingular: 'company', fields: [legacy, controlled] }] } };
    if (method === 'GET' && path.startsWith('/rest/companies?')) return path.includes('starting_after')
      ? { data: { companies: rows.slice(2) }, pageInfo: { hasNextPage: false } }
      : { data: { companies: rows.slice(0, 2) }, pageInfo: { hasNextPage: true, endCursor: 'next' } };
    if (method === 'GET') return { data: { company: rows.find((row) => path === `/rest/companies/${row.id}`) } };
    writes.push({ path, body: body! });
    if (!dropWrites) {
      if (path === '/rest/metadata/fields/legacy-id') Object.assign(legacy, body);
      else Object.assign(rows.find((row) => path === `/rest/companies/${row.id}`)!, body);
    }
    return {};
  };
  return { request, rows, legacy, controlled, writes, ignoreWrites: () => { dropWrites = true; } };
};

describe('国家迁移的数据保全', () => {
  it('预览零写入；识别分页中的异常值，已有选择不能被覆盖', async () => {
    const fixture = migrationFixture();
    const result = await migrateCompanyCountries(fixture.request);
    assert.deepEqual(result.updates, [{ id: 'a', country: 'DE' }]);
    assert.deepEqual(result.invalid.map((row) => row.id), ['c']);
    assert.equal(fixture.writes.length, 0);
  });

  it('回填、回读、停用旧输入；重跑无写入，旧文本一个字不动', async () => {
    const fixture = migrationFixture();
    const before = fixture.rows.map((row) => row.hqCountry);
    await migrateCompanyCountries(fixture.request, { apply: true });
    assert.equal(fixture.rows[0]?.hqCountryCode, 'DE');
    assert.equal(fixture.rows[1]?.hqCountryCode, 'FR');
    assert.equal(fixture.rows[2]?.hqCountryCode, null);
    assert.deepEqual(fixture.rows.map((row) => row.hqCountry), before);
    assert.equal(fixture.legacy.isActive, false);
    assert.deepEqual(fixture.writes.map((write) => write.path), ['/rest/companies/a', '/rest/metadata/fields/legacy-id']);
    const count = fixture.writes.length;
    await migrateCompanyCountries(fixture.request, { apply: true });
    assert.equal(fixture.writes.length, count);
  });

  it('HTTP 成功但回填没落住时，不停用旧输入', async () => {
    const fixture = migrationFixture();
    fixture.ignoreWrites();
    await assert.rejects(migrateCompanyCountries(fixture.request, { apply: true }), /did not persist/);
    assert.equal(fixture.legacy.isActive, true);
    assert.equal(fixture.writes.some((write) => write.path.includes('/metadata/')), false);
  });

  it('受控字段还没建/出现非法选项时，任何数据写入之前就失败', async () => {
    const fixture = migrationFixture();
    fixture.controlled.options.push({ value: 'ZZ' });
    await assert.rejects(migrateCompanyCountries(fixture.request, { apply: true }), /ISO country list/);
    assert.equal(fixture.writes.length, 0);
  });

  it('分页元数据缺失或游标重复时，不把部分读取当成完整迁移', async () => {
    for (const pageInfo of [undefined, { hasNextPage: true, endCursor: 'same' }, { hasNextPage: true }]) {
      const fixture = migrationFixture();
      const request = async (method: string, path: string, body?: Record<string, unknown>) => {
        const response = await fixture.request(method, path, body);
        return path.startsWith('/rest/companies?') ? { ...response, pageInfo } : response;
      };
      await assert.rejects(migrateCompanyCountries(request, { apply: true }), /response|pagination/);
      assert.equal(fixture.writes.length, 0);
      assert.equal(fixture.legacy.isActive, true);
    }
  });
});
