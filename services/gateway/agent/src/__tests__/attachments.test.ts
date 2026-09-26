import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractAttachmentText } from '../attachments.ts';
import { env } from '../host.ts';

/**
 * 附件解析。**这一组的重点不是「能不能读」，是「读不了的时候会怎样」。**
 *
 * 展会现场会遇到的东西：加密的 PDF、扫描件、别人 AirDrop 过来的 .pages、
 * 传到一半断掉的空文件。这些全都必须降级成「只记文件名」，
 * 绝不能让一个附件把整条速记拖成 failed —— 销售说的话永远是主，附件是佐证。
 *
 * 图片那条路要真发网络请求（走视觉模型），不在单元测试里跑。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** attachments.ts 内部按 `join(env.audioDir, path)` 取文件，所以这里给相对 audioDir 的路径。 */
const rel = (abs: string) => relative(env.audioDir, abs);

const tmp = mkdtempSync(join(tmpdir(), 'boothnote-att-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const write = (name: string, content: string | Buffer) => {
  const p = join(tmp, name);
  writeFileSync(p, content);
  return p;
};

describe('能读的格式', () => {
  it('docx 真的被读开了（不是存个附件了事）', async () => {
    const r = await extractAttachmentText({
      path: rel(join(HERE, 'fixtures', 'sample.docx')),
      filename: 'sample.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      kind: 'file',
    });
    assert.equal(r.status, 'ready');
    assert.match(r.text, /Alpin Tannhof/);
    assert.match(r.text, /200Ah/);
  });

  it('纯文本直接读，不开线程', async () => {
    const p = write('note.txt', '年产 12000 台，用 Voltaro');
    const r = await extractAttachmentText({ path: rel(p), filename: 'note.txt', kind: 'file' });
    assert.equal(r.status, 'ready');
    assert.match(r.text, /12000/);
  });

  it('csv 也算纯文本', async () => {
    const p = write('a.csv', 'brand,qty\nAlpin,1200\n');
    const r = await extractAttachmentText({ path: rel(p), filename: 'a.csv', kind: 'file' });
    assert.equal(r.status, 'ready');
    assert.match(r.text, /Alpin,1200/);
  });
});

describe('读不了的时候', () => {
  it('空文件 → 只记文件名，不报错', async () => {
    const p = write('empty.pdf', '');
    const r = await extractAttachmentText({ path: rel(p), filename: 'empty.pdf', kind: 'file' });
    assert.equal(r.status, 'skipped');
    assert.match(r.text, /empty\.pdf/);
  });

  it('坏掉的 pdf → 降级，不抛异常', async () => {
    const p = write('broken.pdf', Buffer.from('not a pdf at all, just bytes'));
    const r = await extractAttachmentText({ path: rel(p), filename: 'broken.pdf', kind: 'file' });
    assert.notEqual(r.status, 'ready');
    assert.match(r.text, /broken\.pdf/);
    assert.ok(r.text.length > 0, '降级之后也必须留下一句话给人看');
  });

  it('没有解析器的格式 → 只记文件名和大小，不假装读懂了', async () => {
    const p = write('weird.pages', 'x'.repeat(3000));
    const r = await extractAttachmentText({ path: rel(p), filename: 'weird.pages', kind: 'file' });
    assert.equal(r.status, 'skipped');
    assert.match(r.text, /weird\.pages/);
    assert.match(r.text, /KB/);
  });

  it('文件不在了 → failed，但仍然返回一个结果对象（不抛）', async () => {
    const r = await extractAttachmentText({
      path: 'no/such/file.docx',
      filename: 'file.docx',
      kind: 'file',
    });
    assert.equal(r.status, 'failed');
  });
});

describe('截断', () => {
  it('超长附件被截断，并且明确标出来 —— 不能让一本手册把销售那句话淹掉', async () => {
    const big = 'A'.repeat(env.attachmentMaxChars + 5000);
    const p = write('manual.txt', big);
    const r = await extractAttachmentText({ path: rel(p), filename: 'manual.txt', kind: 'file' });
    assert.equal(r.status, 'ready');
    assert.equal(r.truncated, true);
    assert.ok(r.text.length < big.length);
    assert.match(r.text, /截断/);
  });
});
