import { t } from './i18n';
/**
 * 设计令牌 —— **2026-08-02 在 chatgpt.com / openai.com 上实测量出来的**，不是凭印象写的。
 *
 * 为什么照抄这一套：销售同事已经在用 ChatGPT。界面长得一样，学习成本接近零，
 * 而展会现场没有第二次培训的机会。
 *
 * 三条最容易写错的：
 *   · 主按钮是 **#0D0D0D 近黑，不是品牌色**。ChatGPT 自己就是这么做的。
 *   · 描边是 **半透明发丝线** rgba(0,0,0,.10)，不是实色 —— 实色在深浅底上会突然变脏。
 *   · **不引 webfont**。系统栈在 iOS 上就是 SF Pro，而且省一次弱网请求。
 *
 * Voltline 蓝只留给 AI（中间那个键、登录页的标记），其余全是黑白灰。
 * 这是取舍不是定论 —— 维护者 2026-08-03：「先跑通，颜色是最后 10 分钟的事」。
 */
export const T = {
  // 底
  bg: '#FCFCFC',
  surface: '#FFFFFF',
  s2: '#F9F9F9',
  s3: '#F3F3F3',
  fill: 'rgba(0,0,0,.04)',

  // 字
  text: '#0D0D0D',
  textSoft: '#5D5D5D',
  textLight: 'rgba(0,0,0,.42)',

  // 线
  line: 'rgba(0,0,0,.10)',
  lineLight: 'rgba(0,0,0,.06)',

  // 语义色。用得很省 —— 这套语言近乎单色，颜色一多就不像了。
  blue: '#0B3587',
  blueSoft: '#E9F0FA',
  red: '#C0392B',
  redSoft: '#FBECEA',
  green: '#2FA361',
  greenSoft: '#EAF6EF',
  amber: '#B37E00',
  amberSoft: '#FDF1E3',

  radius: 16,
  /** 全胶囊。ChatGPT 的控件几乎都是 9999px。 */
  pill: 9999,
  font:
    '-apple-system, ui-sans-serif, system-ui, "SF Pro Text", "PingFang SC", "Segoe UI", sans-serif',
} as const;

export const fmtDuration = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** 「3 分钟前」这种。展馆里人只关心「刚才」还是「上午」。 */
export const fmtAgo = (ts: number): string => {
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 60) return t('刚刚');
  if (d < 3600) return t('{a} 分钟前', { a: Math.floor(d / 60) });
  if (d < 86400) return t('{a} 小时前', { a: Math.floor(d / 3600) });
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
};
