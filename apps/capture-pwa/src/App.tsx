import { useEffect, useState } from 'react';

import { T } from './theme';
import { countBySync, mySurveys } from './db';
import { onSyncChange, flush, flushSurveys, anyUploading } from './sync';
import { useSyncTick } from './useSync';
import { ProgressRing } from './components/ProgressRing';
import { PENDING_STATES } from './retry';
import { useSession, revalidate } from './auth';
import { LoginPage } from './pages/Login';
import { QuickNotePage } from './pages/QuickNote';
import { CompaniesPage } from './pages/Companies';
import { BoardPage } from './pages/Board';
import { MePage } from './pages/Me';
import { ChatSheet } from './pages/Chat';
import { Onboarding, needsOnboarding } from './pages/Onboarding';
import { IconBoard, IconBuilding, IconMic, IconSpark, IconUser } from './icons';
import { t as tr } from './i18n';
import { applyUpdate, setBusy, useUpdate } from './update';

type Tab = 'note' | 'companies' | 'board' | 'me';

/**
 * 底栏五个槽，中间那个是 AI。
 *
 * 这个布局是回到「产品打样那一版」的形态（维护者 2026-08-02 的原话是
 * 「当时 Agent 的界面就做得非常好」）。中间键不是第五个页面 ——
 * 它**弹起一整屏对话**，右上角 ✕ 回来。所以它在 TABS 之外单独处理。
 */
const TABS: Array<{ id: Tab; label: string; Icon: typeof IconMic; slot: 0 | 1 | 3 | 4 }> = [
  { id: 'note', label: '速记', Icon: IconMic, slot: 0 },   // 标签在渲染处过 t()，不在这里 ——
  { id: 'companies', label: '客户', Icon: IconBuilding, slot: 1 },
  { id: 'board', label: '看板', Icon: IconBoard, slot: 3 },
  { id: 'me', label: '我的', Icon: IconUser, slot: 4 },      // 这张表也被顶栏标题复用，翻在源头会让 key 变英文
];

export const App = () => {
  const [tab, setTab] = useState<Tab>('note');
  const [chat, setChat] = useState(false);
  const [chatThread, setChatThread] = useState<string | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(0);
  const [onboarding, setOnboarding] = useState(needsOnboarding);
  const session = useSession();
  const upd = useUpdate();
  useSyncTick(); // 顶栏那个圈也要跟着进度动

  /**
   * AI 对话开着的时候**不许自动刷新**（D83）。
   *
   * 线程本身在服务端，刷新丢不掉数据；丢的是「人正在读的那一屏」——
   * 一次 8 步的 agent 跑完要一两分钟，在展台上被打断就得从头看起。
   * 这不是数据安全问题，是「别在人正看着的时候把桌子掀了」。
   */
  useEffect(() => {
    setBusy('chat', chat);
  }, [chat]);

  /**
   * 启动时向 `/me` 校验一次 —— 撤权的检查点（D35⑤）。
   *
   * ⚠️ 它是**故意不阻塞渲染**的：有缓存的登录态先放人进来，校验在后台跑。
   * 反过来做（等校验完再渲染）会让展馆一断网就谁都进不去，而离线照常录是硬需求。
   * 只有服务端明确回 401 时 `revalidate` 才会清掉登录态，这里随即切回登录页。
   */
  useEffect(() => {
    void revalidate();
  }, []);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const myCode = session?.user.userCode;
  useEffect(() => {
    // ⚠️ `syncing` 也要数进来 —— 一条卡在上传中的速记如果不显示，
    //    人就完全不知道它存在，那是最糟的一种失败（见 retry.ts）
    const refresh = async () => {
      let n = 0;
      for (const st of PENDING_STATES) n += await countBySync(st, myCode);
      // 没传上去的 2C 问卷也算（D138）—— 看不见的待传等于不存在
      n += await mySurveys(myCode).and((x) => PENDING_STATES.includes(x.sync)).count();
      setPending(n);
    };
    void refresh();
    const un = onSyncChange(() => void refresh());
    const t = window.setInterval(() => void refresh(), 2000);
    return () => {
      un();
      window.clearInterval(t);
    };
  }, [myCode]);

  // 未登录 = 整个采集端不可用。所有 hook 都在这行之前调用完，顺序不受分支影响。
  if (!session) return <LoginPage />;
  if (onboarding) return <Onboarding onDone={() => setOnboarding(false)} />;

  const page = (
    <>
      {tab === 'note' && (
        <QuickNotePage
          onOpenChat={(id) => {
            setChatThread(id);
            setChat(true);
          }}
        />
      )}
      {tab === 'companies' && <CompaniesPage />}
      {/* 看板上 `ready` 的行点开只读，出口是「去对话里确认」——
          确认要看 AI 整轮的工作日志，那是对话页的事（D76）。 */}
      {tab === 'board' && (
        <BoardPage
          onOpenChat={(id) => {
            setChatThread(id);
            setChat(true);
          }}
        />
      )}
      {tab === 'me' && <MePage />}
    </>
  );

  /**
   * ── 电脑端侧栏（D77）──────────────────────────────────────────
   *
   * 🔴 **它和底栏两个都渲染，靠 CSS 二选一 —— 没有任何 JS 分支。**
   *
   * 用 `matchMedia` 分叉是更"聪明"的写法，但那意味着手机上也要跑一次判断、
   * 挂一个 resize 监听、并且多一条永远不该走到的代码路径。
   * 而 维护者 的要求是「千万不要动任何相应的手机端 UI」——
   * **最强的保证不是我小心，是 900px 以下根本没有新规则生效**：
   * `.app-side` 的默认值就是 `display:none`，媒体查询之外一条规则都没有。
   *
   * 代价：手机上多十几个 DOM 节点（`display:none`，不进无障碍树、不参与布局）。
   * 换来的是「手机端零改动」这件事可以被机械验证，而不是靠 review。
   */
  const side = (
    <aside className="app-side">
      <div className="app-side-brand">
        <span style={{ color: T.blue, display: 'inline-flex' }}>
          <IconSpark size={16} />
        </span>
        {tr('Boothnote')}
      </div>

      {TABS.map((t) => (
        <button
          key={t.id}
          className="app-side-item"
          // aria-current 既是无障碍语义，也是高亮那条 CSS 的选择器 —— 一处两用
          aria-current={tab === t.id ? 'page' : undefined}
          onClick={() => setTab(t.id)}
        >
          <t.Icon size={17} />
          {tr(t.label)}
        </button>
      ))}

      <div className="app-side-sep" />

      {/* 中间那个圆键在桌面上没有意义（拇指够不着这回事不存在），
          所以在侧栏里它就是一个普通条目 —— 但仍然**永远是新对话**，
          历史要主动去翻（和底栏那个键同一条规矩）。 */}
      <button
        className="app-side-item"
        onClick={() => {
          setChatThread(null);
          setChat(true);
        }}
      >
        <span style={{ color: T.blue, display: 'inline-flex' }}>
          <IconSpark size={17} />
        </span>
        {tr('问 AI')}
      </button>

      <div className="app-side-foot">
        {session.user.displayName}
        <br />
        <span style={{ fontSize: 11 }}>{session.user.userCode}</span>
      </div>
    </aside>
  );

  return (
    <div className="app">
      {side}
      {/* 顶部只留一行：**离线和待传必须一眼看见**。
          「已同步」那个常驻标签删掉了（维护者 2026-08-02）—— 一切正常时不该占位置。

          ⚠️ `app-head` / `app-body` 这两个 class **在 900px 以下没有任何规则**，
          纯粹是给桌面那套 grid 用来显式定位的。加 class 不改变手机端的渲染，
          也不改变 DOM 结构 —— 这是「不动手机端」这条承诺的实现方式（D77）。 */}
      <div
        className="app-head"
        style={{
          flexShrink: 0,
          paddingTop: 'env(safe-area-inset-top)',
          background: online ? T.bg : T.amberSoft,
          borderBottom: `1px solid ${T.lineLight}`,
        }}
      >
        <div
          className="app-head-row"
          style={{
            height: 46,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 16px',
          }}
        >
          <span style={{ fontSize: 15.5, fontWeight: 600 }}>
            {tr(TABS.find((x) => x.id === tab)?.label ?? '')}
          </span>
          {(!online || pending > 0) && (
            <button
              onClick={() => void flush({ manual: true }).then(() => flushSurveys({ manual: true }))}  // 人点了就一定试一次
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12.5,
                color: online ? T.textSoft : T.amber,
                padding: '4px 8px',
              }}
            >
              {anyUploading() ? (
                <ProgressRing size={13} color={online ? T.blue : T.amber} />
              ) : (
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 4,
                    background: online ? T.blue : T.amber,
                    animation: pending && online ? 'pulse 1.2s infinite' : undefined,
                  }}
                />
              )}
              {online
                ? tr('待传 ') + pending
                : tr('离线') + (pending ? ` · ${tr('待传 ')}${pending}` : '')}
            </button>
          )}
        </div>

        {/* ── 有新版本（D83）───────────────────────────────────────
            只在**不能自动换**的时候才会出现：正在录音 / 有草稿 / 正在上传 /
            AI 对话开着。那几种情况下替人刷新会把内存里的东西冲掉，
            所以这里退回「告诉他一声，让他自己挑时候」。
            平时它一格都不占 —— 一切正常时不该有东西常驻（和「已同步」那个标签同一条）。 */}
        {upd.status === 'ready' && (
          <button
            onClick={applyUpdate}
            style={{
              width: '100%',
              padding: '8px 16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              background: T.blueSoft,
              color: T.blue,
              fontSize: 12.5,
              fontWeight: 600,
              borderTop: `1px solid ${T.lineLight}`,
            }}
          >
            {tr('有新版本 · 点这里更新')}
          </button>
        )}
      </div>

      <div className="app-body" style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {/* `page-wrap` 的窄屏取值就是原来这里的内联样式（max-width:780px / margin:0 auto），
            逐条等价；桌面上它放宽到 1180（D77）。 */}
        <div className="page-wrap">{page}</div>
      </div>

      {/* ── 底栏：左二 · 中间 AI · 右二 ─────────────────────────
          桌面上整条收起来（`.app-tabs` 在 ≥900px 是 display:none）——
          它是拇指的东西，有鼠标时只是把五个键摊到一米宽。 */}
      <nav
        className="app-tabs"
        style={{
          flexShrink: 0,
          display: 'grid',
          gridTemplateColumns: 'repeat(5, 1fr)',
          alignItems: 'center',
          background: T.surface,
          borderTop: `1px solid ${T.lineLight}`,
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        {[0, 1, 2, 3, 4].map((slot) => {
          if (slot === 2) {
            return (
              <div key="ai" style={{ display: 'flex', justifyContent: 'center', padding: '6px 0' }}>
                <button
                  className="ai-key"
                  onClick={() => {
                    setChatThread(null); // 中间那个键永远是**新对话**，历史要主动去翻
                    setChat(true);
                  }}
                  aria-label={tr('打开 AI')}
                >
                  <IconSpark size={22} />
                </button>
              </div>
            );
          }
          const t = TABS.find((x) => x.slot === slot)!;
          const on = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 3,
                padding: '9px 0 7px',
                color: on ? T.text : T.textLight,
              }}
            >
              <t.Icon size={21} />
              <span style={{ fontSize: 10.5, fontWeight: on ? 600 : 400 }}>{tr(t.label)}</span>
            </button>
          );
        })}
      </nav>

      {chat && <ChatSheet initialThreadId={chatThread} onClose={() => setChat(false)} />}
    </div>
  );
};
