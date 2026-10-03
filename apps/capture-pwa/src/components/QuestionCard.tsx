import { useEffect, useRef, useState } from 'react';
import { questionAnswerText, type QuestionSnapshot } from '../../../../shared/agent-questions.mjs';
import { t } from '../i18n';
import { T } from '../theme';

export type QuestionAnswerInput = {
  questionId: string;
  expectedRevision: string;
  optionId?: string;
  text?: string;
  displayText: string;
};
export type LegacyQuestion = { question: string; options?: string[] };

/** Both renderers use this card. A target answer stays bound to its question and version. */
export const QuestionCard = ({
  question, disabled = false, onAnswer, onLegacyAnswer, localAnswerState, localAnswerError,
}: {
  question: QuestionSnapshot | LegacyQuestion;
  disabled?: boolean;
  onAnswer?: (input: QuestionAnswerInput) => Promise<void>;
  onLegacyAnswer?: (text: string) => Promise<void>;
  localAnswerState?: 'queued' | 'syncing' | 'failed' | 'synced';
  localAnswerError?: string;
}) => {
  const snapshot = question as Partial<QuestionSnapshot> & LegacyQuestion;
  const bound = Boolean(snapshot.questionId);
  const [text, setText] = useState('');
  const [clarifyOption, setClarifyOption] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  useEffect(() => {
    setQueued(false);
    setError('');
    setText('');
    setClarifyOption(undefined);
    lock.current = false;
  }, [snapshot.questionId, snapshot.expectedRevision]);

  const settled = snapshot.status && snapshot.status !== 'pending';
  const pendingLocal = localAnswerState && localAnswerState !== 'failed';
  const inactive = disabled || busy || Boolean(settled) || Boolean(pendingLocal) || queued ||
    (bound && (!snapshot.expectedRevision || !onAnswer));

  const answer = async (optionId?: string, freeText?: string) => {
    if (inactive || lock.current) return;
    const displayText = bound
      ? questionAnswerText(snapshot as QuestionSnapshot, optionId, freeText)
      : (freeText ?? '').trim();
    if (!displayText) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      if (bound && snapshot.expectedRevision && snapshot.questionId && onAnswer) {
        await onAnswer({ questionId: snapshot.questionId, expectedRevision: snapshot.expectedRevision,
          optionId, ...(freeText ? { text: freeText.trim() } : {}), displayText });
        setQueued(true);
      } else {
        await onLegacyAnswer?.(displayText);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('回答保存失败，请重试。'));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  let stateText = '';
  if (snapshot.status === 'answered') {
    const label = snapshot.choices?.find((option) => option.optionId === snapshot.selectedOptionId)?.label;
    stateText = label ? t('已回答：{a}', { a: label }) : t('已回答');
  } else if (snapshot.status === 'stale') stateText = t('提案已变化，请根据最新问题重新选择。');
  else if (snapshot.status === 'expired') stateText = t('这个问题已过期，请让 AI 重新核对。');
  else if (localAnswerState === 'synced') stateText = t('回答已同步');
  else if (localAnswerState === 'syncing') stateText = t('回答正在同步…');
  else if (localAnswerState === 'failed') stateText = t('回答未同步，请核对下方错误和最新问题。');
  else if (queued || localAnswerState === 'queued') stateText = t('回答已保存在本机，等待同步。');

  const showFreeText = bound && !settled && (clarifyOption !== undefined || !snapshot.choices?.length);
  return (
    <section aria-label={t('AI 问题')} data-question-id={snapshot.questionId}
      style={{ alignSelf: 'flex-start', width: '100%', maxWidth: 460, border: `1px solid ${T.line}`,
        borderRadius: T.radius, padding: '12px 13px', background: T.surface }}>
      <div style={{ fontSize: 14, lineHeight: 1.65, marginBottom: 9 }}>{question.question}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
        {bound ? snapshot.choices?.map((option) => (
          <button key={option.optionId} type="button" className="chip" disabled={inactive}
            aria-label={option.label} data-question-option={option.optionId}
            onClick={() => option.action === 'clarify' ? setClarifyOption(option.optionId) : void answer(option.optionId)}>
            {option.label}
            {snapshot.recommendedOptionId === option.optionId &&
              <span style={{ marginLeft: 5, fontSize: 11, color: T.blue }}>{t('建议')}</span>}
            {option.target?.code && <span style={{ marginLeft: 5, fontSize: 11 }}>{option.target.code}</span>}
          </button>
        )) : question.options?.map((option, index) => (
          <button key={`${index}:${option}`} type="button" className="chip"
            disabled={inactive || !onLegacyAnswer} onClick={() => void answer(undefined, option)}>{option}</button>
        ))}
      </div>
      {showFreeText && (
        <div style={{ marginTop: 10 }}>
          <textarea value={text} onChange={(event) => setText(event.target.value)} disabled={inactive}
            aria-label={t('补充说明')} placeholder={t('补充说明')}
            style={{ width: '100%', minHeight: 68, padding: 9, border: `1px solid ${T.line}`,
              borderRadius: 9, font: 'inherit', resize: 'vertical', boxSizing: 'border-box' }} />
          <button type="button" className="btn ghost sm" disabled={inactive || !text.trim()}
            onClick={() => void answer(clarifyOption, text)}>{t('提交回答')}</button>
        </div>
      )}
      {stateText && <div role="status" style={{ fontSize: 12, marginTop: 8, color: T.textSoft }}>{stateText}</div>}
      {(error || localAnswerError) && <div role="alert" style={{ fontSize: 12, marginTop: 8, color: T.red }}>
        {error || localAnswerError}
      </div>}
    </section>
  );
};
