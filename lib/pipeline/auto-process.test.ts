import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  acquireProcessingLease: vi.fn(),
  releaseProcessingLease: vi.fn(),
  getCursor: vi.fn(),
  setCursor: vi.fn(),
  recordAutoRun: vi.fn(),
  listAutoProcessAccounts: vi.fn(),
  listEnabledCategories: vi.fn(),
  findProcessedMessageIds: vi.fn(),
  fetchEmailsByUid: vi.fn(),
  classifyAndLabel: vi.fn(),
  search: vi.fn(),
  status: vi.fn(),
}))

vi.mock("@/lib/db/email-accounts", () => ({
  acquireProcessingLease: mocks.acquireProcessingLease,
  releaseProcessingLease: mocks.releaseProcessingLease,
  getCursor: mocks.getCursor,
  setCursor: mocks.setCursor,
  recordAutoRun: mocks.recordAutoRun,
  listAutoProcessAccounts: mocks.listAutoProcessAccounts,
}))
vi.mock("@/lib/db/categories", () => ({ listEnabledCategories: mocks.listEnabledCategories }))
vi.mock("@/lib/db/classifications", () => ({ findProcessedMessageIds: mocks.findProcessedMessageIds }))
vi.mock("@/lib/pipeline/fetch", () => ({ fetchEmailsByUid: mocks.fetchEmailsByUid }))
vi.mock("@/lib/pipeline/classify-batch", () => ({ classifyAndLabel: mocks.classifyAndLabel }))
vi.mock("@/lib/gmail/client", () => ({
  withGmail: vi.fn(async (_u: string, _a: string, fn: (g: object) => unknown) =>
    fn({
      allMailStatus: mocks.status,
      inAllMail: (inner: () => unknown) => inner(),
      imap: { search: mocks.search },
    })
  ),
}))

import { AiError } from "@/lib/ai/errors"

import { AUTO_BATCH_SIZE, processNewMail, runAutoProcessing } from "./auto-process"

const CATEGORY = { id: "c", name: "Invoices", minConfidence: 0.8 }
const BATCH = { emails: [], failed: [], skipped: 0 }
const OUTCOME = { processed: 3, classified: 2 }

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.acquireProcessingLease.mockResolvedValue(true)
  mocks.listEnabledCategories.mockResolvedValue([CATEGORY])
  mocks.getCursor.mockResolvedValue({ lastSeenUid: 100, uidValidity: "7" })
  mocks.status.mockResolvedValue({ uidValidity: "7", uidNext: 104 })
  mocks.fetchEmailsByUid.mockResolvedValue(BATCH)
  mocks.classifyAndLabel.mockResolvedValue(OUTCOME)
})

describe("processNewMail", () => {
  it("does nothing while a scan or another run holds the mailbox", async () => {
    mocks.acquireProcessingLease.mockResolvedValue(false)
    expect(await processNewMail("u1", "a1")).toMatchObject({ status: "busy" })
    expect(mocks.status).not.toHaveBeenCalled()
    expect(mocks.releaseProcessingLease).not.toHaveBeenCalled()
  })

  it("catches up on the last day's mail on the first run, so nothing between switching on and the first run is skipped", async () => {
    mocks.getCursor.mockResolvedValue(null)
    mocks.search.mockResolvedValue([102, 97])

    const result = await processNewMail("u1", "a1")

    expect(mocks.search).toHaveBeenCalledWith({ gmraw: "newer_than:1d -in:sent -in:drafts -in:chats" }, { uid: true })
    expect(mocks.fetchEmailsByUid).toHaveBeenCalledWith(expect.anything(), [97, 102], expect.anything())
    expect(mocks.classifyAndLabel).toHaveBeenCalled()
    expect(mocks.setCursor).toHaveBeenCalledWith("a1", { lastSeenUid: 103, uidValidity: "7" })
    expect(mocks.recordAutoRun).toHaveBeenCalledWith("a1", { processed: 3, classified: 2, error: null })
    expect(result).toMatchObject({ status: "initialized", processed: 3, classified: 2 })
  })

  it("processes UIDs above the cursor, oldest first, then advances the cursor", async () => {
    mocks.search.mockResolvedValue([103, 101, 102])

    const result = await processNewMail("u1", "a1")

    expect(mocks.search).toHaveBeenCalledWith({ uid: "101:*", gmraw: "-in:sent -in:drafts -in:chats" }, { uid: true })
    expect(mocks.fetchEmailsByUid).toHaveBeenCalledWith(expect.anything(), [101, 102, 103], expect.anything())
    expect(mocks.classifyAndLabel).toHaveBeenCalledWith("u1", "a1", [CATEGORY], BATCH)
    expect(mocks.setCursor).toHaveBeenCalledWith("a1", { lastSeenUid: 103, uidValidity: "7" })
    expect(result).toMatchObject({ status: "processed", processed: 3, classified: 2, remaining: false })
    expect(mocks.releaseProcessingLease).toHaveBeenCalledWith("a1")
  })

  it("dedupes against saved classifications, so overlapping with a manual scan never repeats work", async () => {
    mocks.search.mockResolvedValue([101])
    await processNewMail("u1", "a1")
    const { isKnown } = mocks.fetchEmailsByUid.mock.calls[0][2]
    await isKnown(["1766"])
    expect(mocks.findProcessedMessageIds).toHaveBeenCalledWith("u1", "a1", ["1766"])
  })

  it("ignores the newest message that IMAP's `n:*` returns when nothing is new", async () => {
    mocks.search.mockResolvedValue([99])
    mocks.status.mockResolvedValue({ uidValidity: "7", uidNext: 100 })
    await processNewMail("u1", "a1")
    expect(mocks.fetchEmailsByUid).toHaveBeenCalledWith(expect.anything(), [], expect.anything())
    // The cursor never moves backwards.
    expect(mocks.setCursor).toHaveBeenCalledWith("a1", { lastSeenUid: 99, uidValidity: "7" })
  })

  it("caps a run and leaves the rest for next time", async () => {
    const uids = Array.from({ length: 30 }, (_, i) => 101 + i)
    mocks.search.mockResolvedValue(uids)
    mocks.status.mockResolvedValue({ uidValidity: "7", uidNext: 131 })

    const result = await processNewMail("u1", "a1")

    expect(mocks.fetchEmailsByUid.mock.calls[0][1]).toHaveLength(AUTO_BATCH_SIZE)
    expect(mocks.setCursor).toHaveBeenCalledWith("a1", { lastSeenUid: 100 + AUTO_BATCH_SIZE, uidValidity: "7" })
    expect(result.remaining).toBe(true)
  })

  it("recovers from a UIDVALIDITY change with a bounded resync", async () => {
    mocks.status.mockResolvedValue({ uidValidity: "8", uidNext: 50 })
    mocks.search.mockResolvedValue([48, 49])

    const result = await processNewMail("u1", "a1")

    expect(mocks.search).toHaveBeenCalledWith({ gmraw: "newer_than:2d -in:sent -in:drafts -in:chats" }, { uid: true })
    expect(mocks.setCursor).toHaveBeenCalledWith("a1", { lastSeenUid: 49, uidValidity: "8" })
    expect(result.status).toBe("resynced")
  })

  it("keeps the cursor when classification stops, so no email is skipped", async () => {
    mocks.search.mockResolvedValue([101, 102])
    mocks.classifyAndLabel.mockRejectedValue(new AiError("AI_QUOTA_EXCEEDED", "quota"))

    const result = await processNewMail("u1", "a1")

    expect(result).toMatchObject({ status: "error", error: "AI_QUOTA_EXCEEDED" })
    expect(mocks.setCursor).not.toHaveBeenCalled()
    expect(mocks.recordAutoRun).toHaveBeenCalledWith("a1", { processed: 0, classified: 0, error: "AI_QUOTA_EXCEEDED" })
    expect(mocks.releaseProcessingLease).toHaveBeenCalledWith("a1")
  })

  it("moves the cursor to now when there are no categories, instead of building a backlog", async () => {
    mocks.listEnabledCategories.mockResolvedValue([])
    expect(await processNewMail("u1", "a1")).toMatchObject({ status: "no_categories" })
    expect(mocks.setCursor).toHaveBeenCalledWith("a1", { lastSeenUid: 103, uidValidity: "7" })
    expect(mocks.recordAutoRun).toHaveBeenCalledWith("a1", { processed: 0, classified: 0, error: null })
    expect(mocks.search).not.toHaveBeenCalled()
  })
})

describe("runAutoProcessing", () => {
  it("processes each opted-in mailbox in turn and skips a pass while one is running", async () => {
    mocks.listAutoProcessAccounts.mockResolvedValue([
      { id: "a1", userId: "u1" },
      { id: "a2", userId: "u2" },
    ])
    mocks.search.mockResolvedValue([])

    const first = runAutoProcessing()
    expect(await runAutoProcessing()).toBe("already_running")
    const results = await first

    expect(Array.isArray(results) && results.map((r) => r.accountId)).toEqual(["a1", "a2"])
  })
})
