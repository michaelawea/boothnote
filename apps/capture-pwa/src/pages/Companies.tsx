import { useEffect, useMemo, useState } from 'react';

import { T } from '../theme';
import { fetchGaps, type Gaps } from '../api';
import { useCompanies } from '../companies';
import { db, myNotes, type Company } from '../db';
import { useSession } from '../auth';
import { IconChevron, IconSearch } from '../icons';
import { CompanyPicker } from '../components/CompanyPicker';
import { t } from '../i18n';

/**
 * 客户页。
 *
 * 它回答的是展馆里最常见的那个问题：**「这家我们之前聊到哪了？」**
 * 所以第一屏是「我记过几条」，点进去才是情报缺口 —— 缺口要联网算，
 * 而「我记过几条」离线也答得出来（本地就有）。
 */
export const CompaniesPage = () => {
  const all = useCompanies();
  const session = useSession();
  const me = session?.user;
  const [q, setQ] = useState('');
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [open, setOpen] = useState<Company | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!me) return;
    void myNotes(me.userCode)
      .toArray()
      .then((ns) => {
        const c: Record<string, number> = {};
        for (const n of ns) if (n.companyCode) c[n.companyCode] = (c[n.companyCode] ?? 0) + 1;
        setCounts(c);
      });
  }, [me?.userCode, all.length]);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const filtered = s
      ? all.filter((c) => c.name.toLowerCase().includes(s) || c.code.toLowerCase().includes(s))
      : all;
    // 记过的排前面 —— 展会期间关心的永远是「今天聊过的那几家」
    return [...filtered].sort((a, b) => (counts[b.code] ?? 0) - (counts[a.code] ?? 0));
  }, [q, all, counts]);

  if (open) return <CompanyDetail company={open} notes={counts[open.code] ?? 0} onBack={() => setOpen(null)} />;

  if (adding) {
    return (
      <div style={{ padding: 14 }}>
        <CompanyPicker onPick={() => setAdding(false)} />
        <button className="btn ghost sm" style={{ width: '100%', marginTop: 14 }} onClick={() => setAdding(false)}>
          {t('返回')}
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: '10px 14px 24px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 40,
          padding: '0 13px',
          borderRadius: T.pill,
          background: T.s3,
          marginBottom: 12,
        }}
      >
        <span style={{ color: T.textLight, display: 'flex' }}>
          <IconSearch size={17} />
        </span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('找客户（共 {a} 家）', { a: all.length })}
          style={{ flex: 1, fontSize: 15 }}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {list.map((c) => (
          <button key={c.id} className="card" onClick={() => setOpen(c)}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 500 }}>{c.name}</div>
                <div style={{ fontSize: 11.5, color: T.textLight, marginTop: 2 }}>
                  {c.code}
                  {c.group ? ` · ${c.group}` : ''}
                </div>
              </div>
              {counts[c.code] ? (
                <span className="chip" style={{ height: 26, fontSize: 12 }}>
                  {t('我记过 {a}', { a: counts[c.code] })}
                </span>
              ) : null}
              <span style={{ color: T.textLight, display: 'flex' }}>
                <IconChevron size={16} />
              </span>
            </div>
          </button>
        ))}
        {!list.length && (
          <div style={{ textAlign: 'center', color: T.textLight, fontSize: 13.5, padding: '26px 0' }}>
            {t('没找到「{a}」。', { a: q })}
          </div>
        )}
      </div>

      <button className="btn ghost" style={{ width: '100%', marginTop: 14 }} onClick={() => setAdding(true)}>
        {t('新建客户')}
      </button>
    </div>
  );
};

const CompanyDetail = ({
  company,
  notes,
  onBack,
}: {
  company: Company;
  notes: number;
  onBack: () => void;
}) => {
  const [gaps, setGaps] = useState<Gaps | null>(null);
  const [loading, setLoading] = useState(true);
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    void fetchGaps(company.code).then((g) => {
      setGaps(g);
      setLoading(false);
    });
    void db.notes
      .where('companyCode')
      .equals(company.code)
      .reverse()
      .sortBy('createdAt')
      .then((ns) => setRecent(ns.slice(0, 5).map((n) => n.text).filter(Boolean)));
  }, [company.code]);

  return (
    <div style={{ padding: '10px 14px 24px' }}>
      <button className="chip" onClick={onBack} style={{ marginBottom: 12 }}>
        {t('← 返回')}
      </button>

      <div style={{ fontSize: 20, fontWeight: 600 }}>{company.name}</div>
      <div style={{ fontSize: 12.5, color: T.textLight, marginTop: 3 }}>
        {company.code}
        {company.group ? ` · ${company.group}` : ''}
        {company.type ? ` · ${company.type}` : ''}
      </div>

      <div style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
        <Stat n={notes} label={t('我记过')} />
        <Stat
          n={gaps?.completeness ?? '—'}
          label={t('情报完整度')}
          suffix={gaps?.completeness != null ? '%' : ''}
        />
        <Stat n={gaps?.totalItems === 0 ? '—' : (gaps?.missing.length ?? '—')} label={t('还缺')} />
      </div>

      <div style={{ fontSize: 13, fontWeight: 600, margin: '18px 0 8px' }}>{t('还没问过的')}</div>
      {loading ? (
        <div style={{ fontSize: 13, color: T.textLight }}>{t('算一下…')}</div>
      ) : !gaps ? (
        <div style={{ fontSize: 13, color: T.textLight, lineHeight: 1.7 }}>
          {t('现在连不上服务器，情报缺口算不出来。上面那两个数字是本地的，照常准。')}
        </div>
      ) : gaps.totalItems === 0 ? (
        /* 🔴 清单没配 ≠ 都问过了。说实话，并且说清楚该做什么。 */
        <div style={{ fontSize: 13, color: T.textLight, lineHeight: 1.7 }}>
          {t('情报清单还没配内容 —— 所以这里暂时算不出「还缺什么」。')}
          <br />
          {t('清单是数据不是代码：业务方定完，直接在 CRM 的「情报清单项」里建记录就生效，不用发版。')}
        </div>
      ) : !gaps.missing.length ? (
        <div style={{ fontSize: 13.5, color: T.green }}>{t('都问过了。')}</div>
      ) : (
        /**
         * 🔴 **一次只露 3 个**（D17④ / §4.3 第 4 条）。
         *
         * 原文：「销售永远看不到『还差 27 项』这种让人直接放弃的界面。」
         * 生产实测（2026-08-04 · issue #6）这里一次摊了 10 条，
         * 上面还明晃晃写着「还缺 14」—— 正是那条判据想避免的画面。
         *
         * 排序已经在服务端做好（wave 升序 → 阶段门优先 → 权重降序），
         * 所以前 3 个就是「今天该问的」。其余折起来 —— 不是藏，是不催。
         */
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {gaps.missing.slice(0, 3).map((m) => (
              <Ask key={m.key} q={m.question} wave={m.wave} />
            ))}
          </div>
          {gaps.missing.length > 3 && (
            <details style={{ marginTop: 8 }}>
              <summary
                style={{ fontSize: 12.5, color: T.textLight, cursor: 'pointer', padding: '4px 2px' }}
              >
                {t('还有 {a} 项（不急着今天问）', { a: gaps.missing.length - 3 })}
              </summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 7 }}>
                {gaps.missing.slice(3).map((m) => (
                  <Ask key={m.key} q={m.question} wave={m.wave} />
                ))}
              </div>
            </details>
          )}
        </>
      )}

      {/* ── 已经知道的（手册 P19）──────────────────────────────────
          「展台前 30 秒看完」不能只看还缺什么 ——
          得看见已知的那些**有多可信**，传闻要能一眼认出来。 */}
      {gaps?.known?.length ? (
        <>
          <div style={{ fontSize: 13, fontWeight: 600, margin: '22px 0 8px' }}>
            {t('已经知道的')}
            {gaps.known.some((k) => k.isRumor) && (
              <span style={{ fontSize: 11.5, fontWeight: 400, color: T.amber, marginLeft: 8 }}>
                {t('带「传闻」标的还没核实过')}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {gaps.known.slice(0, 12).map((k, i) => (
              <div
                key={`${k.key}-${i}`}
                style={{
                  padding: '11px 13px',
                  background: k.isRumor ? T.amberSoft : T.s2,
                  borderRadius: 12,
                  fontSize: 14,
                  lineHeight: 1.6,
                }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 12, color: T.textLight }}>{k.question || k.key}</span>
                    <br />
                    {k.value}
                  </span>
                  {k.isRumor && (
                    <span
                      style={{
                        fontSize: 11,
                        color: T.amber,
                        fontWeight: 600,
                        flexShrink: 0,
                      }}
                    >
                      {t('传闻')}
                    </span>
                  )}
                </div>
                {(k.sourceName || k.by) && (
                  <div style={{ fontSize: 11.5, color: T.textLight, marginTop: 4 }}>
                    {k.sourceName ? t('听 {a} 说的', { a: k.sourceName }) : ''}
                    {k.sourceName && k.by ? ' · ' : ''}
                    {k.by ? t('{a} 记的', { a: k.by }) : ''}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      ) : null}

      {recent.length > 0 && (
        <>
          <div style={{ fontSize: 13, fontWeight: 600, margin: '22px 0 8px' }}>{t('我最近说过')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {recent.map((t, i) => (
              <div key={i} style={{ fontSize: 13.5, color: T.textSoft, lineHeight: 1.7 }}>
                · {t}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

/** 一条「该问的」。折叠区内外共用，两处长得一样才不会看着像两回事。 */
const Ask = ({ q, wave }: { q: string; wave: number | null }) => (
  <div
    style={{
      padding: '11px 13px',
      background: T.s2,
      borderRadius: 12,
      fontSize: 14,
      display: 'flex',
      gap: 10,
    }}
  >
    <span style={{ flex: 1 }}>{q}</span>
    {wave != null && (
      <span style={{ fontSize: 11, color: T.textLight, flexShrink: 0 }}>
        {t('第 {a} 次问', { a: wave })}
      </span>
    )}
  </div>
);

const Stat = ({ n, label, suffix = '' }: { n: number | string; label: string; suffix?: string }) => (
  <div
    style={{
      flex: 1,
      textAlign: 'center',
      padding: '13px 6px',
      background: T.s2,
      borderRadius: 14,
    }}
  >
    <div style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.2 }}>
      {n}
      {suffix}
    </div>
    <div style={{ fontSize: 11.5, color: T.textLight, marginTop: 2 }}>{label}</div>
  </div>
);
