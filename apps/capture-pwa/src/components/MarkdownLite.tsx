import { T } from '../theme';

/**
 * **最小的 markdown 渲染。不引 markdown 库。**
 *
 * 维护者 2026-08-05（issue #16）：「富文本不需要，只是渲染时按照 markdown 来就好了」。
 *
 * 🔴 为什么不上 `react-markdown`：这一版 PWA 打包 111 KB gzip 是刻意压出来的，
 * 而一个 markdown 解析器几十 KB 起 —— 展馆里是 4G，每一 KB 都要在人按下按钮
 * 之前下载完。issue #7 已经为一个 `**粗体**` 做过同样的取舍，结论一样。
 *
 * 认这几种，其余原样输出：
 *   `**粗体**` · `- 列表` / `· 列表` · `## 标题` · 空行分段
 *
 * ⚠️ **不认 HTML，也不认链接。** 输入里有 agent 生成的内容和客户附件的正文，
 * 那是**不可信来源** —— 认 HTML 就等于给了它一条注入路径，而这一屏
 * 显示的东西没有一样值得冒这个险。React 默认转义，这里就靠它。
 */

/** 行内：只认 `**粗体**`。和 Chat.tsx 里那个 `bold()` 是同一条规则。 */
const inline = (s: string, key: string) =>
  String(s ?? '')
    .split(/\*\*(.+?)\*\*/g)
    .map((part, i) => (i % 2 ? <b key={`${key}-${i}`}>{part}</b> : part));

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
        const line = raw.trimEnd();
        if (!line.trim()) return <div key={i} style={{ height: 6 }} />;

        // ## 标题
        const h = line.match(/^(#{1,4})\s+(.*)$/);
        if (h) {
          return (
            <div
              key={i}
              style={{
                fontWeight: 600,
                fontSize: h[1]!.length <= 2 ? 15 : 14.5,
                margin: '6px 0 2px',
              }}
            >
              {inline(h[2] ?? '', String(i))}
            </div>
          );
        }

        // - 列表 / · 列表 / * 列表
        const li = line.match(/^\s*[-*·]\s+(.*)$/);
        if (li) {
          return (
            <div key={i} style={{ display: 'flex', gap: 7, paddingLeft: 2 }}>
              <span style={{ color: T.textLight, flexShrink: 0 }}>·</span>
              <span style={{ flex: 1, minWidth: 0 }}>{inline(li[1] ?? '', String(i))}</span>
            </div>
          );
        }

        return <div key={i}>{inline(line, String(i))}</div>;
      })}
      {truncated && <div style={{ color: T.textLight }}>…</div>}
    </div>
  );
};
