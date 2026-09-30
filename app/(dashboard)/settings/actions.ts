"use server"

import { refresh } from "next/cache"

import { boolArg, idArg } from "@/lib/action-args"
import { requireSession } from "@/lib/auth/session"
import { syncMissingLabels } from "@/lib/categories/service"
import { setAutoProcess, upsertGmailAccount } from "@/lib/db/email-accounts"
import { deleteMailboxAndHistory } from "@/lib/db/mailbox-data"
import { CONNECT_GMAIL_LIMIT, formatRetryAfter, hitRateLimit } from "@/lib/db/rate-limits"
import { withGmailCredentials } from "@/lib/gmail/client"
import { gmailConnectSchema } from "@/lib/gmail/connect-schema"
import { toGmailError, type GmailErrorCode } from "@/lib/gmail/errors"

export type ConnectGmailState =
  | { status: "idle" }
  | { status: "success"; email: string }
  | {
      status: "error"
      message?: string
      fieldErrors?: { email?: string; appPassword?: string }
      email?: string
    }

const CONNECT_ERRORS: Partial<Record<GmailErrorCode, string>> = {
  GMAIL_AUTH_FAILED:
    "Gmail didn't accept that address and app password. Check both, or create a new app password.",
  APP_PASSWORD_REQUIRED:
    "That looks like your normal Google password. MailBrain needs an app password instead.",
  IMAP_DISABLED:
    "IMAP isn't available for this account. In Gmail settings, turn on IMAP and make sure All Mail is shown in IMAP.",
  RATE_LIMITED: "Gmail is limiting connections right now. Wait a minute and try again.",
}

export async function connectGmailAction(
  _prev: ConnectGmailState,
  formData: FormData
): Promise<ConnectGmailState> {
  const { user } = await requireSession()
  const email = String(formData.get("email") ?? "")
  const parsed = gmailConnectSchema.safeParse({
    email,
    appPassword: String(formData.get("appPassword") ?? ""),
  })
  if (!parsed.success) {
    const fieldErrors: { email?: string; appPassword?: string } = {}
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as keyof typeof fieldErrors
      fieldErrors[field] ??= issue.message
    }
    return { status: "error", fieldErrors, email }
  }

  // Each attempt is a live Gmail login, so password guessing through MailBrain
  // (and Gmail locking the account) is capped per user.
  const limit = await hitRateLimit(CONNECT_GMAIL_LIMIT, user.id)
  if (!limit.allowed) {
    return {
      status: "error",
      message: `Too many connection attempts. Wait ${formatRetryAfter(limit.retryAfterMs)} and try again.`,
      email,
    }
  }

  // Sign in once before saving, so we never store credentials that don't work.
  try {
    await withGmailCredentials(parsed.data, (gmail) => gmail.allMail())
  } catch (error) {
    const code = toGmailError(error).code
    return {
      status: "error",
      message: CONNECT_ERRORS[code] ?? "Couldn't reach Gmail. Please try again.",
      email,
    }
  }

  await upsertGmailAccount({ userId: user.id, ...parsed.data })

  // Categories created before connecting get their labels now. Not fatal.
  await syncMissingLabels(user.id).catch((error: unknown) => {
    console.error("Label sync after connect failed:", error instanceof Error ? error.name : "unknown")
  })

  refresh()
  return { status: "success", email: parsed.data.email }
}

/** Turns automatic processing of new mail on or off (PRD CLS-8). */
export async function setAutoProcessAction(accountId: unknown, enabled: unknown) {
  const { user } = await requireSession()
  const id = idArg(accountId)
  const on = boolArg(enabled)
  if (id === null || on === null) return { ok: false }
  const ok = await setAutoProcess(user.id, id, on)
  refresh()
  return { ok }
}

/** Deletes the mailbox's app password and its classification history (PRD AUTH-6). */
export async function disconnectGmailAction(
  accountId: unknown
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { user } = await requireSession()
  const id = idArg(accountId)
  const result = id
    ? await deleteMailboxAndHistory(user.id, id).catch((error: unknown) => {
        console.error("Disconnect failed:", error instanceof Error ? error.name : "unknown")
        return null
      })
    : ({ status: "not_found" } as const)
  refresh()
  if (result?.status === "deleted") return { ok: true }
  if (result?.status === "busy") {
    return { ok: false, message: "MailBrain is working on this mailbox right now. Try again in a minute." }
  }
  if (result?.status === "not_found") return { ok: false, message: "This Gmail account is already disconnected." }
  return { ok: false, message: "Couldn't disconnect Gmail. Please try again." }
}
