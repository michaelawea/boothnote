import { T } from '../theme';
import { parseLine, splitBold } from '../markdown';

/**
 * **最小的 markdown 渲染。不引 markdown 库。**
 *
 * 维护者 2026-08-05（issue #16）：「富文本不需要，只是渲染时按照 markdown 来就好了」。
 *
 * 🔴 为什么不上 `react-markdown`：这一版 PWA 打包 111 KB gzip 是刻意压出来的，
 * 而一个 markdown 解析器几十 KB 起 —— 展馆里是 4G，每一 KB 都要在人按下按钮
 * 之前下载完。issue #7 已经为一个 `**粗体**` 做过同样的取舍，结论一样。
 *
 * 认哪几种写在 `markdown.ts` 里（D135 起那是唯一一份规则 —— 编辑器的预览、
 * 速记列表的摘要、回车续列表都从那儿读）。这里只管「每一种长什么样」。
 *
 * ⚠️ **不认 HTML，也不认链接。** 输入里有 agent 生成的内容和客户附件的正文，
 * 那是**不可信来源** —— 认 HTML 就等于给了它一条注入路径，而这一屏
 * 显示的东西没有一样值得冒这个险。React 默认转义，这里就靠它。
 */

/** 行内：只认 `**粗体**`。和 Chat.tsx 里那个 `bold()` 是同一条规则。 */
const inline = (s: string, key: string) =>
  splitBold(s).map((part, i) => (i % 2 ? <b key={`${key}-${i}`}>{part}</b> : part));

/** 列表类的一行：左边一个记号，右边正文。三种列表共用，只有记号不同。 */
const Marked = ({ mark, dim, children }: { mark: string; dim?: boolean; children: React.ReactNode }) => (
  <div style={{ display: 'flex', gap: 7, paddingLeft: 2 }}>
    <span style={{ color: T.textLight, flexShrink: 0, minWidth: 10, textAlign: 'center' }}>{mark}</span>
    <span
      style={{
        flex: 1,
        minWidth: 0,
        color: dim ? T.textLight : undefined,
        textDecoration: dim ? 'line-through' : undefined,
      }}
    >
      {children}
    </span>
  </div>
);

export const MarkdownLite = ({
  text,
  clamp,
}: {
  text: string;
  /** 只显示前几行，超出的省略。展开由调用方控制。 */
  clamp?: number;
}) => {
  const all = String(text ?? '').split('\n');
  const lines = clamp ? all.slice(0, clamp) : all;
  const truncated = clamp ? all.length > clamp : false;

  return (
    <div style={{ fontSize: 14.5, lineHeight: 1.65, wordBreak: 'break-word' }}>
      {lines.map((raw, i) => {
        const l = parseLine(raw);
        const k = String(i);
        switch (l.kind) {
          case 'blank':
            return <div key={i} style={{ height: 6 }} />;
          case 'h':
            return (
              <div key={i} style={{ fontWeight: 600, fontSize: l.level <= 2 ? 15 : 14.5, margin: '6px 0 2px' }}>
                {inline(l.text, k)}
              </div>
            );
          case 'task':
            // 勾掉的那条淡一点 + 划线：一眼分得出「还欠着什么」
            return (
              <Marked key={i} mark={l.done ? '☑' : '☐'} dim={l.done}>
                {inline(l.text, k)}
              </Marked>
            );
          case 'li':
            return (
              <Marked key={i} mark="·">
                {inline(l.text, k)}
              </Marked>
            );
          case 'ol':
            return (
              <Marked key={i} mark={`${l.n}.`}>
                {inline(l.text, k)}
              </Marked>
            );
          case 'quote':
            return (
              <div
                key={i}
                style={{ borderLeft: `3px solid ${T.line}`, paddingLeft: 10, color: T.textSoft }}
              >
                {inline(l.text, k)}
              </div>
            );
          default:
            return <div key={i}>{inline(l.text, k)}</div>;
        }
      })}
      {truncated && <div style={{ color: T.textLight }}>…</div>}
    </div>
  );
};
