import "server-only"

import { AiError, type AiErrorCode } from "@/lib/ai/errors"
import type { AiClient } from "@/lib/ai/client"
import { buildClassificationPrompt } from "@/lib/ai/prompt"
import { classificationJsonSchema, classificationResponseSchema } from "@/lib/ai/schema"
import type { ClassifierCategory } from "@/lib/db/categories"
import type { NormalizedEmail } from "@/lib/pipeline/normalize"

export type CategoryMatch = { categoryId: string; confidence: number; reason: string }

export type EmailClassificationResult =
  | { status: "classified"; matches: CategoryMatch[]; model: string }
  /** No category reached its threshold. `best` is the strongest rejected candidate, if any. */
  | { status: "no_match"; model: string; best?: { categoryId: string; confidence: number } }
  | { status: "failed"; errorCode: AiErrorCode }

/**
 * Errors that would repeat for every email (bad key, no credits, unusable
 * model). They're thrown so the batch stops instead of failing each email.
 */
const FATAL_CODES = new Set<AiErrorCode>(["AI_AUTH_FAILED", "AI_NO_CREDITS", "AI_BAD_REQUEST", "AI_QUOTA_EXCEEDED"])

export function isFatalAiError(error: unknown): error is AiError {
  return error instanceof AiError && FATAL_CODES.has(error.code)
}

/**
 * Classifies one email against the user's enabled categories (ARCHITECTURE §6):
 * validated AI output only, unknown IDs discarded, duplicates merged, and each
 * category's `minConfidence` applied.
 */
export async function classifyEmail(
  ai: AiClient,
  categories: ClassifierCategory[],
  email: NormalizedEmail
): Promise<EmailClassificationResult> {
  if (categories.length === 0) throw new Error("classifyEmail needs at least one category")

  // Short aliases keep the prompt small and never expose database IDs.
  const byAlias = new Map(categories.map((category, i) => [`c${i + 1}`, category]))
  const aliases = [...byAlias.keys()]
  const prompt = buildClassificationPrompt(
    [...byAlias].map(([id, c]) => ({ id, name: c.name, description: c.description, instructions: c.instructions })),
    email
  )

  let response
  try {
    response = await ai.completeJson(prompt, {
      jsonSchema: classificationJsonSchema(aliases),
      schema: classificationResponseSchema,
    })
  } catch (error) {
    if (isFatalAiError(error)) throw error
    return { status: "failed", errorCode: error instanceof AiError ? error.code : "AI_ERROR" }
  }

  // Unknown IDs (possible when a provider doesn't enforce the schema) are dropped;
  // a repeated ID keeps its highest confidence.
  const best = new Map<string, CategoryMatch>()
  for (const match of response.data.matches) {
    const category = byAlias.get(match.categoryId)
    if (!category) continue
    const current = best.get(category.id)
    if (!current || match.confidence > current.confidence) {
      best.set(category.id, { categoryId: category.id, confidence: match.confidence, reason: match.reason })
    }
  }

  const minConfidence = new Map(categories.map((c) => [c.id, c.minConfidence]))
  const candidates = [...best.values()].sort((a, b) => b.confidence - a.confidence)
  const accepted = candidates.filter((m) => m.confidence >= (minConfidence.get(m.categoryId) ?? 1))

  if (accepted.length > 0) return { status: "classified", matches: accepted, model: response.model }
  const top = candidates[0]
  return {
    status: "no_match",
    model: response.model,
    ...(top && { best: { categoryId: top.categoryId, confidence: top.confidence } }),
  }
}
