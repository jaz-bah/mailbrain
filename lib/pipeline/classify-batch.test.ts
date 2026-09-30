import { beforeEach, describe, expect, it, vi } from "vitest"

import type { NormalizedEmail } from "./normalize"

const mocks = vi.hoisted(() => ({
  listEnabledCategories: vi.fn(),
  findProcessedMessageIds: vi.fn(),
  saveClassification: vi.fn(),
  fetchEmailBatch: vi.fn(),
  classifyEmail: vi.fn(),
  applyPendingLabels: vi.fn(),
}))

vi.mock("@/lib/db/categories", () => ({ listEnabledCategories: mocks.listEnabledCategories }))
vi.mock("@/lib/db/classifications", () => ({
  findProcessedMessageIds: mocks.findProcessedMessageIds,
  saveClassification: mocks.saveClassification,
}))
vi.mock("@/lib/gmail/client", () => ({ withGmail: vi.fn(async (_u: string, _a: string, fn: (g: object) => unknown) => fn({})) }))
vi.mock("@/lib/pipeline/fetch", () => ({ DEFAULT_BATCH_SIZE: 25, fetchEmailBatch: mocks.fetchEmailBatch }))
vi.mock("@/lib/ai/client", () => ({ getAiClient: () => ({}) }))
vi.mock("@/lib/ai/classify", () => ({ classifyEmail: mocks.classifyEmail }))
vi.mock("@/lib/pipeline/apply-labels", () => ({ applyPendingLabels: mocks.applyPendingLabels }))
vi.mock("@/lib/pipeline/backfill-headers", () => ({ backfillMatchHeaders: vi.fn(async () => 0) }))

import { AiError } from "@/lib/ai/errors"

import { mapWithConcurrency, runScanBatch, ScanError } from "./classify-batch"

const email = (id: string) => ({ id, threadId: `t${id}` }) as NormalizedEmail
const CATEGORY = { id: "65a000000000000000000001", name: "Invoices", minConfidence: 0.8 }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listEnabledCategories.mockResolvedValue([CATEGORY])
  mocks.saveClassification.mockResolvedValue(undefined)
  mocks.applyPendingLabels.mockResolvedValue({ labelled: 1, pending: 0 })
})

describe("mapWithConcurrency", () => {
  it("keeps order and never exceeds the limit", async () => {
    let active = 0
    let peak = 0
    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5 * (8 - n)))
      active--
      return n * 10
    })
    expect(results).toEqual([10, 20, 30, 40, 50, 60, 70])
    expect(peak).toBe(3)
  })

  it("stops starting new work after an error and rethrows it", async () => {
    const started: number[] = []
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
        started.push(n)
        if (n === 1) throw new Error("fatal")
        await new Promise((r) => setTimeout(r, 10))
      })
    ).rejects.toThrow("fatal")
    expect(started).toEqual([1, 2])
  })
})

describe("runScanBatch", () => {
  it("refuses to scan without an enabled category", async () => {
    mocks.listEnabledCategories.mockResolvedValue([])
    await expect(runScanBatch("u1", "a1")).rejects.toBeInstanceOf(ScanError)
    expect(mocks.fetchEmailBatch).not.toHaveBeenCalled()
  })

  it("classifies and saves every email, counting outcomes", async () => {
    mocks.fetchEmailBatch.mockResolvedValue({
      emails: [email("1"), email("2"), email("3")],
      failed: [{ id: "4", threadId: "t4" }],
      skipped: 2,
      nextPageToken: "99",
    })
    mocks.classifyEmail
      .mockResolvedValueOnce({ status: "classified", matches: [], model: "m" })
      .mockResolvedValueOnce({ status: "no_match", model: "m" })
      .mockResolvedValueOnce({ status: "failed", errorCode: "AI_INVALID_RESPONSE" })

    const result = await runScanBatch("u1", "a1", { batchSize: 4 })

    expect(result).toEqual({
      processed: 4,
      classified: 1,
      noMatch: 1,
      failed: 2,
      skipped: 2,
      hasMore: true,
      labelled: 1,
      labelsPending: 0,
      labelStepFailed: false,
    })
    expect(mocks.saveClassification).toHaveBeenCalledTimes(4)
    expect(mocks.saveClassification).toHaveBeenCalledWith("u1", "a1", { id: "4", threadId: "t4" }, {
      status: "failed",
      errorCode: "PARSE_FAILED",
    })
  })

  it("uses the processed-ID lookup to skip known emails", async () => {
    mocks.fetchEmailBatch.mockImplementation(async (_gmail, { isKnown }) => {
      await isKnown(["1", "2"])
      return { emails: [], failed: [], skipped: 2 }
    })
    await runScanBatch("u1", "a1")
    expect(mocks.findProcessedMessageIds).toHaveBeenCalledWith("u1", "a1", ["1", "2"])
    expect(mocks.classifyEmail).not.toHaveBeenCalled()
  })

  it("keeps paging past already-processed mail until it has a full batch", async () => {
    mocks.fetchEmailBatch
      .mockResolvedValueOnce({ emails: [], failed: [], skipped: 2, nextPageToken: "p2" })
      .mockResolvedValueOnce({ emails: [email("3")], failed: [], skipped: 1, nextPageToken: "p3" })
      .mockResolvedValueOnce({ emails: [email("5")], failed: [], skipped: 1 })
    mocks.classifyEmail.mockResolvedValue({ status: "no_match", model: "m" })

    const result = await runScanBatch("u1", "a1", { batchSize: 2 })

    expect(mocks.fetchEmailBatch.mock.calls.map(([, o]) => o.pageToken)).toEqual([undefined, "p2", "p3"])
    expect(result).toMatchObject({ processed: 2, skipped: 4, hasMore: false })
  })

  it("stops on a fatal AI error but keeps the results already saved", async () => {
    mocks.fetchEmailBatch.mockResolvedValue({ emails: [email("1"), email("2"), email("3")], failed: [], skipped: 0 })
    mocks.classifyEmail
      .mockResolvedValueOnce({ status: "no_match", model: "m" })
      .mockRejectedValue(new AiError("AI_NO_CREDITS", "out of credits"))

    await expect(runScanBatch("u1", "a1")).rejects.toMatchObject({ code: "AI_NO_CREDITS" })
    expect(mocks.saveClassification).toHaveBeenCalledTimes(1)
    // What was classified before the stop still gets its Gmail label.
    expect(mocks.applyPendingLabels).toHaveBeenCalledOnce()
  })

  it("applies labels after saving, and a label failure never fails the scan", async () => {
    const order: string[] = []
    mocks.fetchEmailBatch.mockResolvedValue({ emails: [email("1")], failed: [], skipped: 0 })
    mocks.classifyEmail.mockResolvedValue({ status: "classified", matches: [], model: "m" })
    mocks.saveClassification.mockImplementation(async () => void order.push("save"))
    mocks.applyPendingLabels.mockImplementation(async () => {
      order.push("label")
      throw new Error("IMAP down")
    })
    vi.spyOn(console, "error").mockImplementation(() => {})

    const result = await runScanBatch("u1", "a1")
    expect(order).toEqual(["save", "label"])
    expect(result).toMatchObject({ classified: 1, labelled: 0, labelStepFailed: true })
  })

  it("retries pending labels even when there's no new mail", async () => {
    mocks.fetchEmailBatch.mockResolvedValue({ emails: [], failed: [], skipped: 5 })
    mocks.applyPendingLabels.mockResolvedValue({ labelled: 3, pending: 0 })
    const result = await runScanBatch("u1", "a1")
    expect(mocks.classifyEmail).not.toHaveBeenCalled()
    expect(result).toMatchObject({ processed: 0, labelled: 3 })
  })
})
