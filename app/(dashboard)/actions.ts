"use server"

import { refresh } from "next/cache"

import { AiError, type AiErrorCode } from "@/lib/ai/errors"
import { requireSession } from "@/lib/auth/session"
import { acquireProcessingLease, listEmailAccounts, releaseProcessingLease } from "@/lib/db/email-accounts"
import { PROCESSING_LEASE_MS } from "@/lib/pipeline/auto-process"
import { GmailError, type GmailErrorCode } from "@/lib/gmail/errors"
import { runScanBatch, ScanError, type ScanBatchResult } from "@/lib/pipeline/classify-batch"

export type ScanActionResult =
  | { ok: true; summary: ScanBatchResult }
  | { ok: false; message: string; fixAt?: "/settings" | "/categories" }

const GMAIL_ERRORS: Partial<Record<GmailErrorCode, { message: string; fixAt?: "/settings" }>> = {
  GMAIL_NOT_CONNECTED: { message: "Connect Gmail in Settings before scanning.", fixAt: "/settings" },
  GMAIL_AUTH_FAILED: { message: "Gmail rejected the saved app password. Update it in Settings.", fixAt: "/settings" },
  APP_PASSWORD_REQUIRED: { message: "Gmail needs an app password. Update it in Settings.", fixAt: "/settings" },
  IMAP_DISABLED: {
    message: "IMAP isn't available for this Gmail account. Turn it on in Gmail's settings, then try again.",
    fixAt: "/settings",
  },
  RATE_LIMITED: { message: "Gmail is limiting connections right now. Try again in a few minutes." },
}

const AI_ERRORS: Partial<Record<AiErrorCode, string>> = {
  AI_AUTH_FAILED: "The AI service rejected MailBrain's API key (GEMINI_API_KEY or OPENROUTER_API_KEY, per AI_PROVIDER).",
  AI_NO_CREDITS: "The AI service is out of credits.",
  AI_QUOTA_EXCEEDED:
    "Today's free AI quota is used up. Emails classified so far are saved; scan again after the daily reset.",
  AI_BAD_REQUEST:
    "The AI service refused the request. Check the model setting (GEMINI_MODEL or OPENROUTER_MODEL); the server log has details.",
}

/** Scans the next batch of unprocessed emails (CLS-1). */
export async function scanEmailsAction(): Promise<ScanActionResult> {
  const { user } = await requireSession()
  const [account] = await listEmailAccounts(user.id)
  if (!account) return { ok: false, ...GMAIL_ERRORS.GMAIL_NOT_CONNECTED! }

  // One scan or automatic run per mailbox at a time (a database lease, so it
  // holds across server instances), so no email is paid for twice.
  if (!(await acquireProcessingLease(account.id, PROCESSING_LEASE_MS))) {
    return { ok: false, message: "MailBrain is already working on this mailbox. Try again in a minute." }
  }
  try {
    const summary = await runScanBatch(user.id, account.id)
    refresh()
    return { ok: true, summary }
  } catch (error) {
    // Results saved before a failure are kept, so refresh either way.
    refresh()
    if (error instanceof ScanError) {
      return { ok: false, message: "Create or turn on a category before scanning.", fixAt: "/categories" }
    }
    if (error instanceof GmailError) {
      return { ok: false, ...(GMAIL_ERRORS[error.code] ?? { message: "Couldn't reach Gmail. Please try again." }) }
    }
    if (error instanceof AiError) {
      console.error("Scan stopped by an AI error:", error.code, error.status ?? "", error.detail ?? "")
      return { ok: false, message: AI_ERRORS[error.code] ?? "The AI service failed. Please try again." }
    }
    console.error("Scan failed:", error instanceof Error ? error.name : "unknown")
    return { ok: false, message: "The scan failed. Please try again." }
  } finally {
    await releaseProcessingLease(account.id)
  }
}
