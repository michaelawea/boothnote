/**
 * 原型数据。客户名是**虚构的示例品牌**。
 * 接真数据时换成网关的一次 GET /companies，下拉行为完全不变。
 */
export const COMPANIES = [
  { code: 'HAVEL', name: 'Havel', group: 'Erwin Havel Group' },
  { code: 'DELLMANNS', name: 'Dellmanns', group: 'Erwin Havel Group' },
  { code: 'BRUCKNER', name: 'Brückner', group: 'Erwin Havel Group' },
  { code: 'LIRIO', name: 'Lirio', group: 'Erwin Havel Group' },
  { code: 'ISTRA', name: 'Istra', group: 'Istra Mobil' },
  { code: 'SEALIGHTS', name: 'Sea Lights', group: 'Istra Mobil' },
  { code: 'ALPIN', name: 'Alpin', group: 'Alpin Tannhof' },
  { code: 'ROSENFELD', name: 'Rosenfeld', group: 'Alpin Tannhof' },
  { code: 'MORENA', name: 'Morena', group: 'Alpin Tannhof' },
  { code: 'CASTELLA_BRAND', name: 'Castella', group: 'Castella Group' },
  { code: 'MALIVA', name: 'Maliva', group: 'Castella Group' },
  { code: 'VIVACE_BRAND', name: 'Vivace', group: 'Vivace Group' },
  { code: 'WESTMARCH', name: 'Westmarch', group: 'Vivace Group' },
  { code: 'FRANKEL', name: 'Frankel', group: 'Planet Group' },
  { code: 'CHANCELLOR', name: 'Chancellor', group: 'Trevano' },
  { code: 'ORBAMOBIL', name: 'Orba Mobil', group: 'Trevano' },
  // `COMPANIES` 是原型残留（现在只有 CURRENT_VISIT 还有人 import），
  // 而且 group 是**数据**不是界面文案 —— 数据路径存规范形式（D80）。
  { code: 'CORDIALE', name: 'Cordiale', group: '（独立厂）' }, // i18n-ignore
  { code: 'LARIVERA', name: 'La Rivera', group: '（独立厂）' }, // i18n-ignore
];

/** 当前事件（D32）：展会期间设成 Caravan Salon，速记自动挂到它下面，销售零感知。 */
export const CURRENT_VISIT = 'Caravan Salon 2026';

// 原来这里还有一个硬编码的 `CURRENT_USER = 'alex'` —— 2026-07-31 已删除，
// 录入人改为来自真实登录态（`auth.ts`）。留着它就等于打开应用即是 alex。
