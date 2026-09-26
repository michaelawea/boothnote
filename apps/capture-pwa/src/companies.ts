import { useEffect, useState } from 'react';

import { cachedCompanies, syncCompanies } from './api';
import { type Company } from './db';

/**
 * 客户名单的单一来源。
 *
 * 顺序刻意如此：**先给缓存，再后台刷新。**
 * 反过来（等网络回来再渲染）会让展馆断网时下拉是空的 —— 那等于采集端废了。
 */
export const useCompanies = (): Company[] => {
  const [items, setItems] = useState<Company[]>([]);

  useEffect(() => {
    let alive = true;
    void cachedCompanies().then((c) => alive && c.length && setItems(c));
    void syncCompanies().then((c) => alive && c.length && setItems(c));

    // 展会期间业务方可能新增客户 —— 每 10 分钟悄悄刷一次，不打扰使用
    const t = window.setInterval(() => {
      void syncCompanies().then((c) => alive && c.length && setItems(c));
    }, 600_000);

    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  return items;
};
