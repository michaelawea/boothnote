/** Shared by both chat interfaces. A label is presentation, never a record key. */
export const TARGET_TYPES = Object.freeze(['supportCase', 'project', 'workItem', 'staging']);
export const QUESTION_ACTIONS = Object.freeze(['append', 'update', 'continue', 'create', 'clarify']);
export const isUuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/** Stable business representation. UI state and work-log decorations do not invalidate answers. */
export const canonicalBusinessValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalBusinessValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalBusinessValue(value[key])]));
  }
  return value ?? null;
};

export const questionAnswerText = (question, optionId, text) => {
  const option = question.choices?.find((choice) => choice.optionId === optionId);
  return String(text ?? option?.label ?? '').trim();
};
