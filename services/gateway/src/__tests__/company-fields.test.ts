import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { COUNTRY_CODES, companyCountry, normalizeCountry } from '../../../../shared/countries.mjs';
import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPES } from '../../../../shared/company-types.mjs';
import { companySuggestion } from '../../../../shared/company-suggestion.mjs';
import { createCountryMigrationRequest, migrateCompanyCountries } from '../../../../scripts/migrate-company-countries.mjs';
import { companyIntelPatch } from '../../../../scripts/recompute-intel.mjs';
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

  it('老 TEXT 的 NA 不猜成纳米比亚，已选择的受控 NA 保留', async () => {
    const fixture = migrationFixture();
    fixture.rows[0]!.hqCountry = 'NA';
    fixture.rows[1]!.hqCountryCode = 'NA';
    const result = await migrateCompanyCountries(fixture.request, { apply: true });
    assert.equal(result.complete, false);
    assert.deepEqual(result.updates, []);
    assert.deepEqual(result.invalid.map((row) => row.id), ['a', 'c']);
    assert.equal(fixture.rows[0]!.hqCountryCode, null);
    assert.equal(fixture.rows[1]!.hqCountryCode, 'NA');
    assert.equal(fixture.legacy.isActive, false, '国家输入仍必须受控，异常历史值不重新开放 TEXT 编辑');
  });

  it('读取分页后人工已经选了国家，回填不会盖掉这个选择', async () => {
    const fixture = migrationFixture();
    const request = async (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === 'GET' && path === '/rest/companies/a') fixture.rows[0]!.hqCountryCode = 'ES';
      return fixture.request(method, path, body);
    };
    const result = await migrateCompanyCountries(request, { apply: true });
    assert.equal(fixture.rows[0]!.hqCountryCode, 'ES');
    assert.equal(fixture.writes.some((write) => write.path === '/rest/companies/a'), false);
    assert.deepEqual(result.skipped, [{ id: 'a', reason: 'already_selected' }]);
  });

  it('读取快照后旧值变化，报告待人工处理而不覆盖', async () => {
    const fixture = migrationFixture();
    const request = async (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === 'GET' && path === '/rest/companies/a') {
        return { data: { company: { ...fixture.rows[0], hqCountry: 'Spain' } } };
      }
      return fixture.request(method, path, body);
    };
    const result = await migrateCompanyCountries(request, { apply: true });
    assert.equal(result.complete, false);
    assert.equal(fixture.writes.some((write) => write.path === '/rest/companies/a'), false);
    assert.equal(result.invalid.find((row) => row.id === 'a')?.reason, 'changed_during_migration');
  });

  it('写前的第二次核对发现人工选择，不会继续写旧快照', async () => {
    const fixture = migrationFixture();
    let reads = 0;
    const request = async (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === 'GET' && path === '/rest/companies/a' && ++reads === 2) fixture.rows[0]!.hqCountryCode = 'ES';
      return fixture.request(method, path, body);
    };
    await assert.rejects(migrateCompanyCountries(request, { apply: true }), /changed concurrently/);
    assert.equal(fixture.rows[0]!.hqCountryCode, 'ES');
    assert.equal(fixture.writes.length, 0);
  });

  it('国家 PATCH 写成但回包丢失，回读成功后不重复 PATCH', async () => {
    const fixture = migrationFixture();
    let patches = 0;
    const request = async (method: string, path: string, body?: Record<string, unknown>) => {
      const result = await fixture.request(method, path, body);
      if (method === 'PATCH' && path === '/rest/companies/a') {
        patches++;
        throw Object.assign(new Error('lost reply'), { retryable: true });
      }
      return result;
    };
    const result = await migrateCompanyCountries(request, { apply: true });
    assert.equal(patches, 1);
    assert.equal(fixture.rows[0]!.hqCountryCode, 'DE');
    assert.equal(result.appliedUpdates.length, 1);
  });

  it('瞬时 PATCH 5xx 回读仍未写入才有限重试；明确 400 不重试', async () => {
    for (const status of [503, 400]) {
      const fixture = migrationFixture();
      let patches = 0;
      const delays: number[] = [];
      const request = async (method: string, path: string, body?: Record<string, unknown>) => {
        if (method === 'PATCH' && path === '/rest/companies/a' && ++patches < 3) {
          throw Object.assign(new Error(`HTTP ${status}`), { retryable: status === 503 });
        }
        return fixture.request(method, path, body);
      };
      const work = migrateCompanyCountries(request, { apply: true, pause: async (ms) => { delays.push(ms); } });
      if (status === 503) {
        await work;
        assert.equal(patches, 3);
        assert.deepEqual(delays, [500, 1000]);
      } else {
        await assert.rejects(work, /HTTP 400/);
        assert.equal(patches, 1);
        assert.deepEqual(delays, []);
        assert.equal(fixture.legacy.isActive, true);
      }
    }
  });

  it('PATCH 后无法回读时停止，不把无法核对当成可继续重试', async () => {
    const fixture = migrationFixture();
    let written = false;
    const request = async (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === 'GET' && path === '/rest/companies/a' && written) throw new Error('read unavailable');
      const result = await fixture.request(method, path, body);
      if (method === 'PATCH' && path === '/rest/companies/a') written = true;
      return result;
    };
    await assert.rejects(migrateCompanyCountries(request, { apply: true }), /read unavailable/);
    assert.equal(fixture.writes.length, 1);
    assert.equal(fixture.legacy.isActive, true);
  });

  it('停用旧输入的 PATCH 丢回包也用 metadata 回读核对', async () => {
    const fixture = migrationFixture();
    let patches = 0;
    const request = async (method: string, path: string, body?: Record<string, unknown>) => {
      const result = await fixture.request(method, path, body);
      if (method === 'PATCH' && path.startsWith('/rest/metadata/fields/')) {
        patches++;
        throw Object.assign(new Error('metadata reply lost'), { retryable: true });
      }
      return result;
    };
    await migrateCompanyCountries(request, { apply: true });
    assert.equal(fixture.legacy.isActive, false);
    assert.equal(patches, 1);
  });
});

describe('国家迁移 HTTP 的有限重试', () => {
  const interruptedBody = () => new Response(new ReadableStream({
    start(controller) { controller.error(new TypeError('terminated')); },
  }), { status: 200 });

  it('GET 5xx 有限重试；400 和 PATCH 错误交给调用方核对', async () => {
    for (const [method, status, expectedCalls] of [['GET', 503, 3], ['GET', 400, 1], ['PATCH', 503, 1]] as const) {
      let calls = 0;
      const delays: number[] = [];
      const request = createCountryMigrationRequest({ base: 'http://fixture.invalid', token: 'fixture',
        fetchImpl: async () => { calls++; return new Response('{}', { status }); },
        pause: async (ms) => { delays.push(ms); },
      });
      await assert.rejects(request(method, '/rest/companies/a', { hqCountryCode: 'DE' }), new RegExp(`HTTP ${status}`));
      assert.equal(calls, expectedCalls);
      assert.equal(delays.length, expectedCalls - 1);
    }
  });

  it('超时取消 GET，有限重试后明确失败', async () => {
    let calls = 0;
    const request = createCountryMigrationRequest({ base: 'http://fixture.invalid', token: 'fixture', timeoutMs: 5, maxAttempts: 2,
      pause: async () => {},
      fetchImpl: async (_url, init) => {
        calls++;
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    });
    // AbortSignal.timeout 使用 unref timer；测试自己的计时器只负责保持测试进程存活。
    const hold = setTimeout(() => {}, 1000);
    try { await assert.rejects(request('GET', '/rest/companies/a'), /network\/timeout/); }
    finally { clearTimeout(hold); }
    assert.equal(calls, 2);
  });

  it('GET 200 响应体中断会有限重试，并读到下一次完整响应', async () => {
    let calls = 0;
    const delays: number[] = [];
    const request = createCountryMigrationRequest({ base: 'http://fixture.invalid', token: 'fixture',
      fetchImpl: async () => ++calls === 1 ? interruptedBody() : new Response('{"data":{"company":{"id":"a"}}}'),
      pause: async (ms) => { delays.push(ms); },
    });
    assert.deepEqual(await request('GET', '/rest/companies/a'), { data: { company: { id: 'a' } } });
    assert.equal(calls, 2);
    assert.deepEqual(delays, [500]);
  });

  it('PATCH 200 响应体中断标记可核对，但请求层绝不重复写入', async () => {
    let calls = 0;
    const request = createCountryMigrationRequest({ base: 'http://fixture.invalid', token: 'fixture',
      fetchImpl: async () => { calls++; return interruptedBody(); },
      pause: async () => { assert.fail('PATCH 请求层不应自动重试'); },
    });
    await assert.rejects(request('PATCH', '/rest/companies/a', { hqCountryCode: 'DE' }), (error: any) => {
      assert.equal(error.retryable, true);
      assert.match(error.message, /response body interrupted/);
      return true;
    });
    assert.equal(calls, 1);
  });

  it('200 非法 JSON 不当作网络故障重试', async () => {
    for (const method of ['GET', 'PATCH']) {
      let calls = 0;
      const request = createCountryMigrationRequest({ base: 'http://fixture.invalid', token: 'fixture',
        fetchImpl: async () => { calls++; return new Response('{not-json'); },
        pause: async () => { assert.fail('非法 JSON 不应自动重试'); },
      });
      await assert.rejects(request(method, '/rest/companies/a'), (error: any) => {
        assert.notEqual(error.retryable, true);
        assert.ok(error instanceof SyntaxError);
        return true;
      });
      assert.equal(calls, 1);
    }
  });
});

describe('部署重算与网关使用同一个受控国家规则', () => {
  const items = [{ itemKey: 'hqCountry', question: 'HQ country?', wave: 1, weight: 3, appliesTo: 'company', isEnabled: true }];
  it('新国家、旧 schema 和明确清空得到正确完整度，且不修改档案', () => {
    for (const [company, expected] of [
      [{ hqCountryCode: 'DE' }, 100], [{ hqCountry: 'Germany' }, 100],
      [{ hqCountryCode: null, hqCountry: 'Germany' }, 0],
      [{ hqCountryCode: 'FR', hqCountry: '' }, 100],
    ] as const) {
      const before = { ...company };
      const patch = companyIntelPatch(items, [], company);
      assert.equal(patch.intelCompleteness, expected);
      assert.equal(patch.missingIntel, expected === 100 ? null : 'hqCountry');
      assert.deepEqual(company, before);
    }
  });
  it('情报答案仍能填该项；输出只包括三个派生列', () => {
    const patch = companyIntelPatch(items, [{ intelItem: { itemKey: 'hqCountry' } }], { hqCountryCode: null });
    assert.equal(patch.intelCompleteness, 100);
    assert.deepEqual(Object.keys(patch), ['intelCompleteness', 'missingIntel', 'nextAsk']);
  });
});

describe('国家回填失败时的实际部署脚本', () => {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const runFixture = (statuses: Partial<Record<'PROVISION_STATUS' | 'PREVIEW_STATUS' | 'APPLY_STATUS' | 'HEALTH_STATUS', string>> = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'boothnote-country-deploy-'));
    try {
      for (const directory of ['scripts', 'infra', 'bin']) mkdirSync(join(root, directory));
      writeFileSync(join(root, 'scripts', 'deploy-server.sh'), readFileSync(join(repository, 'scripts', 'deploy-server.sh')));
      writeFileSync(join(root, 'scripts', 'preflight.sh'), '#!/bin/sh\nexit 0\n');
      writeFileSync(join(root, 'infra', 'backup.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(root, 'bin', 'git'), '#!/bin/sh\nprintf "%s\\n" fixture\n', { mode: 0o755 });
      writeFileSync(join(root, 'bin', 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(root, 'bin', 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$FIXTURE_LOG"
case "$*" in
  *scripts/provision-twenty.mjs*) exit "$PROVISION_STATUS" ;;
  *scripts/migrate-company-countries.mjs*--apply*) exit "$APPLY_STATUS" ;;
  *scripts/migrate-company-countries.mjs*) exit "$PREVIEW_STATUS" ;;
  *exec*gateway*node*) exit "$HEALTH_STATUS" ;;
  *ps*--format*) printf '%s\\n' 'server healthy' ;;
esac
exit 0
`, { mode: 0o755 });
      const result = spawnSync('bash', ['scripts/deploy-server.sh', '--skip-smoke'], {
        cwd: root, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, FIXTURE_LOG: join(root, 'calls'),
          PROVISION_STATUS: '0', PREVIEW_STATUS: '0', APPLY_STATUS: '0', HEALTH_STATUS: '0', ...statuses },
      });
      if (result.error) throw result.error;
      return { status: result.status, output: result.stdout + result.stderr, calls: readFileSync(join(root, 'calls'), 'utf8') };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('预览失败时不停止旧网关；provision 失败也不越过前置条件', () => {
    for (const statuses of [{ PREVIEW_STATUS: '1' }, { PROVISION_STATUS: '1' }]) {
      const result = runFixture(statuses);
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.calls, /stop gateway/);
      assert.doesNotMatch(result.calls, /force-recreate gateway caddy/);
      assert.doesNotMatch(result.output, /服务器段完成/);
    }
  });

  it('回填失败时恢复新网关并核健康，部署仍以原错误码退出', () => {
    const result = runFixture({ APPLY_STATUS: '2' });
    assert.equal(result.status, 2);
    const migration = result.calls.indexOf('node src/migrate.ts');
    const provision = result.calls.indexOf('scripts/provision-twenty.mjs');
    const preview = result.calls.indexOf('scripts/migrate-company-countries.mjs');
    const stop = result.calls.indexOf('stop gateway');
    const apply = result.calls.indexOf('scripts/migrate-company-countries.mjs --apply');
    const restart = result.calls.indexOf('up -d --no-deps --force-recreate gateway caddy');
    const health = result.calls.indexOf('exec -T gateway node');
    assert.ok(migration >= 0 && migration < provision && provision < preview && preview < stop && stop < apply && apply < restart && restart < health);
    assert.match(result.output, /服务已恢复/);
    assert.match(result.output, /本次部署仍为失败/);
    assert.doesNotMatch(result.output, /服务器段完成/);
    assert.doesNotMatch(result.calls, /scripts\/import-accounts/);
  });

  it('恢复新网关健康检查失败会明确报告，不能谎报服务已恢复', () => {
    const result = runFixture({ APPLY_STATUS: '1', HEALTH_STATUS: '1' });
    assert.equal(result.status, 1);
    assert.equal((result.calls.match(/exec -T gateway node/g) ?? []).length, 15);
    assert.match(result.output, /新网关恢复失败/);
    assert.doesNotMatch(result.output, /服务已恢复|服务器段完成/);
  });

  it('正常回填后启动新网关并通过健康检查才继续部署', () => {
    const result = runFixture();
    assert.equal(result.status, 0);
    assert.ok(result.calls.indexOf('--apply') < result.calls.indexOf('force-recreate gateway caddy'));
    assert.ok(result.calls.indexOf('exec -T gateway node') < result.calls.indexOf('scripts/import-accounts.mjs'));
    assert.match(result.output, /服务器段完成/);
  });

  it('实际 preflight 核对多事项灰度值和 Compose 透传，不回显配置值', () => {
    const root = mkdtempSync(join(tmpdir(), 'boothnote-country-preflight-'));
    try {
      for (const directory of ['scripts', 'bin', 'services/gateway/src', 'services/gateway/migrations']) {
        mkdirSync(join(root, directory), { recursive: true });
      }
      for (const relative of ['scripts/preflight.sh', 'services/gateway/src/env.ts', 'docker-compose.yml']) {
        writeFileSync(join(root, relative), readFileSync(join(repository, relative)));
      }
      writeFileSync(join(root, 'services/gateway/migrations/001.sql'), '');
      writeFileSync(join(root, 'bin/docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      for (const setting of ['', 'AGENT_MULTI_ITEMS=1\n', 'AGENT_MULTI_ITEMS=invalid\n']) {
        writeFileSync(join(root, '.env'), [
          'APP_DATABASE_URL=fixture-only', 'GATEWAY_JWT_SECRET=fixture-only', 'SERVER_URL=fixture-only',
          'TWENTY_API_KEY=fixture-only', 'OPENAI_API_KEY=fixture-only', 'BOARD_URL=fixture-only', setting,
        ].join('\n'));
        const result = spawnSync('bash', ['scripts/preflight.sh'], {
          cwd: root, encoding: 'utf8', timeout: 10_000,
          env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` },
        });
        if (result.error) throw result.error;
        assert.equal(result.status, setting.includes('invalid') ? 1 : 0, result.stdout);
        assert.doesNotMatch(result.stdout, /fixture-only|environment 没传/);
        assert.match(result.stdout, setting.includes('invalid') ? /AGENT_MULTI_ITEMS 只能是 0 或 1/
          : setting.includes('=1') ? /AGENT_MULTI_ITEMS 已开启/ : /AGENT_MULTI_ITEMS 关闭/);
      }
      const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
      assert.match(compose, /AGENT_MULTI_ITEMS: \$\{AGENT_MULTI_ITEMS:-0\}/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
