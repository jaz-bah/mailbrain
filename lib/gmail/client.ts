import "server-only"

import { ImapFlow } from "imapflow"

import {
  getEmailAccountCredentials,
  setEmailAccountStatus,
} from "@/lib/db/email-accounts"
import { GmailError, isCredentialError, toGmailError } from "@/lib/gmail/errors"

const GMAIL_IMAP = { host: "imap.gmail.com", port: 993, secure: true } as const

/** The ImapFlow methods MailBrain uses. Tests supply a fake with the same shape. */
export type ImapSession = Pick<
  ImapFlow,
  | "list"
  | "getMailboxLock"
  | "search"
  | "fetchAll"
  | "fetchOne"
  | "messageFlagsAdd"
  | "messageFlagsRemove"
  | "mailboxCreate"
  | "mailboxRename"
  | "mailboxDelete"
  | "mailbox"
>

/**
 * One authenticated IMAP session with a Gmail mailbox. Created by withGmail(),
 * which also closes it; don't keep a reference after the callback returns.
 */
export class GmailClient {
  private allMailPath: string | undefined

  constructor(readonly imap: ImapSession) {}

  /**
   * Path of "All Mail". It's localised (e.g. "[Gmail]/Alle Nachrichten"), so
   * it's found by its special-use flag rather than by name.
   */
  async allMail(): Promise<string> {
    if (this.allMailPath) return this.allMailPath
    const mailbox = (await this.imap.list()).find((m) => m.specialUse === "\\All")
    if (!mailbox) {
      throw new GmailError(
        "IMAP_DISABLED",
        "All Mail isn't available over IMAP. Turn on “Show in IMAP” for All Mail in Gmail's label settings."
      )
    }
    this.allMailPath = mailbox.path
    return mailbox.path
  }

  /**
   * All Mail's UIDVALIDITY and the next UID it will assign. UIDs only grow
   * while UIDVALIDITY stays the same, which makes them a cursor (Phase 13).
   */
  async allMailStatus(): Promise<{ uidValidity: string; uidNext: number }> {
    return this.inAllMail(async () => {
      const mailbox = this.imap.mailbox
      if (!mailbox) throw new GmailError("GMAIL_ERROR", "All Mail isn't selected")
      return { uidValidity: String(mailbox.uidValidity), uidNext: mailbox.uidNext }
    })
  }

  /** Runs `fn` with All Mail selected. Every message lives there, whatever its labels. */
  async inAllMail<T>(fn: () => Promise<T>): Promise<T> {
    const lock = await this.imap.getMailboxLock(await this.allMail())
    try {
      return await fn()
    } finally {
      lock.release()
    }
  }
}

export type GmailCredentials = { email: string; appPassword: string }

/**
 * Opens a session with these credentials, runs `fn`, and always logs out.
 * Every failure is thrown as a GmailError.
 */
export async function withGmailCredentials<T>(
  credentials: GmailCredentials,
  fn: (gmail: GmailClient) => Promise<T>
): Promise<T> {
  const imap = new ImapFlow({
    ...GMAIL_IMAP,
    auth: { user: credentials.email, pass: credentials.appPassword },
    logger: false,
    // We run short request-scoped sessions, not a long-lived IDLE connection.
    disableAutoIdle: true,
  })
  // Without a listener, a dropped socket would crash the process.
  imap.on("error", (error: Error) => {
    console.error("IMAP connection error:", toGmailError(error).code)
  })

  try {
    await imap.connect()
    return await fn(new GmailClient(imap))
  } catch (error) {
    throw toGmailError(error)
  } finally {
    // After a failed login the socket stays open, so close it instead of
    // logging out; otherwise every failed attempt would leak a connection.
    if (imap.usable) await imap.logout().catch(() => imap.close())
    else imap.close()
  }
}

/**
 * Runs `fn` against one of the signed-in user's connected mailboxes. If Gmail
 * rejects the stored app password, the account is marked `revoked`; an
 * `active` status is restored after the next successful session.
 */
export async function withGmail<T>(
  userId: string,
  accountId: string,
  fn: (gmail: GmailClient) => Promise<T>
): Promise<T> {
  const account = await getEmailAccountCredentials(userId, accountId)
  if (!account) throw new GmailError("GMAIL_NOT_CONNECTED", "Gmail account not found")

  try {
    const result = await withGmailCredentials(account, fn)
    if (account.status !== "active") await setEmailAccountStatus(account.id, "active")
    return result
  } catch (error) {
    const gmailError = toGmailError(error)
    if (isCredentialError(gmailError)) await setEmailAccountStatus(account.id, "revoked")
    else if (gmailError.code === "IMAP_DISABLED") await setEmailAccountStatus(account.id, "error")
    throw gmailError
  }
}
