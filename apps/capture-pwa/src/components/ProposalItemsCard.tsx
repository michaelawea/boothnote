import { useEffect, useRef, useState } from 'react';
import { cachedEnums, cancelProposalItem, confirmProposalItems, syncEnums, withdrawProposalItem } from '../api';
import { useCompanies } from '../companies';
import type { EnumSet } from '../db';
import { t } from '../i18n';
import { T } from '../theme';
import { itemCanConfirm, itemCompanyId, itemRevisionKey, proposalItemCounts, selectedItemPayload,
  type ItemDraft, type ProposalItemView } from '../proposal-items';
import { CompanyPicker } from './CompanyPicker';

const FIELD_LABELS: Record<string, string> = {
  category: '品类', supplierName: '在位品牌', modelName: '型号', stage: '阶段',
  decisionWindow: '决策窗口', annualVehicles: '整车年产量', demandQuantity: '需求量',
  summary: '小结', caseStatus: '处理状态', severity: '严重度', sourceConfidence: '可信度',
  projectCode: '项目编号', title: '标题', name: '名称', status: '状态',
  details: '详情', affectedUnits: '受影响数量', deliveryBatch: '交付批次',
  budgetEur: '预算', targetPrice: '目标价格', demandBreakdown: '需求细分', ownerTeam: '负责团队',
  customerChain: '客户链', sourceCompanyName: '消息来源客户',
  project: '项目', workItems: '任务', document: '文档', projectStage: '阶段',
  primaryProductName: '核心产品', sampleQty: '样品', plannedSop: '计划 SOP', specSummary: '关键参数',
  openQuestions: '待客户确认', itemCode: '任务编号', body: '内容', ownerRole: '负责角色',
  dueDate: '内部截止', customerDueDate: '客户截止', blockedByCodes: '依赖任务',
  threadType: '任务类型', priority: '优先级', itemStatus: '任务状态',
  docCode: '文档编号', version: '版本', content: '正文', filename: '文件名', docSource: '文档来源', isBaseline: '需求基线',
};
const EDITABLE: Record<string, keyof EnumSet> = {
  category: 'category', stage: 'stage', caseStatus: 'caseStatus', severity: 'severity', sourceConfidence: 'confidence',
};
const STATUS_LABELS: Record<ProposalItemView['status'], string> = {
  ready: '待确认', confirming: '待写入', committing: '正在写入 CRM…', confirmed: '已入库',
  failed: '失败', unknown: '写入结果不明', withdrawn: '已撤回', superseded: '已被取代',
};
const ACTION_LABELS = { create: '新建记录', append: '追加到已有记录', update: '更新已有记录' };
const TYPE_LABELS: Record<string, string> = { fitment: '选型情报', support: '售后问题', project: '项目', followup: '项目跟进', intel: '情报' };

const fieldText = (value: unknown): string => {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2) ?? '';
};

const FieldValue = ({ name, value, enums }: { name: string; value: unknown; enums: EnumSet | null }) => {
  if (Array.isArray(value)) return <ol style={{ margin: 0, paddingLeft: 19 }}>{value.map((entry, index) =>
    <li key={index} style={{ marginBottom: 7 }}><FieldValue name={name} value={entry} enums={enums} /></li>)}</ol>;
  if (value && typeof value === 'object') return <dl style={{ margin: 0 }}>{Object.entries(value).map(([field, entry]) =>
    entry != null && entry !== '' && <div key={field} style={{ marginBottom: 4 }}>
      <dt style={{ fontSize: 11, color: T.textSoft }}>{t(FIELD_LABELS[field] ?? field)}</dt>
      <dd style={{ margin: 0 }}><FieldValue name={field} value={entry} enums={enums} /></dd>
    </div>)}</dl>;
  const key = name === 'projectStage' ? 'stage' : EDITABLE[name];
  const options = key ? enums?.[key] : undefined;
  const label = Array.isArray(options) ? options.find((entry) => entry.value === String(value))?.label : undefined;
  return <>{label ?? (typeof value === 'boolean' ? t(value ? '是' : '否') : fieldText(value))}</>;
};

/** Each independent matter retains its own company, revision, confirmation and receipt. */
export const ProposalItemsCard = ({ stagingId, items, onDone }: {
  stagingId: string; items: ProposalItemView[]; onDone?: () => void;
}) => {
  const companies = useCompanies();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, ItemDraft>>({});
  const [enums, setEnums] = useState<EnumSet | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [cancelled, setCancelled] = useState<Set<string>>(new Set());
  const [withdrawn, setWithdrawn] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(Date.now());
  const lock = useRef(false);

  useEffect(() => {
    let alive = true;
    void cachedEnums().then((result) => alive && result && setEnums(result));
    void syncEnums().then((result) => alive && result && setEnums(result));
    return () => { alive = false; };
  }, []);

  // Optimistic acknowledgement only spans the next server snapshot. Known failures
  // must become selectable again; a successful queue must not lock an item forever.
  useEffect(() => {
    const readyKeys = new Set(items.filter((item) => item.status === 'ready').map(itemRevisionKey));
    const countingKeys = new Set(items.filter((item) => item.status === 'confirming').map(itemRevisionKey));
    setSent((old) => new Set([...old].filter((key) => readyKeys.has(key))));
    setCancelled((old) => new Set([...old].filter((key) => countingKeys.has(key))));
    setWithdrawn((old) => new Set([...old].filter((key) => readyKeys.has(key))));
  }, [items]);

  const counting = items.some((item) => item.status === 'confirming');
  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(interval);
  }, [counting]);

  const selection = selectedItemPayload(items, selected, drafts);
  const counts = proposalItemCounts(items);
  const groups = new Map<string, ProposalItemView[]>();
  for (const item of items) {
    const key = itemRevisionKey(item);
    const companyId = itemCompanyId(item, drafts[key]);
    const group = companyId ?? item.companyCode ?? `unassigned:${item.itemId}`;
    groups.set(group, [...(groups.get(group) ?? []), item]);
  }

  const confirm = async () => {
    if (!selection.length || busy || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await confirmProposalItems(stagingId, selection);
      const keys = new Set(selection.map((item) => `${item.itemId}:${item.revision}`));
      setSent((old) => new Set([...old, ...keys]));
      setCancelled((old) => new Set([...old].filter((key) => !keys.has(key))));
      setSelected((old) => new Set([...old].filter((key) => !keys.has(key))));
      onDone?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('入库失败，稍后再试'));
      onDone?.(); // Revision conflicts require a refreshed projection before another choice.
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  const cancel = async (item: ProposalItemView) => {
    if (busy || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await cancelProposalItem(item.itemId, item.revision);
      const key = itemRevisionKey(item);
      setSent((old) => new Set([...old].filter((candidate) => candidate !== key)));
      setCancelled((old) => new Set([...old, key]));
      onDone?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('事项撤销失败，请刷新后核对。'));
      onDone?.();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  const withdraw = async (item: ProposalItemView) => {
    if (busy || lock.current || item.status !== 'ready' ||
      !window.confirm(t('撤回当前提案版本？已写入的记录会保留。'))) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await withdrawProposalItem(item.itemId, item.revision);
      const key = itemRevisionKey(item);
      setWithdrawn((old) => new Set([...old, key]));
      setSelected((old) => new Set([...old].filter((candidate) => candidate !== key)));
      onDone?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('事项撤回失败，请刷新后核对。'));
      onDone?.();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  return (
    <section aria-label={t('独立事项')} data-proposal-staging={stagingId}
      style={{ border: `1px solid ${T.line}`, borderRadius: T.radius, background: T.surface,
        padding: '13px 14px', width: '100%', boxSizing: 'border-box' }}>
      <div role="status" style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 10 }}>
        {t('{a} 个事项 · 已入库 {b} · 待确认 {c} · 处理中 {d} · 失败 {e} · 结果不明 {f}', {
          a: counts.total, b: counts.confirmed, c: counts.ready, d: counts.working, e: counts.failed, f: counts.unknown,
        })}
        {counts.inactive > 0 && <span>{' · '}{t('已撤回或被取代 {a}', { a: counts.inactive })}</span>}
      </div>
      {[...groups].map(([group, records]) => {
        const first = records[0];
        const firstKey = itemRevisionKey(first);
        const firstId = itemCompanyId(first, drafts[firstKey]);
        const firstCompany = drafts[firstKey]?.company ?? companies.find((company) =>
          firstId ? company.id === firstId : company.code === first.companyCode);
        const heading = firstCompany?.name ?? first.companyCode ?? t('未定客户');
        return (
          <div key={group} style={{ marginBottom: 12 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: '8px 0' }}>{heading}</h3>
            {records.map((item) => {
              const key = itemRevisionKey(item);
              const draft = drafts[key];
              const companyId = itemCompanyId(item, draft);
              const company = draft?.company ?? companies.find((entry) =>
                companyId ? entry.id === companyId : entry.code === item.companyCode) ?? null;
              const awaiting = sent.has(key) && itemCanConfirm(item);
              const awaitingCancel = cancelled.has(key) && item.status === 'confirming';
              const awaitingWithdraw = withdrawn.has(key) && item.status === 'ready';
              const editable = itemCanConfirm(item) && !awaiting && !awaitingWithdraw && !busy;
              const left = item.confirmAfter ? Math.max(0, Math.ceil((Date.parse(item.confirmAfter) - now) / 1000)) : 0;
              const fields = { ...item.fields, ...draft?.fields };
              const statusText = awaiting ? t('已确认，等待服务端更新…')
                : awaitingCancel ? t('已撤销，等待服务端更新…') : awaitingWithdraw ? t('已撤回') : t(STATUS_LABELS[item.status]);
              return (
                <article key={key} data-proposal-item={item.itemId} data-proposal-revision={item.revision}
                  style={{ padding: '12px 11px', border: `1px solid ${T.lineLight}`, borderRadius: 10, marginBottom: 8 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 7 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minHeight: 36 }}>
                      <input type="checkbox" checked={selected.has(key)} disabled={!editable || !companyId}
                        aria-label={t('选择事项：{a}', { a: fieldText(fields.summary ?? fields.title ?? fields.modelName ?? item.itemId) })}
                        onChange={(event) => setSelected((old) => {
                          const next = new Set(old);
                          if (event.target.checked) next.add(key); else next.delete(key);
                          return next;
                        })} />
                      <span style={{ fontSize: 13 }}>{enums?.recordType.find((entry) => entry.value === item.recordType)?.label ?? t(TYPE_LABELS[item.recordType] ?? item.recordType)}</span>
                    </label>
                    <span style={{ fontSize: 12, paddingTop: 9, color: item.status === 'unknown' ? T.amber : T.textSoft }}>{statusText}</span>
                  </div>
                  <div style={{ fontSize: 12, color: T.textSoft, marginBottom: 8 }}>
                    {t(ACTION_LABELS[item.action])}
                    {item.target && ` · ${item.target.code ?? item.target.id}`}
                    {' · '}{t('版本 {a}', { a: item.revision })}
                  </div>
                  {!item.target && editable && <CompanyPicker value={company} onPick={(picked) =>
                    setDrafts((old) => ({ ...old, [key]: { ...old[key], company: picked } }))}
                    suggested={typeof fields.suggested_company === 'string' ? fields.suggested_company : null}
                    suggestedFields={fields.suggestedCompanyFields} />}
                  {!companyId && <div style={{ fontSize: 12, marginTop: 7, color: T.amber }}>{t('入库前必须先定客户')}</div>}
                  <dl style={{ margin: '10px 0', fontSize: 13, lineHeight: 1.65 }}>
                    {Object.entries(fields).filter(([name, value]) => value != null && value !== '' &&
                      !['recordType', 'companyCode', 'companyId', 'suggested_company', 'suggestedCompanyFields', 'corrections'].includes(name)).map(([name, value]) => {
                      const options = EDITABLE[name] ? enums?.[EDITABLE[name]] : undefined;
                      const choices = Array.isArray(options) ? options : undefined;
                      return (
                        <div key={name} style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 5 }}>
                          <dt style={{ flex: '0 0 68px', color: T.textSoft }}>{t(FIELD_LABELS[name] ?? name)}</dt>
                          <dd style={{ margin: 0, flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                            {editable && choices?.length ? (
                              <select value={String(value)} aria-label={t(FIELD_LABELS[name] ?? name)}
                                style={{ width: '100%', minHeight: 36, border: `1px solid ${T.line}`, borderRadius: 7, padding: 6 }}
                                onChange={(event) => setDrafts((old) => ({ ...old, [key]: { ...old[key],
                                  fields: { ...old[key]?.fields, [name]: event.target.value } } }))}>
                                {!choices.some((entry) => entry.value === String(value)) && <option value={String(value)}>{String(value)}</option>}
                                {choices.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
                              </select>
                            ) : <FieldValue name={name} value={value} enums={enums} />}
                            {item.confidence[name] === 'low' && draft?.fields?.[name] === undefined &&
                              <span style={{ fontSize: 11, marginLeft: 6, color: T.amber }}>{t('不太确定')}</span>}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                  {item.evidenceRefs.length > 0 && <details style={{ fontSize: 12, lineHeight: 1.65, marginBottom: 8 }}>
                    <summary>{t('来源证据')}</summary>
                    {item.evidenceRefs.map((source, index) => <div key={index} style={{ marginTop: 7, overflowWrap: 'anywhere' }}>
                      {source.quote && <blockquote style={{ margin: '4px 0', borderLeft: `2px solid ${T.line}`, paddingLeft: 8,
                        whiteSpace: 'pre-wrap' }}>{source.quote}</blockquote>}
                      {(source.messageId || source.inboxId) && <div style={{ color: T.textSoft }}>
                        {t('原文来源：{a}', { a: source.messageId ?? source.inboxId ?? '' })}
                      </div>}
                      {source.attachmentId && <div style={{ color: T.textSoft }}>
                        {t('附件来源：{a}', { a: source.attachmentId })}
                      </div>}
                    </div>)}
                  </details>}
                  {item.status === 'unknown' && <div style={{ fontSize: 12, color: T.amber, lineHeight: 1.65 }}>
                    {t('先核对 CRM 中是否已写入，再解决结果不明状态。')}
                  </div>}
                  {item.status === 'ready' && !awaiting && !awaitingWithdraw && <button type="button" className="btn ghost sm"
                    disabled={busy} onClick={() => void withdraw(item)}>{t('撤回这版提案')}</button>}
                  {item.error && <div role="alert" style={{ fontSize: 12, color: T.red, whiteSpace: 'pre-wrap' }}>{item.error}</div>}
                  {item.status === 'confirming' && !awaitingCancel && <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ flex: 1, fontSize: 12, color: T.textSoft }}>
                      {left > 0 ? t('{a} 秒内可撤销', { a: left }) : t('正在写入 CRM…')}
                    </span>
                    <button type="button" className="btn ghost sm" disabled={busy || left <= 0}
                      onClick={() => void cancel(item)}>{t('撤销此事项')}</button>
                  </div>}
                  {item.status === 'confirmed' && item.twentyRefs && <details style={{ fontSize: 12, color: T.textSoft }}>
                    <summary>{t('查看此事项的入库回执')}</summary>
                    <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(item.twentyRefs, null, 2)}</pre>
                  </details>}
                </article>
              );
            })}
          </div>
        );
      })}
      <button type="button" className="btn primary" disabled={busy || !selection.length}
        onClick={() => void confirm()}>{t('确认选中的 {a} 个事项', { a: selection.length })}</button>
      {error && <div role="alert" style={{ fontSize: 12, marginTop: 8, color: T.red }}>{error}</div>}
    </section>
  );
};
