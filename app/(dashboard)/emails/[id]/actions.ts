"use server"

import { refresh } from "next/cache"

import { AiError } from "@/lib/ai/errors"
import { idArg } from "@/lib/action-args"
import { requireSession } from "@/lib/auth/session"
import { formatRetryAfter, hitRateLimit, RECLASSIFY_LIMIT } from "@/lib/db/rate-limits"
import {
  CorrectionError,
  moveToCategory,
  reclassify,
  removeFromCategory,
  type CorrectionErrorCode,
  type CorrectionResult,
} from "@/lib/corrections/service"
import { GmailError, isCredentialError } from "@/lib/gmail/errors"

export type CorrectionActionResult =
  | ({ ok: true; changed?: boolean } & CorrectionResult)
  | { ok: false; message: string }

const MESSAGES: Record<CorrectionErrorCode, string> = {
  MATCH_NOT_FOUND: "This email has already been changed. Refresh the page to see where it is now.",
  CATEGORY_NOT_FOUND: "That category no longer exists.",
  SAME_CATEGORY: "The email is already in that category.",
  NO_CATEGORIES: "Turn on at least one category before reclassifying.",
  MESSAGE_GONE: "This email is no longer in Gmail, so it can't be reclassified.",
  AI_FAILED: "The AI couldn't give a clear answer. Nothing was changed; try again in a moment.",
}

function failure(error: unknown): CorrectionActionResult {
  if (error instanceof CorrectionError) return { ok: false, message: MESSAGES[error.code] }
  if (error instanceof GmailError) {
    return {
      ok: false,
      message: isCredentialError(error)
        ? "Gmail rejected the saved app password. Update it in Settings; nothing was changed."
        : "Couldn't update the Gmail label, so nothing was changed. Please try again.",
    }
  }
  if (error instanceof AiError) {
    console.error("Reclassify stopped by an AI error:", error.code, error.detail ?? "")
    return { ok: false, message: "The AI service isn't available right now. Nothing was changed." }
  }
  console.error("Correction failed:", error instanceof Error ? error.name : "unknown")
  return { ok: false, message: "Something went wrong. Please try again." }
}

async function run(ids: unknown[], fn: (userId: string, ids: string[]) => Promise<CorrectionActionResult>) {
  const { user } = await requireSession()
  const valid = ids.map(idArg)
  if (valid.some((id) => id === null)) return failure(new CorrectionError("MATCH_NOT_FOUND"))
  try {
    const result = await fn(user.id, valid as string[])
    refresh()
    return result
  } catch (error) {
    return failure(error)
  }
}

export async function moveEmailAction(classificationId: unknown, toCategoryId: unknown) {
  return run([classificationId, toCategoryId], async (userId, [id, categoryId]) => ({
    ok: true,
    ...(await moveToCategory(userId, id, categoryId)),
  }))
}

export async function removeFromCategoryAction(classificationId: unknown) {
  return run([classificationId], async (userId, [id]) => ({ ok: true, ...(await removeFromCategory(userId, id)) }))
}

export async function reclassifyEmailAction(classificationId: unknown) {
  return run([classificationId], async (userId, [id]) => {
    // Each reclassify is an AI call.
    const limit = await hitRateLimit(RECLASSIFY_LIMIT, userId)
    if (!limit.allowed) {
      return {
        ok: false,
        message: `You've reclassified a lot of emails in a short time. Try again in ${formatRetryAfter(limit.retryAfterMs)}.`,
      }
    }
    return { ok: true, ...(await reclassify(userId, id)) }
  })
}
