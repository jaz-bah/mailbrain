import "server-only"

import { withGmail } from "@/lib/gmail/client"
import { listMessageHeaders } from "@/lib/gmail/messages"
import { gmailWebUrl, type GmailMessage } from "@/lib/gmail/types"

export const INBOX_PAGE_SIZE = 25
export const INBOX_QUERY = "in:inbox"

/** One inbox row: headers only, read live from Gmail and never stored. */
export type InboxItem = {
  id: string
  from: string
  subject: string
  /** ISO. When Gmail received it, falling back to the Date header. */
  date: string | null
  unread: boolean
  gmailUrl: string
}

export function toInboxItem(message: GmailMessage, accountEmail: string): InboxItem {
  const [sender] = message.envelope.from
  const date = message.internalDate ?? message.envelope.date
  return {
    id: message.id,
    from: sender?.name?.trim() || sender?.address || "Unknown sender",
    subject: message.envelope.subject.trim(),
    date: date?.toISOString() ?? null,
    unread: !message.flags.includes("\\Seen"),
    gmailUrl: gmailWebUrl(message.id, accountEmail),
  }
}

/**
 * One page of the inbox, newest first. `before` is the previous page's
 * `olderToken` (a UID), so pages don't shift when new mail arrives.
 */
export async function loadInboxPage(
  userId: string,
  account: { id: string; email: string },
  before?: string
): Promise<{ items: InboxItem[]; olderToken?: string }> {
  const page = await withGmail(userId, account.id, (gmail) =>
    listMessageHeaders(gmail, { query: INBOX_QUERY, maxResults: INBOX_PAGE_SIZE, pageToken: before })
  )
  return {
    items: page.messages.map((message) => toInboxItem(message, account.email)),
    olderToken: page.nextPageToken,
  }
}
