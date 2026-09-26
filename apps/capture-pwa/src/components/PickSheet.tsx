import { useEffect } from 'react';
import { createPortal } from 'react-dom';

import { T } from '../theme';
import { IconCheck } from '../icons';

/**
 * 从底下推上来的选择弹层 —— 手册 P8 / P18 / P23 画的就是它。
 *
 * 手册里四个场景的第③步全是同一个动作：**「哪一格不对，点『改一下』」**。
 * 在这之前核对卡上的字段是只读的，人看到「阶段：已接触」不对也只能干瞪眼，
 * 或者退回去再说一句话让 agent 重抽 —— 而那要再烧一轮模型，还不保证改对。
 *
 * 三个地方复用它：
 *   ① 改核对卡的某一格（枚举字段）
 *   ② 选这条情报算谁的、可信度多少（P18）
 *   ③ 选这条进展接在哪个项目 / 哪条售后上（P23，D57）
 *
 * 🔴 **`createPortal` 到 `document.body`。**
 * 不这么做的话它会被对话那一屏的容器裁掉 —— 那个容器有 `transform`，
 * 而带 transform 的祖先会成为 `position:fixed` 的包含块（历史抽屉踩过同一个坑）。
 */

export type PickOption = {
  value: string;
  label: string;
  /** 第二行小字。用来写「它原来读的」「被说的那家 —— 情报是关于它的」这类。 */
  hint?: string;
  /** 置灰但仍可见。手册 PA3 里 SOP / 量产 就是这个样子。 */
  dim?: boolean;
};

export const PickSheet = ({
  title,
  subtitle,
  options,
  value,
  onPick,
  onClose,
  footer,
}: {
  title: string;
  subtitle?: string;
  options: PickOption[];
  /** 当前选中的值。`null` = 一个都没选。 */
  value: string | null;
  onPick: (value: string) => void;
  onClose: () => void;
  footer?: React.ReactNode;
}) => {
  // 弹层开着的时候锁住背后的滚动，否则手指在选项上滑会把底下的对话也带着走
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', esc);
    };
  }, [onClose]);

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 90,
        background: 'rgba(0,0,0,.28)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        animation: 'picksheet-fade .16s ease',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          // 电脑上不铺满整屏 —— 和历史抽屉是同一条判据：手机全屏，电脑局部
          maxWidth: 520,
          maxHeight: '78vh',
          overflowY: 'auto',
          background: T.surface,
          borderRadius: `${T.radius + 6}px ${T.radius + 6}px 0 0`,
          padding: '10px 16px calc(18px + env(safe-area-inset-bottom))',
          animation: 'picksheet-up .22s cubic-bezier(.2,.9,.25,1)',
        }}
      >
        {/* 手柄。它唯一的作用是告诉人「这东西是能推下去的」 */}
        <div
          style={{
            width: 36,
            height: 4,
            borderRadius: 999,
            background: T.line,
            margin: '0 auto 12px',
          }}
        />

        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: subtitle ? 4 : 10 }}>{title}</div>
        {subtitle && (
          <div style={{ fontSize: 12.5, color: T.textSoft, marginBottom: 10, lineHeight: 1.6 }}>
            {subtitle}
          </div>
        )}

        {options.map((o) => {
          const on = o.value === value;
          return (
            <button
              key={o.value}
              onClick={() => onPick(o.value)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                textAlign: 'left',
                border: 'none',
                background: on ? T.blueSoft : 'transparent',
                borderRadius: 12,
                padding: '11px 12px',
                marginBottom: 2,
                cursor: 'pointer',
                font: 'inherit',
                color: o.dim && !on ? T.textLight : T.text,
              }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 14.5 }}>{o.label}</span>
                {o.hint && (
                  <span
                    style={{
                      display: 'block',
                      fontSize: 11.5,
                      color: T.textLight,
                      marginTop: 2,
                      lineHeight: 1.5,
                    }}
                  >
                    {o.hint}
                  </span>
                )}
              </span>
              {on && (
                <span style={{ color: T.blue, flexShrink: 0 }}>
                  <IconCheck size={16} />
                </span>
              )}
            </button>
          );
        })}

        {footer}
      </div>
    </div>,
    document.body,
  );
};
