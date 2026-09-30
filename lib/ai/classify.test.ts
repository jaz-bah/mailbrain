import { describe, expect, it, vi } from "vitest"

import type { ClassifierCategory } from "@/lib/db/categories"
import type { NormalizedEmail } from "@/lib/pipeline/normalize"

import { classifyEmail } from "./classify"
import { AiError } from "./errors"
import type { AiClient } from "./client"

const INVOICES = "65a000000000000000000001"
const JOBS = "65a000000000000000000002"

const CATEGORIES: ClassifierCategory[] = [
  { id: INVOICES, name: "Invoices", description: "Bills", instructions: "", minConfidence: 0.8, gmailLabelId: "AI/Invoices" },
  { id: JOBS, name: "Jobs", description: "Interviews", instructions: "", minConfidence: 0.6, gmailLabelId: "AI/Jobs" },
]

const EMAIL: NormalizedEmail = {
  id: "1766",
  threadId: "1765",
  from: "a@example.com",
  to: [],
  cc: [],
  subject: "s",
  date: null,
  body: "b",
  bodyTruncated: false,
  attachments: [],
}

type Match = { categoryId: string; confidence: number; reason: string }

function fakeAi(result: { matches: Match[] } | Error) {
  const completeJson = vi.fn(async () => {
    if (result instanceof Error) throw result
    return { data: result, model: "test/model", attempts: 1 }
  })
  return { ai: { model: "test/model", completeJson } as unknown as AiClient, completeJson }
}

describe("classifyEmail", () => {
  it("sends short aliases, never database IDs, and maps matches back", async () => {
    const { ai, completeJson } = fakeAi({ matches: [{ categoryId: "c1", confidence: 0.95, reason: "An invoice." }] })
    const result = await classifyEmail(ai, CATEGORIES, EMAIL)

    expect(result).toEqual({
      status: "classified",
      model: "test/model",
      matches: [{ categoryId: INVOICES, confidence: 0.95, reason: "An invoice." }],
    })
    const [messages, options] = completeJson.mock.calls[0] as unknown as [
      { content: string }[],
      { jsonSchema: { schema: { properties: { matches: { items: { properties: { categoryId: { enum: string[] } } } } } } } },
    ]
    expect(JSON.stringify(messages)).not.toContain(INVOICES)
    expect(options.jsonSchema.schema.properties.matches.items.properties.categoryId.enum).toEqual(["c1", "c2"])
  })

  it("applies each category's own minConfidence", async () => {
    const { ai } = fakeAi({
      matches: [
        { categoryId: "c1", confidence: 0.7, reason: "Maybe a bill." }, // below 0.8
        { categoryId: "c2", confidence: 0.7, reason: "Interview." }, // above 0.6
      ],
    })
    const result = await classifyEmail(ai, CATEGORIES, EMAIL)
    expect(result).toMatchObject({ status: "classified", matches: [{ categoryId: JOBS }] })
  })

  it("returns no_match (with the best rejected candidate) when nothing reaches its threshold", async () => {
    const { ai } = fakeAi({ matches: [{ categoryId: "c1", confidence: 0.5, reason: "Weak." }] })
    expect(await classifyEmail(ai, CATEGORIES, EMAIL)).toEqual({
      status: "no_match",
      model: "test/model",
      best: { categoryId: INVOICES, confidence: 0.5 },
    })
  })

  it("returns no_match for an empty match list", async () => {
    const { ai } = fakeAi({ matches: [] })
    expect(await classifyEmail(ai, CATEGORIES, EMAIL)).toEqual({ status: "no_match", model: "test/model" })
  })

  it("discards unknown IDs and merges duplicates, keeping the highest confidence", async () => {
    const { ai } = fakeAi({
      matches: [
        { categoryId: "c9", confidence: 1, reason: "Invented." },
        { categoryId: INVOICES, confidence: 1, reason: "Raw DB ID." },
        { categoryId: "c2", confidence: 0.65, reason: "First." },
        { categoryId: "c2", confidence: 0.9, reason: "Second." },
      ],
    })
    const result = await classifyEmail(ai, CATEGORIES, EMAIL)
    expect(result).toEqual({
      status: "classified",
      model: "test/model",
      matches: [{ categoryId: JOBS, confidence: 0.9, reason: "Second." }],
    })
  })

  it("records per-email AI failures as failed", async () => {
    const { ai } = fakeAi(new AiError("AI_INVALID_RESPONSE", "bad"))
    expect(await classifyEmail(ai, CATEGORIES, EMAIL)).toEqual({ status: "failed", errorCode: "AI_INVALID_RESPONSE" })
  })

  it.each(["AI_AUTH_FAILED", "AI_NO_CREDITS", "AI_BAD_REQUEST", "AI_QUOTA_EXCEEDED"] as const)(
    "throws %s, which would repeat for every email",
    async (code) => {
      const { ai } = fakeAi(new AiError(code, "x"))
      await expect(classifyEmail(ai, CATEGORIES, EMAIL)).rejects.toMatchObject({ code })
    }
  )
})
