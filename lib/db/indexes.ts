import "server-only"

import type { IndexDescription } from "mongodb"

import { CATEGORIES_COLLECTION } from "@/lib/db/categories"
import { CLASSIFICATIONS_COLLECTION } from "@/lib/db/classifications"
import { CORRECTIONS_COLLECTION } from "@/lib/db/corrections"
import { EMAIL_ACCOUNTS_COLLECTION } from "@/lib/db/email-accounts"
import { getDb } from "@/lib/db/mongodb"
import { RATE_LIMITS_COLLECTION } from "@/lib/db/rate-limits"

// BetterAuth's MongoDB adapter only creates indexes declared in explicit table
// config, not its schema's field-level unique/index flags, so its collections
// are indexed here too.
const INDEXES: Record<string, IndexDescription[]> = {
  user: [{ key: { email: 1 }, name: "email_unique", unique: true }],
  session: [
    { key: { token: 1 }, name: "token_unique", unique: true },
    { key: { userId: 1 }, name: "userId" },
  ],
  account: [
    { key: { userId: 1 }, name: "userId" },
    { key: { providerId: 1, accountId: 1 }, name: "providerId_accountId" },
  ],
  verification: [{ key: { identifier: 1 }, name: "identifier" }],
  [EMAIL_ACCOUNTS_COLLECTION]: [
    { key: { userId: 1, email: 1 }, name: "userId_email_unique", unique: true },
  ],
  [CATEGORIES_COLLECTION]: [
    { key: { userId: 1, nameKey: 1 }, name: "userId_nameKey_unique", unique: true },
    { key: { userId: 1, enabled: 1 }, name: "userId_enabled" },
  ],
  [CLASSIFICATIONS_COLLECTION]: [
    // Idempotency: one record per email per category (null = no_match/failed).
    {
      key: { emailAccountId: 1, gmailMessageId: 1, categoryId: 1 },
      name: "emailAccountId_gmailMessageId_categoryId_unique",
      unique: true,
    },
    { key: { userId: 1, categoryId: 1, classifiedAt: -1 }, name: "userId_categoryId_classifiedAt" },
    { key: { gmailThreadId: 1 }, name: "gmailThreadId" },
    // Phase 11: collection pages, newest email first.
    { key: { userId: 1, categoryId: 1, emailDate: -1, classifiedAt: -1 }, name: "userId_categoryId_emailDate" },
    // Phase 9: matches still waiting for their Gmail label.
    {
      key: { emailAccountId: 1, classifiedAt: 1 },
      name: "pending_labels",
      partialFilterExpression: { status: "classified", labelApplied: false },
    },
  ],
  [CORRECTIONS_COLLECTION]: [
    // Correction history and evaluation (ARCHITECTURE §4).
    { key: { userId: 1, createdAt: -1 }, name: "userId_createdAt" },
    // Phase 14: disconnect deletes a mailbox's corrections.
    { key: { emailAccountId: 1 }, name: "emailAccountId" },
  ],
  // Phase 14: expired rate-limit windows are removed by MongoDB.
  [RATE_LIMITS_COLLECTION]: [{ key: { expiresAt: 1 }, name: "expiresAt_ttl", expireAfterSeconds: 0 }],
}

/** Idempotent: createIndexes is a no-op for indexes that already exist. */
export async function ensureIndexes() {
  const db = getDb()
  await Promise.all(
    Object.entries(INDEXES).map(([name, indexes]) => db.collection(name).createIndexes(indexes))
  )
}
