import { useEffect, useRef, useState } from 'react';

import { T } from '../theme';
import { IconChevron, IconClipboard } from '../icons';
import { Sheet } from '../components/Sheet';
import { t } from '../i18n';
import { setBusy } from '../update';
import { useSession } from '../auth';
import { db, mySurveys } from '../db';
import { flushSurveys } from '../sync';
import { PENDING_STATES } from '../retry';
import {
  EMPTY_CONTACT,
  SURVEY_KEY,
  VDL_2026,
  cycleHaveWant,
  submitState,
  toggleMulti,
  type Answers,
  type Choice,
  type Contact,
  type HaveWant,
  type Question,
} from '../survey';

/**
 * 2C 客户问卷（D136 入口 · D137 题目 · D138 数据）。
 *
 * 一题一段、题与题之间一条细线，不用卡片 —— 六道题要尽量一屏半以内看完
 * （维护者：「问卷问题简化一点，免得占用页面太大」）。
 *
 * 存下来走的是**和速记一样的离线优先**：先进手机本地（Dexie `surveys`），
 * 有网就传给网关，网关直接写进 Twenty（一家「终端客户」+ 一条问卷）。
 * **不走 AI** —— 维护者：「这个表单内容比较固定，所以不用走 AI，可以直接填表。」
 */
export const SurveySheet = ({ onClose }: { onClose: () => void }) => {
  const me = useSession()?.user;
  const [closing, setClosing] = useState(false);
  const [answers, setAnswers] = useState<Answers>({});
  const [contact, setContact] = useState<Contact>(EMPTY_CONTACT);
  const [consent, setConsent] = useState(false);
  /** 刚存下的是今天第几份 —— 存完表单清空，这一行告诉人「刚才那份没丢」。 */
  const [savedNo, setSavedNo] = useState<number | null>(null);
  const [today, setToday] = useState({ total: 0, pending: 0 });
  const scroller = useRef<HTMLDivElement | null>(null);

  const state = submitState(VDL_2026, answers, contact, consent);
  const filled = state !== 'empty' || consent;

  /** 问到一半不许被自动更新刷掉（D83）—— 和速记详情同一条判据。 */
  useEffect(() => {
    setBusy('survey', filled);
    return () => setBusy('survey', false);
  }, [filled]);

  // 今天几份、几份还没传 —— 只数自己的（T30）
  useEffect(() => {
    if (!me) return;
    const load = async () => {
      const start = new Date().setHours(0, 0, 0, 0);
      const mine = await mySurveys(me.userCode).and((x) => x.createdAt >= start).toArray();
      setToday({ total: mine.length, pending: mine.filter((x) => PENDING_STATES.includes(x.sync)).length });
    };
    void load();
    const timer = window.setInterval(() => void load(), 1500);
    return () => window.clearInterval(timer);
  }, [me?.userCode, savedNo]);

  const close = () => {
    setClosing(true);
    window.setTimeout(onClose, 190); // 和 `.sheet[data-closing]` 的 0.2s 退场对齐
  };
  const reset = () => {
    setAnswers({});
    setContact(EMPTY_CONTACT);
    setConsent(false);
  };
  const set = (id: string, v: Answers[string] | undefined) =>
    setAnswers((cur) => {
      const next = { ...cur };
      if (v === undefined) delete next[id];
      else next[id] = v;
      return next;
    });

  /**
   * 存下这一份。**写进本地库就算成功**（三段解耦第一段）—— 有没有网是后面的事。
   * 联系方式只在勾了同意时才存；没勾的话按钮本来就按不下去（`submitState`）。
   */
  const save = async () => {
    if (!me || state !== 'ok') return;
    const c = Object.fromEntries(
      Object.entries(contact)
        .map(([k, v]) => [k, v.trim()])
        .filter(([, v]) => v),
    );
    const now = Date.now();
    await db.surveys.add({
      id: crypto.randomUUID(),
      surveyKey: SURVEY_KEY,
      answers,
      contact: Object.keys(c).length ? c : undefined,
      consentAt: consent ? new Date(now).toISOString() : undefined,
      createdAt: now,
      recordedBy: me.userCode,
      sync: 'queued',
      attempts: 0,
    });
    reset();
    setSavedNo(today.total + 1);
    scroller.current?.scrollTo({ top: 0 });
    void flushSurveys();
  };

  return (
    <Sheet closing={closing}>
      {/* 顶栏和速记详情一个样：左上角「‹ 速记」—— 是从速记页点进来的，人期待的是退回去 */}
      <div
        style={{
          flexShrink: 0,
          paddingTop: 'env(safe-area-inset-top)',
          borderBottom: `1px solid ${T.lineLight}`,
          background: T.bg,
        }}
      >
        <div style={{ height: 52, display: 'flex', alignItems: 'center', padding: '0 8px 0 4px' }}>
          <button
            onClick={close}
            style={{ display: 'flex', alignItems: 'center', gap: 2, color: T.textSoft, padding: 10 }}
            aria-label={t('返回')}
          >
            <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>
              <IconChevron size={18} />
            </span>
            <span style={{ fontSize: 14 }}>{t('速记')}</span>
          </button>
          <div style={{ flex: 1 }} />
          {filled && (
            <button onClick={reset} style={{ color: T.textSoft, fontSize: 14, padding: 10 }}>
              {t('清空')}
            </button>
          )}
        </div>
      </div>

      <div ref={scroller} style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
        <div className="page-wrap" style={{ padding: '12px 16px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                flexShrink: 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: T.blueSoft,
                color: T.blue,
              }}
            >
              <IconClipboard size={20} />
            </span>
            <span style={{ flex: 1 }}>
              <span style={{ display: 'block', fontSize: 17, fontWeight: 600, lineHeight: 1.35 }}>
                {t('2C 客户问卷')}
              </span>
              <span style={{ display: 'block', fontSize: 12, color: T.textLight }}>
                {t('VDL 法国展')} · {t('今天 {a} 份', { a: today.total })}
                {today.pending > 0 && (
                  <span style={{ color: T.amber }}> · {t('{a} 份待上传', { a: today.pending })}</span>
                )}
              </span>
            </span>
          </div>

          {/* 存完表单就清空了 —— 不说一句的话，人会以为刚才那份没存上，再填一遍 */}
          {savedNo !== null && (
            <div
              data-saved
              style={{
                background: T.greenSoft,
                color: T.green,
                borderRadius: 10,
                padding: '7px 11px',
                fontSize: 12.5,
                marginBottom: 4,
              }}
            >
              {t('已存下 · 今天第 {a} 份。可以接着问下一位。', { a: savedNo })}
            </div>
          )}

          {VDL_2026.map((q, i) => (
            <QuestionBlock key={q.id} no={i + 1} q={q} answers={answers} set={set} />
          ))}

          <ContactBlock contact={contact} setContact={setContact} consent={consent} setConsent={setConsent} />
        </div>
      </div>

      {/* 存的键贴在底部，不跟着滚 —— 问完最后一题手指就在下面 */}
      <div
        style={{
          flexShrink: 0,
          borderTop: `1px solid ${T.lineLight}`,
          background: T.bg,
          padding: '10px 16px calc(10px + env(safe-area-inset-bottom))',
        }}
      >
        <div className="page-wrap" style={{ padding: 0 }}>
          {state === 'consent' && (
            <div style={{ fontSize: 12, color: T.amber, marginBottom: 7 }}>
              {t('留了联系方式，要先勾「客户同意」。')}
            </div>
          )}
          <button
            data-save
            disabled={state !== 'ok'}
            onClick={() => void save()}
            style={{
              width: '100%',
              height: 46,
              borderRadius: 12,
              fontSize: 15,
              fontWeight: 500,
              background: state === 'ok' ? T.text : T.s3,
              color: state === 'ok' ? '#fff' : T.textLight,
            }}
          >
            {t('存下这份问卷')}
          </button>
        </div>
      </div>
    </Sheet>
  );
};

/**
 * 联系方式（可不填）。**姓名 / 电话 / 邮箱任何一样留了，就要客户同意**（R20 · GDPR）——
 * 那句法语是念给客户听的。只留邮编不算可识别到人，不要求勾。
 */
const ContactBlock = ({
  contact,
  setContact,
  consent,
  setConsent,
}: {
  contact: Contact;
  setContact: (c: Contact) => void;
  consent: boolean;
  setConsent: (v: boolean) => void;
}) => {
  /**
   * `flex` 只给并排那一行用。⚠️ 竖排的容器里给 `flex: 1` 会把输入框的**高度**压没
   * （列方向上 flex-basis 管的是高）—— 第一版就是这样，「Nom」只剩一条线。
   */
  const field = (k: keyof Contact, fr: string, type: string, flex?: number) => (
    <input
      data-contact={k}
      value={contact[k]}
      onChange={(e) => setContact({ ...contact, [k]: e.target.value })}
      placeholder={fr}
      type={type}
      inputMode={k === 'postcode' ? 'numeric' : undefined}
      autoComplete="off"
      style={{
        ...(flex ? { flex, minWidth: 0 } : { width: '100%' }),
        height: 40,
        padding: '0 12px',
        borderRadius: 10,
        border: `1px solid ${T.line}`,
        background: T.surface,
      }}
    />
  );
  return (
    <div style={{ padding: '14px 0 4px', borderTop: `1px solid ${T.lineLight}` }}>
      <Prompt no="✎" fr="Pour vous recontacter (facultatif)" zh="联系方式（可不填）" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {field('name', 'Nom', 'text')}
        <div style={{ display: 'flex', gap: 7 }}>
          {field('phone', 'Téléphone', 'tel', 3)}
          {field('postcode', 'Code postal', 'text', 2)}
        </div>
        {field('email', 'E-mail', 'email')}
      </div>
      <label
        style={{ display: 'flex', gap: 9, alignItems: 'flex-start', marginTop: 10, cursor: 'pointer' }}
      >
        <input
          data-consent
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          style={{ width: 20, height: 20, margin: '2px 0 0', flexShrink: 0, appearance: 'auto' }}
        />
        <span>
          <span style={{ display: 'block', fontSize: 13, lineHeight: 1.5 }}>
            J’accepte que Voltline conserve ces informations pour me recontacter.
          </span>
          <span style={{ display: 'block', fontSize: 12, color: T.textSoft }}>
            {t('客户同意 Voltline 保存这些信息、用于回访')}
          </span>
        </span>
      </label>
    </div>
  );
};

const QuestionBlock = ({
  no,
  q,
  answers,
  set,
}: {
  no: number;
  q: Question;
  answers: Answers;
  set: (id: string, v: Answers[string] | undefined) => void;
}) => (
  <div style={{ padding: '14px 0 2px', borderTop: no > 1 ? `1px solid ${T.lineLight}` : 'none' }}>
    <Prompt no={String(no)} fr={q.fr} zh={q.zh} />

    {q.kind === 'multi' && (
      <Chips>
        {q.options.map((o) => {
          const cur = (answers[q.id] as string[] | undefined) ?? [];
          return (
            <OptionChip
              key={o.id}
              o={o}
              state={cur.includes(o.id) ? 'on' : 'off'}
              onClick={() => {
                const next = toggleMulti(cur, o.id);
                set(q.id, next.length ? next : undefined);
              }}
            />
          );
        })}
      </Chips>
    )}

    {q.kind === 'havewant' && (
      <>
        <Chips>
          {q.options.map((o) => {
            const cur = (answers[q.id] as Record<string, HaveWant> | undefined) ?? {};
            return (
              <OptionChip
                key={o.id}
                o={o}
                state={cur[o.id] === 'have' ? 'on' : cur[o.id] === 'want' ? 'want' : 'off'}
                onClick={() => {
                  const next = { ...cur };
                  const v = cycleHaveWant(cur[o.id]);
                  if (v) next[o.id] = v;
                  else delete next[o.id];
                  set(q.id, Object.keys(next).length ? next : undefined);
                }}
              />
            );
          })}
        </Chips>
        <div style={{ fontSize: 11.5, color: T.textLight, margin: '-4px 0 10px' }}>
          {t('点一下 = 在用（黑）· 再点 = 想加（蓝）')}
        </div>
      </>
    )}

    {q.kind === 'single' && (
      <>
        <SingleChips q={q} value={answers[q.id] as string | undefined} set={(v) => set(q.id, v)} />
        {q.followUp && (
          // 追问缩进一格、带一个小标签：它是第 3 题的一部分，不是第 4 题
          <div style={{ paddingLeft: 12, borderLeft: `2px solid ${T.lineLight}`, marginBottom: 10 }}>
            <Prompt no={t('追问')} fr={q.followUp.fr} zh={q.followUp.zh} small />
            <SingleChips
              q={q.followUp}
              value={answers[q.followUp.id] as string | undefined}
              set={(v) => set(q.followUp!.id, v)}
            />
          </div>
        )}
      </>
    )}

    {q.kind === 'text' && (
      <TextAnswer value={(answers[q.id] as string | undefined) ?? ''} onChange={(v) => set(q.id, v || undefined)} />
    )}
  </div>
);

/** 一道题的问法：法语那句念给客户听（粗），中文那行给自己看（小、灰）。 */
const Prompt = ({ no, fr, zh, small }: { no: string; fr: string; zh: string; small?: boolean }) => (
  <div style={{ display: 'flex', gap: 8, marginBottom: 9 }}>
    <span
      style={{
        flexShrink: 0,
        minWidth: 18,
        fontSize: small ? 11 : 13,
        fontWeight: 600,
        color: small ? T.blue : T.textLight,
        lineHeight: small ? 1.9 : 1.5,
      }}
    >
      {no}
    </span>
    <span style={{ flex: 1, minWidth: 0 }}>
      <span style={{ display: 'block', fontSize: small ? 13.5 : 14.5, fontWeight: 600, lineHeight: 1.45 }}>
        {fr}
      </span>
      <span style={{ display: 'block', fontSize: 12, color: T.textSoft, lineHeight: 1.5 }}>{t(zh)}</span>
    </span>
  </div>
);

const Chips = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>{children}</div>
);

const SingleChips = ({
  q,
  value,
  set,
}: {
  q: { options: Choice[] };
  value: string | undefined;
  set: (v: string | undefined) => void;
}) => (
  <Chips>
    {q.options.map((o) => (
      <OptionChip
        key={o.id}
        o={o}
        state={value === o.id ? 'on' : 'off'}
        // 再点一下已选的 = 取消，点错了能撤回
        onClick={() => set(value === o.id ? undefined : o.id)}
      />
    ))}
  </Chips>
);

/**
 * 选项：法语词在前（客户说的就是这个词，销售照着找），译文小字在后。
 * 三种状态：没点 / 选中（黑）/ 想加（蓝，只有第 2 题有）。
 *
 * 🔴 **状态只改颜色，不改宽度。** 第一版选中时前面加「✓」，标签一变宽，
 * 后面的选项就跳到下一行 —— 边走边点的时候，下一下就点到了别的选项上。
 */
const OptionChip = ({
  o,
  state,
  onClick,
}: {
  o: Choice;
  state: 'off' | 'on' | 'want';
  onClick: () => void;
}) => (
  <button
    className="chip"
    data-on={state === 'on'}
    data-state={state}
    onClick={onClick}
    style={{
      height: 32,
      padding: '0 11px',
      gap: 5,
      fontSize: 13,
      ...(state === 'want' ? { background: T.blueSoft, color: T.blue, borderColor: 'rgba(11,53,135,.28)' } : {}),
    }}
  >
    <span>{o.fr}</span>
    <span
      style={{
        fontSize: 11.5,
        fontWeight: 400,
        color: state === 'on' ? 'rgba(255,255,255,.7)' : state === 'want' ? T.blue : T.textLight,
      }}
    >
      {t(o.zh)}
    </span>
  </button>
);

/** 开放题：记要点就行，高度跟着内容长（和速记输入框同一个做法）。 */
const TextAnswer = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={t('记要点就行')}
      rows={2}
      style={{
        width: '100%',
        resize: 'none',
        height: 'auto',
        lineHeight: 1.5,
        padding: '8px 12px',
        marginBottom: 12,
        borderRadius: 12,
        border: `1px solid ${T.line}`,
        background: T.surface,
      }}
    />
  );
};
