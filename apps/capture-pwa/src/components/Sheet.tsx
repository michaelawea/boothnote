import { useEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * ══════════════════════════════════════════════════════════════════
 *  全屏浮层的壳（D109 · 2026-08-11 维护者 真机实测）
 *
 *  他的原话：「我点进去之后发现蒙版被挡住了。系统一直在显示『速记』『客户』
 *  『AI』『看板』以及顶部的那些……上面的退出键和下面的一堆按键都被挡住。
 *  更严重的是，被挡住之后，下面的按键就失效了 —— 界面上显示的是这些按键，
 *  但因为被挡住了，你点下去，实际响应的又是下层的按键。」
 *
 *  🔴 **这就是他一直删不掉、改不掉数据的原因**：速记详情页底部那一排
 *  （修改 / 发给 AI / 删除）正好落在底栏五个键的位置上，手指点下去
 *  接住的是底栏 —— 于是「按了没反应」，而界面上一切正常。
 *
 *  ── 两件事一起做，因为它们防的是两个不同的失败 ──────────────────
 *
 *  ① **portal 到 `document.body`。**
 *     `NoteDetail` 原来长在 `.app-body`（`flex:1; overflow-y:auto;
 *     -webkit-overflow-scrolling:touch`）里面。桌面 Chrome 上它照常铺满，
 *     手机上却不是 —— iOS 的滚动容器会把 `position:fixed` 的后代按容器
 *     而不是按视口来摆。**同一份代码在两个平台上不是同一个盒子。**
 *     `ChatSheet` 一直是 `.app` 的直接子级，所以它从来没这个毛病 ——
 *     这也是为什么 维护者 说「就像 AI Agent 那个界面一样就好了」。
 *
 *  ② **顶栏和底栏在浮层开着时整个拿掉**（不是盖住，是 `display:none`）。
 *     光靠层级只能保证「看不见」，拿掉才能保证「点不着」。
 *     而这个 bug 最贵的部分正是后者：**看得见的按钮点下去响应的是别人。**
 *
 *  ⚠️ 计数而不是布尔：速记详情上还能再开 AI 那一屏，两层同时在。
 *     用布尔的话，先关的那一层会把底栏放回来，而上面那层还开着。
 * ══════════════════════════════════════════════════════════════════ */

/** 现在有几层全屏浮层开着。 */
let open = 0;

const mark = (delta: number) => {
  open = Math.max(0, open + delta);
  if (open > 0) document.body.dataset.sheet = 'open';
  else delete document.body.dataset.sheet;
};

export const Sheet = ({
  /** 关闭动画正在播（`.sheet[data-closing]`）。 */
  closing,
  children,
}: {
  closing?: boolean;
  children: React.ReactNode;
}) => {
  useEffect(() => {
    mark(1);
    return () => mark(-1);
  }, []);

  return createPortal(
    <div className="sheet" data-closing={closing}>
      {children}
    </div>,
    document.body,
  );
};
