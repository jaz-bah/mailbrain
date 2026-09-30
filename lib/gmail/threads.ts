import "server-only"

import type { GmailClient } from "@/lib/gmail/client"
import { GmailError } from "@/lib/gmail/errors"
import { toGmailMessage } from "@/lib/gmail/messages"
import type { GmailThread } from "@/lib/gmail/types"

/** All messages in a thread, oldest first, with headers and labels (no bodies). */
export async function getThread(gmail: GmailClient, threadId: string): Promise<GmailThread> {
  return gmail.inAllMail(async () => {
    const uids = (await gmail.imap.search({ threadId }, { uid: true })) || []
    if (uids.length === 0) throw new GmailError("NOT_FOUND", "Gmail thread not found")

    const fetched = await gmail.imap.fetchAll(
      uids,
      { uid: true, envelope: true, flags: true, labels: true, threadId: true, internalDate: true, size: true },
      { uid: true }
    )
    const messages = fetched
      .map(toGmailMessage)
      .sort((a, b) => (a.internalDate?.getTime() ?? 0) - (b.internalDate?.getTime() ?? 0))
    return { id: threadId, messages }
  })
}
