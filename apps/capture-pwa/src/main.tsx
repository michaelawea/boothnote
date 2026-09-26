import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './index.css';
import { App } from './App';
import { startSyncLoop } from './sync';
import { initUpdate } from './update';

startSyncLoop();
// Service Worker 的注册与更新检查都在这里面（D83）。
// 🔴 放在这里而不是组件里：StrictMode 会把 effect 跑两遍，定时器会翻倍。
initUpdate();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
