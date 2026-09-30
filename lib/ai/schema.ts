import { z } from "zod"

/** Max characters kept from the AI's reason (longer ones are cut, not rejected). */
export const MAX_REASON_CHARS = 300
const MAX_MATCHES = 20

/**
 * The AI output contract (ARCHITECTURE §6):
 * `{ matches: [{ categoryId, confidence, reason }] }`. An empty array means no match.
 */
export const classificationResponseSchema = z.object({
  matches: z
    .array(
      z.object({
        categoryId: z.string().min(1),
        confidence: z.number().min(0).max(1),
        reason: z
          .string()
          .trim()
          .min(1)
          .transform((reason) =>
            reason.length <= MAX_REASON_CHARS ? reason : `${reason.slice(0, MAX_REASON_CHARS - 1).trimEnd()}…`
          ),
      })
    )
    .max(MAX_MATCHES),
})

export type ClassificationResponse = z.infer<typeof classificationResponseSchema>
export type ClassificationMatch = ClassificationResponse["matches"][number]

/**
 * JSON Schema sent as `response_format` (strict structured output). `categoryId`
 * is limited to this request's category IDs, so a provider that enforces the
 * schema can't return anything else.
 */
export function classificationJsonSchema(categoryIds: string[]) {
  return {
    name: "email_classification",
    strict: true,
    schema: {
      type: "object",
      properties: {
        matches: {
          type: "array",
          description: "Categories the email belongs to. Empty when none fit.",
          items: {
            type: "object",
            properties: {
              categoryId: { type: "string", enum: categoryIds, description: "One of the given category IDs." },
              confidence: {
                type: "number",
                description: "How sure you are that the email belongs in this category, from 0 to 1.",
              },
              reason: { type: "string", description: "One short sentence explaining the match." },
            },
            required: ["categoryId", "confidence", "reason"],
            additionalProperties: false,
          },
        },
      },
      required: ["matches"],
      additionalProperties: false,
    },
  } as const
}
