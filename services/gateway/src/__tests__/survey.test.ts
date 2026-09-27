/**
 * 2C 问卷：答案怎么被收下、怎么落到 Twenty 的列上（D138）。
 *
 * 最要紧的是第一组 —— **三份选项清单对账**。PWA 能点、网关认、Twenty 有，
 * 三处任何一处少一个，后果都是静默的：点了、存了、上传成功了，CRM 里那一格是空的。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  OPTIONS,
  backoffSeconds,
  customerName,
  normalizeSurvey,
  surveyBody,
  toEnum,
} from '../survey.ts';
import { VDL_2026 } from '../../../../apps/capture-pwa/src/survey.ts';

// schema 是 .mjs、没有类型声明 —— 用变量路径动态导入，tsc 就不去解析它（按 any 处理）
const SCHEMA_PATH = '../../../../scripts/twenty-schema.mjs';
const {
  FIELDS,
  OBJECTS,
  SURVEY_APPLIANCES,
  SURVEY_BRAND_CHOOSER,
  SURVEY_EQUIPMENT,
  SURVEY_INSTALL,
  SURVEY_OVERNIGHT,
  toEnumValue,
}: any = await import(SCHEMA_PATH);

const values = (opts: Array<{ value: string }>) => opts.map((o) => o.value);
const pwa = (id: string) => {
  for (const q of VDL_2026) {
    if (q.id === id && 'options' in q) return q.options.map((o) => o.id);
    if (q.kind === 'single' && q.followUp?.id === id) return q.followUp.options.map((o) => o.id);
  }
  throw new Error(`PWA 里没有题目 ${id}`);
};

describe('三份选项清单逐个对账（PWA 题目 · 网关 · Twenty schema）', () => {
  const pairs: Array<[keyof typeof OPTIONS, Array<{ value: string }>]> = [
    ['equipment', SURVEY_EQUIPMENT],
    ['appliances', SURVEY_APPLIANCES],
    ['install', SURVEY_INSTALL],
    ['brand_chooser', SURVEY_BRAND_CHOOSER],
    ['overnight', SURVEY_OVERNIGHT],
  ];
  for (const [key, schema] of pairs)
    it(key, () => {
      assert.deepEqual([...OPTIONS[key]], pwa(key), 'PWA 和网关对不上');
      assert.deepEqual([...OPTIONS[key]], values(schema), '网关和 Twenty schema 对不上');
    });

  it('PWA 的每一道题网关都认（文字题也算）', () => {
    const handled = new Set([...Object.keys(OPTIONS), 'camping_pain', 'wish']);
    for (const q of VDL_2026) {
      assert.ok(handled.has(q.id), `网关不认第「${q.id}」题 —— 那一题的答案会被静默丢掉`);
      if (q.kind === 'single' && q.followUp) assert.ok(handled.has(q.followUp.id));
    }
  });

  it('网关算出来的枚举值和 provision 写进 Twenty 的一模一样', () => {
    for (const v of Object.values(OPTIONS).flat()) assert.equal(toEnum(v), toEnumValue(v));
  });

  it('surveyBody 会写的每一列，schema 里都有', () => {
    assert.ok(OBJECTS.some((o: { nameSingular: string }) => o.nameSingular === 'consumerSurvey'));
    const cols = new Set(FIELDS.consumerSurvey.map((f: { name: string }) => f.name));
    const body = surveyBody({
      answers: {
        equipment: ['solar'],
        appliances: { fridge: 'have', ac: 'want' },
        install: 'pro',
        brand_chooser: 'me',
        overnight: ['aire'],
        camping_pain: 'x',
        wish: 'y',
      },
      contact: { name: 'Jean', email: 'j@x.fr', phone: '06', postcode: '75001' },
      consentAt: '2026-09-27T10:00:00.000Z',
      clientId: 'abcd1234-0000-4000-8000-000000000000',
      eventName: 'VDL 2026',
      surveyedAt: '2026-09-27T10:00:00.000Z',
    });
    for (const k of Object.keys(body)) if (k !== 'name') assert.ok(cols.has(k), `schema 里没有 ${k}`);
  });
});

describe('normalizeSurvey', () => {
  it('🔴 有姓名/电话/邮箱就必须有同意时间 —— 挡在服务端', () => {
    for (const contact of [{ name: 'Jean' }, { email: 'j@x.fr' }, { phone: '0612' }])
      assert.deepEqual(normalizeSurvey({ answers: { wish: 'x' }, contact }), { error: 'consent_required' });
  });

  it('只有邮编不要求同意；同意时间只在有可识别信息时才留', () => {
    const r = normalizeSurvey({ answers: {}, contact: { postcode: '75001' }, consentAt: '2026-09-27T10:00:00Z' });
    assert.ok('ok' in r);
    assert.equal(r.ok.consentAt, null);
    assert.deepEqual(r.ok.contact, { postcode: '75001' });
  });

  it('什么都没有就不收', () => {
    assert.deepEqual(normalizeSurvey({ answers: { wish: '   ' }, contact: { name: ' ' } }), { error: 'empty' });
  });

  it('不认识的选项、题目、状态一律丢掉；「都没有」和具体设备同时来只信具体的', () => {
    const r = normalizeSurvey({
      answers: {
        equipment: ['solar', 'none', 'nuclear', 'solar'],
        appliances: { fridge: 'have', jacuzzi: 'want', tv: 'maybe' },
        install: 'robot',
        overnight: 'camping',
        hacker: 'drop table',
      },
      contact: {},
    });
    assert.ok('ok' in r);
    assert.deepEqual(r.ok.answers, { equipment: ['solar'], appliances: { fridge: 'have' } });
  });

  it('文字去首尾空白、有上限', () => {
    const r = normalizeSurvey({ answers: { wish: `  ${'a'.repeat(3000)}  ` }, contact: {} });
    assert.ok('ok' in r);
    assert.equal((r.ok.answers.wish as string).length, 2000);
  });
});

describe('surveyBody', () => {
  const base = {
    contact: {},
    consentAt: null,
    clientId: '3f2a9c00-0000-4000-8000-000000000000',
    eventName: 'VDL 2026',
    surveyedAt: '2026-09-27T10:00:00.000Z',
  };

  it('在用/想加拆成两列，选项转成 Twenty 的枚举写法', () => {
    const b = surveyBody({
      ...base,
      answers: { equipment: ['dcdc'], appliances: { ebike: 'want', fridge: 'have', ac: 'want' }, install: 'diy' },
    });
    assert.deepEqual(b.equipment, ['DCDC']);
    assert.deepEqual(b.appliancesInUse, ['FRIDGE']);
    assert.deepEqual(b.appliancesWanted, ['EBIKE', 'AC']);
    assert.equal(b.installPreference, 'DIY');
  });

  it('没答的单选和文字不发，联系方式没有就不发', () => {
    const b = surveyBody({ ...base, answers: { equipment: ['solar'] } });
    for (const k of ['installPreference', 'brandChooser', 'campingPain', 'wish', 'contactEmail', 'consentAt'])
      assert.ok(!(k in b), k);
  });

  it('匿名的客户名 = 展会 + id 前 4 位；记录名不重复展会名', () => {
    assert.equal(customerName({}, 'VDL 2026', base.clientId), 'VDL 2026 · #3F2A');
    assert.equal(surveyBody({ ...base, answers: { wish: 'x' } }).name, 'VDL 2026 · #3F2A');
    assert.equal(
      surveyBody({ ...base, contact: { name: 'Jean Dupont' }, answers: { wish: 'x' } }).name,
      'VDL 2026 · Jean Dupont',
    );
    assert.equal(customerName({ name: 'Jean Dupont' }, 'VDL 2026', base.clientId), 'Jean Dupont');
  });
});

describe('backoffSeconds', () => {
  it('30 秒起翻倍，封顶 1 小时', () => {
    assert.deepEqual([1, 2, 3, 4].map(backoffSeconds), [30, 60, 120, 240]);
    assert.equal(backoffSeconds(50), 3600);
  });
});
