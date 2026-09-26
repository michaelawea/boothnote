import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { findSimilar, nameKeys, similarity } from '../match.ts';

/**
 * 查重。**这一组用例全部来自销售那份 Excel 里真发生过的分裂** ——
 * 不是想象出来的边界情况。品牌名单三份文件的交集只有 32/61，
 * 集团名的三份交集是 0，散架的形态就是下面这些。
 *
 * 六个必须有的测试之⑤。
 */

const COMPANIES = [
  { code: 'BRUECKNER', name: 'Brückner GmbH & Co. KG' },
  { code: 'HERON', name: 'Heron-Wohnwagenwerk' },
  { code: 'ALPIN', name: 'Alpin Tannhof AG' },
  { code: 'ROSENFELD', name: 'Rosenfeld' },
  { code: 'ISTRA', name: 'Istra Mobil' },
];

describe('规范形', () => {
  it('变音符两种折叠都要（ü→u 和 ü→ue，德语两种写法都真实存在）', () => {
    const k = nameKeys('Brückner');
    assert.ok(k.includes('bruckner'), `缺 bruckner：${k.join(',')}`);
    assert.ok(k.includes('brueckner'), `缺 brueckner：${k.join(',')}`);
  });

  it('法律后缀不参与匹配', () => {
    assert.ok(nameKeys('Alpin Tannhof AG').includes('alpintannhof'));
  });
});

describe('相似度', () => {
  it('Brückner / Bruckner / Brueckner 是同一家', () => {
    assert.equal(similarity('Brückner', 'Bruckner'), 1);
    assert.equal(similarity('Brückner', 'Brueckner'), 1);
    assert.equal(similarity('BRUCKNER', 'brückner'), 1);
  });

  it("'Heron ' 和 Heron 是同一家（引号和空格）", () => {
    assert.equal(similarity("'Heron '", 'Heron'), 1);
  });

  it('大小写与法律后缀不构成差异', () => {
    assert.equal(similarity('ALPIN TANNHOF AG', 'Alpin Tannhof'), 1);
  });

  it('不相干的两家不会被判成同一家', () => {
    assert.ok(similarity('Istra Mobil', 'Alpin Tannhof') < 0.5);
    assert.ok(similarity('Rosenfeld', 'Heron') < 0.5);
  });

  it('🐛 回归：行业通用词按「词」去掉，不是按子串', () => {
    // 按子串去 "mobil" 会把 VANTAmobil 切成 VARIO（一个品牌名被切没了）；
    // 完全不去又会让 Istra Mobil 和 Orba Mobil 相似度 0.70 被误判成同一家。
    // 这三条一起才把两头都摁住 —— 对着真实的 56 家名单跑，误命中从 3 组降到 0 组。
    assert.ok(similarity('Istra Mobil', 'Orba Mobil') < 0.66, '同名后缀不构成同一家');
    assert.ok(similarity('Istra Mobil', 'VANTAmobil') < 0.66);
    assert.equal(similarity('Istra Mobil', 'Istra'), 1, '父子对必须还认得出来');
  });

  it('集团与旗下品牌互相认得（这些本来就该命中）', () => {
    assert.ok(similarity('Erwin Havel Group (Thor)', 'Havel') >= 0.9);
    assert.ok(similarity('Alpin Tannhof', 'Alpin') >= 0.9);
    assert.ok(similarity('Castella Group', 'Castella') >= 0.9);
  });
});

describe('findSimilar', () => {
  it('语音转写听错的品牌名能捞回来（Rozenfelt → Rosenfeld）', () => {
    const hits = findSimilar('Rozenfelt', COMPANIES);
    assert.equal(hits[0]?.item.code, 'ROSENFELD', JSON.stringify(hits));
  });

  it('只报代号也能找到', () => {
    assert.equal(findSimilar('ALPIN', COMPANIES)[0]?.item.code, 'ALPIN');
  });

  it('部分名字能命中（Alpin → Alpin Tannhof AG）', () => {
    assert.equal(findSimilar('Alpin Tannhof', COMPANIES)[0]?.item.code, 'ALPIN');
  });

  it('空查询不返回任何东西 —— 不能让「没填名字」变成「匹配所有人」', () => {
    assert.deepEqual(findSimilar('', COMPANIES), []);
    assert.deepEqual(findSimilar('   ', COMPANIES), []);
  });

  it('完全没关系的名字返回空（该新建就新建）', () => {
    assert.deepEqual(findSimilar('Zhengzhou Yutong Bus', COMPANIES), []);
  });
});
