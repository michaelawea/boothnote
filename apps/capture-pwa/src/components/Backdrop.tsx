import { createPortal } from 'react-dom';

import { T } from '../theme';

/**
 * 底部弹层的壳。点遮罩关掉。
 *
 * 三个删除确认（对话 / 速记 / 看板）和「发给 AI」那个选择框都长在它上面 ——
 * 删除这件事在三个面上手感一致，靠的就是它们共用这一个壳。
 *
 * 🔴 **必须 portal 到 body，光靠 z-index 不够**（2026-08-11 在 Chrome 里实测撞到）。
 *
 * 症状：AI 那一屏的历史抽屉里点删除，确认框**出现在抽屉的遮罩下面** ——
 * 看着是灰的，点「删除」那一下打的是遮罩，结果是抽屉被关掉，对话一条没删。
 * 而且它看起来像「按钮没反应」，人只会以为删除坏了。
 *
 * 根因是这个仓库已经记过一次的那个坑（`Chat.tsx` 历史抽屉那段注释）：
 * **`.sheet` 带 `transform`（开合动画），于是它自己成了一个层叠上下文** ——
 * 长在里面的 `z-index: 60` 只在那个上下文内部排序，对外整体只有 `.sheet` 的 40，
 * 而抽屉和它的遮罩是 body 上的 50/51。数字大的那个反而在下面。
 *
 * 判据：**只要一个浮层可能和另一个浮层同屏，就 portal 到 body，别只调数字。**
 * z-index 在不同的层叠上下文之间是不可比的 —— 「60 > 51」这句话本身就是错的前提。
 *
 * ⚠️ 于是 z-index 也要压过抽屉（51）和撤销条（70）：确认框永远在最上面。
 *
 * 📜 原来住在 `pages/NoteDetail.tsx` 里，被 `Board.tsx` 以 `SheetBackdrop`
 *    的名字反向 import 走。issue #33 之后第三个页面也要用它，
 *    「页面 A 从页面 B 里 import 一个壳」这条线就该断了。
 */
export const Backdrop = ({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) =>
  createPortal(
  <div
    onClick={onClose}
    style={{
      position: 'fixed',
      inset: 0,
      zIndex: 80,
      background: 'rgba(0,0,0,.34)',
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'center',
      animation: 'fade .16s ease both',
    }}
  >
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        width: '100%',
        maxWidth: 460,
        background: T.surface,
        borderRadius: '18px 18px 0 0',
        padding: '18px 18px 20px',
        paddingBottom: 'max(20px, env(safe-area-inset-bottom))',
        maxHeight: '82vh',
        overflowY: 'auto',
        animation: 'picksheet-up .2s cubic-bezier(.2,.9,.25,1) both',
      }}
    >
      {children}
    </div>
  </div>,
  document.body,
);
