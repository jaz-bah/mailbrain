import { ensureIndexes } from "@/lib/db/indexes"
import { getEnv } from "@/lib/env"

// Node.js-only startup work, imported from instrumentation.ts.

// Fail fast on a misconfigured environment when the server starts, instead of
// on the first request that happens to need a variable.
try {
  getEnv()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}

// Not fatal: the app can serve pages while the database is unreachable, and
// the next restart retries.
ensureIndexes().catch((error: unknown) => {
  console.error("Failed to ensure MongoDB indexes:", error instanceof Error ? error.name : "unknown")
})

// Encryption key rotation (Phase 14): while the previous key is configured,
// move every stored app password to the current key. Counts only in the log.
if (getEnv().TOKEN_ENCRYPTION_KEY_PREVIOUS) {
  import("@/lib/db/email-accounts")
    .then(({ reencryptStaleAppPasswords }) => reencryptStaleAppPasswords())
    .then(({ reencrypted, unreadable }) => {
      console.log(`Key rotation: ${reencrypted} app password(s) re-encrypted, ${unreadable} unreadable with either key`)
    })
    .catch((error: unknown) => {
      console.error("Key rotation failed:", error instanceof Error ? error.name : "unknown")
    })
}

// Automatic new-email processing on a timer (Phase 13), for local and
// self-hosted servers. Serverless deployments use /api/cron/process-new-mail.
//
// The interval is read again before every wait (not cached like getEnv()), so
// changing AUTO_PROCESS_INTERVAL_MINUTES in .env applies from the next check
// when the dev server reloads its env. Unset or invalid: no checks, but the
// loop keeps looking once a minute in case it's set later.
function intervalMinutes(): number | null {
  const minutes = Number(process.env.AUTO_PROCESS_INTERVAL_MINUTES)
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : null
}

async function runScheduledPass() {
  try {
    const { runAutoProcessing } = await import("@/lib/pipeline/auto-process")
    const results = await runAutoProcessing()
    if (results === "already_running" || results.length === 0) return
    const classified = results.reduce((sum, r) => sum + r.classified, 0)
    const errors = results.filter((r) => r.status === "error").map((r) => r.error)
    console.log(`Automatic processing: ${results.length} mailbox(es), ${classified} classified${errors.length ? `, errors: ${errors.join(", ")}` : ""}`)
  } catch (error) {
    console.error("Automatic processing failed:", error instanceof Error ? error.name : "unknown")
  }
}

function scheduleNextPass() {
  const timer = setTimeout(async () => {
    if (intervalMinutes()) await runScheduledPass()
    scheduleNextPass()
  }, (intervalMinutes() ?? 1) * 60_000)
  // Don't keep the process alive just for this timer.
  timer.unref()
}

scheduleNextPass()
