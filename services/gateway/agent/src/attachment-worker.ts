import { parentPort, workerData } from 'node:worker_threads';

import { parseOfficeAsync } from 'officeparser';

/**
 * 附件解析的 worker 线程。
 *
 * 🔴 **整条链路上唯一 CPU 密集的一步。** 等 OpenAI 回包是 I/O，不阻塞；
 * 但拿 officeparser 啃一个 80 页 PDF 会把事件循环卡住 —— 而事件循环卡住的
 * 后果不是「解析慢」，是**登录和收速记一起卡住**。展会现场没人会把这两件事
 * 联系到一份 PDF 上，所以它必须从一开始就在主线程之外。
 *
 * 传路径而不是 Buffer：officeparser 靠扩展名判类型，路径比 Buffer 准。
 */
const run = async () => {
  const { path } = workerData as { path: string };
  const text = await parseOfficeAsync(path, { outputErrorToConsole: false });
  parentPort?.postMessage({ ok: true, text: String(text ?? '') });
};

run().catch((e: unknown) => {
  parentPort?.postMessage({ ok: false, error: (e as Error)?.message ?? String(e) });
});
