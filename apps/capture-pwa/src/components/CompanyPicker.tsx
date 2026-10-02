import { useId, useMemo, useState } from 'react';
import { COUNTRY_CODES, countryName, normalizeCountry } from '../../../../shared/countries.mjs';
import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS } from '../../../../shared/company-types.mjs';
import { companySuggestion, type CompanySuggestion } from '../../../../shared/company-suggestion.mjs';

import { T } from '../theme';
import { DuplicateError, createCompany, searchCompanies } from '../api';
import { useCompanies } from '../companies';
import type { Company } from '../db';
import { IconPlus, IconSearch } from '../icons';
import { locale, t } from '../i18n';

/**
 * 🔴 **必须和 Twenty 里 `company.accountType` 的选项逐字一致。**
 *
 * 我第一版凭印象多写了「租赁 / 改装厂 / 其他」三个 Twenty 里没有的 ——
 * 界面上选得到，一提交就 500（`Invalid value "OTHER"`，2026-08-03 实测）。
 * **界面上能选到一个后端会拒绝的值，是最糟的一类 bug**：
 * 人以为是自己填错了，其实是我们给了一个不存在的选项。
 */
const TYPES = ACCOUNT_TYPES.map((value) => [value, ACCOUNT_TYPE_LABELS[value]] as const);

/**
 * 选客户。
 *
 * 这个组件承担 D28 修订那一条闸门的**界面一半**：
 * 录入时可以不选，但确认入库时必须选 —— 所以它出现在核对卡里，不出现在录音那一屏。
 * 现场每多一步下拉就少录一条；而挂错客户的数据比没录更糟。
 */
export const CompanyPicker = ({
  value,
  onPick,
  suggested,
  suggestedFields,
}: {
  value?: Company | null;
  onPick: (c: Company) => void;
  /** agent 提议的新客户名（它只提议，绝不建 —— §4.2 第3条）。 */
  suggested?: string | null;
  suggestedFields?: unknown;
}) => {
  const all = useCompanies();
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState<CompanySuggestion | null>(null);
  const suggestion = companySuggestion(suggested, suggestedFields);

  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    const matches = all
      .filter((c) => !s || c.name.toLowerCase().includes(s) || c.code.toLowerCase().includes(s))
      .slice(0, 8);
    // A new selection may not be in the cached list yet; keep it visible.
    return value && !matches.some((c) => c.id === value.id) ? [value, ...matches].slice(0, 8) : matches;
  }, [q, all, value]);

  if (draft) {
    return (
      <NewCompany
        initial={draft}
        onCancel={() => setDraft(null)}
        onCreated={(c) => {
          setDraft(null);
          onPick(c);
        }}
      />
    );
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 40,
          padding: '0 13px',
          borderRadius: T.pill,
          background: T.s3,
          marginBottom: 10,
        }}
      >
        <span style={{ color: T.textLight, display: 'flex' }}>
          <IconSearch size={17} />
        </span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('找客户…')}
          style={{ flex: 1, fontSize: 15 }}
        />
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
        {hits.map((c) => (
          <button
            key={c.id}
            className="chip"
            data-on={value?.id === c.id}
            onClick={() => onPick(c)}
            title={c.group}
          >
            {c.name}
          </button>
        ))}
        {suggestion && !hits.some((h) => h.name === suggestion.name) && (
          <button type="button" className="chip" data-suggest="true" onClick={() => setDraft(suggestion)}>
            {t('AI 提议：{a}', { a: suggestion.name })}
          </button>
        )}
        <button type="button" className="chip" onClick={() => setDraft(companySuggestion(q || suggested || '') ?? { name: '', country: null, accountType: null })}>
          <IconPlus size={14} /> {t('新建')}
        </button>
      </div>
      {!hits.length && q && (
        <div style={{ fontSize: 12.5, color: T.textLight, marginTop: 8 }}>
          {t('名单里没有「{a}」。确认拼写没错的话点「新建」——', { a: q })}{' '}
          {t('建之前系统会再查一次重。')}
        </div>
      )}
    </div>
  );
};

/**
 * 新建客户。三样必填 + **强制查重**。
 *
 * 查重命中时**不给「忽略」按钮**，而是把候选摆出来让人点。
 * 只有把每一个候选都看过、都不是，才会出现「都不是，新建」那一下 ——
 * 这一步慢半秒，换的是不再出现第二个 Brückner。
 */
const NewCompany = ({
  initial,
  onCreated,
  onCancel,
}: {
  initial: CompanySuggestion;
  onCreated: (c: Company) => void;
  onCancel: () => void;
}) => {
  const [name, setName] = useState(initial.name);
  const [country, setCountry] = useState(initial.country ?? '');
  const [type, setType] = useState<string>(initial.accountType ?? '');
  const countryId = useId();
  const [dupes, setDupes] = useState<Array<Company & { score: number }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const ready = name.trim() && normalizeCountry(country) && ACCOUNT_TYPES.some((value) => value === type);

  const submit = async (confirmedUnique: boolean) => {
    setBusy(true);
    setErr('');
    try {
      const c = await createCompany({ name: name.trim(), country: country.trim(), accountType: type, confirmedUnique });
      onCreated(c);
    } catch (e) {
      if (e instanceof DuplicateError) setDupes(e.candidates);
      else setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    setBusy(true);
    setErr('');
    try {
      const hits = await searchCompanies(name.trim());
      if (hits.length) setDupes(hits);
      else await submit(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (dupes) {
    return (
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{t('是不是这几家里的一家？')}</div>
        <div style={{ fontSize: 12.5, color: T.textSoft, marginBottom: 10, lineHeight: 1.7 }}>
          {t('名字写法不同但其实是同一家，是这份客户名单散架过一次的原因。')}
          <b>{t('先看一眼再决定。')}</b>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {dupes.map((d) => (
            <button key={d.id} className="card" onClick={() => onCreated(d)} style={{ padding: '12px 14px' }}>
              <div style={{ fontSize: 14.5, fontWeight: 500 }}>{d.name}</div>
              <div style={{ fontSize: 12, color: T.textLight, marginTop: 2 }}>
                {d.code}
                {d.group ? ` · ${d.group}` : ''} ·{' '}
                {t('相似度 {a}%', { a: (d.score * 100).toFixed(0) })}
              </div>
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn ghost sm" style={{ flex: 1 }} onClick={() => setDupes(null)}>
            {t('改名字')}
          </button>
          <button className="btn sm" style={{ flex: 1 }} disabled={busy} onClick={() => void submit(true)}>
            {t('都不是，新建')}
          </button>
        </div>
        <button className="btn ghost sm" style={{ width: '100%', marginTop: 8 }} onClick={onCancel}>
          {t('取消')}
        </button>
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>{t('新建客户')}</div>
      <Field label={t('名字')} value={name} onChange={setName} placeholder={t('照他们自己的写法')} />
      <div style={{ marginTop: 10 }}>
        <label htmlFor={countryId} style={{ display: 'block', fontSize: 12, color: T.textSoft, marginBottom: 5 }}>{t('国家')}</label>
        <select id={countryId} value={country} required onChange={(e) => setCountry(e.target.value)}
          style={{ width: '100%', height: 44, padding: '0 14px', borderRadius: 12, background: T.s3, fontSize: 15 }}>
          <option value="" disabled>{t('请选择国家')}</option>
          {COUNTRY_CODES.map((code) => <option key={code} value={code}>{countryName(code, locale())}</option>)}
        </select>
      </div>
      <div style={{ fontSize: 12, color: T.textSoft, margin: '10px 0 6px' }}>{t('类型')}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
        {TYPES.map(([v, label]) => (
          <button key={v} className="chip" data-on={type === v} onClick={() => setType(v)}>
            {t(label)}
          </button>
        ))}
      </div>
      {err && <div style={{ color: T.red, fontSize: 12.5, marginTop: 10 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button className="btn ghost sm" style={{ flex: 1 }} onClick={onCancel}>
          {t('取消')}
        </button>
        <button className="btn sm" style={{ flex: 2 }} disabled={!ready || busy} onClick={() => void check()}>
          {busy ? t('查重中…') : t('查重并新建')}
        </button>
      </div>
      <div style={{ fontSize: 11.5, color: T.textLight, marginTop: 8, lineHeight: 1.7 }}>
        {t('不需要审批，建完就能用。系统会记下是你建的。')}
      </div>
    </div>
  );
};

const Field = ({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) => {
  const id = useId();
  return (
    <div style={{ marginTop: 10 }}>
      <label htmlFor={id} style={{ display: 'block', fontSize: 12, color: T.textSoft, marginBottom: 5 }}>{label}</label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: '100%',
          height: 44,
          padding: '0 14px',
          borderRadius: 12,
          background: T.s3,
          fontSize: 15,
        }}
      />
    </div>
  );
};
