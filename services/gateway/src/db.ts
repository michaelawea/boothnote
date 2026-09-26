import postgres from 'postgres';

import { env } from './env.ts';

/** boothnote 库。与 Twenty 的 default 库物理隔离（D33），永不直连 Twenty 的表（D8）。 */
export const sql = postgres(env.databaseUrl, {
  max: 10,
  transform: { undefined: null },
  onnotice: () => {},
});

export type Role = 'admin' | 'management' | 'staff' | 'user';

export type AppUser = {
  id: string;
  user_code: string;
  display_name: string;
  role: Role;
  is_active: boolean;
  token_version: number;
  /**
   * 界面语言（D80）。**跟账号走，不跟浏览器走** —— 换设备、换浏览器、清缓存都还在。
   * 和 D35④「账号是真相源」同一条判据；展会现场借手机用是常事。
   * 它同时决定 `/enums` 返回哪种标签、网关的错误话术用哪种语言、
   * 以及 agent 写小结用什么语言（模型默认跟着输入语言走，必须显式指定）。
   */
  locale: 'zh' | 'en';
};

/** D35②：角色名留四个，V1 只分叉两次。以后要细分，改的是这两行，不是建一套权限引擎。 */
export const canSeeBoard = (role: Role) => role !== 'user';
export const canManageUsers = (role: Role) => role === 'admin';

export const publicUser = (u: AppUser) => ({
  userCode: u.user_code,
  displayName: u.display_name,
  role: u.role,
  locale: u.locale ?? 'zh',
  canSeeBoard: canSeeBoard(u.role),
  canManageUsers: canManageUsers(u.role),
});
