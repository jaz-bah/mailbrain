import { ObjectId } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findPendingLabels: vi.fn(),
  markLabelsApplied: vi.fn(),
  markLabelError: vi.fn(),
  listCategoryLabels: vi.fn(),
  setCategoryLabelId: vi.fn(),
  addLabelToMessages: vi.fn(),
  createLabel: vi.fn(),
}))

vi.mock("@/lib/db/classifications", () => ({
  findPendingLabels: mocks.findPendingLabels,
  markLabelsApplied: mocks.markLabelsApplied,
  markLabelError: mocks.markLabelError,
}))
vi.mock("@/lib/db/categories", () => ({
  listCategoryLabels: mocks.listCategoryLabels,
  setCategoryLabelId: mocks.setCategoryLabelId,
}))
vi.mock("@/lib/gmail/client", () => ({ withGmail: vi.fn(async (_u: string, _a: string, fn: (g: object) => unknown) => fn({})) }))
vi.mock("@/lib/gmail/labels", () => ({
  addLabelToMessages: mocks.addLabelToMessages,
  createLabel: mocks.createLabel,
  categoryLabelName: (name: string) => `AI/${name}`,
}))

import { GmailError } from "@/lib/gmail/errors"

import { applyPendingLabels } from "./apply-labels"

const INVOICES = new ObjectId("65a000000000000000000001")
const JOBS = new ObjectId("65a000000000000000000002")
const DELETED = new ObjectId("65a000000000000000000009")

function record(messageId: string, categoryId: ObjectId) {
  return { _id: new ObjectId(), gmailMessageId: messageId, categoryId }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listCategoryLabels.mockResolvedValue([
    { id: INVOICES.toHexString(), name: "Invoices", gmailLabelId: "AI/Invoices" },
    { id: JOBS.toHexString(), name: "Jobs", gmailLabelId: null },
  ])
  mocks.addLabelToMessages.mockImplementation(async (_g, ids: string[]) => ({ labelled: ids, missing: [] }))
  mocks.createLabel.mockImplementation(async (_g, name: string) => ({ id: name, name, type: "user" }))
})

describe("applyPendingLabels", () => {
  it("does nothing (and opens no Gmail session) when nothing is pending", async () => {
    mocks.findPendingLabels.mockResolvedValue([])
    expect(await applyPendingLabels("u1", "a1")).toEqual({ labelled: 0, pending: 0 })
    expect(mocks.addLabelToMessages).not.toHaveBeenCalled()
  })

  it("labels each category's emails in one call and marks them applied", async () => {
    const a = record("1", INVOICES)
    const b = record("2", INVOICES)
    mocks.findPendingLabels.mockResolvedValue([a, b])

    expect(await applyPendingLabels("u1", "a1")).toEqual({ labelled: 2, pending: 0 })
    expect(mocks.addLabelToMessages).toHaveBeenCalledWith({}, ["1", "2"], "AI/Invoices")
    expect(mocks.markLabelsApplied).toHaveBeenCalledWith("u1", [a._id, b._id])
  })

  it("creates a category's missing label first and stores its ID", async () => {
    mocks.findPendingLabels.mockResolvedValue([record("3", JOBS)])
    await applyPendingLabels("u1", "a1")
    expect(mocks.createLabel).toHaveBeenCalledWith({}, "AI/Jobs")
    expect(mocks.setCategoryLabelId).toHaveBeenCalledWith("u1", JOBS, "AI/Jobs")
    expect(mocks.addLabelToMessages).toHaveBeenCalledWith({}, ["3"], "AI/Jobs")
  })

  it("stops retrying emails that no longer exist or whose category was deleted", async () => {
    const gone = record("4", INVOICES)
    const orphan = record("5", DELETED)
    mocks.findPendingLabels.mockResolvedValue([gone, orphan])
    mocks.addLabelToMessages.mockResolvedValue({ labelled: [], missing: ["4"] })

    await applyPendingLabels("u1", "a1")
    expect(mocks.markLabelError).toHaveBeenCalledWith("u1", [orphan._id], "CATEGORY_DELETED")
    expect(mocks.markLabelError).toHaveBeenCalledWith("u1", [gone._id], "MESSAGE_NOT_FOUND")
  })

  it("leaves a failed label pending for the next scan without failing the others", async () => {
    mocks.findPendingLabels.mockResolvedValue([record("1", INVOICES), record("3", JOBS)])
    mocks.addLabelToMessages
      .mockRejectedValueOnce(new GmailError("GMAIL_ERROR", "store failed"))
      .mockImplementationOnce(async (_g, ids: string[]) => ({ labelled: ids, missing: [] }))
    vi.spyOn(console, "error").mockImplementation(() => {})

    expect(await applyPendingLabels("u1", "a1")).toEqual({ labelled: 1, pending: 1 })
  })

  it("rethrows a rejected app password", async () => {
    mocks.findPendingLabels.mockResolvedValue([record("1", INVOICES)])
    mocks.addLabelToMessages.mockRejectedValue(new GmailError("GMAIL_AUTH_FAILED", "rejected"))
    await expect(applyPendingLabels("u1", "a1")).rejects.toMatchObject({ code: "GMAIL_AUTH_FAILED" })
  })
})
