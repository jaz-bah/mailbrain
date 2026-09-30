import { timingSafeEqual } from "node:crypto"

import { NextResponse } from "next/server"

import { getEnv } from "@/lib/env"
import { runAutoProcessing } from "@/lib/pipeline/auto-process"

// Each mailbox is capped at AUTO_BATCH_SIZE emails per run, paced by the AI's
// per-minute limit, so a run for a few mailboxes fits comfortably.
export const maxDuration = 300

function authorized(header: string | null, secret: string) {
  const expected = Buffer.from(`Bearer ${secret}`)
  const given = Buffer.from(header ?? "")
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/**
 * Scheduled automatic processing (PRD CLS-8). Called by a cron scheduler
 * (e.g. Vercel Cron every 5 minutes) with the CRON_SECRET bearer token.
 * Returns counts only.
 */
export async function GET(request: Request) {
  const secret = getEnv().CRON_SECRET
  // Off unless configured, so it can't be triggered on a deployment that doesn't use it.
  if (!secret) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (!authorized(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const results = await runAutoProcessing()
  if (results === "already_running") return NextResponse.json({ ok: true, skipped: "already_running" })

  return NextResponse.json({
    ok: true,
    mailboxes: results.length,
    processed: results.reduce((sum, r) => sum + r.processed, 0),
    classified: results.reduce((sum, r) => sum + r.classified, 0),
    errors: results.filter((r) => r.status === "error").map((r) => r.error),
  })
}
