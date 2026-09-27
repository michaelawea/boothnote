import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MarkdownLite } from '../components/MarkdownLite';

/**
 * 详情页 / 编辑器预览的渲染（D135 起认 编号 · 待办 · 引用）。
 *
 * 在这之前 `MarkdownLite` 一条测试都没有 —— 包括它头注释里最要紧的那条承诺：
 * **不认 HTML、不认链接**（输入里有 agent 生成的内容和客户附件正文，是不可信来源）。
 * 用 react-dom/server 渲染成字符串来断言，不需要浏览器。
 */
const html = (text: string, clamp?: number) => renderToStaticMarkup(createElement(MarkdownLite, { text, clamp }));

describe('MarkdownLite：工具栏插得进去的，这里都画得出来', () => {
  it('标题：符号不露出来，字加粗', () => {
    const h = html('## Alpin 会谈');
    expect(h).toContain('Alpin 会谈');
    expect(h).not.toContain('##');
    expect(h).toContain('font-weight:600');
  });

  it('行内粗体 → <b>', () => {
    expect(html('**结论**：要 200Ah')).toContain('<b>结论</b>：要 200Ah');
  });

  it('待办：没勾 ☐；勾了 ☑ + 划线', () => {
    const open = html('- [ ] 发报价');
    expect(open).toContain('☐');
    expect(open).not.toContain('[ ]');
    expect(open).not.toContain('line-through');
    const done = html('- [x] 交换名片');
    expect(done).toContain('☑');
    expect(done).toContain('line-through');
  });

  it('编号：保留原来的号，列表：一个圆点', () => {
    expect(html('3. 报价')).toMatch(/>3\.<\/span>.*报价/);
    expect(html('- 锂电')).toMatch(/>·<\/span>.*锂电/);
  });

  it('引用：左边一道竖线，`>` 不露出来', () => {
    const q = html('> 客户原话');
    expect(q).toContain('border-left');
    expect(q).toContain('客户原话');
    expect(q).not.toContain('&gt;');
  });

  it('clamp：超出的行不画，末尾一个省略号', () => {
    const c = html('一\n二\n三', 2);
    expect(c).toContain('二');
    expect(c).not.toContain('三');
    expect(c).toContain('…');
  });
});

describe('🔴 MarkdownLite：不认 HTML、不认链接（不可信来源）', () => {
  it('HTML 标签原样当字显示（转义），不会变成真的元素', () => {
    const h = html('<img src=x onerror=alert(1)> **粗** <script>alert(2)</script>');
    expect(h).not.toMatch(/<img|<script/);
    expect(h).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(h).toContain('<b>粗</b>');
  });

  it('markdown 链接不变成 <a>', () => {
    const h = html('[点我](javascript:alert(1)) 和 https://example.com');
    expect(h).not.toContain('<a');
    expect(h).toContain('[点我](javascript:alert(1))');
  });

  it('标题 / 列表 / 待办 / 引用里夹 HTML 也一样转义', () => {
    for (const line of ['## <b>x</b>', '- <i>x</i>', '- [ ] <u>x</u>', '> <em>x</em>', '1. <s>x</s>']) {
      expect(html(line)).toContain('&lt;');
    }
  });
});
