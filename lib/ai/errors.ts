export type AiErrorCode =
  | "AI_AUTH_FAILED" // 401/403: bad or revoked OPENROUTER_API_KEY
  | "AI_NO_CREDITS" // 402: out of credits
  | "AI_BAD_REQUEST" // 400/404: e.g. unknown OPENROUTER_MODEL, or no provider meets the request's requirements
  | "AI_RATE_LIMITED" // 429 after retries
  | "AI_QUOTA_EXCEEDED" // 429 for a limit that won't reset soon (e.g. free models' 50 requests/day)
  | "AI_UNAVAILABLE" // 5xx, timeouts or network errors after retries
  | "AI_INVALID_RESPONSE" // output wasn't schema-valid JSON after retries
  | "AI_ERROR"

/** Messages never include prompt or response text, which may contain email content. */
export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
    readonly status?: number,
    /** OpenRouter's own error text (e.g. "not a valid model ID"), for server logs only. */
    readonly detail?: string
  ) {
    super(message)
    this.name = "AiError"
  }
}

/** Worth retrying with backoff. */
export function isTransientAiError(error: AiError) {
  return error.code === "AI_RATE_LIMITED" || error.code === "AI_UNAVAILABLE"
}
