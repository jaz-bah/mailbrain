/** Typed Gmail failures the UI can map to an action (ARCHITECTURE §12). */
export type GmailErrorCode =
  | "GMAIL_AUTH_FAILED" // Wrong or revoked app password.
  | "APP_PASSWORD_REQUIRED" // The normal Google password was used instead of an app password.
  | "IMAP_DISABLED" // IMAP access is off, or All Mail is hidden from IMAP.
  | "GMAIL_NOT_CONNECTED" // No such account for this user.
  | "RATE_LIMITED" // Gmail bandwidth or connection limits.
  | "NOT_FOUND" // Message or label doesn't exist.
  | "CONFLICT" // A label with that name already exists.
  | "GMAIL_ERROR" // Anything else, including network failures.

export class GmailError extends Error {
  constructor(
    readonly code: GmailErrorCode,
    message: string
  ) {
    super(message)
    this.name = "GmailError"
  }
}

/** The fields imapflow adds to its errors. */
type ImapErrorLike = Error & {
  authenticationFailed?: boolean
  serverResponseCode?: string
  response?: string
  code?: string
}

const RATE_LIMIT_CODES = new Set(["OVERQUOTA", "LIMIT", "THROTTLED", "INUSE"])

/** Never includes the password or message content in the result. */
export function toGmailError(error: unknown): GmailError {
  if (error instanceof GmailError) return error
  if (!(error instanceof Error)) return new GmailError("GMAIL_ERROR", "Gmail request failed")

  const e = error as ImapErrorLike
  const text = `${e.response ?? ""} ${e.message}`

  if (/not enabled for IMAP/i.test(text)) {
    return new GmailError("IMAP_DISABLED", "IMAP access is turned off for this Gmail account")
  }
  if (/application-specific password required/i.test(text)) {
    return new GmailError("APP_PASSWORD_REQUIRED", "Gmail requires an app password")
  }
  if (e.authenticationFailed || e.serverResponseCode === "AUTHENTICATIONFAILED") {
    return new GmailError("GMAIL_AUTH_FAILED", "Gmail rejected the app password")
  }
  if (e.serverResponseCode && RATE_LIMIT_CODES.has(e.serverResponseCode)) {
    return new GmailError("RATE_LIMITED", "Gmail rate limit reached")
  }
  if (/too many simultaneous connections/i.test(text)) {
    return new GmailError("RATE_LIMITED", "Too many simultaneous Gmail connections")
  }
  if (e.serverResponseCode === "NONEXISTENT") {
    return new GmailError("NOT_FOUND", "Gmail label or message not found")
  }
  if (e.serverResponseCode === "ALREADYEXISTS") {
    return new GmailError("CONFLICT", "A Gmail label with that name already exists")
  }
  return new GmailError("GMAIL_ERROR", `Gmail request failed${e.code ? ` (${e.code})` : ""}`)
}

/** Errors that mean the stored credentials no longer work. */
export function isCredentialError(error: GmailError) {
  return error.code === "GMAIL_AUTH_FAILED" || error.code === "APP_PASSWORD_REQUIRED"
}
