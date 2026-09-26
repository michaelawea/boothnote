import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after } from 'node:test';

import {
  __resetProbe,
  extractAttachmentText,
  isExtUnsupported,
  markExtsUnsupported,
  rejectsInputFile,
} from '../attachments.ts';
import { env } from '../host.ts';
import { FILE_MARKER_RE, spliceFilesIntoPayload } from '../runtime.ts';

/**
 * D71 附件原生直通的单元档。**一行网络请求都不发。**
 *
 * 重点不是「能不能传」（那要真模型，e2e 里验），是三件容易静默坏掉的事：
 *   ① 占位符 → input_file 的拼接是不是精确（拼错 = 模型看见乱码或文件丢失，都不报错）；
 *   ② 「模型不收这种文件」的判据够不够保守（错判 = 这个格式重启前永远降级）；
 *   ③ 降级路径在 describeImage 删掉之后还兜不兜得住图片。
 */

describe('spliceFilesIntoPayload —— 占位符换成 input_file', () => {
  const marker = '⟦files:0000-test⟧';
  const files = [{ filename: 'spec.pdf', mime: 'application/pdf', data: 'QUJD' }];

  const payload = () => ({
    model: 'gpt-5.6-luna',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: `销售说的：xx\n\n${marker}` }] },
    ],
  });

  it('占位符被删掉，input_file 追加进同一条消息', () => {
    const p = payload();
    const out = spliceFilesIntoPayload(p, marker, files) as typeof p;
    const content = out.input[0]!.content as any[];
    assert.equal(content[0].text.includes('⟦files:'), false, '占位符必须消失');
    assert.equal(content.length, 2);
    assert.equal(content[1].type, 'input_file');
    assert.equal(content[1].filename, 'spec.pdf');
    assert.match(content[1].file_data, /^data:application\/pdf;base64,QUJD$/);
  });

  it('多个文件全部进去，顺序保持', () => {
    const p = payload();
    const two = [
      { filename: 'a.pdf', mime: 'application/pdf', data: 'QQ==' },
      { filename: 'b.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: 'Qg==' },
    ];
    const out = spliceFilesIntoPayload(p, marker, two) as typeof p;
    const names = (out.input[0]!.content as any[]).filter((c) => c.type === 'input_file').map((c) => c.filename);
    assert.deepEqual(names, ['a.pdf', 'b.xlsx']);
  });

  it('🔴 旧轮次残留的占位符（session 恢复）换成人话，绝不吃进这一轮的文件', () => {
    const p = {
      input: [
        {
          role: 'user',
          // 旧 nonce 是上一轮 crypto.randomUUID() 生成的 —— 十六进制 + 连字符
          content: [{ type: 'input_text', text: '上一轮的话 ⟦files:9d3c1a2b-77e4-4f10-8a2b-000000000000⟧' }],
        },
        { role: 'user', content: [{ type: 'input_text', text: `这一轮的话\n\n${marker}` }] },
      ],
    };
    const out = spliceFilesIntoPayload(p, marker, files) as typeof p;
    const old = out.input[0]!.content as any[];
    assert.equal(old.length, 1, '旧消息绝不能被塞进新文件');
    assert.match(old[0].text, /更早一轮已看过/);
    // ⚠️ 不用 FILE_MARKER_RE.test() —— /g 正则的 lastIndex 有状态，断言会假绿/假红
    assert.equal(old[0].text.match(FILE_MARKER_RE), null, '旧占位符必须被清干净');
    const cur = out.input[1]!.content as any[];
    assert.equal(cur.filter((c) => c.type === 'input_file').length, 1);
  });

  it('不是 Responses 形状的 payload 原样放过（返回 undefined = 不改）', () => {
    assert.equal(spliceFilesIntoPayload({ messages: [] }, marker, files), undefined);
    assert.equal(spliceFilesIntoPayload(null, marker, files), undefined);
  });

  it('assistant 消息不动 —— 只有 user 消息里才有我们放的占位符', () => {
    const p = {
      input: [
        { role: 'assistant', content: [{ type: 'output_text', text: marker }] },
        { role: 'user', content: [{ type: 'input_text', text: marker }] },
      ],
    };
    const out = spliceFilesIntoPayload(p, marker, files) as typeof p;
    assert.equal((out.input[0]!.content as any[]).length, 1, 'assistant 消息不该被碰');
    assert.equal((out.input[1]!.content as any[]).length, 2);
  });
});

describe('rejectsInputFile —— 「不收这种文件」的判据（宁可漏判也别错判）', () => {
  it('像格式被拒的报文 → true', () => {
    assert.equal(rejectsInputFile('400 Invalid file format for input_file: .docx is not supported'), true);
    assert.equal(rejectsInputFile('Unable to process file: unsupported document type'), true);
    assert.equal(rejectsInputFile('failed to parse the attached PDF'), true);
  });

  it('🔴 网络抖动 / 超载 / 别的参数错 → false（错判 = 这个格式重启前永远降级）', () => {
    assert.equal(rejectsInputFile('Our servers are currently overloaded. Please try again later.'), false);
    assert.equal(rejectsInputFile('429 rate limit exceeded'), false);
    assert.equal(rejectsInputFile('ECONNRESET'), false);
    assert.equal(rejectsInputFile('400 Function tools with reasoning_effort are not supported'), false);
    // 「invalid」但和文件无关
    assert.equal(rejectsInputFile('invalid input syntax for type uuid'), false);
  });
});

describe('格式探测三态', () => {
  it('标了不支持就记住，重置后忘掉（= 重启网关重新探测）', () => {
    __resetProbe();
    assert.equal(isExtUnsupported('.docx'), false);
    markExtsUnsupported(['.docx', '.xlsx']);
    assert.equal(isExtUnsupported('.docx'), true);
    assert.equal(isExtUnsupported('.xlsx'), true);
    assert.equal(isExtUnsupported('.pdf'), false, '没标过的不受牵连');
    __resetProbe();
    assert.equal(isExtUnsupported('.docx'), false);
  });
});

describe('降级路径在 describeImage 删掉之后', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'boothnote-mm-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('走到降级路径的图片 → 只记文件名，不发网络请求、不炸', async () => {
    const p = join(tmp, 'booth.jpg');
    writeFileSync(p, Buffer.from('fake-jpeg-bytes'));
    const r = await extractAttachmentText({
      path: relative(env.audioDir, p),
      filename: 'booth.jpg',
      mime: 'image/jpeg',
      kind: 'photo',
    });
    assert.equal(r.status, 'skipped');
    assert.match(r.text, /booth\.jpg/);
    assert.match(r.text, /门槛/, '要说清楚为什么只有文件名 —— 不是坏了，是超了直通门槛');
  });
});
