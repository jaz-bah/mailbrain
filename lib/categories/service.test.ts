import { ObjectId } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { CategoryDoc } from "@/lib/db/categories"
import { GmailError } from "@/lib/gmail/errors"

vi.mock("@/lib/db/categories", () => ({
  insertCategory: vi.fn(),
  getCategory: vi.fn(),
  updateCategoryFields: vi.fn(),
  setCategoryLabelId: vi.fn(),
  deleteCategoryDoc: vi.fn(),
  findCategoriesWithoutLabel: vi.fn(),
}))
vi.mock("@/lib/db/email-accounts", () => ({ listEmailAccounts: vi.fn() }))
vi.mock("@/lib/gmail/client", () => ({ withGmail: vi.fn() }))
vi.mock("@/lib/gmail/labels", async (importOriginal) => ({
  categoryLabelName: (await importOriginal<typeof import("@/lib/gmail/labels")>()).categoryLabelName,
  createLabel: vi.fn(),
  renameLabel: vi.fn(),
  deleteLabel: vi.fn(),
}))

const db = await import("@/lib/db/categories")
const accounts = await import("@/lib/db/email-accounts")
const client = await import("@/lib/gmail/client")
const labels = await import("@/lib/gmail/labels")
const {
  createCategory,
  deleteCategory,
  LabelDeleteError,
  syncMissingLabels,
  updateCategory,
} = await import("./service")

const USER = "user-1"
const gmail = { accountId: "acc-1" }
const input = { name: "Invoices", description: "Bills.", instructions: "" }

function category(overrides: Partial<CategoryDoc> = {}): CategoryDoc {
  return {
    _id: new ObjectId(),
    userId: USER,
    name: "Invoices",
    nameKey: "invoices",
    description: "Bills.",
    instructions: "",
    gmailLabelId: null,
    minConfidence: 0.8,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function gmailConnected(connected = true) {
  vi.mocked(accounts.listEmailAccounts).mockResolvedValue(
    connected ? [{ id: "acc-1", email: "a@b.com", status: "active", connectedAt: "", autoProcess: false, lastAutoRun: null }] : []
  )
  vi.mocked(client.withGmail).mockImplementation(async (_user, _account, fn) => fn(gmail as never))
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(labels.createLabel).mockResolvedValue({ id: "Label_1", name: "AI/Invoices", type: "user" })
})

describe("createCategory", () => {
  it("saves the category and marks the label pending when Gmail isn't connected", async () => {
    gmailConnected(false)
    vi.mocked(db.insertCategory).mockResolvedValue(category())

    const result = await createCategory(USER, input)

    expect(result.label).toBe("pending")
    expect(labels.createLabel).not.toHaveBeenCalled()
  })

  it("creates the AI/<name> label and stores its ID when Gmail is connected", async () => {
    gmailConnected()
    const doc = category()
    vi.mocked(db.insertCategory).mockResolvedValue(doc)

    const result = await createCategory(USER, input)

    expect(result.label).toBe("synced")
    expect(labels.createLabel).toHaveBeenCalledWith(gmail, "AI/Invoices")
    expect(db.setCategoryLabelId).toHaveBeenCalledWith(USER, doc._id, "Label_1")
  })

  it("keeps the category and reports failed when Gmail errors", async () => {
    gmailConnected()
    vi.mocked(db.insertCategory).mockResolvedValue(category())
    vi.mocked(labels.createLabel).mockRejectedValue(new GmailError("RATE_LIMITED", "slow down"))

    const result = await createCategory(USER, input)

    expect(result.label).toBe("failed")
    expect(db.deleteCategoryDoc).not.toHaveBeenCalled()
  })
})

describe("updateCategory", () => {
  it("doesn't call Gmail when the name is unchanged and a label exists", async () => {
    gmailConnected()
    vi.mocked(db.getCategory).mockResolvedValue(category({ gmailLabelId: "Label_1" }))

    const result = await updateCategory(USER, "id", { ...input, description: "New" })

    expect(result.label).toBe("synced")
    expect(client.withGmail).not.toHaveBeenCalled()
  })

  it("renames the Gmail label and stores its new path as the label ID", async () => {
    gmailConnected()
    const doc = category({ gmailLabelId: "AI/Invoices" })
    vi.mocked(db.getCategory).mockResolvedValue(doc)
    vi.mocked(labels.renameLabel).mockResolvedValue({ id: "AI/Bills", name: "AI/Bills", type: "user" })

    const result = await updateCategory(USER, "id", { ...input, name: "Bills" })

    expect(result.label).toBe("synced")
    expect(labels.renameLabel).toHaveBeenCalledWith(gmail, "AI/Invoices", "AI/Bills")
    expect(db.setCategoryLabelId).toHaveBeenCalledWith(USER, doc._id, "AI/Bills")
  })

  it("reports pending, not failed, when the app password was rejected", async () => {
    vi.mocked(accounts.listEmailAccounts).mockResolvedValue([
      { id: "acc-1", email: "a@b.com", status: "active", connectedAt: "", autoProcess: false, lastAutoRun: null },
    ])
    vi.mocked(client.withGmail).mockRejectedValue(new GmailError("GMAIL_AUTH_FAILED", "rejected"))
    vi.mocked(db.getCategory).mockResolvedValue(category())

    const result = await updateCategory(USER, "id", input)

    expect(result.label).toBe("pending")
  })

  it("re-attaches a label when the old one was deleted in Gmail", async () => {
    gmailConnected()
    const doc = category({ gmailLabelId: "Label_old" })
    vi.mocked(db.getCategory).mockResolvedValue(doc)
    vi.mocked(labels.renameLabel).mockRejectedValue(new GmailError("NOT_FOUND", "gone"))

    const result = await updateCategory(USER, "id", { ...input, name: "Bills" })

    expect(result.label).toBe("synced")
    expect(labels.createLabel).toHaveBeenCalledWith(gmail, "AI/Bills")
    expect(db.setCategoryLabelId).toHaveBeenCalledWith(USER, doc._id, "Label_1")
  })
})

describe("deleteCategory", () => {
  it("keeps the Gmail label unless asked", async () => {
    const doc = category({ gmailLabelId: "Label_1" })
    vi.mocked(db.getCategory).mockResolvedValue(doc)

    await deleteCategory(USER, "id", { deleteGmailLabel: false })

    expect(labels.deleteLabel).not.toHaveBeenCalled()
    expect(db.deleteCategoryDoc).toHaveBeenCalledWith(USER, doc._id)
  })

  it("deletes the Gmail label first when asked", async () => {
    gmailConnected()
    const doc = category({ gmailLabelId: "Label_1" })
    vi.mocked(db.getCategory).mockResolvedValue(doc)

    await deleteCategory(USER, "id", { deleteGmailLabel: true })

    expect(labels.deleteLabel).toHaveBeenCalledWith(gmail, "Label_1")
    expect(db.deleteCategoryDoc).toHaveBeenCalledWith(USER, doc._id)
  })

  it("deletes nothing if the Gmail label can't be deleted", async () => {
    gmailConnected()
    vi.mocked(db.getCategory).mockResolvedValue(category({ gmailLabelId: "Label_1" }))
    vi.mocked(labels.deleteLabel).mockRejectedValue(new GmailError("GMAIL_ERROR", "boom"))

    await expect(deleteCategory(USER, "id", { deleteGmailLabel: true })).rejects.toBeInstanceOf(
      LabelDeleteError
    )
    expect(db.deleteCategoryDoc).not.toHaveBeenCalled()
  })

  it("refuses to delete the label when Gmail isn't connected", async () => {
    gmailConnected(false)
    vi.mocked(db.getCategory).mockResolvedValue(category({ gmailLabelId: "Label_1" }))

    const error = await deleteCategory(USER, "id", { deleteGmailLabel: true }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LabelDeleteError)
    expect((error as InstanceType<typeof LabelDeleteError>).reason).toBe("not_connected")
    expect(db.deleteCategoryDoc).not.toHaveBeenCalled()
  })
})

describe("syncMissingLabels", () => {
  it("creates labels for categories made before Gmail was connected", async () => {
    gmailConnected()
    const a = category({ name: "Invoices" })
    const b = category({ name: "Travel" })
    vi.mocked(db.findCategoriesWithoutLabel).mockResolvedValue([a, b])

    expect(await syncMissingLabels(USER)).toBe("synced")
    expect(labels.createLabel).toHaveBeenCalledWith(gmail, "AI/Invoices")
    expect(labels.createLabel).toHaveBeenCalledWith(gmail, "AI/Travel")
    expect(db.setCategoryLabelId).toHaveBeenCalledTimes(2)
  })
})
