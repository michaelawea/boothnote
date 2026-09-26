import { useEffect, useState } from 'react';

import { T, fmtAgo } from '../theme';
import { myNotes, type Note } from '../db';
import { flush } from '../sync';
import { CURRENT_VISIT } from '../mock-data';
import { useSession, logout } from '../auth';
import { probe, type RecorderDiagnostics } from '../recorder';
import { t, type Locale } from '../i18n';
import { setLocale } from '../api';
import { BUILD_ID } from '../config';
import { applyUpdate, checkForUpdate, useUpdate } from '../update';

/**
 * 语言名**用它自己那种语言写**，所以不过 `t()`：
 * 一个只会英文的人在中文界面里要能认出「English」这一格，
 * 而把它翻成「英文/英语」恰好让他认不出来。
 */
const LOCALES: Array<{ id: Locale; label: string }> = [
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
];

/**
 * 个人看板 —— 只看「我自己相关的」。
 *
 * 这一页在 Twenty 里做不了：按人过滤属于**行级权限**，而那是企业版功能。
 * 在自己的应用里它就是一句 where recordedBy = 我。
 *
 * 它同时是 R11（录入者看不到回报 = 没动力）目前唯一能给的激励：
 * 自己报了多少条、覆盖了多少客户。
 */
export const MePage = () => {
  const [notes, setNotes] = useState<Note[]>([]);
  const [diag] = useState<RecorderDiagnostics>(() => probe());
  const [confirmOut, setConfirmOut] = useState(false);
  const [langBusy, setLangBusy] = useState<Locale | null>(null);
  const [langErr, setLangErr] = useState('');
  const session = useSession();
  const me = session?.user;
  const upd = useUpdate();

  // 老服务端不返回 locale，缺省即中文 —— 和 i18n.ts 里那条判断保持一致
  const curLocale: Locale = me?.locale === 'en' ? 'en' : 'zh';

  const switchLocale = async (next: Locale) => {
    if (next === curLocale || langBusy) return;
    setLangErr('');
    if (!navigator.onLine) {
      // 不做本地假开关：本机翻成英文、服务端的小结和错误话术仍是中文，
      // 那种半边天比「现在改不了」更难查
      setLangErr(t('离线时改不了 —— 语言存在账号上，要连上服务器。'));
      return;
    }
    setLangBusy(next);
    try {
      await setLocale(next);
    } catch (e) {
      setLangErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLangBusy(null);
    }
  };

  /** 版本那一行的说明。**「连不上」和「已是最新」必须分开说**，混成一句会骗人。 */
  const updateNote = (): string => {
    if (upd.status === 'checking') return t('正在检查…');
    if (upd.status === 'ready') return t('有新版本 —— 点右边换过去');
    if (upd.status === 'offline') return t('连不上服务器，这次没查成');
    if (upd.status === 'unsupported') return t('这个浏览器不支持后台更新');
    if (upd.status === 'latest')
      return upd.checkedAt ? t('已是最新 · {a}检查过', { a: fmtAgo(upd.checkedAt) }) : t('已是最新');
    return t('还没查过');
  };

  useEffect(() => {
    if (!me) return;
    const load = async () =>
      setNotes(await myNotes(me.userCode).toArray());
    void load();
    const t = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(t);
  }, [me?.userCode]);

  const companies = new Set(notes.map((n) => n.companyCode).filter(Boolean));
  const unassigned = notes.filter((n) => !n.companyCode).length;
  const withAudio = notes.filter((n) => n.audioSeconds != null).length;
  const pending = notes.filter((n) => n.sync !== 'synced').length;
  const totalSec = notes.reduce((a, n) => a + (n.audioSeconds ?? 0), 0);

  return (
    <div style={{ padding: 14, paddingBottom: 28 }}>
      <div style={{ ...card, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{me?.displayName}</span>
          <span style={{ fontSize: 12, color: T.textLight }}>{me?.userCode}</span>
          <span style={{ fontSize: 11, color: T.textSoft, marginLeft: 'auto' }}>{me?.role}</span>
        </div>
        <div style={{ fontSize: 12, color: T.textSoft, marginTop: 3 }}>{t('当前事件：{a}', { a: CURRENT_VISIT })}</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
        <Stat n={notes.length} label={t('我的速记')} />
        <Stat n={companies.size} label={t('覆盖客户')} />
        <Stat n={withAudio} label={t('含录音')} />
        <Stat n={unassigned} label={t('待定客户')} accent={unassigned ? T.amber : undefined} />
      </div>

      {totalSec > 0 && (
        <div style={{ ...card, marginBottom: 12, fontSize: 12, color: T.textSoft }}>
          {t('累计录音 {a} 分钟', { a: Math.round(totalSec / 60) })}
        </div>
      )}

      {pending > 0 && (
        <button
          onClick={() => void flush()}
          style={{
            width: '100%',
            padding: '12px 0',
            borderRadius: 10,
            background: T.blue,
            color: '#fff',
            fontSize: 14,
            fontWeight: 600,
            marginBottom: 20,
          }}
        >
          {t('立即上传 {a} 条', { a: pending })}
        </button>
      )}

      {/* ── 界面语言（D83）─────────────────────────────────────────
          这一格改的是**服务端**，不是本机开关：语言存在账号上（D80），
          换台手机登录、清一次缓存，看到的还是自己那种语言。
          它同时决定 `/enums` 给哪种标签、网关的错误话术、agent 小结用哪种语言 ——
          所以不能有一个「只改本机」的版本，那会让人一半界面英文、一半中文。 */}
      <div style={{ fontSize: 12, fontWeight: 600, color: T.textSoft, margin: '18px 0 8px' }}>
        {t('界面语言')}
      </div>
      <div style={{ ...card }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {LOCALES.map((L) => {
            const on = L.id === curLocale;
            return (
              <button
                key={L.id}
                onClick={() => void switchLocale(L.id)}
                disabled={langBusy !== null}
                style={{
                  flex: 1,
                  padding: '10px 0',
                  borderRadius: 10,
                  borderWidth: 1,
                  borderStyle: 'solid',
                  // ⚠️ 用 borderWidth/Style/Color 三条，**不用 border 简写** ——
                  //    简写会被后面的 borderColor 整条盖掉，重渲染时边框直接消失
                  //    （2026-08-07 在 ReviewCard 上踩过，那个 bug 已经上过生产）
                  borderColor: on ? T.text : T.line,
                  background: on ? T.text : T.bg,
                  color: on ? '#fff' : T.text,
                  fontSize: 14,
                  fontWeight: on ? 600 : 400,
                  opacity: langBusy && langBusy !== L.id ? 0.5 : 1,
                }}
              >
                {langBusy === L.id ? '…' : L.label}
              </button>
            );
          })}
        </div>
        <div
          style={{
            fontSize: 11,
            color: langErr ? T.red : T.textLight,
            marginTop: 8,
            lineHeight: 1.6,
          }}
        >
          {langErr || t('语言跟账号走 —— 换手机、换浏览器、清缓存都还在。')}
        </div>
      </div>

      {/* ── 版本（D83）─────────────────────────────────────────────
          iOS 把网页存到桌面之后多半只「恢复」不「重新加载」，
          所以自动更新那条路可能整段不跑（这正是 D83 要修的）。
          这个键是那条路的兜底：**人自己能问一次，并且看得见答案。** */}
      <div style={{ fontSize: 12, fontWeight: 600, color: T.textSoft, margin: '18px 0 8px' }}>
        {t('版本')}
      </div>
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>{BUILD_ID}</div>
          <div
            style={{
              fontSize: 11,
              color: upd.status === 'ready' ? T.blue : T.textLight,
              marginTop: 3,
              lineHeight: 1.6,
            }}
          >
            {updateNote()}
          </div>
        </div>
        <button
          onClick={() => (upd.status === 'ready' ? applyUpdate() : void checkForUpdate('manual'))}
          disabled={upd.status === 'checking'}
          style={{
            flexShrink: 0,
            padding: '9px 14px',
            borderRadius: 10,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: upd.status === 'ready' ? T.blue : T.line,
            background: upd.status === 'ready' ? T.blue : T.bg,
            color: upd.status === 'ready' ? '#fff' : T.text,
            fontSize: 13,
            fontWeight: 600,
            opacity: upd.status === 'checking' ? 0.5 : 1,
          }}
        >
          {upd.status === 'ready' ? t('立即更新') : t('检查更新')}
        </button>
      </div>

      <div style={{ fontSize: 12, fontWeight: 600, color: T.textSoft, margin: '18px 0 8px' }}>
        {t('本机录音能力')}
      </div>
      <div style={{ ...card, fontSize: 12, lineHeight: 1.9 }}>
        <Row ok={diag.secureContext} label="Secure context" note={t('https 或 localhost')} />
        <Row ok={diag.hasMediaDevices} label="mediaDevices" note={t('能否申请麦克风')} />
        <Row ok={diag.hasMediaRecorder} label="MediaRecorder" note={t('录音 API')} />
        <div style={{ borderTop: `1px solid ${T.line}`, marginTop: 8, paddingTop: 8 }}>
          <div style={{ color: T.textSoft }}>
            {t('将使用容器：')}
            <b style={{ color: diag.chosen ? T.text : T.red }}>{diag.chosen ?? t('（无可用）')}</b>
          </div>
          <div style={{ color: T.textLight, marginTop: 2 }}>
            {t('支持 {a} 种：{b}', { a: diag.supported.length, b: diag.supported.join(' · ') || t('无') })}
          </div>
          <div
            style={{
              color: T.textLight,
              marginTop: 6,
              fontSize: 10.5,
              wordBreak: 'break-all',
              lineHeight: 1.5,
            }}
          >
            {diag.userAgent}
          </div>
        </div>
      </div>
      <div style={{ fontSize: 10.5, color: T.textLight, marginTop: 8, lineHeight: 1.7 }}>
        {t('这一屏就是 T8 的实测结果。Safari 18.4 起才原生支持 webm；更早的 iOS 只有 mp4 ——')}
        {t('所以服务端不能只收一种容器。')}
      </div>

      {/* ── 退出登录 ─────────────────────────────────────────────
          退出**不删本地数据**：没传上去的速记仍在这台手机的 IndexedDB 里，
          按 recordedBy 归在原来那个人名下，重新登录就继续补传（三段解耦的第一段）。
          但换个人登录就看不到它们了 —— 所以这里必须把话说清楚，不能静默退出。 */}
      <div style={{ marginTop: 28 }}>
        {pending > 0 && (
          <div
            style={{
              padding: '11px 13px',
              borderRadius: 10,
              background: T.amberSoft,
              color: T.amber,
              fontSize: 12.5,
              lineHeight: 1.7,
              marginBottom: 10,
            }}
          >
            {t('还有')} <b>{pending}</b> {t('条没上传。退出不会删掉它们，但要等')} <b>{me?.userCode}</b>{' '}
            {t('重新登录后才会继续传。有网的话建议先传完再退。')}
          </div>
        )}
        <button
          onClick={() => (confirmOut ? logout() : setConfirmOut(true))}
          onBlur={() => setConfirmOut(false)}
          style={{
            width: '100%',
            padding: '12px 0',
            borderRadius: 10,
            border: `1px solid ${confirmOut ? T.red : T.line}`,
            color: T.red,
            background: confirmOut ? T.redSoft : T.bg,
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          {confirmOut ? '再点一次确认退出' : t('退出登录')}
        </button>
      </div>
    </div>
  );
};

const Stat = ({ n, label, accent }: { n: number; label: string; accent?: string }) => (
  <div style={{ ...card, textAlign: 'center', padding: '14px 8px' }}>
    <div style={{ fontSize: 24, fontWeight: 700, color: accent ?? T.text, lineHeight: 1.2 }}>{n}</div>
    <div style={{ fontSize: 11.5, color: T.textSoft, marginTop: 2 }}>{label}</div>
  </div>
);

const Row = ({ ok, label, note }: { ok: boolean; label: string; note: string }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    <span style={{ color: ok ? T.green : T.red, fontWeight: 700, width: 14 }}>{ok ? '✓' : '✕'}</span>
    <span style={{ flex: 1 }}>{label}</span>
    <span style={{ color: T.textLight, fontSize: 11 }}>{note}</span>
  </div>
);

const card: React.CSSProperties = {
  background: T.bg,
  border: `1px solid ${T.line}`,
  borderRadius: 10,
  padding: '13px 14px',
};
