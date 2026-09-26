import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * 密码哈希。**刻意不依赖 env 和 db** —— 它是纯计算，不该因为没配数据库就跑不起来。
 *
 * 实测教训（2026-08-02，CI 抓到）：这些函数原本住在 `auth.ts` 里，而 `auth.ts`
 * 为了 `userFromToken` 引了 `db.ts`，`db.ts` 又在模块顶层就 `postgres(env.databaseUrl)`
 * —— 于是**一个纯密码学的单元测试，import 时就因为缺 APP_DATABASE_URL 直接崩**。
 * 本地有 .env 看不出来，CI 上必炸。拆开之后它才是真的"零依赖单元测试"。
 */
const scrypt = promisify(_scrypt) as (
  pw: string,
  salt: Buffer,
  len: number,
  opts: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// Node 内置 scrypt —— 刻意不用 bcrypt/argon2：它们是原生依赖，
// 会让 Mac→x86 的镜像构建多一层出岔子的可能（D29）。
//
// ⚠️ N=2^15 需要 128*N*r ≈ 33.5 MB，超过 Node 默认 32 MB 的 maxmem 上限
//    （报 ERR_CRYPTO_INVALID_SCRYPT_PARAMS）→ 必须显式放开。
const MAXMEM = 96 * 1024 * 1024;
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: MAXMEM };
const KEYLEN = 32;

export const hashPassword = async (pw: string): Promise<string> => {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, KEYLEN, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
};

export const verifyPassword = async (pw: string, stored: string): Promise<boolean> => {
  const [scheme, N, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(pw, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
