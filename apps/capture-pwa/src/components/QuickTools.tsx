import { useState } from 'react';

import { T } from '../theme';
import { activeTools, type ToolWindow } from '../quicktools';
import { IconChevron, IconClipboard } from '../icons';
import { SurveySheet } from '../pages/Survey';
import { t } from '../i18n';

/**
 * ══════════════════════════════════════════════════════════════════
 *  速记页上的「快捷工具」栏（D136 · 维护者 2026-09-27）
 *
 *  「在『速记』界面，下面的历史记录和上面的『拍照』『图片』『文件』之间，
 *   加一条 hot bar，之后在什么时期的时候，这里就会有当时需要用到的
 *   快捷工具可以展开填写。」
 *
 *  第一个工具是法国 VDL 展的 2C 客户问卷 —— 展台上来的终端用户很多，
 *  要一个个记下来。
 *
 *  ── 三个形状上的决定 ──────────────────────────────────────────
 *
 *  ① **没有工具在期 → 整栏不画**（连标题都不留）。这一屏的全部设计目标是
 *     「一屏之内录完」，一条空栏就是白占的一行。
 *  ② **长得像卡片，不像上面那排 chip。** 那三个 chip 是往**正在写的这条速记**
 *     上挂东西；这里点下去是**进另一个工具**，和草稿无关。长得一样的话，
 *     人会以为问卷填完是挂在这条速记上的。
 *  ③ **工具开在全屏浮层里（`Sheet`），不跳路由** —— 和速记详情（D96）同一个理由：
 *     速记页整个还挂着，正在打的草稿、**正在录的音**都不受影响。
 *
 *  ── 要加一个工具 ──────────────────────────────────────────────
 *
 *  往下面 `TOOLS` 里加一行 + 写它自己那一屏。日期窗口填 `from` / `until`
 *  （手机本地日期，两端都含，见 `quicktools.ts`），过期自动下架，不用再发版去删。
 *  ⚠️ `label` / `hint` **存中文原文、渲染时才过 `t()`**（D80：模块级不许调 `t()`），
 *     并且要往 `i18n.ts` 的字典里补英文。
 * ══════════════════════════════════════════════════════════════════ */

type Tool = ToolWindow & {
  id: string;
  label: string;
  hint: string;
  icon: React.ReactNode;
  /** 点开之后那一屏。关掉时必须调 `onClose`。 */
  Open: (p: { onClose: () => void }) => React.ReactNode;
};

const TOOLS: Tool[] = [
  {
    id: 'vdl-2c-survey',
    label: '2C 客户问卷',
    hint: 'VDL 法国展',
    icon: <IconClipboard size={19} />,
    Open: SurveySheet,
    // VDL 2026 第 60 届，巴黎 Le Bourget：「26 sept — 04 oct 2026」（salonvdl.com 官方页，2026-09-27 核对）
    from: '2026-09-26',
    until: '2026-10-04',
  },
];

export const QuickTools = () => {
  const [openId, setOpenId] = useState<string | null>(null);
  // 每次渲染都重算：速记页每 1.5 秒刷一次列表，过了零点自己就会换
  const tools = activeTools(TOOLS, new Date());
  const open = openId ? TOOLS.find((x) => x.id === openId) : undefined;

  return (
    <>
      {tools.length > 0 && (
        <div style={{ marginBottom: 4 }}>
          <div style={{ fontSize: 12.5, color: T.textSoft, marginBottom: 8 }}>{t('快捷工具')}</div>
          {/* 一个工具时占满一行；多了横向滑，不换行 —— 换行会把下面的列表往下推 */}
          <div className="hotbar" style={{ display: 'flex', gap: 8, overflowX: 'auto' }}>
            {tools.map((x) => (
              <ToolTile key={x.id} tool={x} solo={tools.length === 1} onClick={() => setOpenId(x.id)} />
            ))}
          </div>
        </div>
      )}

      {/* 开着的那一屏不跟着窗口走：填到一半跨过了 until 那天的零点，也不能把人踢出去 */}
      {open && <open.Open onClose={() => setOpenId(null)} />}
    </>
  );
};

const ToolTile = ({ tool, solo, onClick }: { tool: Tool; solo: boolean; onClick: () => void }) => (
  <button
    data-tool={tool.id}
    onClick={onClick}
    style={{
      flex: solo ? 1 : '0 0 auto',
      minWidth: solo ? 0 : 176,
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '9px 10px 9px 9px',
      borderRadius: 14,
      border: `1px solid ${T.line}`,
      background: T.surface,
      textAlign: 'left',
    }}
  >
    <span
      style={{
        width: 34,
        height: 34,
        borderRadius: 10,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: T.blueSoft,
        color: T.blue,
      }}
    >
      {tool.icon}
    </span>
    <span style={{ flex: 1, minWidth: 0 }}>
      <span style={{ display: 'block', fontSize: 14, fontWeight: 500, lineHeight: 1.35 }}>{t(tool.label)}</span>
      <span style={{ display: 'block', fontSize: 11.5, color: T.textLight, lineHeight: 1.35 }}>
        {t(tool.hint)}
      </span>
    </span>
    <span style={{ display: 'flex', color: T.textLight, flexShrink: 0 }}>
      <IconChevron size={15} />
    </span>
  </button>
);
