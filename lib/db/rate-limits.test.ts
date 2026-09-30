import { beforeEach, describe, expect, it, vi } from "vitest"

const counters = vi.hoisted(() => new Map<string, { count: number; expiresAt: Date }>())
const findOneAndUpdate = vi.hoisted(() =>
  vi.fn(async (filter: { _id: string }, update: { $setOnInsert: { expiresAt: Date } }) => {
    const doc = counters.get(filter._id) ?? { count: 0, expiresAt: update.$setOnInsert.expiresAt }
    doc.count++
    counters.set(filter._id, doc)
    return { _id: filter._id, ...doc }
  })
)
vi.mock("@/lib/db/mongodb", () => ({ getDb: () => ({ collection: () => ({ findOneAndUpdate }) }) }))

import { formatRetryAfter, hitRateLimit } from "./rate-limits"

const RULE = { name: "test", limit: 3, windowMs: 60_000 }
const at = (ms: number) => new Date(1_800_000_000_000 + ms)

beforeEach(() => {
  counters.clear()
  vi.clearAllMocks()
})

describe("hitRateLimit", () => {
  it("allows up to the limit, then blocks until the window ends", async () => {
    for (let i = 0; i < 3; i++) expect(await hitRateLimit(RULE, "u1", at(1_000))).toEqual({ allowed: true })
    expect(await hitRateLimit(RULE, "u1", at(1_000))).toEqual({ allowed: false, retryAfterMs: 59_000 })
    // A new window starts fresh.
    expect(await hitRateLimit(RULE, "u1", at(61_000))).toEqual({ allowed: true })
  })

  it("counts each user separately", async () => {
    for (let i = 0; i < 4; i++) await hitRateLimit(RULE, "u1", at(0))
    expect(await hitRateLimit(RULE, "u2", at(0))).toEqual({ allowed: true })
  })

  it("stores an expiry at the end of the window for the TTL index", async () => {
    await hitRateLimit(RULE, "u1", at(1_000))
    const [, update, options] = findOneAndUpdate.mock.calls[0] as unknown as [unknown, { $setOnInsert: { expiresAt: Date } }, unknown]
    expect(update.$setOnInsert.expiresAt).toEqual(at(60_000))
    expect(options).toMatchObject({ upsert: true, returnDocument: "after" })
  })
})

describe("formatRetryAfter", () => {
  it("rounds up to whole minutes", () => {
    expect(formatRetryAfter(1)).toBe("1 minute")
    expect(formatRetryAfter(59_000)).toBe("1 minute")
    expect(formatRetryAfter(14 * 60_000 + 1)).toBe("15 minutes")
  })
})
