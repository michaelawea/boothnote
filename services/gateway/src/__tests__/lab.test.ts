import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 实验室 agent · 纯逻辑单元测试（零依赖，不碰库不碰网不碰模型）。
 *
 * 守住的两件事：
 *   ① **能力边界** —— 它只许有 `read_skill` 一个工具（Ring 3 那条纪律的第二个实例）
 *   ② 会话窗口是滑动的，以及回答为空时也要给人一句话
 */
process.env.LAB_SESSION_WINDOW_MIN = '30';
// 共享链接配上，fetch_document 才会被注册（能力靠注册，不靠运行时 if）
process.env.PRODUCT_DOCS_SHARE_URL = 'https://contoso.sharepoint.com/:f:/s/x/unit-test-placeholder';
process.env.LAB_PRICING_GROUPS = 'Boothnote 项目群, 销售内部群';

const { LAB_TOOL_NAMES, labTools, labSystemPrompt } = await import('../../agent/src/lab.ts');
const { FORBIDDEN_TOOL_NAMES } = await import('../../agent/src/tools/index.ts');
const { shouldContinue, renderLabReply } = await import('../channels/lab.ts');
const { resolveDoc, searchDocs, searchRefs, pricingAllowed, loadManifest } = await import(
  '../../agent/src/lab-products.ts'
);
const { buildDocUrl } = await import('../../agent/src/lab-sharepoint.ts');

describe('🔴 能力边界：工具清单逐字对账', () => {
  it('配齐时正好四个，一个不多', () => {
    assert.deepEqual([...LAB_TOOL_NAMES], ['read_skill', 'search_specs', 'find_document', 'fetch_document']);
    assert.deepEqual(labTools().map((t) => t.name), [...LAB_TOOL_NAMES]);
  });

  it('🔴 一个能写 CRM 的都没有（和录入 agent 共用同一份禁用名单）', () => {
    const names = new Set(labTools().map((t) => t.name));
    for (const forbidden of FORBIDDEN_TOOL_NAMES) {
      assert.equal(names.has(forbidden), false, `实验室 agent 不许有 ${forbidden}`);
    }
    // 顺带把「悄悄多挂一个工具」也挡住 —— 加工具是发版动作，要有人在 PR 里看见
    assert.equal(names.size, 4);
  });

  it('🔴 除了 fetch_document，没有第二个碰网的工具', () => {
    // 这三个的实现都只读本地文件；真会发 HTTP 的只有 fetch_document 一个入口
    assert.deepEqual(
      labTools().map((t) => t.name).filter((n) => n !== 'fetch_document'),
      ['read_skill', 'search_specs', 'find_document'],
    );
  });

  it('read_skill 现在能读到 example-products 那本（skill 已装上）', async () => {
    const { labPlaybooks } = await import('../../agent/src/skills.ts');
    await labPlaybooks.load();
    assert.ok(labPlaybooks.names().includes('example-products'), '装好的 skill 要能被加载到');
    const [tool] = labTools();
    const r = await tool!.execute({ name: 'example-products' });
    assert.match(r.text, /Example Product Expert/);
    assert.match(r.text, /VPH/, 'SKILL.md 里的业务判据要原样在');
  });
});

describe('🔴 下载路径闸门：模型给的路径必须在 manifest 里对上号', () => {
  it('索引本身装好了（24 个文件 / 6 个 SKU）', async () => {
    const m = await loadManifest();
    assert.equal(m.counts.files, 24);
    assert.equal(m.counts.skus, 6);
  });

  it('规范路径和物理路径都认', async () => {
    const m = await loadManifest();
    const one = m.files.find((f) => f.doctype === 'Datasheet')!;
    assert.equal(resolveDoc(one.path, m.files)?.name, one.name);
    assert.equal(resolveDoc(one.actual_path, m.files)?.name, one.name);
    assert.equal(resolveDoc(`/${one.path}`, m.files)?.name, one.name, '前导斜杠要容忍');
  });

  it('🔴 目录穿越 / 别的库 / 前缀猜测，一律拒', async () => {
    const m = await loadManifest();
    for (const bad of [
      '../../../etc/passwd',
      'Datasheet/../../Shared Documents/HR/salaries.xlsx',
      'Datasheet/',
      'Datasheet',
      '',
      'https://evil.example.com/x.pdf',
      `${m.files[0]!.path}.bak`,
    ]) {
      assert.equal(resolveDoc(bad, m.files), null, `必须拒绝：${bad}`);
    }
  });

  it('🔴 拼出来的地址只能落在那一个库底下，且逐段编码', () => {
    const url = buildDocUrl('01-Datasheet/IoT_Smart/VLHCP-C02W01-G1-DE/EN/a b.pdf');
    assert.ok(
      url.startsWith(
        'https://contoso.sharepoint.com/sites/Products/Shared%20Documents/',
      ),
    );
    assert.match(url, /a%20b\.pdf\?download=1$/);
    assert.doesNotMatch(url, /%2F/, '路径分隔符不能被编码掉');
    for (const bad of ['../x', 'a/../../b', '']) assert.throws(() => buildDocUrl(bad), /非法路径|路径越界/);
  });

  it('manifest 搜索：按 SKU 命中、按类型过滤、有上限', async () => {
    const m = await loadManifest();
    const sku = m.skus[0]!;
    const all = searchDocs(m.files, sku);
    assert.ok(all.length > 0);
    assert.ok(all.every((h) => `${h.path} ${h.name} ${h.sku}`.includes(sku)));
    const ds = searchDocs(m.files, sku, 'Datasheet');
    assert.ok(ds.every((h) => h.doctype === 'Datasheet'));
    assert.ok(searchDocs(m.files, sku, undefined, 3).length <= 3);
    assert.deepEqual(searchDocs(m.files, ''), []);
  });
});

describe('定价：默认全开，`LAB_PRICING_GROUPS` 是收窄开关（维护者 2026-08-17）', () => {
  it('配了名单 → 只有名单里的群能问', () => {
    // 本文件顶部把 LAB_PRICING_GROUPS 设成了两个群
    assert.equal(pricingAllowed('Boothnote 项目群'), true);
    assert.equal(pricingAllowed('销售内部群'), true, '逗号后的空格要容忍');
    assert.equal(pricingAllowed('随便一个群'), false);
  });
  it('🔴 留空 = 所有群都能问（钉钉群都是内部的，不存在泄漏）', async () => {
    // 单独起一个进程验「不配」那条路 —— env 在模块加载时求值，同进程改不了
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(
      process.execPath,
      ['-e', "const {pricingAllowed}=await import('./agent/src/lab-products.ts');console.log(JSON.stringify([pricingAllowed('随便一个群'),pricingAllowed(''),pricingAllowed(null)]))"],
      { env: { ...process.env, LAB_PRICING_GROUPS: '' }, encoding: 'utf8' },
    );
    assert.deepEqual(JSON.parse(out.trim().split('\n').pop()!), [true, true, true]);
  });
});

describe('参考资料搜索', () => {
  it('返回命中行及其上下文，带出处和行号', () => {
    const refs = [{ name: 'inverters', text: 'a\nb\nVLI1220PCH 2000W\nd\ne' }];
    const hits = searchRefs(refs, 'VLI1220PCH');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.name, 'inverters');
    assert.equal(hits[0]!.line, 3);
    assert.match(hits[0]!.block, /2000W/);
  });
  it('命中太多时有上限，空关键词返回空', () => {
    const refs = [{ name: 'x', text: Array.from({ length: 500 }, () => 'VLB12100LFP').join('\n') }];
    assert.ok(searchRefs(refs, 'VLB12100LFP', 5).length <= 5);
    assert.deepEqual(searchRefs(refs, ''), []);
  });
  it('真资料里搜得到东西（3 份 markdown 已装上）', async () => {
    const tool = labTools().find((t) => t.name === 'search_specs')!;
    const r = await tool.execute({ query: 'VLC2430LINK' });
    assert.match(r.text, /VLC2430LINK/);
  });

  it('🔴 一整句自然语言也要搜得到 —— 2026-08-17 实测漏检的那一条', () => {
    // 模型当时给的就是这一整串，原来的整串子串匹配一条都搜不到，
    // 于是 agent 得出「资料无法确认」——而手册其实躺在文档库里
    const refs = [{ name: 'batteries', text: 'x\ny\nVLB12100LFP-BT (ToB) 12.8V 100Ah BMS\nz' }];
    const q = 'VLB12100LFP-M 报错 错误提示 报警 BMS 故障指示 Bluetooth APP LED manual';
    assert.ok(searchRefs(refs, q).length > 0, '长问句必须还能命中');
  });

  it('🔴 长问句在文档索引里也要能找到那个 SKU 的手册（同一次漏检的另一半）', async () => {
    const m = await loadManifest();
    const q = 'VLB12100LFP-M 报错 错误提示 报警 BMS 故障指示';
    const hits = searchDocs(m.files, q, 'UM');
    assert.ok(hits.length > 0, '按整句也要找得到 UM');
    assert.ok(hits.some((h) => h.sku.startsWith('VLB12100LFP')), `找到的是：${hits.map((h) => h.sku).join(',')}`);
  });

  it('命中词多的排前面', () => {
    const refs = [
      { name: 'a', text: '只提到 BMS' },
      { name: 'b', text: 'VLB12100LFP 带 BMS 保护' },
    ];
    const hits = searchRefs(refs, 'VLB12100LFP BMS');
    assert.equal(hits[0]!.name, 'b', '两个词都命中的要排第一');
  });
});

describe('🔴 模型与思考档位（D125）', () => {
  it('档位字符串校验：认识的收下，不认识的当没设', async () => {
    const { keepThinking } = await import('../../agent/src/lab.ts');
    for (const v of ['high', 'HIGH', ' high ', 'low', 'max']) assert.ok(keepThinking(v));
    for (const v of ['', null, undefined, 'thinking-high', '高']) assert.equal(keepThinking(v), undefined);
  });

  it('🔴 真的把 reasoning 传下去了 —— 配置写了不等于发出去了', async () => {
    const { runLabAgent } = await import('../../agent/src/lab.ts');
    let seen: unknown = 'ᴺᴼᵀ_ᶜᴬᴸᴸᴱᴰ';
    // 假绑定：只记下 runAgent 递给 streamFn 的 options，不发任何请求
    const binding = {
      model: { id: 'faux', name: 'faux', api: 'openai-responses', provider: 'faux', baseUrl: '', reasoning: true, input: ['text'], cost: {}, contextWindow: 1, maxTokens: 1 },
      streamFn: (_m: unknown, _c: unknown, opts: { reasoning?: string }) => {
        seen = opts?.reasoning;
        throw new Error('faux-stop');
      },
    } as never;
    await runLabAgent({ prompt: 'x', sessionId: `t-${Date.now()}`, binding }).catch(() => {});
    assert.equal(seen, 'high', `发出去的档位是 ${String(seen)}`);
  });
});

describe('系统提示词', () => {
  it('🔴 必须写明「我不负责录入」—— 群里有两个 bot，说错对象等于那句话白说了', () => {
    const p = labSystemPrompt();
    assert.match(p, /不负责录入/);
    assert.match(p, /速记/);
    assert.match(p, /不要假装已经记下了/);
  });

  it('底座刻意短 —— 具体打法交给 SKILL.md（长的是技能索引，不是底座）', () => {
    const base = labSystemPrompt().split('The following skills')[0]!;
    assert.ok(base.split('\n').length < 12, `底座 ${base.split('\n').length} 行，太长了`);
  });

  it('🔴 渐进披露：装上的 skill 只在提示词里露一行索引，全文靠 read_skill 拉', async () => {
    const { labPlaybooks } = await import('../../agent/src/skills.ts');
    await labPlaybooks.load();
    const p = labSystemPrompt();
    assert.match(p, /<available_skills>/);
    assert.match(p, /example-products/);
    // 索引里只有 name + description，SKILL.md 的正文不许整个塞进来
    assert.doesNotMatch(p, /VPH N-G bonding pitfall/);
  });
});

describe('会话窗口：滑动，不是固定时间桶', () => {
  const now = new Date('2026-08-17T10:00:00Z');
  const minAgo = (n: number) => new Date(now.getTime() - n * 60_000);

  it('没有历史 → 新开', () => {
    assert.equal(shouldContinue(null, now, 30), false);
  });
  it('29 分钟前说过 → 沿用', () => {
    assert.equal(shouldContinue(minAgo(29), now, 30), true);
  });
  it('31 分钟前说过 → 重开', () => {
    assert.equal(shouldContinue(minAgo(31), now, 30), false);
  });
  it('窗口从**最后一条**起算 —— 连着聊两小时也不会被拦腰切断', () => {
    // 每 10 分钟一条，走 12 轮：每一轮相对上一条都在窗口内
    let last = minAgo(120);
    for (let i = 11; i >= 0; i--) {
      const at = minAgo(i * 10);
      assert.equal(shouldContinue(last, at, 30), true, `第 ${12 - i} 轮`);
      last = at;
    }
  });
});

describe('回答渲染：空回答也要给人一句话', () => {
  it('正常回答原样发，并 @ 提问的人', () => {
    const m = renderLabReply('MOQ 是 20 台。', 'u1', null, 'done');
    // 🔴 @ 是正文里那个串 + at 列表两样都要有：只放 at 列表的话钉钉不会真 @ 人（§2.52⑥）
    assert.equal(m.markdown!.text, 'MOQ 是 20 台。\n\n@u1');
    assert.deepEqual(m.at, { atUserIds: ['u1'], isAtAll: false });
  });
  it('超时/步数用尽 → 说人话，并给下一步', () => {
    for (const r of ['timeout', 'max_steps']) {
      assert.match(renderLabReply('', 'u1', null, r).markdown!.text, /想太久|换个更具体/);
    }
  });
  it('🔴 出错也要回一条消息 —— 群里一片静默最糟', () => {
    const t = renderLabReply('', 'u1', 'provider 400', 'error').markdown!.text;
    assert.match(t, /没答上来/);
    assert.match(t, /provider 400/);
  });
});
