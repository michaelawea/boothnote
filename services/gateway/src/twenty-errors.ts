/** HTTP status alone is insufficient evidence that a mutation did not happen. */
export class TwentyHttpError extends Error {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly response: unknown;
  constructor(
    method: string,
    path: string,
    status: number,
    response: unknown,
    responseText: string,
  ) {
    super(`Twenty ${method} ${path} → ${status} ${responseText.slice(0, 300)}`);
    this.name = 'TwentyHttpError';
    this.method = method;
    this.path = path;
    this.status = status;
    this.response = response;
  }
}

/** Only an explicit application rejection can release an operation for a retry. */
export const isDefiniteTwentyRejection = (error: unknown): boolean => {
  if (!(error instanceof TwentyHttpError) || ![400, 401, 403, 404, 422].includes(error.status)) return false;
  const body = error.response;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const response = body as Record<string, unknown>;
  // Twenty's REST error envelope has a matching statusCode and messages. HTML
  // proxy errors and unrecognized response formats remain uncertain.
  if (response['statusCode'] !== error.status) return false;
  const messages = response['messages'] ?? response['message'];
  if (!(typeof messages === 'string' && messages.trim()) &&
      !(Array.isArray(messages) && messages.length && messages.every((value) => typeof value === 'string' && value.trim()))) return false;
  // A duplicate/unique-key error may be evidence of a prior lost create receipt.
  const text = JSON.stringify(messages);
  return !/duplicate|unique|already exists|LIMIT_REACHED/i.test(text);
};
