import type { FastifyInstance } from 'fastify';

import { sql, type AppUser } from './db.ts';
import {
  SURVEYS,
  backoffSeconds,
  customerName,
  normalizeSurvey,
  surveyBody,
  type Contact,
  type SurveyInput,
} from './survey.ts';
import {
  createConsumerSurvey,
  createEndUserCompany,
  findConsumerSurvey,
  linkSurveyCompany,
  upsertContributor,
} from './twenty.ts';

/**
 * ══════════════════════════════════════════════════════════════════
 *  2C 问卷：手机 → 网关 `survey_response` → Twenty（D138）
 *
 *  维护者 2026-09-27：「全部进入后面的 Twenty 数据库里面，只是客户类型变成终端客户……
 *  因为这个表单内容比较固定，所以不用走 AI，可以直接填表。」
 *
 *  所以这条路**没有 agent、没有 staging、没有确认卡**：表单本身就是结构化的，
 *  人在手机上点完就是最终答案。三段解耦仍然成立 ——
 *    手机本地（Dexie `surveys`）→ 这里 `survey_response`（不依赖 Twenty）→ Twenty
 *  任何一段挂了，前一段的数据都还在。
 *
 *  ── 写 Twenty 的顺序，为什么是这个顺序 ─────────────────────────
 *
 *   ① 先按 `clientId` 查 consumerSurvey —— 有就用它（上一次写到一半）
 *   ② 没有就建 consumerSurvey，id 立刻记进本表
 *   ③ 客户：本表记过 / 问卷上挂着 → 用它；都没有才建一家 END_USER，id 立刻记下
 *   ④ 问卷还没挂客户就挂上
 *
 *  🔴 问卷先建、客户后建：**问卷是资产，客户只是它的一个挂钩。** 问卷有 Twenty 那边
 *  的唯一键（clientId），重试永远不会多出一份；客户没有唯一键，最坏情况是
 *  「建完客户、记 id 之前网关正好被杀」那几毫秒 —— 多出一家空客户，问卷不受影响。
 *  这也是它和 staging 的「committing 不自动重试」不一样的地方：那边没有幂等键。
 * ══════════════════════════════════════════════════════════════════ */

type Row = {
  id: string;
  client_id: string;
  survey_key: string;
  answers: Record<string, unknown>;
  contact: Contact;
  consent_at: Date | null;
  device_created_at: Date | null;
  created_at: Date;
  attempts: number;
  twenty_company_id: string | null;
  twenty_survey_id: string | null;
  user_code: string;
  display_name: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const commit = async (r: Row) => {
  const eventName = SURVEYS[r.survey_key]?.eventName ?? r.survey_key;
  const input: SurveyInput = {
    answers: r.answers,
    contact: r.contact,
    consentAt: r.consent_at ? r.consent_at.toISOString() : null,
  };
  const contributorId = await upsertContributor(r.user_code, r.display_name);

  // ①②
  let surveyId = r.twenty_survey_id;
  let surveyCompany: string | null = null;
  if (!surveyId) {
    const hit = await findConsumerSurvey(r.client_id);
    if (hit) {
      surveyId = hit.id;
      surveyCompany = hit.companyId;
    } else {
      surveyId = await createConsumerSurvey({
        ...surveyBody({
          ...input,
          clientId: r.client_id,
          eventName,
          surveyedAt: (r.device_created_at ?? r.created_at).toISOString(),
        }),
        recordedById: contributorId,
      });
    }
    await sql`update survey_response set twenty_survey_id = ${surveyId} where id = ${r.id}`;
  }

  // ③
  let companyId = r.twenty_company_id ?? surveyCompany;
  if (!companyId) {
    companyId = await createEndUserCompany(customerName(r.contact, eventName, r.client_id));
    await sql`update survey_response set twenty_company_id = ${companyId} where id = ${r.id}`;
  }

  // ④ 已经挂上的不再 PATCH（重试时省一次请求）
  if (surveyCompany !== companyId) await linkSurveyCompany(surveyId, companyId);

  await sql`
    update survey_response
       set status = 'committed', committed_at = now(), last_error = null,
           twenty_company_id = ${companyId}, twenty_survey_id = ${surveyId}
     where id = ${r.id}`;
};

let running = false;

/**
 * 把到期的逐条写进 Twenty。认领是原子的（`for update skip locked` + 改成 committing），
 * 所以 POST 触发的这一轮和心跳那一轮撞在一起也不会写两遍。
 */
export const drainSurveys = async (): Promise<number> => {
  if (running) return 0;
  running = true;
  let done = 0;
  try {
    for (;;) {
      const [r] = await sql<Row[]>`
        update survey_response s
           set status = 'committing', attempts = s.attempts + 1
          from app_user u
         where s.id = (
                 select id from survey_response
                  where status in ('pending','failed') and next_try_at <= now()
                  order by created_at
                  limit 1
                  for update skip locked)
           and u.id = s.user_id
        returning s.*, u.user_code, u.display_name`;
      if (!r) break;
      try {
        await commit(r);
        done++;
      } catch (e) {
        const msg = (e as Error).message.slice(0, 500);
        console.warn(`  ⚠️ 2C 问卷没写进 Twenty（第 ${r.attempts} 次，会自动再试）：${msg}`);
        await sql`
          update survey_response
             set status = 'failed', last_error = ${msg},
                 next_try_at = now() + make_interval(secs => ${backoffSeconds(r.attempts)})
           where id = ${r.id}`;
        // Twenty 连不上的话后面的必然也一样，这一轮到此为止，等下一跳
        break;
      }
    }
  } finally {
    running = false;
  }
  return done;
};

let timer: ReturnType<typeof setInterval> | null = null;

export const startSurveyTicker = () => {
  if (timer) return;
  // 起来先清一次积压，别让重启前没写进去的再等 30 秒
  void drainSurveys().catch(() => {});
  timer = setInterval(() => void drainSurveys().catch(() => {}), 30_000);
  timer.unref?.();
};

export const stopSurveyTicker = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

/**
 * 启动时把上个进程写到一半的放回队列。
 * 可以直接重试 —— 顺序和幂等键见文件顶部（这是和 `resumeConfirming` 故意不同的地方）。
 */
export const resumeSurveys = async () => {
  const back = await sql`
    update survey_response set status = 'pending', next_try_at = now()
     where status = 'committing' returning id`;
  if (back.length) console.log(`  ↻ ${back.length} 份 2C 问卷上次写到一半，放回队列重试`);
};

/** 给 `/agent/health` 的一格：有问卷一直进不去 Twenty 时，冒烟和横幅都看得见。 */
export const surveyHealth = async () => {
  const [r] = await sql<Array<{ waiting: string; failed: string; last_error: string | null }>>`
    select count(*) filter (where status in ('pending','committing'))::text as waiting,
           count(*) filter (where status = 'failed')::text as failed,
           (select last_error from survey_response where status = 'failed'
             order by created_at desc limit 1) as last_error
      from survey_response`;
  return { waiting: Number(r?.waiting ?? 0), failed: Number(r?.failed ?? 0), lastError: r?.last_error ?? null };
};

export const registerSurveys = (
  app: FastifyInstance,
  requireAuth: (req: any, reply: any) => Promise<unknown>,
) => {
  /**
   * 交一份问卷。**幂等**：同一个 `clientId` 再交一次回 200 + 第一次那份 ——
   * 手机断网重传是常态（§4.2 第 6 条），不能因此多出一位客户。
   */
  app.post('/surveys', { preHandler: requireAuth }, async (req, reply) => {
    const b = (req.body ?? {}) as {
      clientId?: unknown;
      surveyKey?: unknown;
      answers?: unknown;
      contact?: unknown;
      consentAt?: unknown;
      createdAt?: unknown;
    };
    if (typeof b.clientId !== 'string' || !UUID.test(b.clientId))
      return reply.code(400).send({ error: 'missing_client_id' });
    if (typeof b.surveyKey !== 'string' || !SURVEYS[b.surveyKey])
      return reply.code(422).send({ error: 'unknown_survey' });

    const n = normalizeSurvey(b);
    if ('error' in n) return reply.code(422).send({ error: n.error });

    const user = req.user as AppUser;
    const created =
      typeof b.createdAt === 'number' && Number.isFinite(b.createdAt) ? new Date(b.createdAt) : null;
    const [row] = await sql<Array<{ id: string; status: string }>>`
      insert into survey_response
        (client_id, user_id, survey_key, answers, contact, consent_at, device_created_at)
      values (${b.clientId}, ${user.id}, ${b.surveyKey}, ${sql.json(n.ok.answers as never)},
              ${sql.json(n.ok.contact as never)}, ${n.ok.consentAt}, ${created})
      on conflict (client_id) do nothing
      returning id, status`;
    if (!row) {
      const [prev] = await sql<Array<{ id: string; status: string; user_id: string }>>`
        select id, status, user_id from survey_response where client_id = ${b.clientId}`;
      // 别人的 id 撞上来（几乎不可能，但 id 是客户端给的）—— 不告诉他那份是什么
      if (!prev || prev.user_id !== user.id) return reply.code(409).send({ error: 'client_id_taken' });
      return reply.code(200).send({ id: prev.id, status: prev.status, duplicate: true });
    }

    // 不等 Twenty：手机那头只关心「网关收下了没有」，进 CRM 是网关自己的事
    void drainSurveys().catch(() => {});
    return reply.code(201).send({ id: row.id, status: row.status });
  });
};
