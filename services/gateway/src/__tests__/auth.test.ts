import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { hashPassword, verifyPassword } from '../password.ts';

/**
 * 密码哈希。用 Node 内置 test runner —— 零新依赖，跟网关「无构建步骤」的取向一致。
 *
 *   node --test src/__tests__/
 */

describe('scrypt 密码哈希', () => {
  it('正确密码能验过', async () => {
    const h = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('correct horse battery staple', h), true);
  });

  it('错误密码验不过', async () => {
    const h = await hashPassword('s3cret');
    assert.equal(await verifyPassword('s3cret ', h), false);
    assert.equal(await verifyPassword('S3cret', h), false);
    assert.equal(await verifyPassword('', h), false);
  });

  it('同一个密码两次哈希不同（salt 起作用了）', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    assert.notEqual(a, b);
    assert.equal(await verifyPassword('same', a), true);
    assert.equal(await verifyPassword('same', b), true);
  });

  it('存的是 scrypt 格式，不是明文', async () => {
    const h = await hashPassword('plaintext-should-not-appear');
    assert.match(h, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.equal(h.includes('plaintext-should-not-appear'), false);
  });

  it('🐛 回归：N=2^15 需要约 33.5 MB，超过 Node 默认 32 MB 的 maxmem', async () => {
    // 不显式放开 maxmem 会抛 ERR_CRYPTO_INVALID_SCRYPT_PARAMS（2026-07-31 踩到）
    await assert.doesNotReject(() => hashPassword('memory-param-guard'));
  });

  it('哈希串坏了当作验证失败，不抛异常', async () => {
    assert.equal(await verifyPassword('x', 'not-a-hash'), false);
    assert.equal(await verifyPassword('x', 'scrypt$broken'), false);
    assert.equal(await verifyPassword('x', ''), false);
  });
});
