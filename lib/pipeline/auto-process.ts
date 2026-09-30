import "server-only"

import { AiError } from "@/lib/ai/errors"
import { listEnabledCategories } from "@/lib/db/categories"
import { findProcessedMessageIds } from "@/lib/db/classifications"
import {
  acquireProcessingLease,
  getCursor,
  listAutoProcessAccounts,
  recordAutoRun,
  releaseProcessingLease,
  setCursor,
} from "@/lib/db/email-accounts"
import { withGmail } from "@/lib/gmail/client"
import { GmailError } from "@/lib/gmail/errors"
import { classifyAndLabel } from "@/lib/pipeline/classify-batch"
import { fetchEmailsByUid } from "@/lib/pipeline/fetch"

// Automatic new-email processing (PRD CLS-8, ARCHITECTURE §8): polling. Each
// run looks for All Mail UIDs above the mailbox's cursor and sends them
// through the same pipeline as a manual scan.

/** New emails handled per mailbox per run; the rest wait for the next run. */
export const AUTO_BATCH_SIZE = 25
/** Same exclusions as the manual scan window (fetch.ts DEFAULT_SCAN_QUERY). */
const EXCLUDE_QUERY = "-in:sent -in:drafts -in:chats"
/** After a UIDVALIDITY change the old cursor is meaningless; re-check recent mail instead. */
const RESYNC_QUERY = `newer_than:2d ${EXCLUDE_QUERY}`
/**
 * First run after switching it on: catch up on the last day's mail rather than
 * starting at "now", so emails that arrive before the first run aren't skipped.
 * Already-classified emails are deduped, so this costs AI calls only for mail
 * no scan has handled yet.
 */
const CATCH_UP_QUERY = `newer_than:1d ${EXCLUDE_QUERY}`
/** Longer than any run, short enough that a crashed run frees the mailbox soon. */
export const PROCESSING_LEASE_MS = 10 * 60_000

export type AutoRunResult = {
  accountId: string
  status: "processed" | "initialized" | "resynced" | "busy" | "no_categories" | "error"
  processed: number
  classified: number
  /** More new mail is waiting for the next run. */
  remaining: boolean
  error?: string
}

/**
 * One automatic run for one mailbox. The cursor only moves forward after the
 * batch is classified and saved, so a run that stops (e.g. AI quota) picks up
 * the same emails next time; dedupe skips any it already finished.
 */
export async function processNewMail(userId: string, accountId: string): Promise<AutoRunResult> {
  const base = { accountId, processed: 0, classified: 0, remaining: false }
  // Shared with manual scans: never two runs on one mailbox at once.
  if (!(await acquireProcessingLease(accountId, PROCESSING_LEASE_MS))) return { ...base, status: "busy" }

  try {
    const [categories, cursor] = await Promise.all([listEnabledCategories(userId), getCursor(accountId)])

    const found = await withGmail(userId, accountId, async (gmail) => {
      const box = await gmail.allMailStatus()
      // Every UID below uidNext existed when we looked; later mail gets higher UIDs.
      const newest = box.uidNext - 1

      if (categories.length === 0) return { mode: "no_categories" as const, box, newest }

      // No cursor yet (first run) or a UIDVALIDITY change: a bounded catch-up
      // by date. Otherwise, everything above the cursor.
      const mode: "initialized" | "resynced" | "processed" = !cursor
        ? "initialized"
        : cursor.uidValidity !== box.uidValidity
          ? "resynced"
          : "processed"
      const uids = await gmail.inAllMail(async () =>
        mode === "processed"
          ? // `n:*` always includes the newest message, so keep only UIDs above the cursor.
            ((await gmail.imap.search({ uid: `${cursor!.lastSeenUid + 1}:*`, gmraw: EXCLUDE_QUERY }, { uid: true })) || []).filter(
              (uid) => uid > cursor!.lastSeenUid
            )
          : (await gmail.imap.search({ gmraw: mode === "initialized" ? CATCH_UP_QUERY : RESYNC_QUERY }, { uid: true })) || []
      )
      const ordered = [...uids].sort((a, b) => a - b)
      const take = ordered.slice(0, AUTO_BATCH_SIZE)
      const batch = await fetchEmailsByUid(gmail, take, {
        isKnown: (ids) => findProcessedMessageIds(userId, accountId, ids),
      })
      return { mode, box, newest, take, remaining: ordered.length > take.length, batch }
    })

    if (found.mode === "no_categories") {
      // Nothing to classify: move the cursor to now so a backlog doesn't build up.
      await setCursor(accountId, { lastSeenUid: found.newest, uidValidity: found.box.uidValidity })
      await recordAutoRun(accountId, { processed: 0, classified: 0, error: null })
      return { ...base, status: found.mode }
    }

    const outcome = await classifyAndLabel(userId, accountId, categories, found.batch)

    // Everything up to `newest` is done unless some matching UIDs are still waiting.
    const lastTaken = found.take.at(-1) ?? 0
    const lastSeenUid = found.remaining ? lastTaken : Math.max(found.newest, lastTaken)
    await setCursor(accountId, { lastSeenUid, uidValidity: found.box.uidValidity })
    await recordAutoRun(accountId, { processed: outcome.processed, classified: outcome.classified, error: null })

    return {
      ...base,
      status: found.mode,
      processed: outcome.processed,
      classified: outcome.classified,
      remaining: found.remaining,
    }
  } catch (error) {
    const code = error instanceof AiError || error instanceof GmailError ? error.code : "UNKNOWN"
    try {
      await recordAutoRun(accountId, { processed: 0, classified: 0, error: code })
    } catch {
      // The run's outcome is already known; failing to record it isn't worth more noise.
    }
    return { ...base, status: "error", error: code }
  } finally {
    await releaseProcessingLease(accountId)
  }
}

let running = false

/**
 * One scheduled pass over every mailbox with automatic processing on.
 * Mailboxes run one after another to stay within AI and Gmail limits. A pass
 * that starts while another is still going (in this process) is skipped.
 */
export async function runAutoProcessing(): Promise<AutoRunResult[] | "already_running"> {
  if (running) return "already_running"
  running = true
  try {
    const results: AutoRunResult[] = []
    for (const account of await listAutoProcessAccounts()) {
      results.push(await processNewMail(account.userId, account.id))
    }
    return results
  } finally {
    running = false
  }
}
