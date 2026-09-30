import { ObjectId } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ bulkWrite: vi.fn(), distinct: vi.fn() }))
vi.mock("@/lib/db/mongodb", () => ({ getDb: () => ({ collection: () => db }) }))

import { MAX_FAILED_ATTEMPTS, findProcessedMessageIds, saveClassification } from "./classifications"

const ACCOUNT = "65b000000000000000000001"
const CATEGORY = "65a000000000000000000001"
const MESSAGE = { id: "1766", threadId: "1765" }

type Op = {
  updateOne?: { filter: Record<string, unknown>; update: Record<string, Record<string, unknown>>; upsert: boolean }
  deleteMany?: { filter: Record<string, unknown> }
}
const ops = (): Op[] => db.bulkWrite.mock.calls[0][0]

beforeEach(() => vi.clearAllMocks())

describe("saveClassification", () => {
  it("upserts one record per matched category and clears an earlier null-category record", async () => {
    await saveClassification("u1", ACCOUNT, MESSAGE, {
      status: "classified",
      model: "m",
      matches: [{ categoryId: CATEGORY, confidence: 0.9, reason: "Invoice." }],
    })
    const [upsert, cleanup] = ops()
    expect(upsert.updateOne).toMatchObject({
      filter: { userId: "u1", emailAccountId: new ObjectId(ACCOUNT), gmailMessageId: "1766", categoryId: new ObjectId(CATEGORY) },
      update: {
        $set: { status: "classified", confidence: 0.9, reason: "Invoice.", model: "m", gmailThreadId: "1765" },
        $setOnInsert: { labelApplied: false },
      },
      upsert: true,
    })
    expect(cleanup.deleteMany?.filter).toMatchObject({ gmailMessageId: "1766", categoryId: null })
  })

  it("stores no_match under a null category, without a reason", async () => {
    await saveClassification("u1", ACCOUNT, MESSAGE, { status: "no_match", model: "m", best: { categoryId: CATEGORY, confidence: 0.4 } })
    const [op] = ops()
    expect(op.updateOne).toMatchObject({
      filter: { categoryId: null },
      update: { $set: { status: "no_match", confidence: 0.4, reason: null }, $unset: { attempts: "" } },
    })
  })

  it("counts failed attempts", async () => {
    await saveClassification("u1", ACCOUNT, MESSAGE, { status: "failed", errorCode: "AI_INVALID_RESPONSE" })
    const [op] = ops()
    expect(op.updateOne).toMatchObject({
      filter: { categoryId: null },
      update: { $set: { status: "failed", errorCode: "AI_INVALID_RESPONSE" }, $inc: { attempts: 1 } },
    })
  })

  it("stores sender, subject and date on matches, but never the body", async () => {
    await saveClassification(
      "u1",
      ACCOUNT,
      { ...MESSAGE, from: "Acme <a@acme.test>", subject: "Invoice #12", date: "2026-09-29T09:59:00.000Z", body: "Private body" } as typeof MESSAGE,
      { status: "classified", model: "m", matches: [{ categoryId: CATEGORY, confidence: 0.9, reason: "Invoice." }] }
    )
    const [upsert] = ops()
    expect(upsert.updateOne?.update.$set).toMatchObject({
      from: "Acme <a@acme.test>",
      subject: "Invoice #12",
      emailDate: new Date("2026-09-29T09:59:00.000Z"),
    })
    expect(JSON.stringify(ops())).not.toContain("Private body")
  })

  it("never stores email content", async () => {
    await saveClassification("u1", ACCOUNT, { ...MESSAGE, subject: "Secret", body: "Private" } as typeof MESSAGE, {
      status: "no_match",
      model: "m",
    })
    expect(JSON.stringify(ops())).not.toMatch(/Secret|Private/)
  })
})

describe("findProcessedMessageIds", () => {
  it("treats failed emails as unprocessed until they reach the attempt limit", async () => {
    db.distinct.mockResolvedValue(["1"])
    expect(await findProcessedMessageIds("u1", ACCOUNT, ["1", "2"])).toEqual(new Set(["1"]))
    expect(db.distinct).toHaveBeenCalledWith("gmailMessageId", {
      userId: "u1",
      emailAccountId: new ObjectId(ACCOUNT),
      gmailMessageId: { $in: ["1", "2"] },
      $or: [{ status: { $ne: "failed" } }, { attempts: { $gte: MAX_FAILED_ATTEMPTS } }],
    })
  })

  it("skips the query for an empty list", async () => {
    expect(await findProcessedMessageIds("u1", ACCOUNT, [])).toEqual(new Set())
    expect(db.distinct).not.toHaveBeenCalled()
  })
})
