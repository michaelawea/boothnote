/**
 * 出站投递口自测：**让真实代码算出报文**，原样打到一个 webhook 上（D122 · §2.52）。
 *
 * 为什么要这么一个脚本：那个投递口对「被关键词拦掉」和「送达」返回的东西
 * 逐字节相同（`200 {"data":true,"success":true}`），**我们这一侧没有任何运行时信号** ——
 * 所以配好之后唯一的验证办法是「发一条，人去群里看」。手编报文验不了，
 * 因为要验的恰恰是 `outboundBody()` 拼出来的那串字节和钉钉那边对不对得上。
 *
 *   node scripts/probe-flow-webhook.mjs <webhook-url> [要发的一句话] [@谁的 sender-id]
 *
 * 只发一条消息，不碰库、不碰 agent。
 */
import { md, outboundBody, isFlowWebhook } from '../services/gateway/src/channels/render.ts';

const [url, text, sender] = process.argv.slice(2);
if (!url) {
  console.error('用法：node scripts/probe-flow-webhook.mjs <webhook-url> [一句话] [sender-id]');
  process.exit(1);
}

const ding = md(text || '出站投递口自测：如果你在群里看到这条，说明报文形状和关键词都对上了。', sender);
const body = outboundBody(ding, url);

console.log(`投递口类型：${isFlowWebhook(url) ? '连接平台流程 webhook（包一层 {keyword, ding}）' : '群自定义机器人（原样发）'}`);
console.log(`真实报文（${Buffer.byteLength(JSON.stringify(body), 'utf8')} 字节）：`);
console.log(JSON.stringify(body, null, 2).slice(0, 800));

const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(10_000),
});
console.log(`\nHTTP ${res.status} · ${await res.text()}`);
console.log(
  '\n🔴 回包一律是 200 {"data":true,"success":true} —— 被拦和送达长得一模一样。' +
    '\n   唯一算数的验证是：去群里用眼睛看那条消息在不在。',
);
