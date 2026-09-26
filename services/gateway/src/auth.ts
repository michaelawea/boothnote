import { SignJWT, jwtVerify } from 'jose';

import { hashPassword, verifyPassword } from './password.ts';

import { env } from './env.ts';
import { sql, type AppUser } from './db.ts';

// 转发，调用方不用改 import
export { hashPassword, verifyPassword };

const secret = new TextEncoder().encode(env.jwtSecret);

/** 载荷只有 sub + tv —— **角色不写进 token**，否则 90 天内撤不掉权限（D35⑤）。 */
export const signToken = (u: AppUser) =>
  new SignJWT({ tv: u.token_version })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(u.id)
    .setIssuedAt()
    .setExpirationTime(`${env.tokenDays}d`)
    .sign(secret);

/** 每次请求都查库：是不是还在职、token_version 有没有被 +1。撤权立即生效。 */
export const userFromToken = async (token: string): Promise<AppUser | null> => {
  let sub: string | undefined;
  let tv: unknown;
  try {
    const { payload } = await jwtVerify(token, secret);
    sub = payload.sub;
    tv = payload.tv;
  } catch {
    return null;
  }
  if (!sub) return null;

  const [u] = await sql<AppUser[]>`
    select id, user_code, display_name, role, is_active, token_version, locale
    from app_user where id = ${sub}`;
  if (!u || !u.is_active || u.token_version !== tv) return null;
  return u;
};
