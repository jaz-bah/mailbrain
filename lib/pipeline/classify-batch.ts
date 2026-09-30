import "server-only"

import { classifyEmail } from "@/lib/ai/classify"
import { getAiClient } from "@/lib/ai/client"
import { listEnabledCategories, type ClassifierCategory } from "@/lib/db/categories"
import { findProcessedMessageIds, saveClassification } from "@/lib/db/classifications"
import { withGmail } from "@/lib/gmail/client"
import { applyPendingLabels, type LabelResult } from "@/lib/pipeline/apply-labels"
import { backfillMatchHeaders } from "@/lib/pipeline/backfill-headers"
import { DEFAULT_BATCH_SIZE, fetchEmailBatch, type EmailBatch } from "@/lib/pipeline/fetch"

/** Parallel AI calls per scan (ARCHITECTURE §6: capped concurrency). */
export const AI_CONCURRENCY = 4
/** Pages of already-processed mail to skip through before giving up on finding new mail. */
const MAX_PAGES_PER_SCAN = 20

export class ScanError extends Error {
  constructor(readonly code: "NO_CATEGORIES") {
    super("Create or enable a category before scanning")
    this.name = "ScanError"
  }
}

export type ScanBatchResult = {
  /** Emails sent to the AI in this batch. */
  processed: number
  classified: number
  noMatch: number
  failed: number
  /** Already processed earlier, so skipped. */
  skipped: number
  /** More mail in the scan window after this batch. */
  hasMore: boolean
  /** Gmail labels applied in this scan (including retries from earlier scans). */
  labelled: number
  /** Matches whose label couldn't be applied yet; retried next scan without the AI. */
  labelsPending: number
  /** The whole label step failed (e.g. Gmail unreachable); all matches are retried next scan. */
  labelStepFailed: boolean
}

/**
 * Runs `fn` over `items` with at most `limit` in flight. If `fn` throws, no
 * new items start; in-flight ones finish, then the first error is rethrown.
 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let next = 0
  let failure: { error: unknown } | undefined

  async function worker() {
    while (!failure && next < items.length) {
      const index = next++
      try {
        results[index] = await fn(items[index])
      } catch (error) {
        failure ??= { error }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (failure) throw failure.error
  return results
}

/**
 * Labelling never fails a scan: the classifications are already saved, and
 * unlabelled matches are retried next time.
 */
async function labelSafely(userId: string, accountId: string): Promise<LabelResult & { stepFailed: boolean }> {
  let result: LabelResult & { stepFailed: boolean }
  try {
    result = { ...(await applyPendingLabels(userId, accountId)), stepFailed: false }
  } catch (error) {
    console.error("Applying Gmail labels failed:", error instanceof Error ? error.name : "unknown")
    result = { labelled: 0, pending: 0, stepFailed: true }
  }
  // Housekeeping for matches saved before Phase 11; never fails the scan.
  await backfillMatchHeaders(userId, accountId).catch((error: unknown) => {
    console.error("Backfilling email headers failed:", error instanceof Error ? error.name : "unknown")
  })
  return result
}

/**
 * One manual scan (CLS-1): the next batch of unprocessed emails in the scan
 * window, newest first, is fetched, normalised, classified and saved.
 * Each result is saved as soon as it's ready, so a failure part-way keeps
 * the work done so far. Then Gmail labels are applied (Phase 9).
 */
export async function runScanBatch(
  userId: string,
  accountId: string,
  { batchSize = DEFAULT_BATCH_SIZE }: { batchSize?: number } = {}
): Promise<ScanBatchResult> {
  const categories = await listEnabledCategories(userId)
  if (categories.length === 0) throw new ScanError("NO_CATEGORIES")

  // One IMAP session for all Gmail work; it's closed before the AI calls start.
  // Pages are collected until a batch's worth of unprocessed mail is found, so
  // already-processed (or repeatedly failing) emails never stall the scan.
  const batch = await withGmail(userId, accountId, async (gmail) => {
    const collected: EmailBatch = { emails: [], failed: [], skipped: 0 }
    let pageToken: string | undefined
    for (let page = 1; page <= MAX_PAGES_PER_SCAN; page++) {
      const result = await fetchEmailBatch(gmail, {
        batchSize,
        pageToken,
        isKnown: (ids) => findProcessedMessageIds(userId, accountId, ids),
      })
      collected.emails.push(...result.emails)
      collected.failed.push(...result.failed)
      collected.skipped += result.skipped
      collected.nextPageToken = result.nextPageToken
      pageToken = result.nextPageToken
      if (!pageToken || collected.emails.length + collected.failed.length >= batchSize) break
    }
    return collected
  })

  return { ...(await classifyAndLabel(userId, accountId, categories, batch)), hasMore: Boolean(batch.nextPageToken) }
}

export type BatchOutcome = Omit<ScanBatchResult, "hasMore">

/**
 * The shared second half of a manual scan and an automatic run: classify each
 * email (AI_CONCURRENCY at a time), save each result as soon as it's ready,
 * then apply Gmail labels. A fatal AI error still labels what was saved, then
 * rethrows.
 */
export async function classifyAndLabel(
  userId: string,
  accountId: string,
  categories: ClassifierCategory[],
  batch: EmailBatch
): Promise<BatchOutcome> {
  // Emails whose source couldn't be parsed are recorded as failed (retried up to a limit).
  for (const ref of batch.failed) {
    await saveClassification(userId, accountId, ref, { status: "failed", errorCode: "PARSE_FAILED" })
  }

  const ai = getAiClient()
  let outcomes: Awaited<ReturnType<typeof classifyEmail>>["status"][]
  try {
    outcomes = await mapWithConcurrency(batch.emails, AI_CONCURRENCY, async (email) => {
      const result = await classifyEmail(ai, categories, email)
      await saveClassification(userId, accountId, email, result)
      return result.status
    })
  } catch (error) {
    // Label what was classified before the AI stopped, then report the AI error.
    await labelSafely(userId, accountId)
    throw error
  }

  // Classifications are saved first, so labelling can fail and retry without the AI.
  const labels = await labelSafely(userId, accountId)

  return {
    labelled: labels.labelled,
    labelsPending: labels.pending,
    labelStepFailed: labels.stepFailed,
    processed: batch.emails.length + batch.failed.length,
    classified: outcomes.filter((s) => s === "classified").length,
    noMatch: outcomes.filter((s) => s === "no_match").length,
    failed: outcomes.filter((s) => s === "failed").length + batch.failed.length,
    skipped: batch.skipped,
  }
}
