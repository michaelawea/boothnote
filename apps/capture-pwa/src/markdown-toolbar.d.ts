/**
 * `@github/markdown-toolbar-element` 的几个自定义元素在 JSX 里的类型（D135）。
 * 那个包只声明了 DOM 那一侧（`HTMLElementTagNameMap`），没有给 React 声明。
 * 只列我们用到的那几个 —— 工具栏上每个键都必须是 `markdown.ts` 渲染得出来的格式。
 */
import type { DetailedHTMLProps, HTMLAttributes } from 'react';

type MdProps = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
  /** `<markdown-toolbar for="…">`：它操作的那个 textarea 的 id。 */
  for?: string;
  /** `<md-header level="2">`：插几个 `#`。 */
  level?: string;
};

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'markdown-toolbar': MdProps;
      'md-header': MdProps;
      'md-bold': MdProps;
      'md-unordered-list': MdProps;
      'md-ordered-list': MdProps;
      'md-task-list': MdProps;
      'md-quote': MdProps;
    }
  }
}
