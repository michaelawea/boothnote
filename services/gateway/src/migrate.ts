import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from './db.ts';

/** 按编号顺序跑 migrations/*.sql，已跑过的跳过。部署到 VPS 时同一套命令。 */
const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

await sql`
  create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`;

const done = new Set((await sql`select name from schema_migrations`).map((r) => r.name as string));
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

let applied = 0;
for (const f of files) {
  if (done.has(f)) {
    console.log(`  ⏭  ${f}`);
    continue;
  }
  await sql.begin(async (tx) => {
    await tx.unsafe(readFileSync(join(DIR, f), 'utf8'));
    await tx`insert into schema_migrations (name) values (${f})`;
  });
  console.log(`  ✅ ${f}`);
  applied++;
}

/**
 * 🔴 **「库里比镜像里还新」= 镜像是旧的，而这一步会「成功」且什么都不做。**
 *
 * 2026-08-04 实测撞到：本地忘了先 `build` 就跑
 * `docker compose run --rm --no-deps gateway node src/migrate.ts`，
 * 输出是
 *
 *     ⏭  001_init.sql
 *     无待执行迁移。
 *
 * —— 退出码 0，看着一切正常。真相是那个镜像是很久以前 build 的，
 * 里面**只有 001**（`migrations/` 是 COPY 进镜像的，Dockerfile 第 12 行）。
 * 002–005 它压根看不见，于是「没有待执行的」这句话字面上是对的、实质上是假的。
 *
 * 这正是这个仓库栽过三次的那个形状（D65 · issue #2 · issue #5）：
 * **一步静默地什么都没做，而部署一路绿到「完成」。**
 *
 * 判据很简单：**库里记着跑过的迁移，镜像里却找不到那个文件** ——
 * 只可能是镜像比库旧。这种时候必须**中止**，不能报成功：
 * 后面 `up -d gateway` 起来的会是同一个旧镜像，而它面对的是新库。
 */
const missing = [...done].filter((n) => !files.includes(n)).sort();
if (missing.length) {
  console.error(
    `\n🔴 库里记着 ${missing.length} 个迁移，而这个镜像里没有它们的文件：\n` +
      missing.map((m) => `     · ${m}`).join('\n') +
      `\n\n   镜像里只有 ${files.length} 个：${files.join(', ') || '(一个都没有)'}\n` +
      `   **说明这个镜像比数据库旧** —— migrations 是 COPY 进镜像的，不是挂载的。\n` +
      `   先 build 再跑：\n` +
      `     docker compose --profile prod build gateway\n` +
      `     docker compose --profile prod run --rm --no-deps gateway node src/migrate.ts\n`,
  );
  await sql.end();
  process.exit(1);
}

console.log(
  applied
    ? `\n迁移完成，新执行 ${applied} 个（镜像里共 ${files.length} 个）。`
    : `\n无待执行迁移（镜像里共 ${files.length} 个，都跑过了）。`,
);
await sql.end();
