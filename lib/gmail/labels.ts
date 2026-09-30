import "server-only"

import type { GmailClient } from "@/lib/gmail/client"
import { GmailError, toGmailError } from "@/lib/gmail/errors"
import { uidForMessage } from "@/lib/gmail/messages"
import type { GmailLabel } from "@/lib/gmail/types"

/** Prefix for every label MailBrain creates, e.g. `AI/Job Interview`. */
export const LABEL_PREFIX = "AI/"

export function categoryLabelName(categoryName: string): string {
  return `${LABEL_PREFIX}${categoryName.trim()}`
}

/** MailBrain only renames or deletes labels it owns. Never INBOX or [Gmail]/… folders. */
function assertOwnLabel(path: string) {
  if (!path.startsWith(LABEL_PREFIX) || path.length === LABEL_PREFIX.length) {
    throw new GmailError("GMAIL_ERROR", "Refusing to modify a label MailBrain didn't create")
  }
}

/** Labels are IMAP mailboxes. `\Noselect` entries are containers (e.g. `[Gmail]`), not labels. */
export async function getLabels(gmail: GmailClient): Promise<GmailLabel[]> {
  const mailboxes = await gmail.imap.list()
  return mailboxes
    .filter((m) => !m.flags.has("\\Noselect"))
    .map((m) => ({
      id: m.path,
      name: m.path,
      type: m.specialUse || m.path === "INBOX" || m.path.startsWith("[Gmail]") ? "system" : "user",
    }))
}

/** Gmail treats label names case-insensitively when checking for duplicates. */
function findByName(labels: GmailLabel[], name: string) {
  const wanted = name.toLowerCase()
  return labels.find((label) => label.name.toLowerCase() === wanted)
}

/**
 * Returns the label with this name, creating it if needed. Safe to call
 * repeatedly: an existing label (including one created concurrently) is reused.
 */
export async function createLabel(gmail: GmailClient, name: string): Promise<GmailLabel> {
  const existing = findByName(await getLabels(gmail), name)
  if (existing) return existing

  try {
    const created = await gmail.imap.mailboxCreate(name)
    return { id: created.path, name: created.path, type: "user" }
  } catch (error) {
    if (toGmailError(error).code === "CONFLICT") {
      const found = findByName(await getLabels(gmail), name)
      if (found) return found
    }
    throw error
  }
}

/** Renames one of MailBrain's labels. The returned `id` is the new path. */
export async function renameLabel(gmail: GmailClient, labelId: string, name: string): Promise<GmailLabel> {
  assertOwnLabel(labelId)
  const result = await gmail.imap.mailboxRename(labelId, name)
  return { id: result.newPath, name: result.newPath, type: "user" }
}

/**
 * Deletes one of MailBrain's labels. Gmail removes the label from every
 * message; the messages themselves stay in All Mail. A missing label counts as done.
 */
export async function deleteLabel(gmail: GmailClient, labelId: string) {
  assertOwnLabel(labelId)
  try {
    await gmail.imap.mailboxDelete(labelId)
  } catch (error) {
    if (toGmailError(error).code === "NOT_FOUND") return
    throw error
  }
}

/** Idempotent: adding a label the message already has is a no-op. Only MailBrain's labels. */
export async function addLabel(gmail: GmailClient, messageId: string, labelIds: string[]) {
  labelIds.forEach(assertOwnLabel)
  await gmail.inAllMail(async () => {
    const uid = await uidForMessage(gmail, messageId)
    await gmail.imap.messageFlagsAdd(String(uid), labelIds, { uid: true, useLabels: true })
  })
}

/**
 * Adds one of MailBrain's labels to several messages: one search and one
 * STORE, however many messages. Idempotent. Returns which IDs were labelled
 * and which no longer exist in the mailbox.
 */
export async function addLabelToMessages(
  gmail: GmailClient,
  messageIds: string[],
  labelId: string
): Promise<{ labelled: string[]; missing: string[] }> {
  // Classification only ever applies MailBrain's own labels.
  assertOwnLabel(labelId)
  if (messageIds.length === 0) return { labelled: [], missing: [] }

  return gmail.inAllMail(async () => {
    const uids =
      (await gmail.imap.search({ or: messageIds.map((emailId) => ({ emailId })) }, { uid: true })) || []
    if (uids.length === 0) return { labelled: [], missing: messageIds }

    const found = await gmail.imap.fetchAll(uids, { uid: true, threadId: true }, { uid: true })
    await gmail.imap.messageFlagsAdd(uids.join(","), [labelId], { uid: true, useLabels: true })

    const present = new Set(found.map((m) => m.emailId))
    return {
      labelled: messageIds.filter((id) => present.has(id)),
      missing: messageIds.filter((id) => !present.has(id)),
    }
  })
}

/** Idempotent: removing a label the message doesn't have is a no-op. Only MailBrain's labels. */
export async function removeLabel(gmail: GmailClient, messageId: string, labelIds: string[]) {
  labelIds.forEach(assertOwnLabel)
  await gmail.inAllMail(async () => {
    const uid = await uidForMessage(gmail, messageId)
    await gmail.imap.messageFlagsRemove(String(uid), labelIds, { uid: true, useLabels: true })
  })
}
