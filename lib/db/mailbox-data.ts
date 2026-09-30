import "server-only"

import { ObjectId } from "mongodb"

import { CLASSIFICATIONS_COLLECTION } from "@/lib/db/classifications"
import { CORRECTIONS_COLLECTION } from "@/lib/db/corrections"
import {
  acquireProcessingLease,
  EMAIL_ACCOUNTS_COLLECTION,
  releaseProcessingLease,
} from "@/lib/db/email-accounts"
import { getDb, getMongoClient } from "@/lib/db/mongodb"

/** Long enough for the deletes; a scan can't start on this mailbox meanwhile. */
const DISCONNECT_LEASE_MS = 60_000

export type DisconnectResult =
  | { status: "deleted"; classifications: number; corrections: number }
  | { status: "not_found" }
  | { status: "busy" } // a scan or automatic run is using the mailbox

/**
 * Disconnects a mailbox and deletes everything MailBrain stored about it: the
 * encrypted app password, its classification records (sender, subject, date,
 * AI reasons) and its correction log (PRD AUTH-6, Phase 14 privacy decision).
 * Gmail itself is untouched, so the `AI/…` labels stay on the emails.
 */
export async function deleteMailboxAndHistory(userId: string, accountId: string): Promise<DisconnectResult> {
  if (!ObjectId.isValid(accountId)) return { status: "not_found" }
  const _id = new ObjectId(accountId)
  const db = getDb()

  const owned = await db.collection(EMAIL_ACCOUNTS_COLLECTION).countDocuments({ _id, userId }, { limit: 1 })
  if (owned === 0) return { status: "not_found" }

  // Holding the lease stops a scan from writing new records mid-delete.
  if (!(await acquireProcessingLease(accountId, DISCONNECT_LEASE_MS))) return { status: "busy" }

  const session = getMongoClient().startSession()
  try {
    let counts = { classifications: 0, corrections: 0 }
    await session.withTransaction(async () => {
      const filter = { userId, emailAccountId: _id }
      // Sequential: a session doesn't support parallel operations in a transaction.
      const classifications = await db.collection(CLASSIFICATIONS_COLLECTION).deleteMany(filter, { session })
      const corrections = await db.collection(CORRECTIONS_COLLECTION).deleteMany(filter, { session })
      await db.collection(EMAIL_ACCOUNTS_COLLECTION).deleteOne({ _id, userId }, { session })
      counts = { classifications: classifications.deletedCount, corrections: corrections.deletedCount }
    })
    return { status: "deleted", ...counts }
  } catch (error) {
    // Nothing was deleted, so the mailbox must be usable again.
    await releaseProcessingLease(accountId)
    throw error
  } finally {
    await session.endSession()
  }
}
