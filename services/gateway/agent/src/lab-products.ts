import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Type } from '@earendil-works/pi-ai';

import { env } from './host.ts';
import { fetchDocument } from './lab-sharepoint.ts';
import type { Skill } from './runtime.ts';

/**
 * 产品知识 skill 的工具实现（T95 · D124）。
 *
 * 原包是给「有 bash + python + 文件系统」的宿主 agent 写的（`voltline_sp.sh` →
 * `sp_client.py` → MSAL 委托令牌）。实验室 agent 什么都没有，**也不该有** ——
 * 所以这里把它需要的三件事重新实现成三个窄口径工具：
 *
 *   · `search_specs`    —— 搜本地 markdown（纯本地，不碰网）
 *   · `find_document`   —— 查本地 manifest（纯本地，不碰网）
 *   · `fetch_document`  —— 唯一碰网的一个，走匿名共享链接，见 `lab-sharepoint.ts`
 *
 * 🔴 **一个 Microsoft 凭据都没有。** 原包里那套是 维护者 本人账号的**委托令牌**
 * （已授权 scope 含 `mail.send` / `sites.readwrite.all` / `files.readwrite.all`），
 * 放上服务器就意味着「这个 bot 理论上能用他的身份发邮件」。
 * 2026-08-17 实测证明匿名共享链接够用（详见 `docs/lab-agent.md`），
 * 于是那套凭据一个字节都没进这个仓库。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'skills-lab', 'example-products', 'data');
const REF_DIR = join(DATA, 'references');

// ── manifest ───────────────────────────────────────────────────────
export type DocEntry = {
  /** 对外的规范路径（`Datasheet/…`）。 */
  path: string;
  /** SharePoint 上的物理路径（`01-Datasheet/…`）—— 下载用这个。 */
  actual_path: string;
  name: string;
  doctype: string;
  category: string;
  sku: string;
  size: number;
  modified: string;
};
export type Manifest = { counts: { files: number; skus: number }; doctypes: string[]; skus: string[]; files: DocEntry[] };

let manifestCache: Manifest | null = null;
export const loadManifest = async (): Promise<Manifest> => {
  if (manifestCache) return manifestCache;
  manifestCache = JSON.parse(await readFile(join(DATA, 'manifest.json'), 'utf8')) as Manifest;
  return manifestCache;
};
export const __resetProducts = (): void => {
  manifestCache = null;
  refCache = null;
};

/**
 * 🔴 **模型给的路径必须能在 manifest 里对上号，否则一律拒。**（纯函数，有变异测试）
 *
 * 这是整条链路上最重要的一道闸门：下载地址是拼出来的，而拼进去的那一段来自模型。
 * 不校验的话 `../../` 或者随便一个别的库的路径都会被原样拼进 URL —— 那时挡在
 * 前面的就只剩 SharePoint 自己的权限了，而匿名共享链接对整个 collection 是开的。
 *
 * 对上号的判据是「**逐字等于** manifest 里的 `path` 或 `actual_path`」——
 * 不做前缀匹配、不做规范化后再比：任何「聪明一点」的匹配都会给绕过留缝。
 */
export const resolveDoc = (input: string, files: DocEntry[]): DocEntry | null => {
  const want = String(input ?? '').trim().replace(/^\/+/, '');
  if (!want) return null;
  return files.find((f) => f.path === want || f.actual_path === want) ?? null;
};

/**
 * 查询词切分。**纯函数。**
 *
 * 🔴 2026-08-17 实测逼出来的：模型问「这块电池报错了怎么知道」时，
 * 给 `search_specs` 的是一整句
 * 「VLB12100LFP-M 报错 错误提示 报警 BMS 故障指示 Bluetooth APP LED manual」。
 * 原来是**整串子串匹配**，当然一条都搜不到 —— 而资料里其实有这个 SKU 的手册。
 * 于是 agent 得出「资料无法确认」，**一次漏检伪装成了「没有数据」**。
 *
 * 所以切成词、按命中词数排序。单个词的行为和原来一样。
 */
export const tokenize = (q: string): string[] => {
  const raw = String(q ?? '')
    .toLowerCase()
    .split(/[\s,，、;；:：/|"'`?？!！()（）\[\]]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  return [...new Set(raw)];
};

/** 这一行命中了几个词。**纯函数。** */
export const scoreLine = (hay: string, tokens: string[]): number => {
  const h = hay.toLowerCase();
  let n = 0;
  for (const t of tokens) if (h.includes(t)) n++;
  return n;
};

/** manifest 搜索。SKU / 路径 / 文件名任意命中即可，按 doctype 过滤，命中词多的排前面。**纯函数。** */
export const searchDocs = (
  files: DocEntry[],
  q: string,
  type?: string | null,
  limit = 20,
): DocEntry[] => {
  const tokens = tokenize(q);
  if (!tokens.length) return [];
  const t = String(type ?? '').trim().toLowerCase();
  const scored: Array<{ f: DocEntry; s: number }> = [];
  for (const f of files) {
    if (t && f.doctype.toLowerCase() !== t) continue;
    const s = scoreLine(`${f.path} ${f.name} ${f.sku}`, tokens);
    if (s > 0) scored.push({ f, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.f);
};

const human = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`);

// ── references ─────────────────────────────────────────────────────
let refCache: Map<string, string> | null = null;

/**
 * 参考资料。**定价那份刻意不在仓库里**（`PRODUCT_PRICING_FILE` 指到服务器上的一份，
 * 不配就没有）—— EU 分销价是 FOB/DDP/MSRP，进了 git 历史就永远在里面了，
 * 而 维护者 2026-08-17 说这个 skill「说不定还可以完全公开」。
 */
const loadRefs = async (): Promise<Map<string, string>> => {
  if (refCache) return refCache;
  const m = new Map<string, string>();
  for (const f of await readdir(REF_DIR)) {
    if (f.endsWith('.md')) m.set(f.replace(/\.md$/, ''), await readFile(join(REF_DIR, f), 'utf8'));
  }
  if (env.productPricingFile) {
    try {
      m.set('pricing-eu-distri', await readFile(env.productPricingFile, 'utf8'));
    } catch (e) {
      console.warn(`  🟠 定价参考读不到（${env.productPricingFile}）：${(e as Error).message.slice(0, 120)}`);
    }
  }
  refCache = m;
  return m;
};

/**
 * 这个群能不能问定价。**默认能**（维护者 2026-08-17：钉钉群都是内部的）。
 *
 * `LAB_PRICING_GROUPS` 是一道**收窄**开关：留空 = 全开；填了 = 只有列出的群能问。
 * ⚠️ 我第一版做成了「不配就一个群都不给」——那是我自己加的保守假设，
 * 被他明确推翻。留着这个开关只为「哪天群里进了外部人」能一行收窄。
 */
export const pricingAllowed = (conversationKey: string | null | undefined): boolean => {
  const list = env.labPricingGroups
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length) return true; // 没收窄 = 全开
  return list.includes(String(conversationKey ?? '').trim());
};

/** 在若干份 markdown 里按关键词捞段落。**纯函数**，有长度上限。 */
export const searchRefs = (
  refs: Array<{ name: string; text: string }>,
  q: string,
  maxHits = 12,
): Array<{ name: string; line: number; block: string }> => {
  const tokens = tokenize(q);
  if (!tokens.length) return [];
  const scored: Array<{ name: string; line: number; block: string; s: number }> = [];
  for (const r of refs) {
    const lines = r.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const s = scoreLine(lines[i]!, tokens);
      if (!s) continue;
      /**
       * 🔴 **取整条记录，不是命中行前后两行**（2026-08-17 实测逼出来的第二个洞）。
       *
       * 定价那份是「一个产品一个 ~20 行的块」：`**Model:**` 在上面，
       * `**Distri FOB (EUR):**` 在**六行之后**。原来的 ±2 行窗口正好把价格切在外面 ——
       * 于是定价明明开着、SKU 也搜到了，agent 还是回「价格资料未显示」。
       * 现在往后展开到下一个标题为止（上限 20 行 / 1200 字），
       * 宽表那种一行到底的也不会被撑爆（字符上限兜着）。
       */
      const from = Math.max(0, i - 3);
      let to = i + 1;
      while (to < lines.length && to - i < 20 && !/^#{1,6}\s/.test(lines[to]!)) to++;
      const block = lines.slice(from, to).join('\n').slice(0, 1200);
      scored.push({ name: r.name, line: i + 1, block, s });
      i = to - 1; // 同一块里的其它命中不重复出块
    }
  }
  // 命中词多的排前面 —— 一句长问句里，同时命中「VLB12100LFP」和「BMS」的那行才是想要的
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, maxHits).map(({ name, line, block }) => ({ name, line, block }));
};

// ── 出处核对（2026-08-17 实测逼出来的，最重要的一道）────────────────
/**
 * 🔴 **它会编数字，而且挂在「手册说」名下。**
 *
 * 实测：问「VLB12100LFP-M 报错了怎么知道」，agent 正确地找到并下载了那本用户手册，
 * 然后回答「**手册列出的关键阈值包括** 欠压警告 12.0V、关断 10.0V、恢复 12.6V、
 * 过压关断 15.0V、恢复 14.2V」—— 而那本手册是**纯德语**的，
 * 里面**一个阈值都没有**（只写了 BMS 提供保护）。五个数字全是编的。
 *
 * 这是这个 skill 最贵的失败形态：数字精确、有出处、看起来完全可信，
 * 而销售会直接把它报给客户。**光靠 prompt 里写「不要编」挡不住** ——
 * 所以这里做一道机器核对：答案里凡是「挂在文档名下的规格数字」，
 * 逐个回到检索到的原文里找；找不到的**如实说出来**。
 *
 * ⚠️ 只在答案自称有文档出处时才查 —— 否则「6 块电池 = 15.36kWh」这种
 * 推算出来的数会被误报，一条天天误报的警告等于没有警告。
 */
/**
 * 只认**指名道姓引用某份文档**的说法。
 *
 * ⚠️ 第一版还收了「资料 / 文档 / 列出」这类泛称，结果把
 * 「24V 600Ah ≈ 15.36kWh」这种**用户自己给的数 + 算出来的数**也点名了 ——
 * 一条天天误报的警告等于没有警告，人两天就学会无视它。
 */
const CITES = /(手册|说明书|manual|datasheet|规格书|user\s*guide)/i;
const SPEC_NUM = /\d+(?:[.,]\d+)?\s*(?:V|A|Ah|W|Wh|kWh|°C|℃)\b/gi;
const normNum = (s: string) => s.replace(/\s+/g, '').replace(',', '.').toLowerCase();

/** 答案里有几个「自称来自文档」的数字在原文里找不到。**纯函数。** */
export const ungroundedNumbers = (answer: string, evidence: string): string[] => {
  if (!CITES.test(String(answer ?? ''))) return [];
  const hay = normNum(String(evidence ?? ''));
  if (!hay) return [];
  const out: string[] = [];
  for (const m of String(answer).matchAll(SPEC_NUM)) {
    const n = normNum(m[0]);
    if (!hay.includes(n) && !out.includes(m[0].trim())) out.push(m[0].trim());
  }
  return out;
};

/** 要不要在回答后面补一句警告。**纯函数。** */
export const groundingWarning = (answer: string, evidence: string): string | null => {
  const bad = ungroundedNumbers(answer, evidence);
  if (!bad.length) return null;
  return (
    `\n\n⚠️ **这几个数字我没能在查到的文档里逐字对上：${bad.slice(0, 6).join('、')}** —— ` +
    `可能是推算或记错的，**别直接报给客户**，请以官方文档为准。`
  );
};

// ── 工具定义 ────────────────────────────────────────────────────────
export type ProductContext = {
  conversationKey?: string | null;
  sender?: string | null;
  /** 这一轮工具交出去的原文，收在这里供跑完之后做出处核对。 */
  evidence?: string[];
};

export const productTools = (ctx: ProductContext = {}): Skill[] => {
  const tools: Skill[] = [
    {
      name: 'search_specs',
      label: '查产品资料',
      description:
        'Search the Voltline product knowledge base (catalog, batteries, solar panels, inverters, ' +
        'charge controllers, chargers, IoT, accessories, certifications, document index). ' +
        'Use this FIRST for any spec / selection / certification question. Returns matching excerpts.',
      parameters: Type.Object({
        query: Type.String({ description: 'Keyword: SKU, model, feature, or Chinese/English term' }),
      }),
      execute: async ({ query }: { query: string }) => {
        const refs = await loadRefs();
        const allowPricing = pricingAllowed(ctx.conversationKey);
        const usable = [...refs.entries()]
          .filter(([name]) => allowPricing || name !== 'pricing-eu-distri')
          .map(([name, text]) => ({ name, text }));
        const hits = searchRefs(usable, query);
        for (const h of hits) ctx.evidence?.push(h.block);
        if (!hits.length)
          return {
            /**
             * 🔴 **搜不到时要把下一步交出去**（2026-08-17 实测逼出来的）：
             * 原来只回一句「没搜到」，模型直接得出「资料无法确认」就收工了 ——
             * 而那个 SKU 的用户手册其实躺在文档库里。
             * 工具的失败消息**自带下一步**，比在 prompt 里叮嘱可靠。
             */
            text:
              `参考资料里没搜到「${query}」。\n` +
              `→ **下一步：用更短的关键词再搜一次（一两个词，别用整句），或者用 find_document 查这个 SKU 的官方文档**（用户手册里通常有故障码、指示灯、报警说明）。\n` +
              `可用资料：${usable.map((u) => u.name).join(' / ')}。` +
              (allowPricing ? '' : '\n（定价资料在这个群没有开放。）'),
          };
        return {
          text: hits
            .map((h) => `【${h.name}.md:${h.line}】\n${h.block}`)
            .join('\n\n---\n\n')
            .slice(0, 12_000),
        };
      },
    },
    {
      name: 'find_document',
      label: '找文档',
      description:
        'Look up which official documents exist for a SKU in the SharePoint product document center ' +
        '(datasheet / user manual / certification / image / 3D model). Returns exact paths to pass to fetch_document.',
      parameters: Type.Object({
        sku: Type.String({ description: 'SKU or keyword, e.g. VLC2430LINK or VLB12100LFP' }),
        type: Type.Optional(
          Type.String({ description: 'One of: Datasheet, UM, Certification, Image, 3D_Model' }),
        ),
      }),
      execute: async ({ sku, type }: { sku: string; type?: string }) => {
        const man = await loadManifest();
        const hits = searchDocs(man.files, sku, type);
        if (!hits.length)
          return { text: `文档库里没有「${sku}」${type ? `（类型 ${type}）` : ''}的记录。索引共 ${man.counts.files} 个文件 / ${man.counts.skus} 个 SKU。` };
        /**
         * 🔴 **把文档库的链接一起给出去**（维护者 2026-08-17：「SharePoint 的链接是
         * 开放给所有人用的，不存在信息敏感」）。人拿到链接可以自己打开看原件 ——
         * 比只给我解析出来的文字强，尤其是图纸、认证扫描件这种解析不出东西的。
         *
         * ⚠️ 给的是**共享链接（文档库入口）+ 文件路径**，不是拼出来的直连地址：
         * 实测直连地址在没有那个匿名会话 cookie 时是 **403**，发给人点不开。
         */
        const entry = env.productDocsShareUrl
          ? `\n\n📂 文档库（可直接打开）：${env.productDocsShareUrl}\n   按上面的路径进去找即可。`
          : '';
        return {
          text:
            hits
              .map((h) => `[${h.doctype}] ${h.sku} · ${h.name} · ${human(h.size)} · 更新 ${String(h.modified).slice(0, 10)}\n  路径：${h.path}`)
              .join('\n') + entry,
        };
      },
    },
  ];

  // 🔴 没配共享链接就**不注册**这个工具 —— 能力边界靠「没有」，不靠运行时判断
  if (env.productDocsShareUrl) {
    tools.push({
      name: 'fetch_document',
      label: '读文档',
      description:
        'Download one official document from SharePoint and read its text (PDF/Office). ' +
        'The path MUST come from find_document — arbitrary paths are rejected. ' +
        'Images and 3D models cannot be read; report their existence instead.',
      parameters: Type.Object({
        path: Type.String({ description: 'Exact path from find_document, e.g. Datasheet/MPPT_Charger/…/x.pdf' }),
      }),
      execute: async ({ path }: { path: string }) => {
        const man = await loadManifest();
        const hit = resolveDoc(path, man.files);
        if (!hit)
          return {
            text: `「${path}」不在文档索引里，拒绝下载。请先用 find_document 拿到准确路径（只接受逐字一致的路径）。`,
          };
        if (/^(Image|3D_Model)$/i.test(hit.doctype))
          return { text: `${hit.name} 是 ${hit.doctype}（${human(hit.size)}），我读不了图片/模型的内容，只能确认它存在。` };
        if (hit.size > env.productDocsMaxBytes)
          return { text: `${hit.name} 有 ${human(hit.size)}，超过了 ${human(env.productDocsMaxBytes)} 的上限，没有下载。` };
        const r = await fetchDocument(hit);
        const body = r.slice(0, 20_000);
        ctx.evidence?.push(body);
        /**
         * 🔴 指令跟着数据一起走。实测过的失败：模型拿到手册之后，
         * 把**记忆里的**阈值写成「手册列出的」——而那本手册里一个数都没有。
         * 这句话贴在原文前面，比在 prompt 里叮嘱有效得多（它就在眼前）。
         */
        return {
          text:
            '【以下是这份文档抽出来的原文。🔴 只能引用其中真实出现的内容 —— ' +
            '文中没写的参数/阈值/数字，一律回答「手册里没写」，不要用记忆补。】\n\n' +
            body,
        };
      },
    });
  }
  return tools;
};

/** 工具清单的真相源（测试逐字对账）。 */
export const productToolNames = (): string[] => productTools().map((t) => t.name);
