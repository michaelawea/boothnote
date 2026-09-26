import { T } from '../theme';
import { t } from '../i18n';

/**
 * 项目 / 任务线程 / 文档 三块提案（D59）。
 *
 * 核对卡上多出来的这一段，回答的是「确认之后 CRM 里会长出什么」——
 * agent 拆了四条线程、生成了一份文档，人**必须先看见才能确认**。
 * 看不见就等于系统替他做了决定，而这套系统的全部前提是「AI 只提议」。
 *
 * ⚠️ 这里只显示，不编辑。要改哪一格，回对话里说一句让它重抽 ——
 * 在手机上编辑四条线程的截止日期是反效果的（手册 P8 的同一条判据）。
 */

// 下面三张表存**中文规范形式**，渲染那一行才过 `t()`（D80 判据）——
// 写成 `t('…')` 的话在 import 时就求值了，英文账号登录之后还是中文（issue #53 A3 的同一类）。
const THREAD_LABEL: Record<string, string> = {
  doc: '文档',
  hardware: '硬件接口',
  protocol: '通信协议',
  software: '测试软件',
  milestone: '里程碑',
  other: '其他',
};

const PRIORITY_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  URGENT: { bg: T.redSoft, fg: T.red, label: '紧急' },
  HIGH: { bg: T.amberSoft, fg: T.amber, label: '高' },
  MEDIUM: { bg: T.s3, fg: T.textSoft, label: '中' },
  LOW: { bg: T.s3, fg: T.textLight, label: '低' },
};

/**
 * 🔴 文档来源要**一眼看出来**。
 * AI 整理的和客户给的长得一样，是这套系统最贵的一种错（D59）。
 */
const DOC_SOURCE: Record<string, { bg: string; fg: string; label: string }> = {
  CUSTOMER_ATTACHMENT: { bg: T.greenSoft, fg: T.green, label: '客户提供' },
  AGENT_GENERATED: { bg: T.amberSoft, fg: T.amber, label: 'AI 生成' },
  DICTATION: { bg: T.amberSoft, fg: T.amber, label: '按口述整理' },
  INTERNAL: { bg: T.blueSoft, fg: T.blue, label: '我方编写' },
};

const box: React.CSSProperties = {
  background: T.s2,
  borderRadius: 12,
  padding: '11px 12px',
  marginBottom: 10,
};

const Row = ({ k, v }: { k: string; v: React.ReactNode }) =>
  v ? (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', lineHeight: 1.7 }}>
      <span style={{ fontSize: 12, color: T.textLight, width: 62, flexShrink: 0 }}>{k}</span>
      <span style={{ fontSize: 13.5, flex: 1, minWidth: 0 }}>{v}</span>
    </div>
  ) : null;

export type ProjectProposal = {
  projectCode?: string | null;
  name?: string | null;
  projectStage?: string | null;
  ownerTeam?: string | null;
  budgetEur?: number | null;
  primaryProductName?: string | null;
  sampleQty?: number | null;
  plannedSop?: string | null;
  specSummary?: string | null;
  openQuestions?: string | null;
};

export type WorkItemProposal = {
  itemCode: string;
  title: string;
  threadType: string;
  priority?: string;
  ownerRole?: string | null;
  dueDate?: string | null;
  customerDueDate?: string | null;
  blockedByCodes?: string | null;
  openQuestions?: string | null;
};

export type DocProposal = {
  name: string;
  version?: string;
  docSource: string;
  isBaseline?: boolean;
  content?: string;
};

export const ProjectCard = ({
  project,
  workItems,
  document: doc,
  stageLabel,
}: {
  project?: ProjectProposal | null;
  workItems?: WorkItemProposal[] | null;
  document?: DocProposal | null;
  /** 阶段的中文。枚举表在 ReviewCard 手上，这里只收结果。 */
  stageLabel?: (v: string) => string;
}) => {
  const items = workItems ?? [];
  if (!project && !items.length && !doc) return null;

  return (
    <div style={{ marginBottom: 12 }}>
      {project && (
        <div style={box}>
          <div style={{ fontSize: 12, color: T.textSoft, marginBottom: 6 }}>
            {t('项目')}
            {project.projectCode ? (
              <b style={{ color: T.text, marginLeft: 6 }}>{project.projectCode}</b>
            ) : (
              /* 没编号 = 下次认不出是同一个项目。这一条要说出来。 */
              <span style={{ color: T.amber, marginLeft: 6 }}>{t('没有编号 —— 入库前补一个')}</span>
            )}
          </div>
          <Row k={t('名称')} v={project.name} />
          <Row
            k={t('阶段')}
            v={project.projectStage ? (stageLabel?.(project.projectStage) ?? project.projectStage) : null}
          />
          <Row k={t('负责团队')} v={project.ownerTeam} />
          <Row
            k={t('预算')}
            v={project.budgetEur ? `€${Number(project.budgetEur).toLocaleString()}` : null}
          />
          <Row k={t('核心产品')} v={project.primaryProductName} />
          <Row k={t('样品')} v={project.sampleQty ? t('{a} 台', { a: project.sampleQty }) : null} />
          <Row k={t('计划 SOP')} v={project.plannedSop} />

          {project.specSummary && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ fontSize: 12, color: T.textSoft, cursor: 'pointer' }}>
                {t('关键参数（{a} 字）', { a: project.specSummary.length })}
              </summary>
              <div
                style={{
                  fontSize: 12.5,
                  lineHeight: 1.7,
                  whiteSpace: 'pre-wrap',
                  marginTop: 6,
                  maxHeight: 220,
                  overflowY: 'auto',
                }}
              >
                {project.specSummary}
              </div>
            </details>
          )}

          {/* 🔴 待确认要默认展开。它的全部意义就是「别把这些当成客户确认过的」，
              折起来就等于没有。 */}
          {project.openQuestions && (
            <div
              style={{
                marginTop: 8,
                background: T.amberSoft,
                color: T.amber,
                borderRadius: 10,
                padding: '8px 10px',
                fontSize: 12.5,
                lineHeight: 1.7,
                whiteSpace: 'pre-wrap',
              }}
            >
              <b>{t('待客户确认')}</b> {t('—— 下面这些还没定，别当成已确认的参数')}
              <div style={{ color: T.textSoft, marginTop: 4 }}>{project.openQuestions}</div>
            </div>
          )}
        </div>
      )}

      {items.length > 0 && (
        <div style={box}>
          <div style={{ fontSize: 12, color: T.textSoft, marginBottom: 8 }}>
            {t('拆成 {a} 条线程', { a: items.length })}
            <span style={{ color: T.textLight }}> {t('—— 可以分别派人、分别跟踪')}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {items.map((w) => {
              const pri = PRIORITY_STYLE[w.priority ?? 'MEDIUM'] ?? PRIORITY_STYLE.MEDIUM!;
              return (
                <div
                  key={w.itemCode}
                  style={{
                    background: T.surface,
                    borderRadius: 10,
                    padding: '9px 11px',
                    fontSize: 13,
                    lineHeight: 1.6,
                  }}
                >
                  <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span
                      style={{
                        fontSize: 11,
                        padding: '1px 7px',
                        borderRadius: 999,
                        background: T.s3,
                        color: T.textSoft,
                      }}
                    >
                      {t(THREAD_LABEL[w.threadType] ?? w.threadType)}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        padding: '1px 7px',
                        borderRadius: 999,
                        background: pri.bg,
                        color: pri.fg,
                        fontWeight: 600,
                      }}
                    >
                      {t(pri.label)}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>{w.title}</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: T.textLight, marginTop: 3 }}>
                    {w.itemCode}
                    {w.ownerRole ? ` · ${w.ownerRole}` : ''}
                    {/* 客户日期和内部截止**分开显示** —— 混成一个就分不清是谁定的 */}
                    {w.customerDueDate ? t(' · 客户要 {a}', { a: w.customerDueDate }) : ''}
                    {w.dueDate ? t(' · 内部 {a}', { a: w.dueDate }) : ''}
                    {w.blockedByCodes ? t(' · 依赖 {a}', { a: w.blockedByCodes }) : ''}
                  </div>
                  {w.openQuestions && (
                    <div style={{ fontSize: 11.5, color: T.amber, marginTop: 3 }}>
                      {t('未知：{a}', { a: w.openQuestions })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {doc && (
        <div style={box}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: T.textLight }}>{t('文档')}</span>
            <span style={{ fontSize: 13.5, flex: 1, minWidth: 0 }}>
              {doc.name} <span style={{ color: T.textLight }}>{doc.version}</span>
            </span>
            {/* 🔴 来源徽章。客户给的是绿的，AI 写的是黄的 —— 一眼分得开。 */}
            {(() => {
              const src = DOC_SOURCE[doc.docSource] ?? DOC_SOURCE.AGENT_GENERATED!;
              return (
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: src.bg,
                    color: src.fg,
                    fontWeight: 600,
                  }}
                >
                  {t(src.label)}
                </span>
              );
            })()}
            {doc.isBaseline && (
              <span style={{ fontSize: 11, color: T.blue, fontWeight: 600 }}>{t('需求基线')}</span>
            )}
          </div>
          {doc.docSource !== 'CUSTOMER_ATTACHMENT' && (
            <div style={{ fontSize: 11.5, color: T.amber, marginTop: 5, lineHeight: 1.6 }}>
              {/* ⚠️ JSX 里 `**粗体**` 是字面量 —— markdown 不会被解析（实测踩到）。用 <b>。 */}
              {t('这份是 AI 整理的，')}<b>{t('入库后是草稿')}</b> {t('—— 「客户已确认」只有人能给。')}
            </div>
          )}
          {doc.content && (
            <details style={{ marginTop: 7 }}>
              <summary style={{ fontSize: 12, color: T.textSoft, cursor: 'pointer' }}>
                {t('正文（{a} 字）', { a: doc.content.length })}
              </summary>
              <div
                style={{
                  fontSize: 12.5,
                  lineHeight: 1.75,
                  whiteSpace: 'pre-wrap',
                  marginTop: 6,
                  maxHeight: 260,
                  overflowY: 'auto',
                }}
              >
                {doc.content}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
};
