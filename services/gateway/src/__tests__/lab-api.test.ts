import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { sql } from '../db.ts';
import { env } from '../env.ts';

/**
 * 实验室 agent · 集成测试（真 HTTP + 真库）。
 *
 * ⚠️ 一次性环境里 `OPENAI_API_KEY` 是占位符，所以**模型调用必然失败** ——
 * 这一档验的是「端点这一层」：secret 门、会话窗口、幂等、记账、
 * **以及那条最要紧的：它一条 CRM 记录都不产生**。
 * 模型真的答得对不对，靠单元测试 + 真群里走一遍（测试全绿 ≠ 群里是对的）。
 */

const BASE = process.env.GATEWAY_URL ?? `http://localhost:${env.port}`;

const isLocal = (u: string) => /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(u);
if (!isLocal(BASE) || !/@(localhost|127\.0\.0\.1)[:/]/.test(env.databaseUrl)) {
  const target = (() => {
    try {
      return new URL(BASE).host;
    } catch {
      return BASE;
    }
  })();
  if (process.env.ALLOW_NONLOCAL_TESTS !== target) {
    console.error(`\n🔴 实验室 agent 集成测试只对本地跑。GATEWAY_URL=${BASE}\n`);
    process.exit(1);
  }
}

/**
 * 🔴 **默认和录入 bot 共用一个 secret**（维护者 2026-08-17）——
 * `CHANNEL_LAB_SECRET` 是可选覆盖，没配就回退到 `CHANNEL_DINGTALK_SECRET`。
 * 这里的取值顺序必须和 `env.ts` 里那一行完全一致，否则测的就不是生产那条路径。
 */
const SECRET = process.env.CHANNEL_LAB_SECRET || process.env.CHANNEL_DINGTALK_SECRET || '';
const RUN = Boolean(SECRET);
if (!RUN) console.error('⏭ 两个 secret 都没配 —— 实验室 agent 整档 skip');

after(async () => {
  await sql.end({ timeout: 5 });
});

const SUFFIX = randomUUID().slice(0, 8);
const GROUP = `itest 实验室群 ${SUFFIX}`;
let clock = 1_755_500_000_000;

const post = async (content: string, sender: string, extra: Record<string, unknown> = {}, secret = SECRET) => {
  const res = await fetch(`${BASE}/channels/lab/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Channel-Secret': secret },
    body: JSON.stringify({
      message: {
        content,
        images: [],
        sender,
        send_time: (clock += 1000),
        group_name: GROUP,
        mentioned_users: [],
        ...extra,
      },
    }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
};

describe('实验室 agent · 入口', { skip: !RUN }, () => {
  it('错 secret → 401', async () => {
    assert.equal((await post('在吗', `x-${SUFFIX}`, {}, 'wrong')).status, 401);
  });

  it('🔴 两个入口共用一个 secret —— 同一把钥匙，两个端点都开得了', async () => {
    const shared = process.env.CHANNEL_DINGTALK_SECRET ?? '';
    if (!shared) return;
    // 录入 bot 那个端点认它（这是它本来的钥匙）
    const toRecorder = await fetch(`${BASE}/channels/dingtalk/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Channel-Secret': shared },
      body: JSON.stringify({
        message: {
          content: '共用 secret 自测：Alpin 想把逆变器换成 3000W，Q4 送样',
          images: [],
          sender: `shared-${SUFFIX}`,
          send_time: (clock += 1000),
          group_name: GROUP,
          mentioned_users: [],
        },
      }),
    });
    assert.equal(toRecorder.status, 200);
    // 实验室这个端点也认它（没配 CHANNEL_LAB_SECRET 时回退到它）
    const toLab = await post('共用 secret 自测：一句话说说 MOQ', `shared-${SUFFIX}`, {}, shared);
    assert.equal(toLab.status, 200);
    assert.ok(['final', 'ack'].includes(toLab.json.kind));
  });

  it('只 @ 不说话 → 提示「我看不到群里其他消息」，不跑模型', async () => {
    const r = await post('   ', `empty-${SUFFIX}`);
    assert.equal(r.json.kind, 'final');
    assert.match(r.json.ding.markdown.text, /看不到群里其他消息/);
    assert.equal(r.json.runId ?? null, null, '没跑就不该有 run');
  });

  it('帮助：说清它是谁、窗口多久、以及**它不负责录入**', async () => {
    const r = await post('帮助', `help-${SUFFIX}`);
    assert.equal(r.json.kind, 'final');
    const t = r.json.ding.markdown.text;
    assert.match(t, /实验室助手/);
    assert.match(t, /不负责录入/);
    assert.match(t, new RegExp(`${env.labSessionWindowMin} 分钟`));
  });

  it('🔴 只拉了实验室 bot 的群也要自动登记 —— 否则它在管理台上不存在，webhook 没地方填', async () => {
    // 用一个只有实验室 bot 见过的群名（帮助命令不烧模型，够触发登记）
    const soloGroup = `itest 实验室独占群 ${SUFFIX}`;
    const r = await post('帮助', `solo-${SUFFIX}`, { group_name: soloGroup });
    assert.equal(r.status, 200);
    // 🔴 登记在 channel='dingtalk' 那一行（webhook 是群的投递口，两个 bot 共用一行、只配一次）
    const [convo] = await sql<Array<{ title: string | null }>>`
      select title from channel_conversation
      where channel = 'dingtalk' and conversation_key = ${soloGroup}`;
    assert.ok(convo, '实验室入口也要登记群，不然管理台上看不见它');
    assert.equal(convo!.title, soloGroup);
  });

  it('正常一句：落 lab_run、@ 提问人、回答有着落（sync 或 ack 都算）', async () => {
    const sender = `ask-${SUFFIX}`;
    const r = await post('一句话说说 MOQ 是什么意思', sender);
    assert.equal(r.status, 200);
    assert.ok(['final', 'ack'].includes(r.json.kind));
    assert.ok(r.json.runId);
    assert.deepEqual(r.json.ding.at, { atUserIds: [sender], isAtAll: false });

    const [row] = await sql<Array<{ prompt: string; session_id: string; delivery: string }>>`
      select prompt, session_id, delivery from lab_run where id = ${r.json.runId}`;
    assert.match(row!.prompt, /MOQ/);
    assert.ok(row!.session_id);
  });

  it('🔴 会话窗口：同群同人第二句沿用同一个 session；把 last_at 拨老之后重开', async () => {
    const sender = `sess-${SUFFIX}`;
    const a = await post('第一句', sender);
    const b = await post('第二句', sender);
    const rows = await sql<Array<{ session_id: string }>>`
      select session_id from lab_run where id in (${a.json.runId}, ${b.json.runId})`;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.session_id, rows[1]!.session_id, '窗口内 = 同一段对话');

    // 把最后活动时间拨到窗口之外 —— 下一句应当换一个新 session
    await sql`
      update lab_session set last_at = now() - interval '10 hours'
      where conversation_key = ${GROUP} and sender = ${sender}`;
    const c = await post('隔天再来一句', sender);
    const [after2] = await sql<Array<{ session_id: string }>>`
      select session_id from lab_run where id = ${c.json.runId}`;
    assert.notEqual(after2!.session_id, rows[0]!.session_id, '超窗 = 重开一段');
  });

  it('两个人在同一个群里各聊各的，session 不串线', async () => {
    const a = await post('我问的问题', `p1-${SUFFIX}`);
    const b = await post('我问的另一个问题', `p2-${SUFFIX}`);
    const [ra] = await sql<Array<{ session_id: string }>>`select session_id from lab_run where id = ${a.json.runId}`;
    const [rb] = await sql<Array<{ session_id: string }>>`select session_id from lab_run where id = ${b.json.runId}`;
    assert.notEqual(ra!.session_id, rb!.session_id);
  });

  it('幂等：同一份报文重放不重跑', async () => {
    const sender = `dup-${SUFFIX}`;
    const first = await post('会重放的一句', sender);
    // 同样的 send_time + 同样的正文 = 同一份报文
    clock -= 1000;
    const again = await post('会重放的一句', sender);
    assert.equal(again.json.kind, 'final');
    assert.match(again.json.ding.markdown.text, /重复投递/);
    assert.notEqual(again.json.runId, first.json.runId);
    const [dup] = await sql<Array<{ delivery: string; text: string }>>`
      select delivery, text from lab_run where id = ${again.json.runId}`;
    assert.equal(dup!.delivery, 'sync');
    assert.match(dup!.text, /重复投递/);
  });

  it('🔴 装了 skill 之后，工具清单在真进程里也只有那四个', async () => {
    // 从跑着的网关问 —— 单测验的是模块，这条验的是**这个进程真的这么跑**
    const { labTools } = await import('../../agent/src/lab.ts');
    const names = labTools().map((t) => t.name);
    assert.ok(names.includes('read_skill'));
    assert.ok(names.includes('search_specs'));
    assert.ok(names.includes('find_document'));
    assert.ok(names.length <= 4, `多了工具：${names.join(',')}`);
  });

  it('🔴 跑了这么多轮，CRM 侧一条记录都没产生（它没有那个能力）', async () => {
    const [n] = await sql<Array<{ n: number }>>`
      select count(*)::int as n from inbox where source = 'dingtalk-lab'`;
    assert.equal(n!.n, 0);
    const [s] = await sql<Array<{ n: number }>>`
      select count(*)::int as n from staging s join inbox i on i.id = s.inbox_id
      where i.text like '%MOQ%' and i.source <> 'note'`;
    assert.equal(s!.n, 0, '实验室 agent 不许在 staging 里留下任何东西');
  });
});
