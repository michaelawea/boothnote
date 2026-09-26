#!/usr/bin/env node
/**
 * 让一句真话穿过整条链路，然后把每一步摊开给人看。
 *
 *   node scripts/e2e-agent.mjs
 *   node scripts/e2e-agent.mjs "刚跟 Istra 聊完，他们在看 200Ah 锂电"
 *
 * 这是**排查工具**，不是测试 —— 它会真的调 OpenAI（花钱），会真的往
 * Twenty 里写情报项。所以：
 *   · 只对本地跑，非本地直接拒绝（和集成测试同一道守卫）
 *   · 建一个临时账号，跑完立刻停用（`inbox` 只增不改，账号删不掉，只能停用）
 *
 * 什么时候用它：agent 抽不出东西、抽错了、或者你想知道它到底调了哪几个工具。
 * `staging.agent_trace` 和 `agent_run` 表里也有同样的信息，这个脚本只是排好版。
 */
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { sql } = await import(join(ROOT, 'services/gateway/src/db.ts'));
const { hashPassword } = await import(join(ROOT, 'services/gateway/src/password.ts'));
const { env } = await import(join(ROOT, 'services/gateway/src/env.ts'));

const BASE = process.env.GATEWAY_URL ?? `http://localhost:${env.port}`;

// ── 守卫：非本地一律拒跑（会写数据、会花钱）─────────────────────────
const isLocal = (u) => /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(u);
if (!isLocal(BASE) || !/@(localhost|127\.0\.0\.1)[:/]/.test(env.databaseUrl)) {
  console.error(`
🔴 这个脚本只对本地跑（会建账号、会调 OpenAI、会往 Twenty 写情报项）。
   GATEWAY_URL      = ${BASE}
   APP_DATABASE_URL = ${env.databaseUrl.replace(/:\/\/[^@]*@/, '://***@')}
`);
  process.exit(1);
}

const TEXT =
  process.argv[2] ??
  '刚从 Rozenfelt 展台出来，他们逆变器现在用 Voltaro，2000 瓦那款，明年想换供应商，' +
    '说是 2026 年第四季度定点。年产大概 12000 台。另外他们提到底盘配额今年只有 8000 个，这个卡着他们产能。';

const line = (s = '') => console.log(s);
const rule = (t) => line(`\n\x1b[1m── ${t} ${'─'.repeat(Math.max(0, 56 - t.length))}\x1b[0m`);

// ── 临时账号 ───────────────────────────────────────────────────────
const code = `e2e-${randomUUID().slice(0, 8)}`;
const pass = randomUUID();
await sql`insert into app_user (user_code, display_name, password_hash, role)
          values (${code}, ${'E2E 临时账号'}, ${await hashPassword(pass)}, 'staff')`;

const cleanup = async () => {
  await sql`update app_user set is_active = false, token_version = token_version + 1
            where user_code = ${code}`;
  await sql.end();
};

try {
  const login = await (
    await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userCode: code, password: pass }),
    })
  ).json();
  if (!login.token) throw new Error(`登录失败：${JSON.stringify(login)}（网关跑起来了吗？）`);
  const auth = { Authorization: `Bearer ${login.token}` };

  rule('这句话');
  line(`  ${TEXT}`);

  const form = new FormData();
  form.append(
    'payload',
    JSON.stringify({
      clientId: randomUUID(),
      text: TEXT,
      visitLabel: 'E2E',
      createdAt: Date.now(),
      /**
       * 🔴 D31（2026-08-05）之后抽取是显式触发 —— 不带这个标记，
       * 这条只是一条纯速记，agent 永远不会跑，下面会一直等到超时。
       * （这个脚本就是抽取链路的排查工具，所以这里永远要 agent。）
       */
      toAgent: true,
    }),
  );
  const up = await (await fetch(`${BASE}/inbox`, { method: 'POST', headers: auth, body: form })).json();
  rule('上行');
  line(`  inbox    ${up.inboxId}`);
  line(`  staging  ${up.stagingId}`);
  line(`  thread   ${up.threadId}`);

  // ── 等 agent ─────────────────────────────────────────────────────
  let st = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    [st] = await sql`select status, extracted, confidence, suggested_company, partial,
                            agent_steps, agent_trace, error
                     from staging where inbox_id = ${up.inboxId}`;
    process.stdout.write(`\r  等 agent… ${st?.status ?? '?'} (${i * 2}s)    `);
    if (st && ['ready', 'failed'].includes(st.status)) break;
  }
  process.stdout.write('\r' + ' '.repeat(40) + '\r');

  rule('工具调用轨迹');
  for (const t of st?.agent_trace ?? [])
    line(
      `  ${t.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${String(t.tool).padEnd(20)} ` +
        `${String(t.ms).padStart(5)}ms  ${String(t.summary).slice(0, 90).replace(/\n/g, ' ⏎ ')}`,
    );
  if (!st?.agent_trace?.length) line('  （一个工具都没调 —— 多半是模型调用本身失败了，看下面的 error）');

  rule('抽出来的字段');
  for (const [k, v] of Object.entries(st?.extracted ?? {})) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    const c = st?.confidence?.[k];
    line(`  ${k.padEnd(16)} ${JSON.stringify(v)}${c ? `   (${c})` : ''}`);
  }

  rule('状态');
  line(`  status      ${st?.status}`);
  line(`  steps       ${st?.agent_steps}${st?.partial ? '   ⚠️ 达到上限，结果可能不全' : ''}`);
  line(`  suggested   ${st?.suggested_company ?? '—'}`);
  if (st?.error) line(`  \x1b[31merror       ${st.error}\x1b[0m`);

  const msgs = await sql`select role, text from thread_message
                         where thread_id = ${up.threadId} order by created_at`;
  rule('对话');
  for (const m of msgs) line(`  [${m.role}] ${String(m.text).replace(/\n/g, '\n         ')}`);

  const fields = await sql`select item_key, question, value, twenty_item_id
                           from intel_field_log where inbox_id = ${up.inboxId}`;
  if (fields.length) {
    rule('agent 当场造的情报字段（D47）');
    for (const f of fields) line(`  ${f.item_key} — ${f.question} = ${f.value}`);
    line('  （weight 一律为 0，不参与完整度算分 —— 护栏③）');
  }

  const runs = await sql`select stop_reason, duration_ms from agent_run
                         where inbox_id = ${up.inboxId} order by created_at desc limit 1`;
  rule('这一轮');
  line(`  ${runs[0]?.stop_reason} · ${runs[0]?.duration_ms}ms`);
  line('');
} finally {
  await cleanup();
}
