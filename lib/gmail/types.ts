// Gmail over IMAP, using Gmail's IMAP extensions (X-GM-MSGID, X-GM-THRID,
// X-GM-LABELS, X-GM-RAW).
// https://developers.google.com/workspace/gmail/imap/imap-extensions

export type MailAddress = { name?: string; address?: string }

/** A message reference. `id` is Gmail's X-GM-MSGID (decimal), stable across folders. */
export type GmailMessageRef = {
  id: string
  threadId: string
}

export type GmailMessage = GmailMessageRef & {
  /** Gmail labels, including system ones such as `\Inbox` and `\Important`. */
  labels: string[]
  flags: string[]
  internalDate: Date | null
  size: number | null
  envelope: {
    date: Date | null
    subject: string
    messageId: string | null
    from: MailAddress[]
    to: MailAddress[]
    cc: MailAddress[]
  }
  /** Raw RFC 822 source, only when requested. May be cut short (see getMessagesWithSource). */
  source?: Buffer
}

export type GmailThread = {
  id: string
  messages: GmailMessage[]
}

/** A Gmail label. Over IMAP a label is a mailbox, so `id` is its path (e.g. `AI/Invoices`). */
export type GmailLabel = {
  id: string
  name: string
  type: "system" | "user"
}

/** Gmail web URL for a message. The web UI uses the hex form of X-GM-MSGID. */
export function gmailWebUrl(messageId: string, accountEmail?: string) {
  const hex = BigInt(messageId).toString(16)
  const account = accountEmail ? `?authuser=${encodeURIComponent(accountEmail)}` : ""
  return `https://mail.google.com/mail/${account}#all/${hex}`
}
