/**
 * 客户项目进度的纯函数（D139–D142）：写进来收什么、写出去长什么样、读出去给客户什么。
 *
 * 最要紧的是三组：
 *   ① **和 twenty-schema.mjs 对账** —— 枚举、字段名、默认值。网关镜像里读不到 schema，只能各存一份，
 *      对不上的后果是静默的（Twenty 回 400 → 门户看到 502；或者读回来的列名不对 → 那一格永远是空）。
 *   ② **布尔只认 true** —— `portalVisible` / `customerVisible` 猜错一次就是把内部记录公开给客户。
 *   ③ **阶段增删计划** —— 停用某个项目正停着的阶段必须整个拒掉（stage_in_use）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  actorName,
  buildSnapshot,
  camelOf,
  DATE_PRECISIONS,
  LIMITS,
  needsType,
  normalizeOccurredAt,
  normProject,
  normUpdate,
  planStages,
  portalProjectBody,
  PROJECT_STATUSES,
  projectTypeBody,
  projectUpdateBody,
  sanitizeProjectCreate,
  sanitizeProjectPatch,
  sanitizeTypeCreate,
  sanitizeTypePatch,
  sanitizeUpdateCreate,
  sanitizeUpdatePatch,
  stageBody,
  stageKeyFor,
  statusOf,
  typeCodeFor,
  UPDATE_KINDS,
  type LiveStage,
} from '../portalModel.ts';
import { toEnum } from '../survey.ts';
import { softDeleteRecords } from '../twenty.ts';

// schema 是 .mjs、没有类型声明 —— 用变量路径动态导入，tsc 就不去解析它（按 any 处理）
const SCHEMA_PATH = '../../../../scripts/twenty-schema.mjs';
const schema: any = await import(SCHEMA_PATH);
const { FIELDS, OBJECTS, toEnumValue } = schema;

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const field = (obj: string, name: string) => {
  const f = (FIELDS[obj] ?? []).find((x: any) => x.name === name);
  assert.ok(f, `twenty-schema.mjs 里没有 ${obj}.${name}`);
  return f;
};
const values = (opts: Array<{ value: string }>) => opts.map((o) => o.value);

// ═══════════════════════════════════════════════════════════════════
describe('和 twenty-schema.mjs 对账（两份枚举、字段名、默认值）', () => {
  it('三个枚举逐个相同 —— 多一个少一个都红', () => {
    assert.deepEqual([...PROJECT_STATUSES], values(schema.PROJECT_STATUSES));
    assert.deepEqual([...UPDATE_KINDS], values(schema.PROJECT_UPDATE_KINDS));
    assert.deepEqual([...DATE_PRECISIONS], values(schema.DATE_PRECISIONS));
    assert.deepEqual(values(field('project', 'projectStatus').options), [...PROJECT_STATUSES]);
    assert.deepEqual(values(field('projectUpdate', 'kind').options), [...UPDATE_KINDS]);
    assert.deepEqual(values(field('projectUpdate', 'datePrecision').options), [...DATE_PRECISIONS]);
  });

  it('camelCase ⇄ UPPER_SNAKE 两个方向都和 schema 的 toEnumValue 一致（含 accountType / projectStage 全部现有值）', () => {
    const all = [
      ...PROJECT_STATUSES,
      ...UPDATE_KINDS,
      ...DATE_PRECISIONS,
      ...values(schema.ACCOUNT_TYPES),
      ...values(schema.OPPORTUNITY_STAGES),
    ];
    for (const v of all) {
      assert.equal(toEnum(v), toEnumValue(v), `${v} 两边算出来的 UPPER_SNAKE 不一样`);
      assert.equal(camelOf(toEnumValue(v)), v, `${toEnumValue(v)} 读回来不是 ${v}`);
    }
  });

  it('🔴 projectStatus 的默认值是带引号的 UPPER_SNAKE 字面量（provision 原样发，写错 Twenty 拒）', () => {
    assert.equal(field('project', 'projectStatus').defaultValue, `'${toEnumValue('active')}'`);
  });

  it('🔴 两个「给客户看」的开关默认 false；幂等键 / 类型代号是 unique', () => {
    assert.equal(field('project', 'portalVisible').type, 'BOOLEAN');
    assert.equal(field('project', 'portalVisible').defaultValue, false);
    assert.equal(field('projectUpdate', 'customerVisible').type, 'BOOLEAN');
    assert.equal(field('projectUpdate', 'customerVisible').defaultValue, false);
    assert.equal(field('projectUpdate', 'clientId').isUnique, true);
    assert.equal(field('projectType', 'typeCode').isUnique, true);
  });

  it('三个新对象都在 OBJECTS 里，复数名 = 网关用的 REST 路径', () => {
    const plural = Object.fromEntries(OBJECTS.map((o: any) => [o.nameSingular, o.namePlural]));
    assert.equal(plural.projectType, 'projectTypes');
    assert.equal(plural.projectTypeStage, 'projectTypeStages');
    assert.equal(plural.projectUpdate, 'projectUpdates');
  });

  it('🔴 网关写出去的每一列在 schema 里都真的存在（列名漂移 = Twenty 400 → 门户永远 502）', () => {
    const names = (obj: string) => new Set(['name', ...(FIELDS[obj] ?? []).map((f: any) => f.name)]);
    const check = (obj: string, body: Record<string, unknown>) => {
      const have = names(obj);
      for (const k of Object.keys(body)) {
        const col = k.endsWith('Id') && have.has(k.slice(0, -2)) ? k.slice(0, -2) : k;
        assert.ok(have.has(col), `${obj}.${k} 在 twenty-schema.mjs 里不存在`);
      }
    };
    check('projectType', projectTypeBody({ name: 'n', typeCode: 'C', description: 'd', isActive: true }));
    check('projectTypeStage', stageBody({ projectTypeId: U(1), name: 'n', nameZh: 'z', stageKey: 'k', stageOrder: 1, isActive: true }));
    check(
      'project',
      portalProjectBody({
        name: 'n', projectCode: 'C', companyId: U(1), projectTypeId: U(2), currentStageId: U(3),
        status: 'active', portalVisible: true, customerSummary: 's', targetDate: '2026-12-01',
      }),
    );
    check(
      'projectUpdate',
      projectUpdateBody(
        {
          title: 't', projectId: U(1), stageId: U(2), kind: 'note', occurredAt: '2026-09-30T12:00:00.000Z',
          datePrecision: 'day', initiator: 'i', recipient: 'r', summary: 's', result: 'r',
          customerVisible: true, customerMessage: 'm', authorName: 'a', clientId: 'client-0001',
        },
        'create',
      ),
    );
  });

  it('🔴 反向关系 label 在同一个目标上不重名、不以数字开头（Twenty 按 label 音译反向字段名）', () => {
    const seen = new Map<string, string>();
    for (const [obj, fields] of Object.entries(FIELDS) as Array<[string, any[]]>) {
      for (const f of fields) {
        if (f.type !== 'RELATION') continue;
        const { target, targetFieldLabel } = f.relation;
        assert.ok(!/^\d/.test(targetFieldLabel), `${obj}.${f.name} 的反向 label「${targetFieldLabel}」以数字开头`);
        const k = `${target} ← ${targetFieldLabel}`;
        assert.ok(!seen.has(k), `${k} 被 ${seen.get(k)} 和 ${obj}.${f.name} 同时用了`);
        seen.set(k, `${obj}.${f.name}`);
      }
    }
  });

  it('project 上原来那两列一格没动（D140：projectStage / projectCode 原样保留）', () => {
    assert.equal(field('project', 'projectCode').isUnique, true);
    assert.deepEqual(values(field('project', 'projectStage').options), values(schema.OPPORTUNITY_STAGES));
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('🔴 布尔只认 true（失败即关闭）', () => {
  const base = { clientId: 'client-0001', title: 'Call' };

  for (const bad of ['true', 'false', 1, 0, 'yes', null, {}]) {
    it(`写入：customerVisible = ${JSON.stringify(bad)} → 400，不猜`, () => {
      const { errors } = sanitizeUpdateCreate({ ...base, customerVisible: bad, customerMessage: 'Hi' });
      assert.ok(errors.some((e) => e.startsWith('customerVisible:')), `收下了 ${JSON.stringify(bad)}`);
    });
  }

  it('写入：customerVisible 必填（没给 ≠ false）', () => {
    const { errors } = sanitizeUpdateCreate(base);
    assert.ok(errors.some((e) => e.startsWith('customerVisible:')));
  });

  it('写入：portalVisible = "true" → 400', () => {
    assert.ok(sanitizeProjectPatch({ portalVisible: 'true' }).errors.some((e) => e.startsWith('portalVisible:')));
    assert.ok(sanitizeProjectCreate({ portalVisible: 1 }).errors.some((e) => e.startsWith('portalVisible:')));
  });

  for (const v of ['true', 1, 'TRUE', null, undefined]) {
    it(`读出：Twenty 回 ${JSON.stringify(v)} → false`, () => {
      assert.equal(normUpdate({ id: U(1), customerVisible: v }).customerVisible, false);
      assert.equal(normProject({ id: U(1), portalVisible: v }).portalVisible, false);
    });
  }

  it('读出：只有真正的 true 才是 true', () => {
    assert.equal(normUpdate({ id: U(1), customerVisible: true }).customerVisible, true);
    assert.equal(normProject({ id: U(1), portalVisible: true }).portalVisible, true);
  });

  it('公开给客户的进展必须有一句给客户的话', () => {
    const { errors } = sanitizeUpdateCreate({ ...base, customerVisible: true });
    assert.ok(errors.some((e) => e.startsWith('customerMessage:')));
    assert.deepEqual(sanitizeUpdateCreate({ ...base, customerVisible: false }).errors, []);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('写进来：项目', () => {
  const ok = { clientId: 'c1b2c3d4-e5f6', name: 'Battery programme', companyId: U(1), projectTypeId: U(2) };

  it('最小合法体', () => {
    const { value, errors } = sanitizeProjectCreate(ok);
    assert.deepEqual(errors, []);
    assert.deepEqual(value, { ...ok });
  });

  it('必填、UUID、枚举、日期逐个挡', () => {
    const { errors } = sanitizeProjectCreate({
      clientId: 'x', name: '  ', companyId: 'Acme GmbH', projectTypeId: U(2),
      status: 'paused', targetDate: '2026-02-30',
    });
    const keys = errors.map((e) => e.split(':')[0]);
    for (const k of ['clientId', 'name', 'companyId', 'status', 'targetDate']) assert.ok(keys.includes(k), `${k} 没被挡`);
  });

  it('🔴 关系只收 UUID —— 名字串一律拒（规则 3）', () => {
    const { errors } = sanitizeProjectPatch({ companyId: 'Acme GmbH' });
    assert.ok(errors.some((e) => e.startsWith('companyId:')));
  });

  it('超长就拒，不截断（静默截掉客户看到的话比报错更难发现）', () => {
    const { errors } = sanitizeProjectCreate({ ...ok, name: 'x'.repeat(LIMITS.projectName + 1) });
    assert.ok(errors.some((e) => e.startsWith('name:') && e.includes(String(LIMITS.projectName))));
    assert.deepEqual(sanitizeProjectCreate({ ...ok, name: 'x'.repeat(LIMITS.projectName) }).errors, []);
  });

  it('不认识的字段报出来（门户那边字段名写错时第一时间知道）', () => {
    assert.ok(sanitizeProjectCreate({ ...ok, summary: 'x' }).errors.includes('summary: unknown field'));
  });

  it('PATCH：targetDate:null 清空；currentStageId 不能清空；clientId 不能改；空补丁报错', () => {
    assert.deepEqual(sanitizeProjectPatch({ targetDate: null }).value, { targetDate: null });
    assert.ok(sanitizeProjectPatch({ currentStageId: null }).errors.some((e) => e.startsWith('currentStageId:')));
    assert.ok(sanitizeProjectPatch({ clientId: 'abcdefgh' }).errors.includes('clientId: cannot be changed'));
    assert.deepEqual(sanitizeProjectPatch({}).errors, ['body: nothing to change']);
    assert.deepEqual(sanitizeProjectPatch({ customerSummary: null }).value, { customerSummary: '' });
  });

  it('needsType：只在「要公开」时判，类型和当前阶段缺一不可', () => {
    assert.equal(needsType({ portalVisible: true, projectTypeId: U(1), currentStageId: null }), true);
    assert.equal(needsType({ portalVisible: true, projectTypeId: null, currentStageId: U(2) }), true);
    assert.equal(needsType({ portalVisible: true, projectTypeId: U(1), currentStageId: U(2) }), false);
    assert.equal(needsType({ portalVisible: false, projectTypeId: null, currentStageId: null }), false);
    assert.equal(needsType({ projectTypeId: null, currentStageId: null }), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('写进来：进展', () => {
  const ok = { clientId: 'upd-00000001', title: 'Kick-off call', customerVisible: false };

  it('默认 kind = communication；没给时间就没有精度', () => {
    const { value, errors } = sanitizeUpdateCreate(ok);
    assert.deepEqual(errors, []);
    assert.equal(value.kind, 'communication');
    assert.equal(value.occurredAt, null);
    assert.equal(value.datePrecision, null);
  });

  it('🔴 stageChange 门户建不了（只由网关在换阶段时写）', () => {
    assert.ok(sanitizeUpdateCreate({ ...ok, kind: 'stageChange' }).errors.some((e) => e.startsWith('kind:')));
  });

  it('精度 day：存成当天正午 UTC；给了精度没给时间报错', () => {
    const { value } = sanitizeUpdateCreate({ ...ok, occurredAt: '2026-09-30', datePrecision: 'day' });
    assert.equal(value.occurredAt, '2026-09-30T12:00:00.000Z');
    assert.equal(value.datePrecision, 'day');
    assert.ok(sanitizeUpdateCreate({ ...ok, datePrecision: 'day' }).errors.some((e) => e.startsWith('datePrecision:')));
  });

  it('PATCH stageChange：只许改 customerVisible / customerMessage / occurredAt', () => {
    const existing = { kind: 'stageChange' as const, datePrecision: 'minute' as const, customerVisible: true, customerMessage: null };
    assert.ok(sanitizeUpdatePatch({ title: 'x' }, existing).errors.some((e) => e.startsWith('title:')));
    assert.ok(sanitizeUpdatePatch({ stageId: U(1) }, existing).errors.some((e) => e.startsWith('stageId:')));
    // stageChange 公开时可以没有那句话（门户显示「进入阶段 X」）
    assert.deepEqual(sanitizeUpdatePatch({ customerVisible: true }, existing).errors, []);
    assert.deepEqual(
      sanitizeUpdatePatch({ customerMessage: 'We moved on.', occurredAt: '2026-09-30T10:00:00Z' }, existing).errors,
      [],
    );
  });

  it('PATCH 普通进展：合并之后判「公开必须有话」；stageId:null 清空；kind 不能改', () => {
    const existing = { kind: 'note' as const, datePrecision: null, customerVisible: false, customerMessage: null };
    assert.ok(sanitizeUpdatePatch({ customerVisible: true }, existing).errors.some((e) => e.startsWith('customerMessage:')));
    assert.deepEqual(sanitizeUpdatePatch({ customerVisible: true, customerMessage: 'Samples shipped.' }, existing).errors, []);
    assert.deepEqual(sanitizeUpdatePatch({ stageId: null }, existing).value, { stageId: null });
    assert.ok(sanitizeUpdatePatch({ kind: 'milestone' }, existing).errors.includes('kind: cannot be changed'));
  });

  it('PATCH：只改时间时沿用原来的精度', () => {
    const existing = { kind: 'note' as const, datePrecision: 'day' as const, customerVisible: false, customerMessage: null };
    assert.deepEqual(sanitizeUpdatePatch({ occurredAt: '2026-10-02T23:59:00+02:00' }, existing).value, {
      occurredAt: '2026-10-02T12:00:00.000Z',
      datePrecision: 'day',
    });
  });
});

describe('日期规范化', () => {
  it('day 取调用方写的那个日历日，不先换算时区', () => {
    assert.equal(normalizeOccurredAt('2026-09-30T00:30:00+02:00', 'day'), '2026-09-30T12:00:00.000Z');
    assert.equal(normalizeOccurredAt('2026-09-30T12:00:00.000Z', 'day'), '2026-09-30T12:00:00.000Z');
  });
  it('minute 换成 UTC 的标准 ISO', () => {
    assert.equal(normalizeOccurredAt('2026-09-30T00:30:00+02:00', 'minute'), '2026-09-29T22:30:00.000Z');
  });
  it('认不出的一律 null（调用方报 400）', () => {
    for (const s of ['2026-02-30', 'yesterday', '2026-09-30garbage', '30/09/2026'])
      assert.equal(normalizeOccurredAt(s, 'day'), null, s);
    assert.equal(normalizeOccurredAt('2026-09-30', 'minute'), null); // minute 要带时间
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('写进来：项目类型', () => {
  it('新建：阶段 1–20 个，名字不能重复', () => {
    assert.deepEqual(sanitizeTypeCreate({ name: 'Dealer project', stages: [{ name: 'Quote' }] }).errors, []);
    assert.ok(sanitizeTypeCreate({ name: 'X', stages: [] }).errors.some((e) => e.startsWith('stages:')));
    assert.ok(
      sanitizeTypeCreate({ name: 'X', stages: Array.from({ length: 21 }, (_, i) => ({ name: `S${i}` })) }).errors.some((e) =>
        e.startsWith('stages:'),
      ),
    );
    assert.ok(
      sanitizeTypeCreate({ name: 'X', stages: [{ name: 'Quote' }, { name: 'quote' }] }).errors.some((e) => e.includes('duplicate')),
    );
    assert.ok(sanitizeTypeCreate({ name: 'X' }).errors.includes('stages: required'));
  });
  it('PATCH：nameZh 没给 = 不改，null / 空串 = 清空', () => {
    const live: LiveStage[] = [{ id: U(1), name: 'A', nameZh: '甲', stageKey: 'a', order: 1, isActive: true }];
    assert.deepEqual(planStages(live, sanitizeTypePatch({ stages: [{ id: U(1), name: 'A' }] }).value.stages!, []).update, []);
    assert.deepEqual(planStages(live, sanitizeTypePatch({ stages: [{ id: U(1), name: 'A', nameZh: null }] }).value.stages!, []).update, [
      { id: U(1), patch: { nameZh: '' } },
    ]);
  });
  it('PATCH：isActive 只收布尔，阶段可以带 id', () => {
    assert.ok(sanitizeTypePatch({ isActive: 'false' }).errors.some((e) => e.startsWith('isActive:')));
    const { value, errors } = sanitizeTypePatch({ stages: [{ id: U(5), name: 'Quote', nameZh: '报价' }] });
    assert.deepEqual(errors, []);
    assert.deepEqual(value.stages, [{ id: U(5), name: 'Quote', nameZh: '报价' }]);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('🔴 阶段增删计划（PATCH project-types 的 stages）', () => {
  const live: LiveStage[] = [
    { id: U(1), name: 'Contacted', nameZh: '已接触', stageKey: 'contacted', order: 1, isActive: true },
    { id: U(2), name: 'Sample Testing', nameZh: '样品测试', stageKey: 'sampleTesting', order: 2, isActive: true },
    { id: U(3), name: 'SOP', nameZh: 'SOP', stageKey: 'sop', order: 3, isActive: true },
    { id: U(4), name: 'Old', nameZh: '', stageKey: 'old', order: 4, isActive: false },
  ];

  it('有 id 改、无 id 建、漏掉的停用；顺序 = 清单下标 + 1', () => {
    const plan = planStages(
      live,
      [
        { id: U(2), name: 'Sample Testing' }, // 没给 nameZh = 不改
        { id: U(1), name: 'First Contact', nameZh: '已接触' },
        { name: 'Contacted' }, // 新建，名字的 key 和已有的撞 → contacted2
      ],
      [],
    );
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.update, [
      { id: U(2), patch: { stageOrder: 1 } },
      { id: U(1), patch: { name: 'First Contact', stageOrder: 2 } },
    ]);
    assert.deepEqual(plan.create, [{ name: 'Contacted', nameZh: '', stageKey: 'contacted2', stageOrder: 3 }]);
    assert.deepEqual(plan.deactivate, [U(3)]); // 已停用的 U(4) 不再停一次
    assert.deepEqual(plan.inUse, []);
  });

  it('清单里带上已停用阶段的 id = 请它回来', () => {
    const plan = planStages(live, [
      { id: U(1), name: 'Contacted', nameZh: '已接触' },
      { id: U(2), name: 'Sample Testing', nameZh: '样品测试' },
      { id: U(3), name: 'SOP', nameZh: 'SOP' },
      { id: U(4), name: 'Old', nameZh: '' },
    ], []);
    assert.deepEqual(plan.update, [{ id: U(4), patch: { isActive: true } }]);
    assert.deepEqual(plan.deactivate, []);
  });

  it('🔴 要停用的阶段正是某个项目的当前阶段 → inUse（整个 409 stage_in_use）', () => {
    const plan = planStages(
      live,
      [{ id: U(1), name: 'Contacted', nameZh: '已接触' }],
      [
        { id: U(10), name: 'Programme A', currentStageId: U(3) },
        { id: U(11), name: 'Programme B', currentStageId: U(1) }, // 留着的阶段，不算
      ],
    );
    assert.deepEqual(plan.inUse, [{ stageId: U(3), stageName: 'SOP', projects: [{ id: U(10), name: 'Programme A' }] }]);
  });

  it('别的类型的阶段 id、重复的 id → 报错，不猜', () => {
    const plan = planStages(live, [{ id: U(99), name: 'X', nameZh: '' }, { id: U(1), name: 'A', nameZh: '' }, { id: U(1), name: 'B', nameZh: '' }], []);
    assert.equal(plan.errors.length, 2);
  });
});

describe('代号生成', () => {
  it('typeCode：大写短横线，全库唯一；纯中文名 → TYPE', () => {
    assert.equal(typeCodeFor('Dealer project', []), 'DEALER-PROJECT');
    assert.equal(typeCodeFor('Dealer project', ['DEALER-PROJECT', 'dealer-project-2']), 'DEALER-PROJECT-3');
    assert.equal(typeCodeFor('经销商项目', [null]), 'TYPE');
  });
  it('stageKey：camelCase，类型内唯一；纯中文名 → stage', () => {
    assert.equal(stageKeyFor('Sample Testing', new Set()), 'sampleTesting');
    assert.equal(stageKeyFor('RFQ / Quote', new Set(['rfqQuote'])), 'rfqQuote2');
    assert.equal(stageKeyFor('样品', new Set()), 'stage');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('写出去：Twenty 请求体', () => {
  it('SELECT 写 UPPER_SNAKE（Twenty 拒 camelCase，实测 400）', () => {
    assert.equal(portalProjectBody({ status: 'onHold' }).projectStatus, 'ON_HOLD');
    const b = projectUpdateBody({ kind: 'stageChange', datePrecision: 'day' }, 'create');
    assert.equal(b.kind, 'STAGE_CHANGE');
    assert.equal(b.datePrecision, 'DAY');
  });

  it('create 不带空关系；PATCH 里 null = 清空', () => {
    assert.ok(!('stageId' in projectUpdateBody({ title: 't', stageId: null }, 'create')));
    assert.deepEqual(projectUpdateBody({ stageId: null, occurredAt: null, datePrecision: null }, 'patch'), {
      stageId: null,
      occurredAt: null,
      datePrecision: null,
    });
  });

  it('只放给了的字段（PATCH 里的空值会抹掉别人填的东西）', () => {
    assert.deepEqual(portalProjectBody({ name: 'N' }), { name: 'N' });
    assert.deepEqual(projectUpdateBody({ customerVisible: false }, 'patch'), { customerVisible: false });
    assert.deepEqual(projectTypeBody({}), {});
  });

  it('🔴 门户写不到速记管道那几列（projectStage / ownerTeam / budget …）', () => {
    const body = portalProjectBody({
      name: 'n', companyId: U(1), projectTypeId: U(2), currentStageId: U(3), status: 'done',
      portalVisible: true, customerSummary: 's', targetDate: null, projectCode: 'X-1',
      ...({ projectStage: 'SOP', ownerTeam: 'x', budget: 1 } as any),
    });
    for (const k of ['projectStage', 'ownerTeam', 'budget']) assert.ok(!(k in body), k);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('读出去：快照', () => {
  const raw = {
    companies: [
      { id: U(1), name: 'Brand B', accountCode: 'GRP-B', accountType: 'OEM_SUB_GROUP', hqCountry: 'DE' },
      { id: U(2), name: 'A consumer', accountCode: '', accountType: 'END_USER', hqCountry: '' }, // 没代号的也要
    ],
    projectTypes: [{ id: U(10), name: 'RV OEM Program', typeCode: 'OEM-PROGRAM', description: '', isActive: true }],
    stages: [
      { id: U(12), name: 'Sample Testing', nameZh: '样品', stageKey: 'sampleTesting', stageOrder: 2, isActive: true, projectTypeId: U(10) },
      { id: U(11), name: 'Contacted', nameZh: '已接触', stageKey: 'contacted', stageOrder: 1, isActive: null, projectTypeId: U(10) },
      { id: U(19), name: 'Orphan', stageOrder: 1, isActive: true, projectTypeId: U(99) },
    ],
    projects: [
      {
        id: U(20), name: 'Programme', projectCode: 'GRP-B-2026-001', companyId: U(1), projectTypeId: U(10),
        currentStageId: U(12), projectStage: 'VEHICLE_VALIDATION', projectStatus: 'ON_HOLD', portalVisible: true,
        customerSummary: '', targetDate: '2026-12-01', primaryProductName: '', ownerTeam: 'EU OE',
        createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
      },
    ],
    updates: [
      { id: U(30), projectId: U(20), stageId: null, kind: 'NOTE', name: 'old', occurredAt: null, datePrecision: null,
        customerVisible: null, customerMessage: '', createdAt: '2026-09-01T00:00:00.000Z' },
      { id: U(31), projectId: U(20), stageId: U(12), kind: 'STAGE_CHANGE', name: 'Stage: Sample Testing',
        occurredAt: '2026-09-20T08:00:00.000Z', datePrecision: 'MINUTE', customerVisible: true, customerMessage: '',
        authorName: 'admin', createdAt: '2026-09-20T08:00:01.000Z' },
    ],
  };
  const snap = buildSnapshot(raw, new Date('2026-09-30T10:00:00.000Z'));

  it('顶层五格，形状和契约逐键相同', () => {
    assert.deepEqual(Object.keys(snap), ['generatedAt', 'companies', 'projectTypes', 'projects', 'updates']);
    assert.equal(snap.generatedAt, '2026-09-30T10:00:00.000Z');
    assert.deepEqual(Object.keys(snap.companies[0]!), ['id', 'name', 'accountCode', 'accountType', 'hqCountry']);
    assert.deepEqual(Object.keys(snap.projectTypes[0]!), ['id', 'typeCode', 'name', 'description', 'isActive', 'stages']);
    assert.deepEqual(Object.keys(snap.projectTypes[0]!.stages[0]!), ['id', 'name', 'nameZh', 'stageKey', 'order', 'isActive']);
    assert.deepEqual(Object.keys(snap.projects[0]!), [
      'id', 'name', 'projectCode', 'companyId', 'projectTypeId', 'currentStageId', 'legacyStage', 'status', 'portalVisible',
      'customerSummary', 'targetDate', 'primaryProductName', 'ownerTeam', 'createdAt', 'updatedAt',
    ]);
    assert.deepEqual(Object.keys(snap.updates[0]!), [
      'id', 'projectId', 'stageId', 'kind', 'title', 'occurredAt', 'datePrecision', 'initiator', 'recipient', 'summary',
      'result', 'customerVisible', 'customerMessage', 'authorName', 'createdAt',
    ]);
  });

  it('SELECT 一律 camelCase；空串读成 null；没代号的客户也在', () => {
    assert.equal(snap.companies.length, 2);
    assert.equal(snap.companies.find((c) => c.id === U(1))!.accountType, 'oemSubGroup');
    assert.equal(snap.companies.find((c) => c.id === U(2))!.accountCode, null);
    const p = snap.projects[0]!;
    assert.equal(p.status, 'onHold');
    assert.equal(p.legacyStage, 'vehicleValidation');
    assert.equal(p.customerSummary, null);
    assert.equal(snap.updates[0]!.kind, 'stageChange');
    assert.equal(snap.updates[0]!.datePrecision, 'minute');
  });

  it('阶段嵌在自己的类型下、按 order 排；别的类型的阶段不混进来；isActive:null → false', () => {
    const st = snap.projectTypes[0]!.stages;
    assert.deepEqual(st.map((s) => s.id), [U(11), U(12)]);
    assert.equal(st[0]!.isActive, false);
  });

  it('进展新的在前（有时间按时间，没时间按建档时间）', () => {
    assert.deepEqual(snap.updates.map((u) => u.id), [U(31), U(30)]);
  });

  it('项目状态：空值 = active（schema 默认）；认不出的值 = cancelled（失败即关闭）', () => {
    assert.equal(statusOf(null), 'active');
    assert.equal(statusOf(''), 'active');
    assert.equal(statusOf('DONE'), 'done');
    assert.equal(statusOf('SOMETHING_NEW'), 'cancelled');
  });
});

describe('X-Portal-Actor', () => {
  it('去控制字符、截到上限；空的当没有', () => {
    assert.equal(actorName(' admin\n'), 'admin');
    assert.equal(actorName(''), null);
    assert.equal(actorName(undefined), null);
    assert.equal(actorName(['first', 'second']), 'first');
    assert.equal(actorName('a'.repeat(200))!.length, LIMITS.actor);
  });
});

// ═══════════════════════════════════════════════════════════════════
/**
 * 门户删进展走 `softDeleteRecords` → GraphQL。🔴 **Twenty 的 GraphQL 限流不是 429**：
 * HTTP 200 + `errors[].extensions.subCode = "LIMIT_REACHED"`（读 Twenty 源码确认，门户集成测试里真撞到过）。
 * 只认 429 的话，一次限流就变成「删除失败」→ 门户 502。这里桩掉 fetch，不碰网络。
 */
describe('GraphQL 限流（不是 429）要退避重试，不能当删除失败', () => {
  const withStub = async (replies: Array<() => Response>, fn: () => Promise<void>) => {
    const saved = { fetch: globalThis.fetch, url: process.env.SERVER_URL, key: process.env.TWENTY_API_KEY };
    process.env.SERVER_URL = 'http://twenty.stub';
    process.env.TWENTY_API_KEY = 'unit-not-a-key';
    let i = 0;
    globalThis.fetch = (async () => {
      const r = replies[Math.min(i, replies.length - 1)]!;
      i++;
      return r();
    }) as typeof fetch;
    try {
      await fn();
    } finally {
      globalThis.fetch = saved.fetch;
      if (saved.url === undefined) delete process.env.SERVER_URL;
      else process.env.SERVER_URL = saved.url;
      if (saved.key === undefined) delete process.env.TWENTY_API_KEY;
      else process.env.TWENTY_API_KEY = saved.key;
    }
    return i;
  };
  const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const LIMITED = json({ data: null, errors: [{ message: 'Limit reached (100 tokens per 60000 ms)', extensions: { subCode: 'LIMIT_REACHED', code: 'BAD_USER_INPUT' } }] });

  it('HTTP 200 + LIMIT_REACHED → 等一下再试，第二次成功就算删掉了', async () => {
    let out: Awaited<ReturnType<typeof softDeleteRecords>> | null = null;
    const calls = await withStub([LIMITED, json({ data: { deleteProjectUpdate: { id: U(1) } } })], async () => {
      out = await softDeleteRecords([{ object: 'projectUpdate', id: U(1) }]);
    });
    assert.equal(calls, 2);
    assert.deepEqual(out!.deleted.map((r) => r.id), [U(1)]);
    assert.deepEqual(out!.failed, []);
  });

  it('别的错误不重试，如实进 failed', async () => {
    let out: Awaited<ReturnType<typeof softDeleteRecords>> | null = null;
    const calls = await withStub([json({ data: null, errors: [{ message: 'boom', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] })], async () => {
      out = await softDeleteRecords([{ object: 'projectUpdate', id: U(2) }]);
    });
    assert.equal(calls, 1);
    assert.equal(out!.failed.length, 1);
  });
});
