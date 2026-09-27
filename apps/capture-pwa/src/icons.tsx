/** 内联 SVG 图标。不引图标库 —— 展馆弱网，能省一个依赖是一个。 */
type P = { size?: number };
const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

export const IconMic = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <rect x="9" y="2" width="6" height="11" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8" />
  </svg>
);

/**
 * 「新建速记」和「语音速记」—— 方框里一支笔 / 方框里一个麦克风。
 *
 * 维护者 2026-08-05（issue #16）：「应该设计的像是苹果的备忘录那样，
 * 有一个按钮（方框中一支笔）创建速记，旁边并列一个按钮（方框中一个麦克风）
 * 进行麦克风速记」。
 *
 * 🔴 为什么这一改不是审美问题：原来那一屏上是一个 ↑ 发送键，
 * **人以为它是「发给 Agent」**（原话），而它其实只是保存。
 * 一个键长得像另一件事，在展会现场就是每次都要停一下想一想。
 */
export const IconNoteNew = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="3" width="18" height="18" rx="4" />
    <path d="M15.2 8.1l-6 6-.6 2.3 2.3-.6 6-6a1.2 1.2 0 0 0 0-1.7 1.2 1.2 0 0 0-1.7 0z" />
  </svg>
);

export const IconNoteMic = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="3" width="18" height="18" rx="4" />
    <rect x="10.2" y="7" width="3.6" height="6.4" rx="1.8" />
    <path d="M8.4 12.2a3.6 3.6 0 0 0 7.2 0M12 15.8V18" />
  </svg>
);

export const IconSpark = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    <path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
  </svg>
);

export const IconUser = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </svg>
);

export const IconBuilding = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M4 21V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15M14 10h4a2 2 0 0 1 2 2v9M3 21h18" />
    <path d="M8 8h2M8 12h2M8 16h2M17 14h1M17 17h1" />
  </svg>
);

export const IconBoard = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M8 16V11M12 16V8M16 16v-3" />
  </svg>
);

export const IconStop = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
  </svg>
);

export const IconSend = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
);

export const IconTrash = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13" />
  </svg>
);

export const IconCheck = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M4 12.5l5 5L20 6.5" />
  </svg>
);

export const IconClose = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const IconHistory = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M3 12a9 9 0 1 0 3-6.7M3 4v4h4" />
    <path d="M12 8v4l3 2" />
  </svg>
);

export const IconPlus = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconCamera = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <circle cx="12" cy="12.5" r="3.5" />
  </svg>
);

export const IconImage = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="8.5" cy="10" r="1.5" />
    <path d="M21 16l-5-5-6 6-2-2-5 4" />
  </svg>
);

export const IconFile = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </svg>
);

export const IconUndo = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M4 10h10a5 5 0 0 1 0 10h-4M4 10l4-4M4 10l4 4" />
  </svg>
);

/**
 * 长按一条消息之后那一列动作用的两个（D103 · issue #31）。
 * 图标不是装饰：那一列在虚化背景上浮着，只有文字的话三行长得一样，
 * 手指要停下来读一遍才敢按 —— 而这一下操作发生在展台上。
 */
export const IconCopy = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </svg>
);

/** 重新发送 —— 顺时针一圈。和 `IconUndo`（逆时针）刻意反向，两个会挨着出现。 */
export const IconRedo = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M20 10H10a5 5 0 0 0 0 10h4M20 10l-4-4M20 10l-4 4" />
  </svg>
);

/** 「改一下」那支笔（手册 PA3 / PC3 用的就是它）。 */
export const IconPen = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4Z" />
    <path d="M13.5 6.5l4 4" />
  </svg>
);

export const IconSearch = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </svg>
);

/** 漏斗。看板的筛选面板收在它下面（D76 修订）。 */
export const IconFilter = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M3 5h18l-7 8v6l-4 2v-8z" />
  </svg>
);

export const IconChevron = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);

export const IconShare = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M12 16V4M8 8l4-4 4 4" />
    <path d="M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
  </svg>
);

/* ── 编辑器工具栏（D135）─────────────────────────────────────────
   只画 `markdown.ts` 认得的那几种 —— 工具栏上每一个键插进去的东西，
   在详情页和列表摘要里都必须渲染得出来。 */

export const IconHeading = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M7 5v14M17 5v14M7 12h10" />
  </svg>
);

export const IconBold = ({ size = 20 }: P) => (
  <svg {...base(size)} strokeWidth={2.4}>
    <path d="M7 5h5.5a3.5 3.5 0 0 1 0 7H7zM7 12h6.5a3.5 3.5 0 0 1 0 7H7z" />
  </svg>
);

export const IconListBullet = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M10 6h10M10 12h10M10 18h10" />
    <circle cx="5" cy="6" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="5" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="5" cy="18" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);

export const IconListNumber = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M10 6h10M10 12h10M10 18h10" />
    <path d="M4 5l1.3-1V8.5" strokeWidth={1.4} />
    <path d="M3.8 11a1.2 1.2 0 0 1 2.3.4c0 .9-2.3 1.6-2.3 3h2.4" strokeWidth={1.4} />
  </svg>
);

export const IconListTask = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <rect x="3.5" y="3.5" width="6" height="6" rx="1.5" />
    <path d="M5.2 6.6l1.1 1.1 2-2.2" strokeWidth={1.5} />
    <rect x="3.5" y="14.5" width="6" height="6" rx="1.5" />
    <path d="M13 6.5h7M13 17.5h7" />
  </svg>
);

export const IconQuote = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M5 5v14" strokeWidth={2.4} />
    <path d="M10 8h10M10 12h10M10 16h6" />
  </svg>
);
