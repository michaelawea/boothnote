import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';

import { env } from '../env.ts';

/**
 * 看板链接的推导（D67）。
 *
 * 为什么值得单独一档：这个值**不是给网关自己用的，是发到别人手机上让浏览器打开的**。
 * 2026-08-04 它安静地错了整整一天 —— 回退到 `SERVER_URL=http://server:3000`（容器内网），
 * 手机点了打不开、不报错，而本地开发时 `SERVER_URL=http://localhost:3000` 恰好是对的，
 * 所以本地怎么点都是好的（R18 那条「默认值在本地恰好是对的」的第三次）。
 *
 * ⚠️ `env` 的字段是 **getter**，每次读都重新算 —— 所以下面直接改 `process.env` 就能测。
 *    `opt()` 是 `process.env[k] ?? file[k] ?? fallback`，**空字符串不是 undefined**，
 *    所以「没设」要用 `= ''` 来表达（`delete` 会漏回仓库根目录那份真 `.env`，本机上不确定）。
 */
describe('看板链接（boardUrl）', () => {
  beforeEach(() => {
    process.env.SERVER_URL = 'http://server:3000';
    process.env.BOARD_URL = '';
    process.env.CRM_DOMAIN = '';
  });

  it('显式设了 BOARD_URL 就用它', () => {
    process.env.BOARD_URL = 'https://crm.example.com/objects/opportunities';
    process.env.CRM_DOMAIN = 'crm.other.com';
    assert.equal(env.boardUrl, 'https://crm.example.com/objects/opportunities');
  });

  it('BOARD_URL 末尾的斜杠会被去掉（拼路径时不会出现双斜杠）', () => {
    process.env.BOARD_URL = 'https://crm.example.com/';
    assert.equal(env.boardUrl, 'https://crm.example.com');
  });

  it('BOARD_URL 空 → 由 CRM_DOMAIN 推，且协议永远是 https', () => {
    process.env.CRM_DOMAIN = 'crm.example.com';
    // 🔴 即使 SITE_SCHEME=http://（Cloudflare Flexible）也必须是 https ——
    //    SITE_SCHEME 说的是 CF↔源站那一段，浏览器那一段永远是 HTTPS。
    process.env.SITE_SCHEME = 'http://';
    assert.equal(env.boardUrl, 'https://crm.example.com');
  });

  it('两个都空才回退到 SERVER_URL —— 而这一档在线上必然是错的', () => {
    assert.equal(env.boardUrl, 'http://server:3000');
  });
});
