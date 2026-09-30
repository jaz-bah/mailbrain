import "server-only"

import { ObjectId } from "mongodb"
import { cache } from "react"

import { decryptSecretWithStatus, encryptSecret } from "@/lib/crypto/tokens"
import { getDb } from "@/lib/db/mongodb"

export const EMAIL_ACCOUNTS_COLLECTION = "emailAccounts"

/** AAD context for app password encryption. Never reuse it for other data. */
const APP_PASSWORD_CONTEXT = "emailAccount.appPassword"

/**
 * - `active`: credentials worked on the last connection
 * - `revoked`: Gmail rejected the app password (revoked, changed or 2-Step turned off)
 * - `error`: another persistent problem (e.g. IMAP turned off)
 */
export type EmailAccountStatus = "active" | "revoked" | "error"

export type EmailAccountDoc = {
  _id: ObjectId
  userId: string
  provider: "gmail"
  /** How MailBrain signs in to the mailbox. */
  authMethod: "app_password"
  email: string
  appPassword: string // encrypted
  status: EmailAccountStatus
  /** Automatic processing of new mail (Phase 13). Off until the user turns it on. */
  autoProcess?: boolean
  /** Cursor: the highest All Mail UID handled by automatic processing. */
  lastSeenUid?: number
  /** All Mail's UIDVALIDITY when the cursor was set (a bigint, stored as a string). */
  uidValidity?: string
  /** Lease: while in the future, a scan or automatic run owns this mailbox. */
  processingUntil?: Date | null
  lastAutoRun?: { at: Date; classified: number; processed: number; error: string | null }
  createdAt: Date
  updatedAt: Date
}

/** Safe to send to the client: never includes the password. */
export type EmailAccountSummary = {
  id: string
  email: string
  status: EmailAccountStatus
  connectedAt: string
  autoProcess: boolean
  lastAutoRun: { at: string; classified: number; processed: number; error: string | null } | null
}

/** Decrypted credentials for server-side IMAP sessions. Never send to the client. */
export type EmailAccountCredentials = {
  id: string
  email: string
  status: EmailAccountStatus
  appPassword: string
}

function collection() {
  return getDb().collection<EmailAccountDoc>(EMAIL_ACCOUNTS_COLLECTION)
}

function toObjectId(id: string) {
  return ObjectId.isValid(id) ? new ObjectId(id) : null
}

/** Creates the connection, or replaces the app password if this mailbox is already connected. */
export async function upsertGmailAccount(input: { userId: string; email: string; appPassword: string }) {
  const now = new Date()
  await collection().updateOne(
    { userId: input.userId, email: input.email.toLowerCase() },
    {
      $set: {
        appPassword: encryptSecret(input.appPassword, APP_PASSWORD_CONTEXT),
        authMethod: "app_password",
        status: "active",
        updatedAt: now,
      },
      $setOnInsert: { provider: "gmail", createdAt: now },
    },
    { upsert: true }
  )
}

/** Scoped by userId, so one user can never load another user's mailbox. */
export async function getEmailAccountCredentials(
  userId: string,
  accountId: string
): Promise<EmailAccountCredentials | null> {
  const _id = toObjectId(accountId)
  if (!_id) return null
  const doc = await collection().findOne({ _id, userId })
  if (!doc) return null

  const { plaintext, stale } = decryptSecretWithStatus(doc.appPassword, APP_PASSWORD_CONTEXT)
  if (stale) await reencryptAppPassword(doc._id, doc.appPassword, plaintext)
  return { id: doc._id.toHexString(), email: doc.email, status: doc.status, appPassword: plaintext }
}

/** Replaces a value encrypted with the previous key, unless it changed meanwhile. */
async function reencryptAppPassword(_id: ObjectId, current: string, plaintext: string) {
  await collection().updateOne(
    { _id, appPassword: current },
    { $set: { appPassword: encryptSecret(plaintext, APP_PASSWORD_CONTEXT) } }
  )
}

/**
 * Key rotation (Phase 14): re-encrypts every app password still under
 * `TOKEN_ENCRYPTION_KEY_PREVIOUS`. Run at server start while that variable is
 * set; once it reports `remaining: 0` everywhere, the old key can be removed.
 * Returns counts only.
 */
export async function reencryptStaleAppPasswords() {
  let reencrypted = 0
  let unreadable = 0
  for await (const doc of collection().find({}, { projection: { appPassword: 1 } })) {
    try {
      const { plaintext, stale } = decryptSecretWithStatus(doc.appPassword, APP_PASSWORD_CONTEXT)
      if (!stale) continue
      await reencryptAppPassword(doc._id, doc.appPassword, plaintext)
      reencrypted++
    } catch {
      unreadable++ // matches neither key: the user has to reconnect
    }
  }
  return { reencrypted, unreadable }
}

export async function setEmailAccountStatus(accountId: string, status: EmailAccountStatus) {
  const _id = toObjectId(accountId)
  if (!_id) return
  await collection().updateOne({ _id }, { $set: { status, updatedAt: new Date() } })
}

/** Cached per request: the layout and page can both call it for one DB query. */
export const listEmailAccounts = cache(async (userId: string): Promise<EmailAccountSummary[]> => {
  const docs = await collection()
    .find(
      { userId },
      { projection: { email: 1, status: 1, createdAt: 1, autoProcess: 1, lastAutoRun: 1 }, sort: { createdAt: 1 } }
    )
    .toArray()

  return docs.map((doc) => ({
    id: doc._id.toHexString(),
    email: doc.email,
    status: doc.status,
    connectedAt: doc.createdAt.toISOString(),
    autoProcess: doc.autoProcess ?? false,
    lastAutoRun: doc.lastAutoRun ? { ...doc.lastAutoRun, at: doc.lastAutoRun.at.toISOString() } : null,
  }))
})

// ---------------------------------------------------------------------------
// Automatic processing (Phase 13)

/** Turning it on clears the cursor, so the first run catches up on the last day's unclassified mail. */
export async function setAutoProcess(userId: string, accountId: string, enabled: boolean) {
  const _id = toObjectId(accountId)
  if (!_id) return false
  const result = await collection().updateOne(
    { _id, userId },
    enabled
      ? { $set: { autoProcess: true, updatedAt: new Date() }, $unset: { lastSeenUid: "", uidValidity: "", lastAutoRun: "" } }
      : { $set: { autoProcess: false, updatedAt: new Date() } }
  )
  return result.matchedCount === 1
}

/** Mailboxes to process on a scheduled run: switched on and working. */
export async function listAutoProcessAccounts(): Promise<{ id: string; userId: string }[]> {
  const docs = await collection()
    .find({ autoProcess: true, status: "active" }, { projection: { userId: 1 } })
    .toArray()
  return docs.map((doc) => ({ id: doc._id.toHexString(), userId: doc.userId }))
}

export async function getCursor(accountId: string) {
  const _id = toObjectId(accountId)
  if (!_id) return null
  const doc = await collection().findOne({ _id }, { projection: { lastSeenUid: 1, uidValidity: 1 } })
  return doc?.lastSeenUid !== undefined && doc.uidValidity ? { lastSeenUid: doc.lastSeenUid, uidValidity: doc.uidValidity } : null
}

export async function setCursor(accountId: string, cursor: { lastSeenUid: number; uidValidity: string }) {
  const _id = toObjectId(accountId)
  if (!_id) return
  await collection().updateOne({ _id }, { $set: { ...cursor, updatedAt: new Date() } })
}

export async function recordAutoRun(
  accountId: string,
  run: { classified: number; processed: number; error: string | null }
) {
  const _id = toObjectId(accountId)
  if (!_id) return
  await collection().updateOne({ _id }, { $set: { lastAutoRun: { ...run, at: new Date() } } })
}

/**
 * Takes the mailbox's processing lease if it's free (or expired). One scan or
 * automatic run per mailbox at a time, across every server instance. The
 * expiry means a crashed run can't hold the mailbox forever.
 */
export async function acquireProcessingLease(accountId: string, ms: number): Promise<boolean> {
  const _id = toObjectId(accountId)
  if (!_id) return false
  const now = new Date()
  const result = await collection().updateOne(
    { _id, $or: [{ processingUntil: null }, { processingUntil: { $exists: false } }, { processingUntil: { $lt: now } }] },
    { $set: { processingUntil: new Date(now.getTime() + ms) } }
  )
  return result.modifiedCount === 1
}

export async function releaseProcessingLease(accountId: string) {
  const _id = toObjectId(accountId)
  if (!_id) return
  await collection().updateOne({ _id }, { $set: { processingUntil: null } })
}
