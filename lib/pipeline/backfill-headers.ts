import "server-only"

import { findMatchesWithoutHeaders, setMatchHeaders, type EmailHeaders } from "@/lib/db/classifications"
import { withGmail } from "@/lib/gmail/client"
import { getMessageHeaders } from "@/lib/gmail/messages"
import { headersFromEnvelope } from "@/lib/pipeline/normalize"

/**
 * Matches saved before Phase 11 have no sender, subject or date. This fills
 * them in from Gmail's envelope (headers only, no body download), up to 200
 * per scan. Emails that are gone get null headers so they aren't retried.
 */
export async function backfillMatchHeaders(userId: string, accountId: string): Promise<number> {
  const messageIds = await findMatchesWithoutHeaders(userId, accountId)
  if (messageIds.length === 0) return 0

  const messages = await withGmail(userId, accountId, (gmail) => getMessageHeaders(gmail, messageIds))
  const found = new Map(messages.map((m) => [m.id, m]))
  const headers = new Map<string, EmailHeaders | null>(
    messageIds.map((id) => {
      const message = found.get(id)
      return [id, message ? headersFromEnvelope(message) : null]
    })
  )
  await setMatchHeaders(userId, accountId, headers)
  return messages.length
}
