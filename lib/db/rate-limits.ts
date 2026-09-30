import "server-only"

import { getDb } from "@/lib/db/mongodb"

export const RATE_LIMITS_COLLECTION = "rateLimits"

/** One counter per key and time window. A TTL index removes it once the window ends. */
type RateLimitDoc = { _id: string; count: number; expiresAt: Date }

export type RateLimitRule = { name: string; limit: number; windowMs: number }

/** Connect makes a live Gmail login with the submitted password, so keep it slow. */
export const CONNECT_GMAIL_LIMIT: RateLimitRule = { name: "connectGmail", limit: 5, windowMs: 15 * 60_000 }
/** Each reclassify is one AI call. */
export const RECLASSIFY_LIMIT: RateLimitRule = { name: "reclassify", limit: 20, windowMs: 10 * 60_000 }

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterMs: number }

/**
 * Counts one attempt for `subject` (a user ID) and says whether it's within the
 * rule. Fixed windows in MongoDB, so the limit holds across server instances.
 */
export async function hitRateLimit(rule: RateLimitRule, subject: string, now = new Date()): Promise<RateLimitResult> {
  const window = Math.floor(now.getTime() / rule.windowMs)
  const expiresAt = new Date((window + 1) * rule.windowMs)
  const doc = await getDb()
    .collection<RateLimitDoc>(RATE_LIMITS_COLLECTION)
    .findOneAndUpdate(
      { _id: `${rule.name}:${subject}:${window}` },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
      { upsert: true, returnDocument: "after" }
    )
  if ((doc?.count ?? 1) <= rule.limit) return { allowed: true }
  return { allowed: false, retryAfterMs: expiresAt.getTime() - now.getTime() }
}

/** "3 minutes", for messages. Always at least one minute. */
export function formatRetryAfter(ms: number) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  return `${minutes} minute${minutes === 1 ? "" : "s"}`
}
