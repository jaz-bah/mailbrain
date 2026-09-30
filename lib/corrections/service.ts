import "server-only"

import { ObjectId } from "mongodb"

import { classifyEmail } from "@/lib/ai/classify"
import { getAiClient } from "@/lib/ai/client"
import { listCategoryLabels, listEnabledCategories, setCategoryLabelId } from "@/lib/db/categories"
import type { EmailClassificationDoc } from "@/lib/db/classifications"
import { commitCorrection, getMatch, listMatches, type NewMatch } from "@/lib/db/corrections"
import { withGmail, type GmailClient } from "@/lib/gmail/client"
import { GmailError } from "@/lib/gmail/errors"
import { addLabel, categoryLabelName, createLabel, removeLabel } from "@/lib/gmail/labels"
import { getMessagesWithSource } from "@/lib/gmail/messages"
import { MAX_SOURCE_BYTES, normalizeEmail } from "@/lib/pipeline/normalize"

export type CorrectionErrorCode =
  | "MATCH_NOT_FOUND" // the match no longer exists (already corrected, or not the user's)
  | "CATEGORY_NOT_FOUND"
  | "SAME_CATEGORY"
  | "NO_CATEGORIES" // reclassify with no enabled categories
  | "MESSAGE_GONE" // reclassify: the email isn't in Gmail any more
  | "AI_FAILED" // reclassify: the AI couldn't give a valid answer

export class CorrectionError extends Error {
  constructor(readonly code: CorrectionErrorCode) {
    super(`Correction failed: ${code}`)
    this.name = "CorrectionError"
  }
}

/** Where the UI should go next: the email's current match in some category, if any. */
export type CorrectionResult = { classificationId: string | null; categoryId: string | null }

type CategoryLabel = { id: string; name: string; gmailLabelId: string | null }

async function requireMatch(userId: string, classificationId: string) {
  const match = await getMatch(userId, classificationId)
  if (!match || !match.categoryId) throw new CorrectionError("MATCH_NOT_FOUND")
  return match as EmailClassificationDoc & { categoryId: ObjectId }
}

/** The category's Gmail label, created (and stored) first if it doesn't exist yet. */
async function ensureLabel(gmail: GmailClient, userId: string, category: CategoryLabel) {
  if (category.gmailLabelId) return category.gmailLabelId
  const label = await createLabel(gmail, categoryLabelName(category.name))
  await setCategoryLabelId(userId, new ObjectId(category.id), label.id)
  return label.id
}

/**
 * Swaps labels on one message. An email deleted from Gmail can still be
 * corrected in MailBrain, so NOT_FOUND is ignored; other Gmail errors abort
 * the correction before anything in the database changes.
 */
async function relabel(
  userId: string,
  match: EmailClassificationDoc,
  { remove, add }: { remove: CategoryLabel[]; add: CategoryLabel[] }
) {
  await withGmail(userId, match.emailAccountId.toHexString(), async (gmail) => {
    const toRemove = remove.flatMap((c) => (c.gmailLabelId ? [c.gmailLabelId] : []))
    const toAdd: string[] = []
    for (const category of add) toAdd.push(await ensureLabel(gmail, userId, category))
    try {
      if (toRemove.length > 0) await removeLabel(gmail, match.gmailMessageId, toRemove)
      if (toAdd.length > 0) await addLabel(gmail, match.gmailMessageId, toAdd)
    } catch (error) {
      if (error instanceof GmailError && error.code === "NOT_FOUND") return
      throw error
    }
  })
}

function headersOf(match: EmailClassificationDoc) {
  return {
    ...(match.from !== undefined && { from: match.from }),
    ...(match.subject !== undefined && { subject: match.subject }),
    ...(match.emailDate !== undefined && { emailDate: match.emailDate }),
  }
}

async function categoryMap(userId: string) {
  return new Map((await listCategoryLabels(userId)).map((c) => [c.id, c]))
}

/** The email's remaining match (any category), for navigation after a correction. */
async function nextMatch(userId: string, match: EmailClassificationDoc): Promise<CorrectionResult> {
  const [next] = await listMatches(userId, match.emailAccountId, match.gmailMessageId)
  return {
    classificationId: next?._id.toHexString() ?? null,
    categoryId: next?.categoryId?.toHexString() ?? null,
  }
}

/**
 * Moves an email from its current category to another one (UI-4). Gmail
 * first, then the records and correction log in one transaction.
 */
export async function moveToCategory(userId: string, classificationId: string, toCategoryId: string): Promise<CorrectionResult> {
  const match = await requireMatch(userId, classificationId)
  const categories = await categoryMap(userId)
  const target = categories.get(toCategoryId)
  if (!target) throw new CorrectionError("CATEGORY_NOT_FOUND")
  if (match.categoryId.toHexString() === toCategoryId) throw new CorrectionError("SAME_CATEGORY")

  const from = categories.get(match.categoryId.toHexString())
  await relabel(userId, match, { remove: from ? [from] : [], add: [target] })

  const ids = await commitCorrection({
    userId,
    emailAccountId: match.emailAccountId,
    gmailMessageId: match.gmailMessageId,
    gmailThreadId: match.gmailThreadId,
    headers: headersOf(match),
    retire: { ids: [match._id], status: "corrected" },
    upsert: [{ categoryId: new ObjectId(toCategoryId), source: "user", confidence: null, reason: null, model: null }],
    log: [{ classificationId: match._id, kind: "move", fromCategoryId: match.categoryId, toCategoryId: new ObjectId(toCategoryId) }],
  })
  return { classificationId: ids.get(toCategoryId)?.toHexString() ?? null, categoryId: toCategoryId }
}

/** Takes an email out of one category (UI-4). Other matches of the email are kept. */
export async function removeFromCategory(userId: string, classificationId: string): Promise<CorrectionResult> {
  const match = await requireMatch(userId, classificationId)
  const category = (await categoryMap(userId)).get(match.categoryId.toHexString())
  await relabel(userId, match, { remove: category ? [category] : [], add: [] })

  await commitCorrection({
    userId,
    emailAccountId: match.emailAccountId,
    gmailMessageId: match.gmailMessageId,
    gmailThreadId: match.gmailThreadId,
    headers: {},
    retire: { ids: [match._id], status: "removed" },
    upsert: [],
    log: [{ classificationId: match._id, kind: "remove", fromCategoryId: match.categoryId, toCategoryId: null }],
  })
  return nextMatch(userId, match)
}

/**
 * Asks the AI again (CLS-5: the only path that re-sends a classified email).
 * Matches in enabled categories are replaced by the new answer; matches in
 * paused categories are left alone, since the AI didn't consider them.
 */
export async function reclassify(userId: string, classificationId: string): Promise<CorrectionResult & { changed: boolean }> {
  const match = await requireMatch(userId, classificationId)
  const enabled = await listEnabledCategories(userId)
  if (enabled.length === 0) throw new CorrectionError("NO_CATEGORIES")

  const accountId = match.emailAccountId.toHexString()
  const [message] = await withGmail(userId, accountId, (gmail) =>
    getMessagesWithSource(gmail, [match.gmailMessageId], { maxBytes: MAX_SOURCE_BYTES })
  )
  if (!message) throw new CorrectionError("MESSAGE_GONE")
  const email = await normalizeEmail(message)

  const result = await classifyEmail(getAiClient(), enabled, email)
  if (result.status === "failed") throw new CorrectionError("AI_FAILED")
  const newMatches = result.status === "classified" ? result.matches : []

  const enabledIds = new Set(enabled.map((c) => c.id))
  const current = await listMatches(userId, match.emailAccountId, match.gmailMessageId)
  const currentIds = new Set(current.flatMap((m) => (m.categoryId ? [m.categoryId.toHexString()] : [])))
  const newIds = new Set(newMatches.map((m) => m.categoryId))
  const dropped = current.filter((m) => m.categoryId && enabledIds.has(m.categoryId.toHexString()) && !newIds.has(m.categoryId.toHexString()))
  const added = newMatches.filter((m) => !currentIds.has(m.categoryId))

  const categories = await categoryMap(userId)
  const labelsOf = (ids: string[]) => ids.flatMap((id) => categories.get(id) ?? [])
  await relabel(userId, match, {
    remove: labelsOf(dropped.map((m) => m.categoryId!.toHexString())),
    add: labelsOf(added.map((m) => m.categoryId)),
  })

  const upsert: NewMatch[] = newMatches.map((m) => ({
    categoryId: new ObjectId(m.categoryId),
    source: "ai",
    confidence: m.confidence,
    reason: m.reason,
    model: result.status === "classified" ? result.model : null,
  }))
  const ids = await commitCorrection({
    userId,
    emailAccountId: match.emailAccountId,
    gmailMessageId: match.gmailMessageId,
    gmailThreadId: match.gmailThreadId,
    headers: { from: email.from, subject: email.subject, emailDate: email.date ? new Date(email.date) : null },
    retire: { ids: dropped.map((m) => m._id), status: "corrected" },
    upsert,
    log: [
      ...dropped.map((m) => ({ classificationId: match._id, kind: "reclassify" as const, fromCategoryId: m.categoryId, toCategoryId: null })),
      ...added.map((m) => ({ classificationId: match._id, kind: "reclassify" as const, fromCategoryId: null, toCategoryId: new ObjectId(m.categoryId) })),
    ],
  })

  const changed = dropped.length > 0 || added.length > 0
  // Stay on this category if the email is still in it; otherwise go to its best new match.
  const stay = ids.get(match.categoryId.toHexString())
  if (stay) return { classificationId: stay.toHexString(), categoryId: match.categoryId.toHexString(), changed }
  const best = newMatches[0]
  if (best) return { classificationId: ids.get(best.categoryId)?.toHexString() ?? null, categoryId: best.categoryId, changed }
  return { ...(await nextMatch(userId, match)), changed }
}
