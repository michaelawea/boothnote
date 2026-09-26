import { randomUUID } from 'node:crypto';

import { sql, type Role } from './db.ts';
import { hashPassword } from './auth.ts';
import { upsertContributor } from './twenty.ts';

/**
 * 建账号。密码**由脚本本地生成并只打印一次**，不接受命令行传入
 * —— 免得明文密码留在 shell history 里。
 *
 *   npm run adduser -- <user_code> "<显示名>" [admin|management|staff|user]
 */
const [code, name, role = 'user'] = process.argv.slice(2);

if (!code || !name) {
  console.error('用法：npm run adduser -- <user_code> "<显示名>" [admin|management|staff|user]');
  process.exit(1);
}
if (!['admin', 'management', 'staff', 'user'].includes(role)) {
  console.error(`角色只能是 admin / management / staff / user，收到 "${role}"`);
  process.exit(1);
}

const password = Buffer.from(randomUUID().replace(/-/g, '')).toString('base64url').slice(0, 14);

const [row] = await sql<Array<{ user_code: string }>>`
  insert into app_user (user_code, display_name, password_hash, role)
  values (${code}, ${name}, ${await hashPassword(password)}, ${role as Role})
  on conflict (user_code) do nothing
  returning user_code`;

if (!row) {
  console.error(`✗ user_code "${code}" 已存在。`);
  await sql.end();
  process.exit(1);
}

// 同步一份投影到 Twenty，让 recordedBy 能指过去（D34 / D35④）
let contributor = '（跳过：Twenty 不可达）';
try {
  contributor = await upsertContributor(code, name);
} catch (e) {
  contributor = `（同步失败：${(e as Error).message.slice(0, 80)}）`;
}

console.log(`
✅ 账号已创建
   user_code   ${code}
   显示名      ${name}
   角色        ${role}
   初始密码    ${password}      ← 只显示这一次，抄走
   Twenty contributor  ${contributor}
`);

await sql.end();
