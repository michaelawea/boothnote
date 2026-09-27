/**
 * 清 `boothnote` 库的那几张表 —— **只有这一份实现**（D115）。
 *
 * 为什么抽出来：这段流程会**临时关掉三张表的「只增不改」触发器**
 * （`inbox` / `thread_message` / `attachment`，§4.2 第 2 条）。那是整个项目
 * 最硬的一条纪律，而「关了忘了开」的后果是**它从此静默失效，没有人会发现**。
 *
 * 🔴 **判据：一段必须被精确执行的流程只能有一个定义处**（D81）。
 * 两个脚本要清同一批表（`reset-testdata.mjs` 清本地、`reset-entry-data.mjs`
 * 清一个环境的全部录入），抄两份的话，其中一份迟早会漏掉「装回去」或漏掉自检 ——
 * 而漏掉的那一份不会报错，它会打印「清完了」。
 *
 * 安全性质（三条，缺一条这个模块就不该被信任）：
 *   ① 关和开在**同一个事务**里 —— 中途炸了整体回滚，不会留下守卫关着的库；
 *   ② 跑完**必须**逐个回读 `pg_trigger`，没装回去就抛，让调用方以非零码退出；
 *   ③ 删除顺序 = 外键的反方向，写死在 `TABLES` 里，调用方不要自己排。
 */

/** 只增不改的三张表 —— 触发器名写死在这里，跑完要逐个验回来。 */
export const GUARDED = [
  ['inbox', 'inbox_no_update'],
  ['thread_message', 'thread_message_no_update'],
  ['attachment', 'attachment_no_update'],
];

/** 删除顺序 = 外键的反方向。**别改顺序**，改了会撞外键。 */
export const TABLES = [
  'survey_response', // D138 2C 问卷中转表 —— 只挂 app_user，谁都不指向它，放哪都行；没有触发器
  'attachment_text',
  'attachment',
  'agent_run',
  'thread_message',
  'intel_field_log',
  'staging',
  'inbox',
  'thread',
];

/** 每张表现在有多少行（给预览用）。 */
export const countBoothnote = async (sql) => {
  const out = {};
  for (const t of TABLES) {
    const [r] = await sql.unsafe(`select count(*)::int as n from ${t}`);
    out[t] = r.n;
  }
  return out;
};

/**
 * 真删。删完自检触发器，**没装回去就抛**。
 *
 * @param sql      postgres 客户端（services/gateway/src/db.ts 导出的那个）
 * @param onTable  每删完一张表回调一次，给调用方打日志用
 * @returns 三个触发器的自检结果
 */
export const wipeBoothnote = async (sql, onTable = () => {}) => {
  await sql.begin(async (tx) => {
    for (const [t, trg] of GUARDED) await tx.unsafe(`alter table ${t} disable trigger ${trg}`);
    for (const t of TABLES) {
      await tx.unsafe(`delete from ${t}`);
      onTable(t);
    }
    for (const [t, trg] of GUARDED) await tx.unsafe(`alter table ${t} enable trigger ${trg}`);
  });

  // ── 🔴 自检：三个守卫必须都回来了 ────────────────────────────────
  const checks = [];
  for (const [t, trg] of GUARDED) {
    const [r] = await sql`
      select tgenabled from pg_trigger where tgname = ${trg}
        and tgrelid = ${t}::regclass and not tgisinternal`;
    // 'O' = origin，正常启用；'D' = disabled；不存在 = undefined
    checks.push({ table: t, trigger: trg, ok: r?.tgenabled === 'O', state: r?.tgenabled ?? '不存在' });
  }

  const broken = checks.filter((c) => !c.ok);
  if (broken.length) {
    throw new Error(
      `🔴 有 ${broken.length} 个「只增不改」触发器没装回去 —— §4.2 第 2 条现在是**失效的**。\n` +
        broken.map((b) => `   立刻手工修：alter table ${b.table} enable trigger ${b.trigger};`).join('\n'),
    );
  }
  return checks;
};
