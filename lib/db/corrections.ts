import "server-only"

import { ObjectId, type AnyBulkWriteOperation } from "mongodb"

import { CLASSIFICATIONS_COLLECTION, type EmailClassificationDoc } from "@/lib/db/classifications"
import { getDb, getMongoClient } from "@/lib/db/mongodb"

export const CORRECTIONS_COLLECTION = "classificationCorrections"

/**
 * - `move`: the user moved the email to another category
 * - `remove`: the user took the email out of a category
 * - `reclassify`: the user asked the AI again; one entry per category gained or lost
 */
export type CorrectionKind = "move" | "remove" | "reclassify"

/** One user correction (ARCHITECTURE §4 ClassificationCorrection). Kept as evaluation data. */
export type CorrectionDoc = {
  _id: ObjectId
  userId: string
  emailAccountId: ObjectId
  gmailMessageId: string
  /** The match the user acted on. */
  classificationId: ObjectId
  kind: CorrectionKind
  fromCategoryId: ObjectId | null
  toCategoryId: ObjectId | null
  createdAt: Date
}

function classifications() {
  return getDb().collection<EmailClassificationDoc>(CLASSIFICATIONS_COLLECTION)
}

function corrections() {
  return getDb().collection<CorrectionDoc>(CORRECTIONS_COLLECTION)
}

/** A current match, by its record ID, scoped to the user. */
export async function getMatch(userId: string, classificationId: string) {
  if (!ObjectId.isValid(classificationId)) return null
  return classifications().findOne({ _id: new ObjectId(classificationId), userId, status: "classified" })
}

/** Every current match of one email. */
export async function listMatches(userId: string, emailAccountId: ObjectId, gmailMessageId: string) {
  return classifications().find({ userId, emailAccountId, gmailMessageId, status: "classified" }).toArray()
}

export type NewMatch = {
  categoryId: ObjectId
  /** `ai` matches keep the AI's confidence and reason; `user` matches have neither. */
  source: "ai" | "user"
  confidence: number | null
  reason: string | null
  model: string | null
}

export type CorrectionChange = {
  userId: string
  emailAccountId: ObjectId
  gmailMessageId: string
  gmailThreadId: string
  headers: Partial<{ from: string | null; subject: string | null; emailDate: Date | null }>
  /** Matches that end, and the status they end with. */
  retire: { ids: ObjectId[]; status: "corrected" | "removed" }
  /** Matches to create or refresh. Their Gmail labels are already applied. */
  upsert: NewMatch[]
  log: Omit<CorrectionDoc, "_id" | "userId" | "emailAccountId" | "gmailMessageId" | "createdAt">[]
}

/**
 * Writes a correction's record changes and its log entries in one
 * transaction, so they always agree (ROADMAP Phase 12 exit criterion).
 * Gmail is updated before this is called; see lib/corrections/service.ts.
 */
export async function commitCorrection(change: CorrectionChange): Promise<Map<string, ObjectId>> {
  const now = new Date()
  const base = { userId: change.userId, emailAccountId: change.emailAccountId, gmailMessageId: change.gmailMessageId }
  const ids = new Map<string, ObjectId>()

  const session = getMongoClient().startSession()
  try {
    await session.withTransaction(async () => {
      if (change.retire.ids.length > 0) {
        await classifications().updateMany(
          { ...base, _id: { $in: change.retire.ids } },
          { $set: { status: change.retire.status, updatedAt: now } },
          { session }
        )
      }

      const ops: AnyBulkWriteOperation<EmailClassificationDoc>[] = change.upsert.map((match) => ({
        updateOne: {
          filter: { ...base, categoryId: match.categoryId },
          update: {
            $set: {
              ...change.headers,
              gmailThreadId: change.gmailThreadId,
              status: "classified",
              source: match.source,
              confidence: match.confidence,
              reason: match.reason,
              model: match.model,
              errorCode: null,
              labelApplied: true,
              updatedAt: now,
            },
            $unset: { labelError: "" },
            $setOnInsert: { classifiedAt: now },
          },
          upsert: true,
        },
      }))
      if (ops.length > 0) await classifications().bulkWrite(ops, { session, ordered: true })

      if (change.log.length > 0) {
        await corrections().insertMany(
          change.log.map((entry) => ({ ...entry, ...base, _id: new ObjectId(), createdAt: now })),
          { session }
        )
      }
    })

    // Look up the IDs of the (possibly new) matches, for navigation.
    if (change.upsert.length > 0) {
      const docs = await classifications()
        .find({ ...base, categoryId: { $in: change.upsert.map((m) => m.categoryId) } }, { projection: { categoryId: 1 } })
        .toArray()
      for (const doc of docs) if (doc.categoryId) ids.set(doc.categoryId.toHexString(), doc._id)
    }
    return ids
  } finally {
    await session.endSession()
  }
}
