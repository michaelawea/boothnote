import { useEffect, useState } from 'react';

import { onSyncChange } from './sync';

/**
 * 订阅同步事件，进度一变就重渲染。
 *
 * 为什么不复用页面上那个 1.5 秒的轮询：进度圈是给人看「它在动」的，
 * 1.5 秒一跳会让它看起来像卡住了 —— 那正好是这个圈要解决的问题本身。
 */
export const useSyncTick = (): number => {
  const [n, setN] = useState(0);
  useEffect(() => onSyncChange(() => setN((x) => x + 1)), []);
  return n;
};
