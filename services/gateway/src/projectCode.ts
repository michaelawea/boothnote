import { sql } from './db.ts';
import { nextProjectCode } from './twenty.ts';

/**
 * 项目编号从哪来。**三个调用点共用这一份**（D91）。
 *
 * ══ 为什么要有这个文件 ═══════════════════════════════════════════
 *
 * 编号原来只在**确认入库那一刻**才生成（`confirm.ts` 的兜底）。
 * 后果是 issue #18 里那句话：「待确认阶段根本没有稳定的项目标识可以拿来分组」——
 * 早上录一条 CI-Bus 的需求、下午另开一条对话补时间线，是两条 staging，
 * 而在人眼里那是**同一个项目**。看板没有任何键可以把它们并起来。
 *
 * 名字串不能当键（§4.2 第 3 条）：销售那份 Excel 就是用名字做关联键散架的
 * （品牌名单交集 32/61，集团名三份交集为 0）。所以键只能是编号，
 * 而编号必须**提前到提案那一刻**定下来。
 *
 * ══ 三个调用点，一份实现 ═════════════════════════════════════════
 *
 *   · `agent/src/tools/project.ts` 的 `propose_project` → `reserveProjectCode()`（会写）
 *   · `index.ts` 的 `GET /staging/:id/targets`        → `suggestProjectCode()`（只读）
 *   · `confirm.ts` 的入库兜底                          → `suggestProjectCode()`（只读）
 *
 * 各算各的代价这个仓库付过：卡片上显示的编号和真写进去的不是一个，
 * 人下次去 CRM 里按卡片上那个编号找，找不到。
 *
 * ══ 🔴 两条它必须守住的性质 ═══════════════════════════════════════
 *
 * ① **同一个项目问两次，给的是同一个编号。**（否则 issue #18 白做 ——
 *    第二条对话拿到 `-002`，看板上仍然是两张卡。）
 *    「同一个项目」的判据是 D56：**同一家客户 + 同一个品类**。
 *    品类还没抽出来时退回「同一家客户 + 同名」—— 这一档弱，但比每次都开新号强。
 *
 * ② **不同的项目问两次，绝不给同一个编号。**（否则第二条入库时
 *    `findProjectByCode` 会命中第一条，走 update 分支 —— 两个项目被静默并成一个，
 *    而界面上一路绿色。这正是这个仓库最贵的那类 bug。）
 *    靠三件事：已发出去的编号从 `staging` 里查得到、`pg_advisory_xact_lock`
 *    把同一家客户的取号串起来、Twenty 里已有的编号是序号下限。
 *
 * ⚠️ **Twenty 连不上时一个编号都不发。** 那时候拿不到「CRM 里已经到几号了」，
 *    发出去的 `-001` 很可能撞上一个已经存在的项目 —— 而撞上的后果是上面②那条。
 *    宁可让编号继续空着（人在核对卡上还能拿到一个），也不发一个可能是错的。
 */

/** 一条已经占住某个编号的提案（含已入库的 —— 它那行 staging 还在）。 */
export type CodedRow = {
  stagingId: string;
  code: string;
  category: string | null;
  name: string | null;
};

export type CodeAsk = {
  /** 客户代号（`accountCode`，如 EHG-HAVEL）。**没有就不发号** —— 前缀就是它。 */
  companyCode: string | null | undefined;
  /** 品类。D56 的项目身份的另一半。 */
  category?: string | null;
  /** 项目名。只在品类还没抽出来时当退路用，**永远不作为主键**。 */
  name?: string | null;
  /** 排除自己那一行 —— 同一条速记重跑时不能把上一轮的自己算成「别的提案」。 */
  stagingId?: string | null;
  /** 只有测试会传。 */
  now?: Date;
};

const NORM = (s: unknown) => String(s ?? '').trim().toUpperCase().replace(/[\s-]+/g, '');

/** `EHG-HAVEL` + 2026 → `EHG-HAVEL-2026`。编号里只留 `[A-Z0-9-]`。 */
export const codeBase = (companyCode: string, year: number): string =>
  `${String(companyCode).toUpperCase().replace(/[^A-Z0-9-]/g, '')}-${year}`
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

/** `EHG-HAVEL-2026-007` → 7。不是这个 base 下的编号 → null。**纯函数。** */
export const seqOf = (base: string, code: string | null | undefined): number | null => {
  const c = String(code ?? '').trim().toUpperCase();
  const b = base.toUpperCase();
  if (!c.startsWith(`${b}-`)) return null;
  const tail = c.slice(b.length + 1);
  return /^\d+$/.test(tail) ? Number(tail) : null;
};

/**
 * 这个 base 下一个没被占的序号。**纯函数。**
 *
 * `floor` 是 Twenty 那边给的下限（CRM 里已经到几号了）。两边取大的那个 ——
 * 只看 staging 会撞上 CRM 里手工建的项目，只看 CRM 会撞上还没入库的提案。
 */
export const nextFreeSeq = (base: string, used: Iterable<string>, floor = 1): number => {
  let max = floor - 1;
  for (const c of used) {
    const n = seqOf(base, c);
    if (n !== null) max = Math.max(max, n);
  }
  return max + 1;
};

/**
 * 候选里哪一条和「我」是同一个项目。**纯函数。**
 *
 * 🔴 **顺序是承重的**：品类先、名字后。
 * D56 说项目身份 = 客户 + 品类，那是**一个枚举**，对得上就是同一个项目。
 * 名字那一档只在品类还没抽出来时兜底（`propose_project` 可能跑在
 * `propose_fields` 前面），而且要过 `NORM`（大小写、空格、短横线都不算数）——
 * 但它**永远不是主键**：「Istra 电池项目」和「Istra 锂电项目」是同一个项目，
 * 名字比不出来，品类比得出来。
 */
export const sameProject = (
  candidates: CodedRow[],
  want: { category?: string | null; name?: string | null },
): CodedRow | null => {
  const cat = String(want.category ?? '').trim();
  if (cat) {
    const hit = candidates.find((c) => String(c.category ?? '').trim() === cat);
    if (hit) return hit;
  }
  const n = NORM(want.name);
  if (n) {
    /**
     * 🔴 **名字这一档不许翻过品类那道墙。**
     *
     * 我知道自己是 INVERTER、候选那条是 BATTERY，就算名字一模一样
     * （「CI-Bus 电池项目」这种名字后面接着开逆变器的线，现场很常见），
     * 它们也是两个项目 —— 复用编号的后果是入库时 `findProjectByCode` 命中，
     * 第二条 **update 掉**第一条：两个项目静默并成一个，界面一路绿色。
     * 所以品类已知时，名字只能去认那些**品类还空着**的候选。
     * （这条是被 `__tests__/projectCode.test.ts` 里那个用例逼出来的。）
     */
    const hit = candidates.find(
      (c) => NORM(c.name) === n && !(cat && String(c.category ?? '').trim()),
    );
    if (hit) return hit;
  }
  return null;
};

/** 取号的全部判断，**纯函数**（用例见 `__tests__/projectCode.test.ts`）。 */
export const pickCode = (
  rows: CodedRow[],
  ask: {
    companyCode: string;
    category?: string | null;
    name?: string | null;
    year: number;
    /** `nextProjectCode()` 的返回值。null = Twenty 没问到，调用方应当放弃发号。 */
    twentyNext: string | null;
  },
): { code: string; reused: boolean } => {
  /**
   * 只看这家客户的编号。
   * ⚠️ 比前缀时**带上那个短横线**：不带的话代号 `EHG` 会把 `EHG-HAVEL-…` 也算进来，
   * 于是两家客户共用一条序号，早晚撞号。
   */
  const head = `${ask.companyCode.toUpperCase()}-`;
  const mine = rows.filter((r) => r.code.toUpperCase().startsWith(head));

  const reuse = sameProject(mine, ask);
  if (reuse) return { code: reuse.code, reused: true };

  const base = codeBase(ask.companyCode, ask.year);
  const floor = seqOf(base, ask.twentyNext) ?? 1;
  const seq = nextFreeSeq(
    base,
    mine.map((r) => r.code),
    floor,
  );
  return { code: `${base}-${String(seq).padStart(3, '0')}`, reused: false };
};

/**
 * 已经占住编号的那些 staging 行。
 *
 * 编号的三个落点按「人 > agent > 回执」取（和看板 `eff()` 同一个顺序）：
 * 人在核对卡上改过的那一版最大，其次是 agent 写进提案的，
 * 最后是入库回执里的 —— 回执覆盖的是**这次改动之前就已经入库**的老记录，
 * 它们的 `extracted.project` 里没有编号，但 CRM 里实打实有一个项目。
 *
 * ⚠️ `superseded` 的不算：那一版已经被同一条对话后面的修改取代，
 * 它占着的号应该让给取代它的那一版（同一条对话 = 同一个提案）。
 */
const codedRows = async (
  /** `sql` 或事务里的那个 `sql` —— 这里只用到「打标签发一条查询」这一件事。 */
  tx: <T extends readonly unknown[]>(t: TemplateStringsArray, ...a: never[]) => Promise<T>,
  excludeStagingId: string | null,
): Promise<CodedRow[]> => {
  const rows = await tx<
    Array<{ staging_id: string; code: string; category: string | null; name: string | null }>
  >`
    select x.staging_id, x.code, x.category, x.name from (
      select s.id as staging_id, s.created_at,
             coalesce(nullif(s.confirm_payload->'fields'->>'projectCode', ''),
                      nullif(s.extracted->'project'->>'projectCode', ''),
                      nullif(s.extracted->>'projectCode', ''),
                      nullif(s.twenty_refs->>'projectUpdated', ''),
                      nullif(s.twenty_refs->>'projectCodeGenerated', '')) as code,
             nullif(s.extracted->>'category', '') as category,
             nullif(s.extracted->'project'->>'name', '') as name
        from staging s
       where s.status <> 'superseded'
    ) x
    where x.code is not null
    order by x.created_at desc
    limit 500`;
  return rows
    .filter((r) => r.staging_id !== excludeStagingId)
    .map((r) => ({
      stagingId: r.staging_id,
      code: r.code,
      category: r.category,
      name: r.name,
    }));
};

/**
 * 这家客户名下**还没入库的项目提案**（issue #18 的另一半）。
 *
 * 🔴 **`get_projects` 只查 Twenty，而 issue #18 的主场景恰恰是「两条都还没入库」** ——
 * 早上录一条需求（提案拿到 HAVEL-2026-001，还在等人确认），下午另开一条对话补时间线。
 * 下午那一轮 `get_projects` 在 CRM 里什么都查不到，于是 agent
 * **没有任何办法知道上午那个项目存在** —— 要么开一个新号，要么（实测过）
 * 抓一个名字沾边的别家项目的编号来用。
 *
 * 这是这个仓库反复踩的同一个形状：**指令给了、能力没给**
 * （issue #17 根因 C 的原话）。所以这里把待确认的那些也交出去，
 * 由 `get_projects` 和 CRM 里的一起列给模型看，并标明「还没入库」。
 *
 * 只读，Ring 1。
 */
export const pendingProjectProposals = async (
  companyCode: string | null | undefined,
  excludeStagingId?: string | null,
): Promise<Array<{ code: string; name: string | null; category: string | null }>> => {
  const head = String(companyCode ?? '').trim().toUpperCase();
  if (!head) return [];
  const rows = await sql<Array<{ code: string; name: string | null; category: string | null }>>`
    select x.code, x.name, x.category from (
      select s.id as staging_id, s.created_at,
             nullif(coalesce(s.confirm_payload->'fields'->>'projectCode',
                             s.extracted->'project'->>'projectCode'), '') as code,
             nullif(s.extracted->'project'->>'name', '')  as name,
             nullif(s.extracted->>'category', '')         as category
        from staging s
       where s.status not in ('superseded', 'confirmed')
    ) x
    where x.code is not null and upper(x.code) like ${`${head}-%`}
      and (${excludeStagingId ?? null}::uuid is null or x.staging_id <> ${excludeStagingId ?? null}::uuid)
    order by x.created_at desc
    limit 20`;
  // 同一个编号可能有好几条对话在提，列一次就够
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.code) && seen.add(r.code));
};

/** 拿到一个编号，**但不占住它**。给「只是想显示一下」的地方用。 */
export const suggestProjectCode = async (
  ask: CodeAsk,
): Promise<{ code: string; reused: boolean } | null> => {
  const companyCode = String(ask.companyCode ?? '').trim().toUpperCase();
  if (!companyCode) return null;
  const year = (ask.now ?? new Date()).getUTCFullYear();
  const twentyNext = await nextProjectCode(codeBase(companyCode, year)).catch(() => null);
  // Twenty 没问到就一个号都不发 —— 理由见文件头 ⚠️ 那一段
  if (!twentyNext) return null;
  const rows = await codedRows(sql, ask.stagingId ?? null);
  return pickCode(rows, { ...ask, companyCode, year, twentyNext });
};

/**
 * 拿到一个编号**并当场占住它** —— 写进 `staging.extracted.project.projectCode`。
 *
 * 🔴 **「占住」就是写进 staging，没有第二本账。**
 * 建一张 `project_code_reservation` 表是能给唯一约束，但那样「这个项目的编号是几」
 * 就有了两个说法：人在核对卡上把编号改掉之后，台账那份立刻是错的，
 * 而看板、`confirm.ts`、CRM 三处读的都是 staging 那份。
 * 这个仓库为「同一件事两份真相」付过账（issue #17 里 `list_enums` 和 `/enums` 各一份）。
 *
 * 🔴 并发靠 `pg_advisory_xact_lock`：**按客户代号**上锁，同一家客户的取号排成一队。
 * 不上锁的话两条速记同时提案会拿到同一个号，而它们要是不同品类，
 * 第二条入库时会 update 掉第一条的项目 —— 静默地把两个项目并成一个。
 * 锁只在这一小段事务里，不同客户互不阻塞。
 */
export const reserveProjectCode = async (
  stagingId: string,
  ask: CodeAsk,
): Promise<{ code: string; reused: boolean } | null> => {
  const companyCode = String(ask.companyCode ?? '').trim().toUpperCase();
  if (!companyCode) return null;
  const year = (ask.now ?? new Date()).getUTCFullYear();
  // 🔴 问 Twenty 那一下放在锁**外面** —— 别把一次 HTTP 往返关在事务里，
  //    Twenty 慢一秒就是全家客户的取号排队等一秒
  const twentyNext = await nextProjectCode(codeBase(companyCode, year)).catch(() => null);
  if (!twentyNext) return null;

  return await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`boothnote:projectcode:${companyCode}`}))`;
    const rows = await codedRows(tx, stagingId);
    const got = pickCode(rows, { ...ask, companyCode, year, twentyNext });
    /*
     * 在锁里就把它写下去 —— 提案对象是调用方随后 stash 的（编号一样），
     * 但「占住」这件事不能等到那时候：中间只要有一次并发取号就会拿到同一个号。
     */
    await tx`
      update staging
         set extracted = jsonb_set(
               coalesce(extracted, '{}'::jsonb),
               '{project}',
               coalesce(extracted->'project', '{}'::jsonb)
                 || jsonb_build_object('projectCode', ${got.code}::text),
               true)
       where id = ${stagingId}`;
    return got;
  });
};
