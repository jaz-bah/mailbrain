import "server-only"

import { ObjectId, type AnyBulkWriteOperation } from "mongodb"
import { cache } from "react"

import type { EmailClassificationResult } from "@/lib/ai/classify"
import { getDb } from "@/lib/db/mongodb"

export const CLASSIFICATIONS_COLLECTION = "emailClassifications"

/**
 * - `classified`: matched this category (one record per matched category)
 * - `no_match`: the AI found no category above its threshold (categoryId null)
 * - `failed`: the AI or parsing failed; retried on the next scan (categoryId null)
 * - `corrected` / `removed`: set by user corrections (Phase 12)
 */
export type ClassificationStatus = "classified" | "no_match" | "failed" | "corrected" | "removed"

/**
 * One classification record. Holds IDs, AI metadata and, for matches, the
 * three headers the collection pages list (sender, subject, date). Never the
 * body or attachments (ARCHITECTURE §4, data minimisation).
 */
export type EmailClassificationDoc = {
  _id: ObjectId
  userId: string
  emailAccountId: ObjectId
  gmailMessageId: string
  gmailThreadId: string
  /** null for `no_match` and `failed`. */
  categoryId: ObjectId | null
  /** Who made the match: the AI (default) or the user, via a correction (Phase 12). */
  source?: "ai" | "user"
  /** null for matches the user set. */
  confidence: number | null
  reason: string | null
  model: string | null
  status: ClassificationStatus
  errorCode: string | null
  /** Failed attempts so far (failed records only). */
  attempts?: number
  /** Set once the Gmail label is on the message (Phase 9); lets labelling retry without the AI. */
  labelApplied: boolean
  /** Why labelling stopped being retried: the email or its category is gone. */
  labelError?: "MESSAGE_NOT_FOUND" | "CATEGORY_DELETED"
  /** Matches only: "Name <address>". Missing on records from before Phase 11 until backfilled. */
  from?: string | null
  subject?: string | null
  /** The email's own date (not when it was classified). */
  emailDate?: Date | null
  classifiedAt: Date
  updatedAt: Date
}

type MessageRef = { id: string; threadId: string }

/** Headers stored on matches for the collection pages. */
export type EmailHeaders = { from: string; subject: string; date: string | null }

function collection() {
  return getDb().collection<EmailClassificationDoc>(CLASSIFICATIONS_COLLECTION)
}

/** After this many failed attempts an email is left alone, so it can't block every scan. */
export const MAX_FAILED_ATTEMPTS = 3

/**
 * Message IDs this mailbox has already processed, so the scan skips them
 * before downloading or calling the AI (CLS-5). Failed ones are retried until
 * MAX_FAILED_ATTEMPTS.
 */
export async function findProcessedMessageIds(
  userId: string,
  emailAccountId: string,
  messageIds: string[]
): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set()
  const ids = await collection().distinct("gmailMessageId", {
    userId,
    emailAccountId: new ObjectId(emailAccountId),
    gmailMessageId: { $in: messageIds },
    $or: [{ status: { $ne: "failed" } }, { attempts: { $gte: MAX_FAILED_ATTEMPTS } }],
  })
  return new Set(ids)
}

/** Max unlabelled records handled per scan, so a backlog can't make one scan slow. */
const MAX_PENDING_LABELS = 200

export type PendingLabel = { _id: ObjectId; gmailMessageId: string; categoryId: ObjectId }

/**
 * Matches whose Gmail label isn't applied yet: this scan's, plus any from
 * earlier scans whose labelling failed (Phase 9). No AI call is needed to retry.
 */
export async function findPendingLabels(userId: string, emailAccountId: string): Promise<PendingLabel[]> {
  return collection()
    .find(
      {
        userId,
        emailAccountId: new ObjectId(emailAccountId),
        status: "classified",
        labelApplied: false,
        labelError: { $exists: false },
      },
      { projection: { gmailMessageId: 1, categoryId: 1 }, limit: MAX_PENDING_LABELS, sort: { classifiedAt: 1 } }
    )
    .toArray() as Promise<PendingLabel[]>
}

export async function markLabelsApplied(userId: string, ids: ObjectId[]) {
  if (ids.length === 0) return
  await collection().updateMany({ userId, _id: { $in: ids } }, { $set: { labelApplied: true, updatedAt: new Date() } })
}

export async function markLabelError(userId: string, ids: ObjectId[], labelError: "MESSAGE_NOT_FOUND" | "CATEGORY_DELETED") {
  if (ids.length === 0) return
  await collection().updateMany({ userId, _id: { $in: ids } }, { $set: { labelError, updatedAt: new Date() } })
}

/**
 * Saves the outcome for one email. Idempotent: records are keyed by
 * {emailAccountId, gmailMessageId, categoryId}, so saving twice never
 * duplicates, and an earlier `failed` record is replaced.
 */
export async function saveClassification(
  userId: string,
  emailAccountId: string,
  message: MessageRef & Partial<EmailHeaders>,
  result: EmailClassificationResult | { status: "failed"; errorCode: string }
) {
  const accountId = new ObjectId(emailAccountId)
  const now = new Date()
  const base = { userId, emailAccountId: accountId, gmailMessageId: message.id }
  const common = { gmailThreadId: message.threadId, updatedAt: now }
  const onInsert = { labelApplied: false, classifiedAt: now }

  const ops: AnyBulkWriteOperation<EmailClassificationDoc>[] = []
  if (result.status === "classified") {
    // Only matches keep headers: they're what the collection pages list.
    const headers = message.from !== undefined ? headerFields(message as EmailHeaders) : {}
    for (const match of result.matches) {
      ops.push({
        updateOne: {
          filter: { ...base, categoryId: new ObjectId(match.categoryId) },
          update: {
            $set: {
              ...common,
              ...headers,
              confidence: match.confidence,
              reason: match.reason,
              model: result.model,
              status: "classified",
              errorCode: null,
            },
            $setOnInsert: onInsert,
          },
          upsert: true,
        },
      })
    }
    // Replaces an earlier failed attempt for this message.
    ops.push({ deleteMany: { filter: { ...base, categoryId: null } } })
  } else if (result.status === "no_match") {
    ops.push({
      updateOne: {
        filter: { ...base, categoryId: null },
        update: {
          $set: {
            ...common,
            confidence: result.best?.confidence ?? null,
            reason: null,
            model: result.model,
            status: "no_match",
            errorCode: null,
          },
          $unset: { attempts: "" },
          $setOnInsert: onInsert,
        },
        upsert: true,
      },
    })
  } else {
    ops.push({
      updateOne: {
        filter: { ...base, categoryId: null },
        update: {
          $set: { ...common, confidence: null, reason: null, model: null, status: "failed", errorCode: result.errorCode },
          $inc: { attempts: 1 },
          $setOnInsert: onInsert,
        },
        upsert: true,
      },
    })
  }
  await collection().bulkWrite(ops, { ordered: true })
}

function headerFields({ from, subject, date }: EmailHeaders) {
  const parsed = date ? new Date(date) : null
  return {
    from,
    subject,
    emailDate: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
  }
}

/** Matches saved before Phase 11 have no headers yet; the scan fills them in from Gmail. */
export async function findMatchesWithoutHeaders(userId: string, emailAccountId: string, limit = 200) {
  const docs = await collection()
    .find(
      { userId, emailAccountId: new ObjectId(emailAccountId), status: "classified", subject: { $exists: false } },
      { projection: { gmailMessageId: 1 }, limit }
    )
    .toArray()
  return [...new Set(docs.map((d) => d.gmailMessageId))]
}

/** Sets headers on every match of these emails. `null` headers mark an email that's gone from Gmail. */
export async function setMatchHeaders(userId: string, emailAccountId: string, headers: Map<string, EmailHeaders | null>) {
  if (headers.size === 0) return
  await collection().bulkWrite(
    [...headers].map(([gmailMessageId, h]) => ({
      updateMany: {
        filter: { userId, emailAccountId: new ObjectId(emailAccountId), gmailMessageId, status: "classified" as const },
        update: { $set: h ? headerFields(h) : { from: null, subject: null, emailDate: null } },
      },
    })),
    { ordered: false }
  )
}

// ---------------------------------------------------------------------------
// Read side (Phase 11): dashboard, collections, email detail. All scoped by userId.

export type DashboardStats = {
  /** Emails with a final outcome (matched or no match). */
  scanned: number
  /** Emails matched to at least one category. */
  classified: number
  noMatch: number
  /** Failed and still to be retried. */
  retrying: number
  /** Matches per category ID. */
  perCategory: Record<string, number>
}

export const getDashboardStats = cache(async (userId: string): Promise<DashboardStats> => {
  const [facets] = await collection()
    .aggregate<{
      scanned: { emails: number }[]
      classified: { emails: number }[]
      perCategory: { _id: ObjectId; count: number }[]
      retrying: { count: number }[]
    }>([
      { $match: { userId } },
      {
        $facet: {
          // One email has several records (one per category, plus corrections),
          // so count distinct messages. Anything but `failed` is a final outcome.
          scanned: [
            { $match: { status: { $ne: "failed" } } },
            { $group: { _id: { m: "$gmailMessageId", a: "$emailAccountId" } } },
            { $count: "emails" },
          ],
          classified: [
            { $match: { status: "classified" } },
            { $group: { _id: { m: "$gmailMessageId", a: "$emailAccountId" } } },
            { $count: "emails" },
          ],
          perCategory: [
            { $match: { status: "classified" } },
            { $group: { _id: "$categoryId", count: { $sum: 1 } } },
          ],
          retrying: [
            { $match: { status: "failed", $or: [{ attempts: { $lt: MAX_FAILED_ATTEMPTS } }, { attempts: { $exists: false } }] } },
            { $count: "count" },
          ],
        },
      },
    ])
    .toArray()

  const scanned = facets?.scanned[0]?.emails ?? 0
  const classified = facets?.classified[0]?.emails ?? 0
  return {
    scanned,
    classified,
    // Includes emails whose only match the user removed.
    noMatch: scanned - classified,
    retrying: facets?.retrying[0]?.count ?? 0,
    perCategory: Object.fromEntries((facets?.perCategory ?? []).map((c) => [c._id.toHexString(), c.count])),
  }
})

export type CollectionItem = {
  id: string
  from: string | null
  subject: string | null
  /** ISO. */
  date: string | null
  /** null when the user set the category. */
  confidence: number | null
  setByUser: boolean
  labelApplied: boolean
  /** False for matches from before Phase 11 that haven't been backfilled yet. */
  hasHeaders: boolean
}

export const COLLECTION_PAGE_SIZE = 25

/** One page of a category's emails, newest first (UI-2). */
export async function listCollection(
  userId: string,
  categoryId: string,
  page: number
): Promise<{ items: CollectionItem[]; total: number }> {
  if (!ObjectId.isValid(categoryId)) return { items: [], total: 0 }
  const filter = { userId, categoryId: new ObjectId(categoryId), status: "classified" as const }
  const [docs, total] = await Promise.all([
    collection()
      .find(filter, {
        projection: { from: 1, subject: 1, emailDate: 1, confidence: 1, source: 1, labelApplied: 1 },
        sort: { emailDate: -1, classifiedAt: -1 },
        skip: (page - 1) * COLLECTION_PAGE_SIZE,
        limit: COLLECTION_PAGE_SIZE,
      })
      .toArray(),
    collection().countDocuments(filter),
  ])
  return {
    total,
    items: docs.map((doc) => ({
      id: doc._id.toHexString(),
      from: doc.from ?? null,
      subject: doc.subject ?? null,
      date: doc.emailDate?.toISOString() ?? null,
      confidence: doc.confidence,
      setByUser: doc.source === "user",
      labelApplied: doc.labelApplied,
      hasHeaders: doc.subject !== undefined,
    })),
  }
}

export type ClassificationDetail = {
  id: string
  emailAccountId: string
  gmailMessageId: string
  categoryId: string
  from: string | null
  subject: string | null
  date: string | null
  /** null when the user set the category. */
  confidence: number | null
  setByUser: boolean
  reason: string | null
  model: string | null
  classifiedAt: string
  labelApplied: boolean
  labelError: string | null
  hasHeaders: boolean
  /** Other categories this email matched. */
  otherCategoryIds: string[]
}

/** One match, for the email detail view (UI-3). */
export async function getClassificationDetail(userId: string, id: string): Promise<ClassificationDetail | null> {
  if (!ObjectId.isValid(id)) return null
  const doc = await collection().findOne({ _id: new ObjectId(id), userId, status: "classified" })
  if (!doc || !doc.categoryId) return null

  const siblings = await collection()
    .find(
      { userId, emailAccountId: doc.emailAccountId, gmailMessageId: doc.gmailMessageId, status: "classified", _id: { $ne: doc._id } },
      { projection: { categoryId: 1 } }
    )
    .toArray()

  return {
    id: doc._id.toHexString(),
    emailAccountId: doc.emailAccountId.toHexString(),
    gmailMessageId: doc.gmailMessageId,
    categoryId: doc.categoryId.toHexString(),
    from: doc.from ?? null,
    subject: doc.subject ?? null,
    date: doc.emailDate?.toISOString() ?? null,
    confidence: doc.confidence,
    setByUser: doc.source === "user",
    reason: doc.reason,
    model: doc.model,
    classifiedAt: doc.classifiedAt.toISOString(),
    labelApplied: doc.labelApplied,
    labelError: doc.labelError ?? null,
    hasHeaders: doc.subject !== undefined,
    otherCategoryIds: siblings.flatMap((s) => (s.categoryId ? [s.categoryId.toHexString()] : [])),
  }
}
