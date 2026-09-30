import "server-only"

import type { FetchMessageObject, MessageAddressObject } from "imapflow"

import type { GmailClient } from "@/lib/gmail/client"
import { GmailError } from "@/lib/gmail/errors"
import type { GmailMessage, GmailMessageRef, MailAddress } from "@/lib/gmail/types"

export type ListMessagesOptions = {
  /** Gmail search syntax (X-GM-RAW), e.g. `newer_than:30d -in:chats`. Default: everything. */
  query?: string
  maxResults?: number
  /** From a previous page's `nextPageToken`. */
  pageToken?: string
}

export type MessagePage = {
  messages: GmailMessageRef[]
  nextPageToken?: string
}

function toDate(value: Date | string | undefined): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function addresses(list: MessageAddressObject[] | undefined): MailAddress[] {
  return (list ?? []).map(({ name, address }) => ({ name, address }))
}

export function toGmailMessage(message: FetchMessageObject): GmailMessage {
  if (!message.emailId || !message.threadId) {
    throw new GmailError("GMAIL_ERROR", "Gmail didn't return message or thread IDs")
  }
  const envelope = message.envelope
  return {
    id: message.emailId,
    threadId: message.threadId,
    labels: [...(message.labels ?? [])],
    flags: [...(message.flags ?? [])],
    internalDate: toDate(message.internalDate),
    size: message.size ?? null,
    envelope: {
      date: toDate(envelope?.date),
      subject: envelope?.subject ?? "",
      messageId: envelope?.messageId ?? null,
      from: addresses(envelope?.from),
      to: addresses(envelope?.to),
      cc: addresses(envelope?.cc),
    },
    ...(message.source && { source: message.source }),
  }
}

/**
 * One page of message references, newest first. Paging uses UIDs, which only
 * increase in All Mail, so new mail arriving mid-scan doesn't shift pages.
 */
export async function getMessages(
  gmail: GmailClient,
  options: ListMessagesOptions = {}
): Promise<MessagePage> {
  return gmail.inAllMail(async () => {
    const { pageUids, nextPageToken } = await findPage(gmail, options)
    if (pageUids.length === 0) return { messages: [] }

    const fetched = await gmail.imap.fetchAll(pageUids, { uid: true, threadId: true }, { uid: true })
    const byUid = new Map(fetched.map((m) => [m.uid, m]))
    const messages = pageUids.flatMap((uid) => {
      const m = byUid.get(uid)
      return m?.emailId && m.threadId ? [{ id: m.emailId, threadId: m.threadId }] : []
    })
    return { messages, nextPageToken }
  })
}

/**
 * One page of messages with their headers and flags (no body), newest first,
 * paged like getMessages. Nothing is marked as read.
 */
export async function listMessageHeaders(
  gmail: GmailClient,
  options: ListMessagesOptions = {}
): Promise<{ messages: GmailMessage[]; nextPageToken?: string }> {
  return gmail.inAllMail(async () => {
    const { pageUids, nextPageToken } = await findPage(gmail, options)
    if (pageUids.length === 0) return { messages: [] }

    const fetched = await gmail.imap.fetchAll(pageUids, MESSAGE_FIELDS, { uid: true })
    const byUid = new Map(fetched.map((m) => [m.uid, m]))
    const messages = pageUids.flatMap((uid) => {
      const m = byUid.get(uid)
      return m?.emailId && m.threadId ? [toGmailMessage(m)] : []
    })
    return { messages, nextPageToken }
  })
}

/** The UIDs of one page, newest first. Caller must hold the All Mail lock. */
async function findPage(gmail: GmailClient, { query, maxResults = 50, pageToken }: ListMessagesOptions) {
  const before = pageToken ? Number(pageToken) : undefined
  const found = await gmail.imap.search(query ? { gmraw: query } : { all: true }, { uid: true })
  const uids = (found || [])
    .filter((uid) => before === undefined || uid < before)
    .sort((a, b) => b - a)
  const pageUids = uids.slice(0, maxResults)
  return {
    pageUids,
    nextPageToken: uids.length > maxResults ? String(pageUids[pageUids.length - 1]) : undefined,
  }
}

/** Finds a message's UID in All Mail from its X-GM-MSGID. Caller must hold the All Mail lock. */
export async function uidForMessage(gmail: GmailClient, messageId: string): Promise<number> {
  const [uid] = (await gmail.imap.search({ emailId: messageId }, { uid: true })) || []
  if (uid === undefined) throw new GmailError("NOT_FOUND", "Gmail message not found")
  return uid
}

const MESSAGE_FIELDS = {
  uid: true,
  envelope: true,
  flags: true,
  labels: true,
  threadId: true,
  internalDate: true,
  size: true,
} as const

/**
 * Several messages with their raw source, in one search and one fetch.
 * `maxBytes` caps the source per message, so large attachments (which come
 * after the text parts) aren't downloaded. Returned in the order of
 * `messageIds`; messages that no longer exist are left out. Fetching uses
 * BODY.PEEK, so messages aren't marked as read.
 */
export async function getMessagesWithSource(
  gmail: GmailClient,
  messageIds: string[],
  { maxBytes }: { maxBytes: number }
): Promise<GmailMessage[]> {
  return getMessagesById(gmail, messageIds, { source: { maxLength: maxBytes } })
}

/** Several messages' headers and metadata (no source), in one search and one fetch. */
export async function getMessageHeaders(gmail: GmailClient, messageIds: string[]): Promise<GmailMessage[]> {
  return getMessagesById(gmail, messageIds, {})
}

async function getMessagesById(
  gmail: GmailClient,
  messageIds: string[],
  extra: { source?: { maxLength: number } }
): Promise<GmailMessage[]> {
  if (messageIds.length === 0) return []
  return gmail.inAllMail(async () => {
    const uids =
      (await gmail.imap.search({ or: messageIds.map((emailId) => ({ emailId })) }, { uid: true })) || []
    if (uids.length === 0) return []

    const fetched = await gmail.imap.fetchAll(uids, { ...MESSAGE_FIELDS, ...extra }, { uid: true })
    const byId = new Map(fetched.map((m) => [m.emailId, m]))
    return messageIds.flatMap((id) => {
      const message = byId.get(id)
      return message ? [toGmailMessage(message)] : []
    })
  })
}

/** Headers, labels and metadata. Pass `source: true` for the raw message (for parsing). */
export async function getMessage(
  gmail: GmailClient,
  messageId: string,
  { source = false }: { source?: boolean } = {}
): Promise<GmailMessage> {
  return gmail.inAllMail(async () => {
    const uid = await uidForMessage(gmail, messageId)
    const message = await gmail.imap.fetchOne(
      String(uid),
      { ...MESSAGE_FIELDS, source },
      { uid: true }
    )
    if (!message) throw new GmailError("NOT_FOUND", "Gmail message not found")
    return toGmailMessage(message)
  })
}
