import { ObjectId } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  collections: {} as Record<string, { countDocuments: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn>; deleteOne: ReturnType<typeof vi.fn> }>,
  acquire: vi.fn(),
  release: vi.fn(),
  withTransaction: vi.fn(),
  endSession: vi.fn(),
}))

vi.mock("@/lib/db/mongodb", () => ({
  getDb: () => ({ collection: (name: string) => mocks.collections[name] }),
  getMongoClient: () => ({
    startSession: () => ({ withTransaction: mocks.withTransaction, endSession: mocks.endSession }),
  }),
}))
vi.mock("@/lib/db/email-accounts", () => ({
  EMAIL_ACCOUNTS_COLLECTION: "emailAccounts",
  acquireProcessingLease: mocks.acquire,
  releaseProcessingLease: mocks.release,
}))

import { deleteMailboxAndHistory } from "./mailbox-data"

const ACCOUNT = "65b000000000000000000001"
const collection = (deleted = 0) => ({
  countDocuments: vi.fn().mockResolvedValue(1),
  deleteMany: vi.fn().mockResolvedValue({ deletedCount: deleted }),
  deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.collections = {
    emailAccounts: collection(),
    emailClassifications: collection(140),
    classificationCorrections: collection(3),
  }
  mocks.acquire.mockResolvedValue(true)
  mocks.withTransaction.mockImplementation(async (fn: () => Promise<void>) => fn())
})

describe("deleteMailboxAndHistory", () => {
  it("deletes the mailbox, its classifications and its corrections in one transaction", async () => {
    expect(await deleteMailboxAndHistory("u1", ACCOUNT)).toEqual({ status: "deleted", classifications: 140, corrections: 3 })

    const filter = { userId: "u1", emailAccountId: new ObjectId(ACCOUNT) }
    expect(mocks.collections.emailClassifications.deleteMany).toHaveBeenCalledWith(filter, expect.objectContaining({ session: expect.anything() }))
    expect(mocks.collections.classificationCorrections.deleteMany).toHaveBeenCalledWith(filter, expect.anything())
    expect(mocks.collections.emailAccounts.deleteOne).toHaveBeenCalledWith({ _id: new ObjectId(ACCOUNT), userId: "u1" }, expect.anything())
    expect(mocks.withTransaction).toHaveBeenCalledOnce()
    expect(mocks.endSession).toHaveBeenCalled()
  })

  it("refuses while a scan or automatic run holds the mailbox", async () => {
    mocks.acquire.mockResolvedValue(false)
    expect(await deleteMailboxAndHistory("u1", ACCOUNT)).toEqual({ status: "busy" })
    expect(mocks.withTransaction).not.toHaveBeenCalled()
  })

  it("does nothing for another user's mailbox or an invalid ID", async () => {
    mocks.collections.emailAccounts.countDocuments.mockResolvedValue(0)
    expect(await deleteMailboxAndHistory("u2", ACCOUNT)).toEqual({ status: "not_found" })
    expect(await deleteMailboxAndHistory("u1", "not-an-id")).toEqual({ status: "not_found" })
    expect(mocks.acquire).not.toHaveBeenCalled()
  })

  it("frees the mailbox again if the transaction fails", async () => {
    mocks.withTransaction.mockRejectedValue(new Error("TransientTransactionError"))
    await expect(deleteMailboxAndHistory("u1", ACCOUNT)).rejects.toThrow()
    expect(mocks.release).toHaveBeenCalledWith(ACCOUNT)
  })
})
