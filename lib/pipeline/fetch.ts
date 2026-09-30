import "server-only"

import type { GmailClient } from "@/lib/gmail/client"
import { getMessages, getMessagesWithSource } from "@/lib/gmail/messages"
import type { GmailMessageRef } from "@/lib/gmail/types"
import { MAX_SOURCE_BYTES, normalizeEmail, type NormalizedEmail } from "@/lib/pipeline/normalize"

/**
 * Default scan window (PRD §11): the last 30 days, newest first, leaving out
 * mail the user sent, drafts and chats. Spam and Trash aren't in All Mail.
 */
export const DEFAULT_SCAN_QUERY = "newer_than:30d -in:sent -in:drafts -in:chats"
export const DEFAULT_BATCH_SIZE = 25
export const MAX_BATCH_SIZE = 50

export type FetchBatchOptions = {
  /** Gmail search syntax. */
  query?: string
  batchSize?: number
  /** From a previous batch's `nextPageToken`. */
  pageToken?: string
  /**
   * Returns the IDs that are already processed. They're skipped before any
   * content is downloaded (Phase 10 passes the EmailClassification lookup).
   */
  isKnown?: (messageIds: string[]) => Promise<Set<string>>
}

export type EmailBatch = {
  emails: NormalizedEmail[]
  /** Already processed, so not fetched. */
  skipped: number
  /** Messages that couldn't be parsed. */
  failed: GmailMessageRef[]
  nextPageToken?: string
}

/**
 * One batch of the scan: list message IDs, drop known ones, fetch the rest in
 * a single request, and normalise them. Runs inside the caller's IMAP session.
 */
export async function fetchEmailBatch(
  gmail: GmailClient,
  { query = DEFAULT_SCAN_QUERY, batchSize = DEFAULT_BATCH_SIZE, pageToken, isKnown }: FetchBatchOptions = {}
): Promise<EmailBatch> {
  const maxResults = Math.min(Math.max(1, Math.floor(batchSize)), MAX_BATCH_SIZE)
  const page = await getMessages(gmail, { query, maxResults, pageToken })

  const result = await downloadNew(gmail, page.messages.map((m) => m.id), isKnown)
  return { ...result, nextPageToken: page.nextPageToken }
}

/**
 * New mail for automatic processing (Phase 13): the messages with these All
 * Mail UIDs, minus known ones, normalised. Runs inside the caller's session.
 */
export async function fetchEmailsByUid(
  gmail: GmailClient,
  uids: number[],
  { isKnown }: Pick<FetchBatchOptions, "isKnown"> = {}
): Promise<EmailBatch> {
  if (uids.length === 0) return { emails: [], failed: [], skipped: 0 }
  const refs = await gmail.inAllMail(() => gmail.imap.fetchAll(uids, { uid: true, threadId: true }, { uid: true }))
  const ids = refs.sort((a, b) => a.uid - b.uid).flatMap((m) => (m.emailId ? [m.emailId] : []))
  return downloadNew(gmail, ids, isKnown)
}

/** Drops known IDs, downloads the rest in one request and normalises them. */
async function downloadNew(
  gmail: GmailClient,
  ids: string[],
  isKnown: FetchBatchOptions["isKnown"]
): Promise<EmailBatch> {
  const known = isKnown && ids.length > 0 ? await isKnown(ids) : new Set<string>()
  const todo = ids.filter((id) => !known.has(id))

  const messages = await getMessagesWithSource(gmail, todo, { maxBytes: MAX_SOURCE_BYTES })

  const emails: NormalizedEmail[] = []
  const failed: GmailMessageRef[] = []
  for (const message of messages) {
    try {
      emails.push(await normalizeEmail(message))
    } catch (error) {
      // Log the ID and error type only, never message content.
      console.error(`Couldn't normalise message ${message.id}:`, error instanceof Error ? error.name : "unknown")
      failed.push({ id: message.id, threadId: message.threadId })
    }
  }

  return { emails, skipped: ids.length - todo.length, failed }
}
