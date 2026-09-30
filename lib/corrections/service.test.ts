import { ObjectId } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getMatch: vi.fn(),
  listMatches: vi.fn(),
  commitCorrection: vi.fn(),
  listCategoryLabels: vi.fn(),
  listEnabledCategories: vi.fn(),
  setCategoryLabelId: vi.fn(),
  addLabel: vi.fn(),
  removeLabel: vi.fn(),
  createLabel: vi.fn(),
  getMessagesWithSource: vi.fn(),
  normalizeEmail: vi.fn(),
  classifyEmail: vi.fn(),
}))

vi.mock("@/lib/db/corrections", () => ({
  getMatch: mocks.getMatch,
  listMatches: mocks.listMatches,
  commitCorrection: mocks.commitCorrection,
}))
vi.mock("@/lib/db/categories", () => ({
  listCategoryLabels: mocks.listCategoryLabels,
  listEnabledCategories: mocks.listEnabledCategories,
  setCategoryLabelId: mocks.setCategoryLabelId,
}))
vi.mock("@/lib/gmail/client", () => ({ withGmail: vi.fn(async (_u: string, _a: string, fn: (g: object) => unknown) => fn({})) }))
vi.mock("@/lib/gmail/labels", () => ({
  addLabel: mocks.addLabel,
  removeLabel: mocks.removeLabel,
  createLabel: mocks.createLabel,
  categoryLabelName: (name: string) => `AI/${name}`,
}))
vi.mock("@/lib/gmail/messages", () => ({ getMessagesWithSource: mocks.getMessagesWithSource }))
vi.mock("@/lib/pipeline/normalize", () => ({ MAX_SOURCE_BYTES: 1024, normalizeEmail: mocks.normalizeEmail }))
vi.mock("@/lib/ai/client", () => ({ getAiClient: () => ({}) }))
vi.mock("@/lib/ai/classify", () => ({ classifyEmail: mocks.classifyEmail }))

import { GmailError } from "@/lib/gmail/errors"

import { moveToCategory, reclassify, removeFromCategory } from "./service"

const INVOICES = "65a000000000000000000001"
const JOBS = "65a000000000000000000002"
const PAUSED = "65a000000000000000000003"
const ACCOUNT = new ObjectId("65b000000000000000000001")

function matchDoc(categoryId: string, extra: Record<string, unknown> = {}) {
  return {
    _id: new ObjectId(),
    userId: "u1",
    emailAccountId: ACCOUNT,
    gmailMessageId: "1766",
    gmailThreadId: "1765",
    categoryId: new ObjectId(categoryId),
    status: "classified",
    from: "Acme <a@acme.test>",
    subject: "Invoice",
    emailDate: new Date("2026-09-29T09:59:00Z"),
    ...extra,
  }
}

beforeEach(() => {
  // Reset implementations too, so one test's rejected Gmail call can't leak into the next.
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.listCategoryLabels.mockResolvedValue([
    { id: INVOICES, name: "Invoices", gmailLabelId: "AI/Invoices" },
    { id: JOBS, name: "Jobs", gmailLabelId: null },
    { id: PAUSED, name: "Paused", gmailLabelId: "AI/Paused" },
  ])
  mocks.listEnabledCategories.mockResolvedValue([
    { id: INVOICES, name: "Invoices", description: "", instructions: "", minConfidence: 0.8, gmailLabelId: "AI/Invoices" },
    { id: JOBS, name: "Jobs", description: "", instructions: "", minConfidence: 0.8, gmailLabelId: null },
  ])
  mocks.createLabel.mockImplementation(async (_g, name: string) => ({ id: name, name, type: "user" }))
  mocks.commitCorrection.mockImplementation(
    async (change: { upsert: { categoryId: ObjectId }[] }) =>
      new Map(change.upsert.map((m) => [m.categoryId.toHexString(), new ObjectId()]))
  )
  mocks.listMatches.mockResolvedValue([])
})

describe("moveToCategory", () => {
  it("swaps Gmail labels, then retires the match and logs the move in one commit", async () => {
    const match = matchDoc(INVOICES)
    mocks.getMatch.mockResolvedValue(match)

    const result = await moveToCategory("u1", match._id.toHexString(), JOBS)

    expect(mocks.removeLabel).toHaveBeenCalledWith({}, "1766", ["AI/Invoices"])
    // Jobs had no label yet: it's created and stored first.
    expect(mocks.createLabel).toHaveBeenCalledWith({}, "AI/Jobs")
    expect(mocks.addLabel).toHaveBeenCalledWith({}, "1766", ["AI/Jobs"])
    const change = mocks.commitCorrection.mock.calls[0][0]
    expect(change.retire).toEqual({ ids: [match._id], status: "corrected" })
    expect(change.upsert).toEqual([
      { categoryId: new ObjectId(JOBS), source: "user", confidence: null, reason: null, model: null },
    ])
    expect(change.headers).toMatchObject({ subject: "Invoice" })
    expect(change.log).toEqual([
      { classificationId: match._id, kind: "move", fromCategoryId: new ObjectId(INVOICES), toCategoryId: new ObjectId(JOBS) },
    ])
    expect(result.categoryId).toBe(JOBS)
  })

  it("changes nothing in the database when Gmail fails", async () => {
    mocks.getMatch.mockResolvedValue(matchDoc(INVOICES))
    mocks.removeLabel.mockRejectedValue(new GmailError("GMAIL_ERROR", "store failed"))
    await expect(moveToCategory("u1", "x", JOBS)).rejects.toBeInstanceOf(GmailError)
    expect(mocks.commitCorrection).not.toHaveBeenCalled()
  })

  it("still corrects an email that's been deleted from Gmail", async () => {
    mocks.getMatch.mockResolvedValue(matchDoc(INVOICES))
    mocks.removeLabel.mockRejectedValue(new GmailError("NOT_FOUND", "gone"))
    await moveToCategory("u1", "x", JOBS)
    expect(mocks.commitCorrection).toHaveBeenCalledOnce()
  })

  it.each([
    [INVOICES, "SAME_CATEGORY"],
    ["65a0000000000000000000ff", "CATEGORY_NOT_FOUND"],
  ])("rejects moving to %s (%s)", async (target, code) => {
    mocks.getMatch.mockResolvedValue(matchDoc(INVOICES))
    await expect(moveToCategory("u1", "x", target)).rejects.toMatchObject({ code })
    expect(mocks.removeLabel).not.toHaveBeenCalled()
  })

  it("refuses a match that's already been corrected or isn't the user's", async () => {
    mocks.getMatch.mockResolvedValue(null)
    await expect(moveToCategory("u1", "x", JOBS)).rejects.toMatchObject({ code: "MATCH_NOT_FOUND" })
  })
})

describe("removeFromCategory", () => {
  it("removes the label, marks the match removed and points to the email's other match", async () => {
    const match = matchDoc(INVOICES)
    const other = matchDoc(JOBS)
    mocks.getMatch.mockResolvedValue(match)
    mocks.listMatches.mockResolvedValue([other])

    const result = await removeFromCategory("u1", match._id.toHexString())

    expect(mocks.removeLabel).toHaveBeenCalledWith({}, "1766", ["AI/Invoices"])
    expect(mocks.addLabel).not.toHaveBeenCalled()
    const change = mocks.commitCorrection.mock.calls[0][0]
    expect(change.retire).toEqual({ ids: [match._id], status: "removed" })
    expect(change.log[0]).toMatchObject({ kind: "remove", toCategoryId: null })
    expect(result).toEqual({ classificationId: other._id.toHexString(), categoryId: JOBS })
  })
})

describe("reclassify", () => {
  const email = { id: "1766", threadId: "1765", from: "Acme", subject: "Invoice", date: "2026-09-29T09:59:00.000Z" }

  beforeEach(() => {
    mocks.getMessagesWithSource.mockResolvedValue([{ id: "1766" }])
    mocks.normalizeEmail.mockResolvedValue(email)
  })

  it("sends the email to the AI again and applies the difference", async () => {
    const match = matchDoc(INVOICES)
    const paused = matchDoc(PAUSED)
    mocks.getMatch.mockResolvedValue(match)
    mocks.listMatches.mockResolvedValue([match, paused])
    mocks.classifyEmail.mockResolvedValue({
      status: "classified",
      model: "m",
      matches: [{ categoryId: JOBS, confidence: 0.92, reason: "Interview." }],
    })

    const result = await reclassify("u1", match._id.toHexString())

    expect(mocks.classifyEmail).toHaveBeenCalledOnce()
    // Invoices is dropped; the paused category wasn't asked about, so it stays.
    expect(mocks.removeLabel).toHaveBeenCalledWith({}, "1766", ["AI/Invoices"])
    expect(mocks.addLabel).toHaveBeenCalledWith({}, "1766", ["AI/Jobs"])
    const change = mocks.commitCorrection.mock.calls[0][0]
    expect(change.retire.ids).toEqual([match._id])
    expect(change.upsert).toEqual([
      { categoryId: new ObjectId(JOBS), source: "ai", confidence: 0.92, reason: "Interview.", model: "m" },
    ])
    expect(change.log.map((l: { kind: string }) => l.kind)).toEqual(["reclassify", "reclassify"])
    expect(result).toMatchObject({ categoryId: JOBS, changed: true })
  })

  it("reports no change when the AI agrees", async () => {
    const match = matchDoc(INVOICES)
    mocks.getMatch.mockResolvedValue(match)
    mocks.listMatches.mockResolvedValue([match])
    mocks.classifyEmail.mockResolvedValue({
      status: "classified",
      model: "m",
      matches: [{ categoryId: INVOICES, confidence: 0.95, reason: "Invoice." }],
    })

    const result = await reclassify("u1", match._id.toHexString())
    expect(result).toMatchObject({ categoryId: INVOICES, changed: false })
    expect(mocks.commitCorrection.mock.calls[0][0].log).toEqual([])
  })

  it("changes nothing when the AI fails", async () => {
    mocks.getMatch.mockResolvedValue(matchDoc(INVOICES))
    mocks.classifyEmail.mockResolvedValue({ status: "failed", errorCode: "AI_INVALID_RESPONSE" })
    await expect(reclassify("u1", "x")).rejects.toMatchObject({ code: "AI_FAILED" })
    expect(mocks.removeLabel).not.toHaveBeenCalled()
    expect(mocks.commitCorrection).not.toHaveBeenCalled()
  })

  it("refuses when the email is gone from Gmail", async () => {
    mocks.getMatch.mockResolvedValue(matchDoc(INVOICES))
    mocks.getMessagesWithSource.mockResolvedValue([])
    await expect(reclassify("u1", "x")).rejects.toMatchObject({ code: "MESSAGE_GONE" })
    expect(mocks.classifyEmail).not.toHaveBeenCalled()
  })
})
