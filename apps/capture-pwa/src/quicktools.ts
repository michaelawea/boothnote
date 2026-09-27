/**
 * 速记页「快捷工具」栏上，**今天该摆哪几个**（D136）。
 *
 * 维护者 2026-09-27（法国 VDL 展前）：「之后在什么时期的时候，这里就会有
 * 当时需要用到的快捷工具可以展开填写。」—— 工具跟着**时期**走：
 * 这场展会要问卷，下一场可能要别的，用完就该从这一屏上消失。
 *
 * 所以每个工具带一个可选的日期窗口，**判断只在这一个纯函数里**
 * （界面那一层只管画，不再各写一遍日期比较）。
 *
 * 🔴 按**手机本地日期**比，不按 UTC：展馆在巴黎，UTC 比当地晚 1–2 小时，
 * 用 `toISOString()` 的话开展第一天 00:00–02:00 工具还没上架、
 * 撤展那天的深夜又提前消失。日期串就是手机日历上那一天。
 */

export type ToolWindow = {
  /** 第一天（含），`YYYY-MM-DD`。不填 = 一直有。 */
  from?: string;
  /** 最后一天（含），`YYYY-MM-DD`。不填 = 一直有。 */
  until?: string;
};

/** 手机日历上的「今天」，`YYYY-MM-DD`。 */
export const localDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 两端都含：`until` 那一天整天都还在。`YYYY-MM-DD` 定长，字符串比较就是日期比较。 */
export const isActive = (w: ToolWindow, now: Date): boolean => {
  const day = localDay(now);
  return (!w.from || w.from <= day) && (!w.until || day <= w.until);
};

/** 保持清单里的先后顺序 —— 顺序是人排的，不在这里重排。 */
export const activeTools = <T extends ToolWindow>(list: readonly T[], now: Date): T[] =>
  list.filter((x) => isActive(x, now));
