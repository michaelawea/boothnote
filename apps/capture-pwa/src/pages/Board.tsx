import { useCallback, useEffect, useMemo, useState } from 'react';

import { T } from '../theme';
import {
  ForbiddenError,
  cachedEnums,
  deleteRecord,
  fetchDeletionPreview,
  fetchRecords,
  restoreRecord,
  syncEnums,
  type DeletionPreview,
} from '../api';
import { useCompanies } from '../companies';
import { db, type Company, type EnumSet, type RecordRow } from '../db';
import { useSession } from '../auth';
import { ReviewCard } from '../components/ReviewCard';
import { Backdrop } from '../components/Backdrop';
import { IconChevron, IconClose, IconFilter, IconSearch, IconTrash, IconUndo } from '../icons';
import { t } from '../i18n';

/**
 * 看板 —— **我的记录表格**（D76，维护者 2026-08-07）。
 *
 * 🔴 **这一屏在 2026-08-07 换了它回答的问题。**
 *
 * 原来它读 `GET /staging?status=ready`：只有「AI 整理完、等人确认」这一个状态的
 * 记录会出现，确认完一条那条就从屏幕上消失。所以它天然只能是个 inbox，
 * 回答的是「还有什么没确认」。于是「我到底记了些什么、哪些进去了哪些没进去」
 * 这个问题，在整个 PWA 里没有任何一屏能回答。
 *
 * 现在读 `GET /records`：**不按状态过滤**，我名下的全部记录一行一行摆出来，
 * 已入库的、失败的、还在跑的都在，靠状态列区分。
 * 失败的那些尤其不能省 —— 一条录了却没进 CRM 的记录如果表格上不显示，
 * 在人这边就是彻底不存在的，而「界面绿色、东西没进去」是这个仓库最贵的那类 bug。
 *
 * **两件事这一屏刻意不做：**
 *   ① **不做首次确认**（维护者：「确认这边只走对话」）。`ready` 的行点开是只读的，
 *      给一个「去对话里确认 →」把人送过去 —— 确认要看 AI 的整个工作日志和上下文，
 *      那是对话页的事，表格给不了。
 *   ② **不做别人的数据**。作用域不在这里裁，`/records` 端点根本没有 `scope` 参数
 *      （§4.2 第 4 条：前端过滤等于没过滤）。
 *
 * **它做的一件事**：已入库的行点开可以**改**（D75 的重录）——
 * 按 `twenty_refs` 逐条 PATCH 替代原记录，绝不新建第二份。这不是第二套修改逻辑，
 * 是 `POST /staging/:id/reconfirm` 的第二个入口，护栏（类型锁 / 客户锁 / 编号冲突）
 * 全在服务端，两个入口一视同仁。
 */

/** staging 状态 → 表格上那个小标签。**失败要显眼**，其余保持安静。 */
const STATUS: Record<string, { label: string; fg: string; bg: string }> = {
  pending: { label: '待整理', fg: T.textSoft, bg: T.s3 },
  transcribing: { label: '转写中', fg: T.textSoft, bg: T.s3 },
  extracting: { label: 'AI 整理中', fg: T.blue, bg: T.blueSoft },
  ready: { label: '待确认', fg: T.amber, bg: T.amberSoft },
  confirming: { label: '入库中', fg: T.blue, bg: T.blueSoft },
  committing: { label: '写入中', fg: T.blue, bg: T.blueSoft },
  confirmed: { label: '已入库', fg: T.green, bg: T.greenSoft },
  failed: { label: '失败', fg: T.red, bg: T.redSoft },
  superseded: { label: '已被取代', fg: T.textLight, bg: T.s3 },
};

/** 还没到终点的那几档。合成一个「处理中」—— 人不关心它卡在转写还是抽取。 */
const IN_FLIGHT = ['pending', 'transcribing', 'extracting', 'confirming', 'committing'];

/**
 * 项目卡收起来的时候，那一行小字里列的就是这个（issue #18）。
 *
 * 🔴 **九档状态一个都不能漏。** 收起来之后人看不见每一行的状态标签，
 * 这一行就是全部信息 —— 少列一档（比如 `superseded`）的话，
 * 「N 条」和下面几个数字加起来对不上，而人无从知道差的那条去哪了。
 * 「折叠掉的必须能被看见」是 issue #14 和 #18 同一条判据。
 *
 * ⚠️ 标签存中文，`t()` 在渲染那一刻才调 —— 模块级 `t()` 会拿到旧语言（D80）。
 */
const TALLY: Array<{ label: string; hit: (s: string) => boolean }> = [
  { label: '待确认', hit: (s) => s === 'ready' },
  { label: '已入库', hit: (s) => s === 'confirmed' },
  { label: '处理中', hit: (s) => IN_FLIGHT.includes(s) },
  { label: '失败', hit: (s) => s === 'failed' },
  { label: '已被取代', hit: (s) => s === 'superseded' },
];

type Filter = 'all' | 'ready' | 'confirmed' | 'failed' | 'working';
const FILTERS: Array<{ id: Filter; label: string; hit: (s: string) => boolean }> = [
  { id: 'all', label: '全部', hit: () => true },
  { id: 'ready', label: '待确认', hit: (s) => s === 'ready' },
  { id: 'confirmed', label: '已入库', hit: (s) => s === 'confirmed' },
  { id: 'working', label: '处理中', hit: (s) => IN_FLIGHT.includes(s) },
  { id: 'failed', label: '失败', hit: (s) => s === 'failed' },
];

type Grouping = 'project' | 'time' | 'company';
const GROUPINGS: Array<{ id: Grouping; label: string }> = [
  { id: 'project', label: '按项目' },
  { id: 'time', label: '按时间' },
  { id: 'company', label: '按客户' },
];

/**
 * 人最后认可的那份值。
 *
 * `extracted` 是「这一轮从原话里读出了什么」，`confirmed_fields` 是「人确认时改成了什么」。
 * 表格上显示的必须是后者盖前者 —— 只看 `extracted` 的话，上次已经把阶段从 RFQ 改成
 * 整车验证的那条会显示 RFQ，人会以为自己那次修改丢了（D75 踩过）。
 * 服务端合并 payload 时用的是同一个顺序（`{...extracted, ...confirm_payload.fields}`）。
 */
const eff = (r: RecordRow): Record<string, unknown> => ({
  ...(r.extracted ?? {}),
  ...(r.confirmed_fields ?? {}),
});

/**
 * 这一行是哪家客户。
 *
 * 🔴 三个来源缺一不可，因为**归属是入库那一刻才定的**（D28 修订）：
 *   · `resolved_company_id` —— 已入库的靠它（Twenty 的 UUID，最可信）
 *   · `company_code`        —— 录入时就选了客户的那些
 *   · `extracted.companyCode` —— agent 认出来但人还没确认的
 * 只看第二个的话，已入库的行会整片显示「未定客户」——
 * 而那正是这张表最应该说清楚的那一半。
 */
const codeOf = (r: RecordRow, companies: Company[]): string | null =>
  (r.resolved_company_id ? companies.find((c) => c.id === r.resolved_company_id)?.code : null) ??
  r.company_code ??
  (typeof eff(r).companyCode === 'string' ? (eff(r).companyCode as string) : null) ??
  null;

const nameOf = (r: RecordRow, companies: Company[]): string | null => {
  const code = codeOf(r, companies);
  return code ? (companies.find((c) => c.code === code)?.name ?? code) : null;
};

/** 枚举值 → 中文。缓存没到就退回原值，绝不显示空白。 */
const label = (opts: Array<{ value: string; label: string }> | undefined, v: unknown): string => {
  const s = String(v ?? '').trim();
  if (!s) return '';
  return opts?.find((o) => o.value === s)?.label ?? s;
};

/** 「8-07」。表格要的是能对齐扫一眼的短日期，不是「3 小时前」。 */
const fmtDay = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
};

const firstLine = (s: string | null): string =>
  (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);

export type Group = {
  key: string;
  /** 给人看的标题。项目卡上是项目名，其余是「客户 · 品类」。 */
  label: string;
  /**
   * 有值 = **这一组就是一个项目**（issue #18）：同一个编号只占一张卡，
   * 收起来只显示聚合，展开才看到每一条。
   * null = D76 那种普通分组（按客户代号+品类、按天、按客户），行为不变。
   */
  projectCode: string | null;
  rows: RecordRow[];
};

/**
 * 一行记录压平成一串可搜的文字。
 *
 * 🔴 **搜索是纯前端的，而且必须如此。** 数据已经全在手上（`/records` 一次拉回来
 * 并落进 Dexie），再去问服务端只会让**断网时搜不了** —— 而展馆断网是常态不是异常，
 * 「翻一翻自己记过什么」恰恰是网不好时最想干的事。300 行做字符串匹配，无感。
 *
 * 收进来的都是人**会拿来找**的东西：客户名和代号、标题、正文、小结、型号、
 * 在位品牌、项目名和编号、拜访场次。`extracted` 与 `confirmed_fields` 合并之后再取，
 * 所以搜得到的是**人最后认可的那份值**，和表格上显示的一致。
 */
const searchText = (r: RecordRow, companies: Company[]): string => {
  const f = eff(r);
  const proj = (f.project ?? {}) as Record<string, unknown>;
  return [
    r.title,
    r.text,
    nameOf(r, companies),
    codeOf(r, companies),
    r.suggested_company,
    r.visit_label,
    f.summary,
    f.modelName,
    f.supplierName,
    f.projectCode,
    proj.name,
    proj.projectCode,
  ]
    .filter((x) => typeof x === 'string' && x)
    .join(' ')
    .toLowerCase();
};

/**
 * 多个词是**并且**，不是或者。
 *
 * 「alpin 电池」要找的是「Alpin 那条电池的」，不是「所有 Alpin 的 ＋ 所有电池的」——
 * 后者搜出来的比不搜还多，那这个框就白给了。
 */
const matches = (haystack: string, query: string): boolean => {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((t) => haystack.includes(t));
};

/**
 * 这一行的**项目编号** —— issue #18 的分组键（D91 起在提案那一刻就有了）。
 *
 * 🔴 **只能是编号，绝不能是项目名。**（§4.2 第 3 条）
 * 销售那份 Excel 就是用名字做关联键散架的：品牌名单交集 32/61、集团名三份交集为 0。
 * 按 `project.name` 分组会把「Istra 电池项目」和「Istra 锂电项目」分成两组，
 * 而它们是同一个项目；反过来两家客户各有一个「电池项目」会被并成一组。
 *
 * 四个来源按「人 > agent > 回执」取，和 `eff()` / `confirm.ts` 同一个顺序：
 *   · `f.projectCode`            —— 人在核对卡上填的，或 `propose_work_items` 挂的
 *   · `project.projectCode`      —— `propose_project` 提案时取的号（D91）
 *   · `twenty_refs.project*`     —— 入库回执。**这一档专门盖住 D91 之前入库的老记录**：
 *                                   它们的 `extracted.project` 里没有编号，
 *                                   但 CRM 里实打实有一个项目，不认它就分不进组
 * 统一大写：`abc-001` 和 `ABC-001` 在 CRM 里是同一个项目（`findProjectByCode`
 * 也是这么比的），在这张表上就不能是两张卡。
 */
export const projectCodeOf = (r: RecordRow): string | null => {
  const f = eff(r);
  const proj = (f.project ?? {}) as Record<string, unknown>;
  const refs = (r.twenty_refs ?? {}) as Record<string, string>;
  for (const v of [f.projectCode, proj.projectCode, refs.projectUpdated, refs.projectCodeGenerated]) {
    const s = String(v ?? '').trim().toUpperCase();
    if (s) return s;
  }
  return null;
};

/** 项目名。只做标题，**不做键** —— 键永远是编号。 */
const projectNameOf = (r: RecordRow): string | null => {
  const p = (eff(r).project ?? {}) as Record<string, unknown>;
  return String(p.name ?? '').trim() || null;
};

/**
 * D56 的项目身份：**同一家客户 + 同一个品类**。一个代号 + 一个枚举，不是自由文本。
 *
 * 它在这里有两个用处：
 *   ① 还没有编号的那些行（选型 / 售后）照 D76 原样按它分组 —— 行为不变
 *   ② 把「这一桶里已经有人拿到了编号」传染给同桶其他行（见 `buildGroups`），
 *      否则一个项目的三条记录里只有一条调过 `propose_project`，
 *      另外两条会被甩到旁边一组去，而 D76 之前它们本来是在一起的
 */
export const identityOf = (r: RecordRow, companies: Company[]): string | null => {
  const code = codeOf(r, companies);
  const cat = String(eff(r).category ?? '').trim();
  return code && cat ? `${code}|${cat}` : null;
};

/**
 * 这一行归到哪一组。
 *
 * 按项目时的键，**按这个优先级**：
 *   ① 这一行自己的项目编号（D91：提案那一刻就有）
 *   ② 同一个 D56 身份（客户+品类）下别的行拿到的编号 —— 把整桶收进那张项目卡
 *   ③ 都没有 → D76 原样：`客户代号|品类`
 *   ④ 客户或品类缺一个 → 「未归入项目」。**别猜。**
 */
const groupOf = (
  r: RecordRow,
  grouping: Grouping,
  companies: Company[],
  enums: EnumSet | null,
  codeByIdentity: Map<string, string>,
): Omit<Group, 'rows'> => {
  if (grouping === 'company') {
    const code = codeOf(r, companies);
    return {
      key: `c:${code ?? '~none'}`,
      label: nameOf(r, companies) ?? t('未定客户'),
      projectCode: null,
    };
  }
  if (grouping === 'time') {
    const day = r.captured_at.slice(0, 10);
    return {
      key: `t:${day}`,
      label: t('{m} 月 {d} 日', { m: day.slice(5, 7), d: day.slice(8, 10) }),
      projectCode: null,
    };
  }

  const identity = identityOf(r, companies);
  const cat = String(eff(r).category ?? '').trim();
  const code = projectCodeOf(r) ?? (identity ? (codeByIdentity.get(identity) ?? null) : null);
  const named = [nameOf(r, companies), cat ? label(enums?.category, cat) : '']
    .filter(Boolean)
    .join(' · ');

  if (code) return { key: `p:#${code}`, label: named || code, projectCode: code };
  if (!identity) return { key: 'p:~none', label: t('未归入项目'), projectCode: null };
  return { key: `p:${identity}`, label: named, projectCode: null };
};

/**
 * 分好组、排好序的一棵树。**纯函数**（用例见 `__tests__/board-group.test.ts`）。
 *
 * 传进来的 `rows` 已经过筛选和搜索，而且是按 `captured_at` 倒序的（服务端排的）——
 * 所以每组的第一条就是最新那条，组的先后也照它排。
 */
export const buildGroups = (
  rows: RecordRow[],
  grouping: Grouping,
  companies: Company[],
  enums: EnumSet | null,
): Group[] => {
  /*
   * 第一遍：D56 身份 → 编号。只在按项目时才需要。
   * 最新那条拿到的编号说了算 —— 人在核对卡上把编号改掉之后，
   * 整桶要跟着搬到新编号那张卡上去，而不是留一半在旧的。
   */
  const codeByIdentity = new Map<string, string>();
  if (grouping === 'project') {
    for (const r of rows) {
      const code = projectCodeOf(r);
      const identity = identityOf(r, companies);
      if (code && identity && !codeByIdentity.has(identity)) codeByIdentity.set(identity, code);
    }
  }

  const map = new Map<string, Group>();
  for (const r of rows) {
    const g = groupOf(r, grouping, companies, enums, codeByIdentity);
    const got = map.get(g.key);
    if (got) got.rows.push(r);
    else map.set(g.key, { ...g, rows: [r] });
  }

  /*
   * 项目卡的标题优先用项目名 —— 组里哪一条有名字就用哪一条（最新的优先）。
   * ⚠️ 这只影响**显示**：键仍然是编号。一个项目在两条对话里叫了两个名字，
   *    卡上会显示其中一个，但它们绝不会因此分成两张卡。
   */
  for (const g of map.values()) {
    if (!g.projectCode) continue;
    const named = g.rows.map(projectNameOf).find(Boolean);
    if (named) g.label = named;
  }

  return [...map.values()].sort((a, b) => {
    // 兜底那一组永远沉底 —— 它是杂物筐，浮在最上面会把真正的项目压下去
    const an = a.key.endsWith('~none') ? 1 : 0;
    const bn = b.key.endsWith('~none') ? 1 : 0;
    if (an !== bn) return an - bn;
    return b.rows[0]!.captured_at.localeCompare(a.rows[0]!.captured_at);
  });
};

export const BoardPage = ({ onOpenChat }: { onOpenChat?: (threadId: string) => void }) => {
  const session = useSession();
  const me = session?.user;
  const companies = useCompanies();

  const [rows, setRows] = useState<RecordRow[]>([]);
  const [enums, setEnums] = useState<EnumSet | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [grouping, setGrouping] = useState<Grouping>('project');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  /** 筛选面板开着没有。**默认收着** —— 常驻两排 chip 在手机上要吃掉小半屏。 */
  const [panel, setPanel] = useState(false);
  /** 展开的是哪一行。null = 全都收着。 */
  const [open, setOpen] = useState<string | null>(null);
  /**
   * 人手动开合过的组。**没有记录的组走下面 `isOpen()` 里的默认值** ——
   * 存「人怎么点的」而不是「现在开着没有」，是为了让默认值一直有效：
   * 一个项目今天只有一条（默认摊开），明天多了两条（默认收起），
   * 人没碰过它就该跟着变，而不是被今天那次渲染钉住。
   */
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});

  /**
   * ── 删除（D93 · issue #25 / #29）──────────────────────────────────
   *
   * 两格 state，各管一段：
   *   · `asking`  二次确认框正开着，问的是哪一行 + 服务端算出来的后果清单
   *   · `undo`    刚删完那一条。**一直挂到人自己关掉**，不自动消失 ——
   *               自动消失的撤销条等于没有撤销：人反应过来时它已经没了。
   */
  const [asking, setAsking] = useState<{ row: RecordRow; preview: DeletionPreview | null } | null>(null);
  const [undo, setUndo] = useState<{ id: string; summary: string; removed: number } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [banner, setBanner] = useState('');

  const load = useCallback(async () => {
    try {
      setRows(await fetchRecords());
      setForbidden(false);
    } catch (e) {
      // 🔴 只有 403 才是「没权限」。断网走的是 fetchRecords 内部的缓存回退，
      //    根本不会抛到这里 —— 两者混一起会在展馆断网时告诉人他没权限
      if (e instanceof ForbiddenError) setForbidden(true);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void cachedEnums().then((e) => e && setEnums(e));
    void syncEnums().then((e) => e && setEnums(e));
  }, []);

  /**
   * 轮询。**展开着某一行时快一点**（1.5 秒），收着时慢（8 秒）。
   *
   * 🔴 展开时必须快：重录点下去之后是 5 秒撤销窗，而倒计时和「撤销」按钮
   * 都是 `ReviewCard` 从**服务端的 `status`** 推出来的（它自己不记状态，
   * 见组件头部那段注释）。8 秒一跳的话，人点完确认要盯着一个不动的界面等 8 秒。
   *
   * ⚠️ **轮询不会冲掉人改到一半的格子**，靠的是下面每一行的 `key={r.id}` ——
   * key 稳定 React 就不卸载组件，`edits` 那份 state 就活着。组的顺序也按
   * `captured_at`（不可变）排，所以每次拉回来的树形状都一样。
   * 这个仓库为同一件事栽过一次：`ReviewCard` 当初把倒计时放在组件自己的 state 里，
   * 父组件一换渲染条件整张卡被卸载，人点完确认屏幕上什么都不剩。
   */
  useEffect(() => {
    /**
     * ⚠️ `user` 角色一次都别请求。
     *
     * 下面那个「没权限」的分支是**早退渲染**，而 hook 在它之前就跑完了 ——
     * 不挡这一下的话，一个没权限的人打开这一屏就是每 8 秒撞一次 403，
     * 一直撞到他切走。服务端那道 403 是必须的（前端过滤等于没过滤），
     * 但客户端明知会被拒还去敲，是白费的往返和一串没人看的错误日志。
     */
    if (me && !me.canSeeBoard) return;
    void load();
    const t = window.setInterval(() => void load(), open ? 1500 : 8000);
    return () => window.clearInterval(t);
  }, [load, open, me?.canSeeBoard]);

  /**
   * 搜索索引：`staging id → 压平的可搜文字`。
   *
   * 建一次，敲键盘时只做 `includes` —— 不然每敲一个字都要把 300 行的
   * `extracted` 重新展开一遍。依赖里带 `companies`：名单是异步到的，
   * 不带的话客户名进不了索引，搜「Alpin」搜不到刚拉回来的那些。
   */
  const index = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.id, searchText(r, companies));
    return m;
  }, [rows, companies]);

  const counts = useMemo(() => {
    const n: Record<Filter, number> = { all: 0, ready: 0, confirmed: 0, working: 0, failed: 0 };
    // 🔴 计数走的是**搜索之后、状态筛选之前**那一批。
    //    不然搜「Alpin」时 chip 上还写着全公司的数字，人对不上号。
    for (const r of rows) {
      if (query && !matches(index.get(r.id) ?? '', query)) continue;
      for (const f of FILTERS) if (f.hit(r.status)) n[f.id]++;
    }
    return n;
  }, [rows, index, query]);

  const groups = useMemo<Group[]>(() => {
    const hit = FILTERS.find((f) => f.id === filter)!.hit;
    const keep = rows.filter(
      (r) => hit(r.status) && (!query || matches(index.get(r.id) ?? '', query)),
    );
    return buildGroups(keep, grouping, companies, enums);
  }, [rows, index, query, filter, grouping, companies, enums]);

  /**
   * 这一组现在是开着还是收着。
   *
   * 🔴 **默认收起的只有「一个编号 + 多于一条」的项目卡** —— 那正是 issue #18
   * 要的「同一编号只占一张卡」。其余一切默认摊开，和 D76 逐像素一致。
   *
   * 两条例外，都是「别把人正在看/正在改的东西藏起来」：
   *   · 组里有展开着的行 → 强制开。收起会把 `ReviewCard` 卸载掉，
   *     人改到一半的格子当场消失（这个仓库为同一件事栽过一次，见轮询那段注释）。
   *   · 搜索中 → 一律摊开。搜「alpin」是为了看到那几行，不是为了看到一张卡说「3 条」。
   */
  const isOpen = (g: Group): boolean => {
    if (open && g.rows.some((r) => r.id === open)) return true;
    const manual = groupOpen[g.key];
    if (manual !== undefined) return manual;
    if (query.trim()) return true;
    return !(g.projectCode && g.rows.length > 1);
  };

  const shown = groups.reduce((a, g) => a + g.rows.length, 0);
  const filtered = filter !== 'all' || Boolean(query.trim());
  const groupLabel = t(GROUPINGS.find((g) => g.id === grouping)!.label);

  /** 点了「删除」→ 先问服务端「按下去会删掉什么」，再把那句话放进确认框。 */
  const askDelete = async (row: RecordRow) => {
    setBanner('');
    setAsking({ row, preview: null });
    const p = await fetchDeletionPreview(row.id);
    setAsking((cur) => (cur && cur.row.id === row.id ? { row, preview: p } : cur));
  };

  const doDelete = async (row: RecordRow) => {
    setDeleting(true);
    try {
      const r = await deleteRecord(row.id);
      setAsking(null);
      setOpen(null); // 展开着的那张卡指向一条已经不在了的记录
      /**
       * 🔴 **没删干净的要当场说出来**，不能只显示一句「已删除」。
       * 静默留下的孤儿在 CRM 里还在，而看板上这一行已经没了 ——
       * 于是那几条记录从此没有任何一屏能看见（「看不见」≠「不存在」）。
       */
      const stuck = [
        ...(r.failed ?? []).map((f) => `${f.label}${t('：')}${f.reason}`),
        ...(r.skipped ?? []).map((s) => `${s.what}${t('：')}${s.why}`),
      ];
      setBanner(stuck.length ? t('CRM 里这些没能删掉，请去 CRM 处理：') + '\n' + stuck.join('\n') : '');
      setUndo({ id: row.id, summary: r.summary ?? '', removed: r.removed ?? 0 });
      // 本地缓存同步删掉 —— 不然断网时它会从上一次的缓存里冒回来
      await db.records.delete(row.id).catch(() => undefined);
      await load();
    } catch (e) {
      setAsking(null);
      setBanner((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  const doRestore = async (id: string) => {
    setDeleting(true);
    try {
      const r = await restoreRecord(id);
      setUndo(null);
      /**
       * 🔴 **恢复不了的那几条要说出来。** 看板上这一行回来了，
       * 但它指向的 CRM 记录没了 —— 不说的话人会以为撤销把一切都还原了，
       * 直到某天去 CRM 里找才发现是空的。
       */
      const gone = r.gone ?? [];
      setBanner(
        gone.length
          ? t('看板这一行回来了，但 CRM 里这些找不回来（多半是之前被真删过）：') +
              '\n' +
              gone.map((g) => `· ${g.label}`).join('\n')
          : '',
      );
      await load();
    } catch (e) {
      setBanner((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  // ── 没权限：说清楚是权限，不是「你还没记过东西」──────────────────
  if (forbidden || (me && !me.canSeeBoard)) {
    return (
      <div style={{ padding: '60px 26px', textAlign: 'center', color: T.textLight, fontSize: 13, lineHeight: 1.9 }}>
        {t('这一屏需要更高权限。')}
        <br />
        {t('你录的东西照常进库，只是这台设备上看不到汇总。')}
      </div>
    );
  }

  return (
    <div style={{ padding: '10px 14px 28px' }}>
      {/**
       * 🔴 **通往 CRM 的入口放最上面**（维护者 2026-08-05，issue #14：
       * 「进入CRM的跳转，一定一直在最上面，而不是在最后面」）。
       * 这张表只有我自己的，全量还是要去 Twenty 看（D35③ 那一半没变）。
       */}
      {me?.boardUrl && (
        <a
          href={me.boardUrl}
          target="_blank"
          rel="noreferrer"
          className="btn ghost"
          style={{ width: '100%', textDecoration: 'none', marginBottom: 12 }}
        >
          {t('在 CRM 里看完整看板 ↗')}
        </a>
      )}

      {/**
       * ── 刚删掉一条：**撤销一直挂着，不自动消失**（D93 · issue #25）────
       *
       * 🔴 一条几秒钟就没的 toast 等于没有撤销 —— 人反应过来「我删错了」
       * 通常要好几秒，而那时它已经不在屏幕上了，也没有第二个入口能回到那一步。
       * 挂到人自己关掉为止，代价只是屏幕上多一条，收益是这个删除按钮敢按。
       */}
      {undo && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: T.s2,
            border: `1px solid ${T.line}`,
            borderRadius: 12,
            padding: '9px 10px 9px 12px',
            marginBottom: 10,
            fontSize: 12.5,
          }}
        >
          <span style={{ flex: 1, minWidth: 0, color: T.textSoft, lineHeight: 1.6 }}>
            {/* 🔴 「删了一行」和「同时删了 CRM 里 3 条」是两句不同的话，
                   而人最需要知道的恰恰是后者 —— 说清楚才谈得上「知道自己删了什么」 */}
            {undo.removed > 0
              ? t('已删除 · CRM 里同时删掉了 {a}', { a: undo.summary || `${undo.removed}` })
              : t('已从看板删除（这条没进过 CRM）')}
          </span>
          <button
            onClick={() => void doRestore(undo.id)}
            disabled={deleting}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              flexShrink: 0,
              color: T.blue,
              fontWeight: 600,
              opacity: deleting ? 0.5 : 1,
            }}
          >
            <IconUndo size={13} />
            {t('撤销')}
          </button>
          <button
            onClick={() => setUndo(null)}
            aria-label={t('关闭')}
            style={{ color: T.textLight, display: 'flex', flexShrink: 0, padding: 2 }}
          >
            <IconClose size={13} />
          </button>
        </div>
      )}

      {banner && (
        <div
          style={{
            background: T.amberSoft,
            color: T.amber,
            border: `1px solid ${T.line}`,
            borderRadius: 12,
            padding: '9px 12px',
            marginBottom: 10,
            fontSize: 12,
            lineHeight: 1.7,
            whiteSpace: 'pre-wrap',
          }}
        >
          {banner}
        </div>
      )}

      {/**
       * ── 一行工具条：左边说清「现在看的是什么」，右边一个漏斗 ──────
       *
       * 🔴 **筛选不常驻**（维护者 2026-08-07：「这个筛选的按键，并不需要常驻，
       * 可以放在一个筛选漏斗的一个图标之下，点开才有」）。
       * 两排 chip 在 375px 的屏上要吃掉近 70px —— 表格被推下去小半屏，
       * 而这一屏存在的意义就是**一眼扫过去**。
       *
       * 收起之后左边那句话就是唯一的状态显示：分组方式 · 当前筛选 · 条数。
       * 没有它的话，人筛完切走再回来，会对着一张少了一半的表以为数据丢了 ——
       * **「筛掉了」和「不存在」必须分得开**，和这一屏别处是同一条判据。
       */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: T.textSoft }}>
          <span style={{ color: T.text, fontWeight: 600 }}>{shown}</span> {t('条')}
          <span style={{ color: T.textLight }}> · {groupLabel}</span>
          {filter !== 'all' && (
            <span style={{ color: T.textLight }}>
              {' · '}
              {t(FILTERS.find((f) => f.id === filter)!.label)}
            </span>
          )}
          {query.trim() && (
            <span
              style={{
                color: T.textLight,
                display: 'inline-block',
                maxWidth: '40%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                verticalAlign: 'bottom',
              }}
            >
              {t(' · 搜「{a}」', { a: query.trim() })}
            </span>
          )}
        </div>
        <button
          onClick={() => setPanel(!panel)}
          aria-label={t('筛选与搜索')}
          style={{
            position: 'relative',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            padding: '6px 11px',
            borderRadius: T.pill,
            fontSize: 12.5,
            color: panel || filtered ? '#fff' : T.textSoft,
            background: panel || filtered ? T.text : T.s3,
          }}
        >
          <IconFilter size={14} />
          {t('筛选')}
          {/* 面板收着但筛选生效时的那个点 —— 不然人不知道自己还筛着 */}
          {filtered && !panel && (
            <span
              style={{
                position: 'absolute',
                top: 4,
                right: 5,
                width: 5,
                height: 5,
                borderRadius: 3,
                background: T.amber,
              }}
            />
          )}
        </button>
      </div>

      {panel && (
        <div
          style={{
            background: T.s2,
            border: `1px solid ${T.line}`,
            borderRadius: 14,
            padding: '12px 12px 14px',
            marginBottom: 12,
          }}
        >
          {/**
           * 🔴 **搜索是纯前端的** —— 数据已经全在手上，再去问服务端只会让
           * 断网时搜不了，而展馆断网是常态。搜的范围见 `searchText()`。
           */}
          <div style={{ position: 'relative', marginBottom: 12 }}>
            <span
              style={{
                position: 'absolute',
                left: 11,
                top: '50%',
                transform: 'translateY(-50%)',
                color: T.textLight,
                display: 'flex',
              }}
            >
              <IconSearch size={15} />
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('客户 · 内容 · 型号 · 品牌 · 编号')}
              // ⚠️ iOS 上字号小于 16 会在聚焦时自动放大整页，再也缩不回去
              style={{
                width: '100%',
                fontSize: 16,
                padding: '9px 32px 9px 32px',
                borderRadius: 10,
                border: `1px solid ${T.line}`,
                background: T.surface,
                color: T.text,
              }}
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                aria-label={t('清空搜索')}
                style={{
                  position: 'absolute',
                  right: 6,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: T.textLight,
                  padding: 6,
                  display: 'flex',
                }}
              >
                <IconClose size={14} />
              </button>
            )}
          </div>

          <PanelRow label={t('分组')}>
            {GROUPINGS.map((g) => (
              <Chip key={g.id} on={grouping === g.id} onClick={() => setGrouping(g.id)}>
                {t(g.label)}
              </Chip>
            ))}
          </PanelRow>

          {/**
           * 面板里**每一档都列出来，计数为 0 的也列** —— 和收起态的取舍相反。
           * 收起态是寸土寸金，这里是「告诉我全貌」：看到「失败 0」是一种信息，
           * 而一个不出现的 chip 只会让人以为这个系统不区分失败。
           */}
          <PanelRow label={t('状态')}>
            {FILTERS.map((f) => (
              <Chip key={f.id} on={filter === f.id} onClick={() => setFilter(f.id)}>
                {t(f.label)} {counts[f.id]}
              </Chip>
            ))}
          </PanelRow>

          {filtered && (
            <button
              onClick={() => {
                setFilter('all');
                setQuery('');
              }}
              style={{
                marginTop: 10,
                fontSize: 12.5,
                color: T.blue,
                padding: '2px 0',
              }}
            >
              {t('清除筛选')}
            </button>
          )}
        </div>
      )}

      {/* ── 表头。有它这一屏才读得出「这是一张表」 ────────────────── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '38px 1fr auto',
          gap: 8,
          fontSize: 11,
          color: T.textLight,
          padding: '0 2px 6px',
          borderBottom: `1px solid ${T.line}`,
        }}
      >
        <span>{t('日期')}</span>
        <span>{t('客户 / 内容')}</span>
        <span>{t('状态')}</span>
      </div>

      {groups.map((g) => {
        const shownOpen = isOpen(g);
        return (
          <div key={g.key} style={{ marginTop: 14 }}>
            <GroupHead
              group={g}
              open={shownOpen}
              onToggle={() => setGroupOpen({ ...groupOpen, [g.key]: !shownOpen })}
              /**
               * ⚠️ **扩展位** —— 针对整组的操作（删除、导出…）挂这里。
               * 不传就什么都不渲染，行为和现在一模一样。
               */
              actions={null}
            />
            {shownOpen &&
              g.rows.map((r) => (
                /**
                 * 🔴 `key` 必须是 staging id（见上面轮询那段）。
                 * 换成 index 或者带上状态，一次轮询就能把展开着的那张卡卸载掉。
                 */
                <Row
                  key={r.id}
                  row={r}
                  companies={companies}
                  enums={enums}
                  open={open === r.id}
                  onToggle={() => setOpen(open === r.id ? null : r.id)}
                  onOpenChat={onOpenChat}
                  onDone={load}
                  onDelete={() => void askDelete(r)}
                />
              ))}
          </div>
        );
      })}

      {loaded && !groups.length && (
        <div
          style={{
            textAlign: 'center',
            color: T.textLight,
            fontSize: 13.5,
            padding: '40px 16px',
            lineHeight: 1.9,
          }}
        >
          {/**
           * 🔴 三种空是三句不同的话。合成一句「没有记录」的话，
           * 一个搜错字的人会以为自己录的东西全没了。
           */}
          {!rows.length
            ? t('还没有记录。去「速记」页记一条。')
            : query.trim()
              ? t('没有匹配「{a}」的记录。', { a: query.trim() })
              : t('这个筛选下没有记录。')}
          {filtered && (
            <div>
              <button
                onClick={() => {
                  setFilter('all');
                  setQuery('');
                }}
                style={{ marginTop: 10, fontSize: 13, color: T.blue }}
              >
                {t('清除筛选，看全部 {a} 条', { a: rows.length })}
              </button>
            </div>
          )}
        </div>
      )}

      {/**
       * 🔴 **上限必须说出来。** 服务端一次给 300 条，到顶了就意味着更早的记录
       * 既不在表里、**也搜不到**（搜索是在已拉回来的这批上做的）。
       * 不说的话，一个搜不到三周前那条的人会认为它不存在 ——
       * 而这个仓库里「看不见」和「不存在」必须分得开。
       */}
      {rows.length >= 300 && (
        <div
          style={{
            marginTop: 18,
            fontSize: 11.5,
            color: T.textLight,
            textAlign: 'center',
            lineHeight: 1.8,
          }}
        >
          {t('只显示最近 300 条，搜索也只在这 300 条里找。')}
          <br />
          {t('更早的去 CRM 里看。')}
        </div>
      )}

      {asking && (
        <DeleteRecordSheet
          row={asking.row}
          preview={asking.preview}
          busy={deleting}
          companies={companies}
          onCancel={() => setAsking(null)}
          onConfirm={() => void doDelete(asking.row)}
        />
      )}
    </div>
  );
};

/**
 * ══════════════════════════════════════════════════════════════════
 *  看板删除的二次确认（D93 · issue #25 / #29）
 *
 *  维护者 2026-08-07：「删除要有 double check 的确认按钮，不能因为误触删除。」
 *
 *  🔴 **拦住误触的不是「再问一次」，是「说清楚这一下会发生什么」。**
 *  一个写着「确定删除吗？」的框，人会条件反射地点确定 —— 它没有提供
 *  任何新信息，所以第二次点击和第一次是同一个动作。
 *  真正让人停一下的是这一句：**「会同时删掉 CRM 里的 3 条：拜访 · 商机 · 项目文档」**，
 *  而那份清单是服务端按 `created_records` 算出来的，和真正执行删除的
 *  是同一份判断（`deletion.ts` 的 `plan()`）—— 两份实现总有一天会说的和做的不一样。
 *
 *  ⚠️ 还没入库的那些（issue #29 的主场景）清单是空的，文案也就完全不同：
 *     「这条没进过 CRM，删掉只是它不再出现在看板上」。
 *     两种情况共用一句话的话，必然有一边是假的。
 * ══════════════════════════════════════════════════════════════════ */
const DeleteRecordSheet = ({
  row,
  preview,
  busy,
  companies,
  onCancel,
  onConfirm,
}: {
  row: RecordRow;
  preview: DeletionPreview | null;
  busy: boolean;
  companies: Company[];
  onCancel: () => void;
  onConfirm: () => void;
}) => {
  const company = nameOf(row, companies) ?? t('未定客户');
  const title = row.title || firstLine(row.text) || t('（无正文）');
  const hasCrm = (preview?.records.length ?? 0) > 0;

  return (
    <Backdrop onClose={busy ? () => undefined : onCancel}>
      <div style={{ fontSize: 15.5, fontWeight: 600, marginBottom: 4 }}>{t('删掉这条记录？')}</div>
      <div
        style={{
          fontSize: 12.5,
          color: T.textLight,
          marginBottom: 12,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {company} · {title}
      </div>

      {!preview ? (
        <div style={{ fontSize: 13, color: T.textLight }}>{t('正在看它牵扯到什么…')}</div>
      ) : (
        <div style={{ fontSize: 12.5, color: T.textSoft, lineHeight: 1.8 }}>
          {hasCrm ? (
            <>
              <div style={{ color: T.text }}>
                {t('会同时删掉 CRM 里的 {a} 条记录：', { a: preview.records.length })}
              </div>
              <div
                style={{
                  margin: '7px 0 4px',
                  padding: '9px 11px',
                  background: T.s2,
                  border: `1px solid ${T.line}`,
                  borderRadius: 10,
                }}
              >
                {preview.records.map((r, i) => (
                  <div key={i} style={{ display: 'flex', gap: 7, padding: '2px 0' }}>
                    <span style={{ color: T.textLight, flexShrink: 0, minWidth: 58 }}>{t(r.label)}</span>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {r.name || '—'}
                    </span>
                  </div>
                ))}
              </div>
              {/* 🔴 「删掉还能不能回来」是这一刻最该回答的问题。
                     软删（`delete{Object}`，不是 `destroy`）+ 我们自己存住了那串 id，
                     所以撤销是真的能撤 —— 说出来，人才敢按这个键。 */}
              <div style={{ color: T.textLight }}>
                {t('是软删除，撤销可以把它们原样恢复。速记那条原话照常留在「速记」页。')}
              </div>
            </>
          ) : (
            <div>
              {preview.committed
                ? t('这条已入库，但 CRM 里那几条记录查不到（可能已经在 CRM 里删过了）—— 这里只会把它从看板上移除。')
                : t('这条还没进过 CRM —— 删掉只是它不再出现在看板上。原话照常留在「速记」页。')}
            </div>
          )}

          {/* 🔴 删不掉的必须现在就说，不能等删完再说 ——
                 那时人已经以为整条都干净了，不会再回来看一眼 */}
          {preview.skipped.length > 0 && (
            <div
              style={{
                marginTop: 9,
                padding: '9px 11px',
                background: T.amberSoft,
                borderRadius: 10,
                color: T.amber,
                lineHeight: 1.7,
              }}
            >
              {t('这些删不掉，会留在 CRM 里：')}
              {preview.skipped.map((s, i) => (
                <div key={i} style={{ marginTop: 3 }}>
                  · <b>{s.what}</b> —— {s.why}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 9, marginTop: 16 }}>
        <button
          className="btn"
          style={{ flex: 1, background: T.s3, color: T.text, boxShadow: 'none' }}
          onClick={onCancel}
          disabled={busy}
        >
          {t('不删')}
        </button>
        <button
          className="btn"
          style={{ flex: 1, background: T.red, color: '#fff', boxShadow: 'none', opacity: busy ? 0.5 : 1 }}
          onClick={onConfirm}
          disabled={busy || !preview}
        >
          {busy ? t('删除中…') : t('删除')}
        </button>
      </div>
    </Backdrop>
  );
};

/**
 * 一组的表头。**两种长相，一个组件**（issue #18 · D92）。
 *
 * · `group.projectCode` 有值 → **项目卡**：编号在左，标题在右，下面一行小字说清
 *   「聚合了几条、各是什么状态、最近一条是哪天」，可以收起也可以展开。
 *   收起来的时候那行小字是全部信息 —— **折叠掉的必须能被看见**（issue #14 同一条判据）。
 * · 没有编号 → **D76 原样**的一行标题 + 条数。选型 / 售后仍然一条一行，行为不变。
 *
 * ⚠️ **`actions` 是留给后来人的扩展位**：针对整组的操作（删除、导出…）放这里。
 * 它包在一个自己 `stopPropagation` 的容器里 ——
 * 挂进去的按钮点下去**不会顺手把这一组折叠掉**，那是这类嵌套按钮最常见的坑。
 */
const GroupHead = ({
  group,
  open,
  onToggle,
  actions,
}: {
  group: Group;
  open: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
}) => {
  const n = group.rows.length;
  const tally = TALLY.map((x) => ({
    label: x.label,
    n: group.rows.filter((r) => x.hit(r.status)).length,
  })).filter((x) => x.n > 0);
  // rows 是按 captured_at 倒序进来的，第一条就是最新那条
  const latest = group.rows[0]!.captured_at;

  const slot = actions ? (
    <span style={{ display: 'flex', flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
      {actions}
    </span>
  ) : null;

  // ── 没有项目编号：D76 原样，不可折叠 ──────────────────────────
  if (!group.projectCode) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 6,
          fontSize: 12.5,
          fontWeight: 600,
          color: T.textSoft,
          marginBottom: 4,
        }}
      >
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {group.label}
        </span>
        <span style={{ fontSize: 11, fontWeight: 400, color: T.textLight }}>
          {t('{a} 条', { a: n })}
        </span>
        <span style={{ flex: 1 }} />
        {slot}
      </div>
    );
  }

  // ── 项目卡 ────────────────────────────────────────────────────
  return (
    <div
      style={{
        background: T.s2,
        border: `1px solid ${T.line}`,
        borderRadius: 12,
        padding: '8px 10px',
        marginBottom: open ? 6 : 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={onToggle}
          aria-expanded={open}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            textAlign: 'left',
            background: 'transparent',
          }}
        >
          {/**
           * 🔴 编号常驻在卡上，不是「展开才看得到」。
           * 它是这张卡的**身份**（分组就是按它分的），也是人去 CRM 里找这个项目
           * 唯一带得走的东西 —— 藏起来的话，这张卡就只剩一个可能重名的名字。
           */}
          <span
            style={{
              flexShrink: 0,
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: 0.2,
              color: T.blue,
              background: T.blueSoft,
              borderRadius: T.pill,
              padding: '2px 7px',
              whiteSpace: 'nowrap',
            }}
          >
            {group.projectCode}
          </span>
          <b
            style={{
              minWidth: 0,
              fontSize: 13,
              fontWeight: 600,
              color: T.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {group.label}
          </b>
        </button>
        {slot}
        <button
          onClick={onToggle}
          aria-label={open ? t('收起') : t('展开')}
          style={{
            flexShrink: 0,
            color: T.textLight,
            display: 'inline-flex',
            padding: 2,
            transform: open ? 'rotate(90deg)' : 'none',
          }}
        >
          <IconChevron size={14} />
        </button>
      </div>

      {/**
       * 🔴 收起来之后这一行就是全部信息。九档状态在 `TALLY` 里一个不漏，
       * 所以「N 条」和后面几个数字加起来一定对得上 ——
       * 对不上的话人无从知道差的那条去哪了。
       */}
      <div style={{ fontSize: 11, color: T.textLight, marginTop: 3, paddingLeft: 1 }}>
        {t('{a} 条', { a: n })}
        {tally.map((x) => (
          <span key={x.label}>
            {' · '}
            {x.n} {t(x.label)}
          </span>
        ))}
        {' · '}
        {fmtDay(latest)}
      </div>
    </div>
  );
};

/** 面板里的一行：左边一个固定宽的标签，右边一排 chip。对齐了才像个设置面板。 */
const PanelRow = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
    <span style={{ width: 30, flexShrink: 0, fontSize: 11.5, color: T.textLight }}>{label}</span>
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{children}</div>
  </div>
);

// ═══════════════════════════════════════════════════════════════════

const Chip = ({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) => (
  <button
    onClick={onClick}
    style={{
      flexShrink: 0,
      padding: '5px 12px',
      borderRadius: T.pill,
      fontSize: 12.5,
      fontWeight: on ? 600 : 400,
      color: on ? '#fff' : T.textSoft,
      background: on ? T.text : T.s3,
      border: 'none',
      whiteSpace: 'nowrap',
    }}
  >
    {children}
  </button>
);

const Row = ({
  row,
  companies,
  enums,
  open,
  onToggle,
  onOpenChat,
  onDone,
  onDelete,
}: {
  row: RecordRow;
  companies: Company[];
  enums: EnumSet | null;
  open: boolean;
  onToggle: () => void;
  onOpenChat?: (threadId: string) => void;
  onDone: () => void;
  onDelete: () => void;
}) => {
  const st = STATUS[row.status] ?? { label: row.status, fg: T.textSoft, bg: T.s3 };
  const f = eff(row);
  const type = label(enums?.recordType, f.recordType) || t('速记');
  const company = nameOf(row, companies) ?? t('未定客户');
  const summary = row.title || firstLine(row.text) || (row.audio_seconds ? '（语音）' : t('（无正文）'));

  return (
    <div style={{ borderBottom: `1px solid ${T.lineLight}` }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%',
          display: 'grid',
          gridTemplateColumns: '38px 1fr auto',
          gap: 8,
          alignItems: 'start',
          textAlign: 'left',
          padding: '9px 2px',
          background: open ? T.s2 : 'transparent',
        }}
      >
        <span style={{ fontSize: 11.5, color: T.textLight, paddingTop: 1 }}>
          {fmtDay(row.captured_at)}
        </span>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <b style={{ fontSize: 13.5, fontWeight: 600 }}>{company}</b>
            <span style={{ fontSize: 11, color: T.textLight, flexShrink: 0 }}>{type}</span>
            {row.attachments > 0 && (
              <span style={{ fontSize: 11, color: T.textLight, flexShrink: 0 }}>
                📎{row.attachments}
              </span>
            )}
          </span>
          <span
            style={{
              display: 'block',
              fontSize: 12,
              color: T.textSoft,
              marginTop: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {summary}
          </span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0, paddingTop: 1 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 500,
              color: st.fg,
              background: st.bg,
              borderRadius: T.pill,
              padding: '2px 8px',
              whiteSpace: 'nowrap',
            }}
          >
            {t(st.label)}
          </span>
          <span
            style={{
              color: T.textLight,
              display: 'inline-flex',
              transform: open ? 'rotate(90deg)' : 'none',
            }}
          >
            <IconChevron size={14} />
          </span>
        </span>
      </button>

      {open && (
        <div style={{ padding: '2px 2px 12px' }}>
          <Detail row={row} companies={companies} onOpenChat={onOpenChat} onDone={onDone} />
          {/**
           * 🔴 删除**只在展开之后才出现**（issue #25：「不能因为误触删除」）。
           *
           * 挂在收起态的那一行上，就等于在一张要靠拇指滚动的表格里
           * 每一行都放了一个垃圾桶 —— 展馆里边走边看，误触是必然的。
           * 现在要删一条得先点开它、看清是哪一条，再点删除，再在确认框里
           * 看清会连带删掉 CRM 里的什么。三步里有两步是**读信息**，不是重复点击。
           *
           * ── 但它得看得见（D106 · issue #35）───────────────────────────
           *
           * 维护者 2026-08-11：「希望把看板中的删除按钮做得更显眼一些，
           * 让用户更容易发现这个操作入口，同时仍然保持和现有页面风格一致。」
           *
           * 原来是一行 12px 的**浅灰小字**，颜色和它上面那些说明文字一模一样 ——
           * 在一屏灰字里它读起来像一句注释，不像一个能按的东西。
           * 现在：红字 + 红描边 + 撑满一行 + 36px 高（够拇指按）。
           *
           * 🔴 **改的是可见性，不是那道门槛。** 它仍然只在展开之后出现，
           *    确认框仍然会先列出会连带删掉 CRM 里的哪几条 —— issue 的
           *    最后一句写着「不改变现有删除逻辑」，这里一行逻辑都没动。
           */}
          <div style={{ display: 'flex', marginTop: 12 }}>
            <button
              onClick={onDelete}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                height: 36,
                borderRadius: 10,
                border: `1px solid ${T.red}40`,
                background: T.redSoft,
                color: T.red,
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              <IconTrash size={15} />
              {t('删除这条记录')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * 展开之后看到什么 —— **完全由状态决定**。
 *
 * 已入库（含正在写入的）→ 核对卡的重录模式，可以改（D75）。
 * 其余一律只读 + 一个「去对话里看」的出口：确认要看 AI 的工作日志和上下文，
 * 那是对话页的事，一张表格给不了（维护者 2026-08-07：「确认这边只走对话」）。
 */
const Detail = ({
  row,
  companies,
  onOpenChat,
  onDone,
}: {
  row: RecordRow;
  companies: Company[];
  onOpenChat?: (threadId: string) => void;
  onDone: () => void;
}) => {
  const toChat =
    row.thread_id && onOpenChat ? (
      <button
        className="btn sm"
        style={{ marginTop: 8 }}
        onClick={() => onOpenChat(row.thread_id!)}
      >
        {row.status === 'ready' ? t('去对话里确认') : t('去对话里看')} →
      </button>
    ) : (
      // 🔴 没有对话就说出来。给一个点不动的按钮，人会以为是自己没点中
      <div style={{ marginTop: 8, fontSize: 11.5, color: T.textLight, lineHeight: 1.8 }}>
        {t('这条还没交给 AI 整理过 —— 去「速记」页找到它，点「发给 AI」。')}
      </div>
    );

  if (['confirmed', 'confirming', 'committing'].includes(row.status)) {
    return (
      <>
        <ReviewCard
          stagingId={row.id}
          extracted={row.extracted ?? {}}
          confidence={row.confidence ?? undefined}
          suggestedCompany={row.suggested_company}
          partial={row.partial ?? undefined}
          status={row.status}
          confirmAfter={row.confirm_after}
          twentyRefs={row.twenty_refs}
          confirmedFields={row.confirmed_fields}
          stagingError={row.error}
          initialCompany={
            companies.find(
              (c) => c.id === row.resolved_company_id || c.code === codeOf(row, companies),
            ) ?? null
          }
          onDone={onDone}
        />
        {row.thread_id && onOpenChat && toChat}
      </>
    );
  }

  return (
    <div style={{ fontSize: 12.5, color: T.textSoft, lineHeight: 1.8, padding: '4px 2px' }}>
      <div style={{ whiteSpace: 'pre-wrap', marginBottom: 6 }}>
        {row.text || t('（这条只有语音，转写还没回来）')}
      </div>

      {/**
       * 🔴 被取代的必须说出来（issue #14）。「看不见」和「不存在」分不开的话，
       * 下次有人怀疑数据丢了，没有任何地方能回答他。
       */}
      {row.status === 'superseded' && (
        <div style={{ fontSize: 11.5, color: T.textLight }}>
          {t('同一条对话后面又改过一次，这一版被那次取代了 —— 原话和抽取结果都还在。')}
        </div>
      )}
      {(row.supersedes ?? 0) > 0 && (
        <div style={{ fontSize: 11.5, color: T.textLight }}>
          {t('这条对话前面还有 {a} 版，已被这一版取代（原话都还在）', { a: row.supersedes })}
        </div>
      )}
      {row.status === 'failed' && row.error && (
        <div
          style={{
            fontSize: 11.5,
            color: T.red,
            background: T.redSoft,
            borderRadius: 10,
            padding: '8px 10px',
            marginTop: 4,
            lineHeight: 1.7,
          }}
        >
          {row.error}
        </div>
      )}
      {row.status === 'ready' && (
        <div style={{ fontSize: 11.5, color: T.textLight }}>
          {t('AI 已经整理好了，等你确认 —— 确认要看它整轮的工作日志，所以那一步在对话里做。')}
        </div>
      )}

      {toChat}
    </div>
  );
};
