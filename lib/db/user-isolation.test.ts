import { ObjectId } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Cross-user access (ROADMAP Phase 14 exit criterion). Every user-facing
 * database function is called by an "attacker" with another user's record IDs.
 * Each query it sends to MongoDB must be filtered by the attacker's own
 * userId, so it can only ever match the attacker's records.
 */

type Filter = Record<string, unknown>
const recorded = vi.hoisted(() => [] as { method: string; filter: Filter }[])

vi.mock("@/lib/db/mongodb", () => {
  const cursor = () => ({ toArray: async () => [], async *[Symbol.asyncIterator]() {} })
  const record = (method: string, filter: Filter) => recorded.push({ method, filter })
  const collection = {
    find: (filter: Filter) => (record("find", filter), cursor()),
    findOne: async (filter: Filter) => (record("findOne", filter), null),
    distinct: async (_field: string, filter: Filter) => (record("distinct", filter), []),
    countDocuments: async (filter: Filter) => (record("countDocuments", filter), 0),
    updateOne: async (filter: Filter) => (record("updateOne", filter), { matchedCount: 0, modifiedCount: 0 }),
    updateMany: async (filter: Filter) => (record("updateMany", filter), { matchedCount: 0, modifiedCount: 0 }),
    deleteOne: async (filter: Filter) => (record("deleteOne", filter), { deletedCount: 0 }),
    deleteMany: async (filter: Filter) => (record("deleteMany", filter), { deletedCount: 0 }),
    aggregate: (pipeline: { $match?: Filter }[]) => (record("aggregate", pipeline[0]?.$match ?? {}), cursor()),
    bulkWrite: async (ops: Record<string, { filter: Filter }>[]) => {
      for (const op of ops) for (const [method, body] of Object.entries(op)) record(`bulkWrite.${method}`, body.filter)
      return {}
    },
  }
  return { getDb: () => ({ collection: () => collection }), getMongoClient: () => ({}) }
})

import * as categories from "./categories"
import * as classifications from "./classifications"
import * as corrections from "./corrections"
import * as emailAccounts from "./email-accounts"
import { deleteMailboxAndHistory } from "./mailbox-data"

const ATTACKER = "attacker-user"
const VICTIM_ACCOUNT = "65b000000000000000000001"
const VICTIM_CATEGORY = "65a000000000000000000001"
const VICTIM_RECORD = "65c000000000000000000001"
const oid = (id: string) => new ObjectId(id)

const CALLS: Record<string, () => Promise<unknown>> = {
  getEmailAccountCredentials: () => emailAccounts.getEmailAccountCredentials(ATTACKER, VICTIM_ACCOUNT),
  listEmailAccounts: () => emailAccounts.listEmailAccounts(ATTACKER),
  setAutoProcess: () => emailAccounts.setAutoProcess(ATTACKER, VICTIM_ACCOUNT, true),
  deleteMailboxAndHistory: () => deleteMailboxAndHistory(ATTACKER, VICTIM_ACCOUNT),

  listCategories: () => categories.listCategories(ATTACKER),
  listEnabledCategories: () => categories.listEnabledCategories(ATTACKER),
  listCategoryLabels: () => categories.listCategoryLabels(ATTACKER),
  getCategory: () => categories.getCategory(ATTACKER, VICTIM_CATEGORY),
  updateCategoryFields: () =>
    categories.updateCategoryFields(ATTACKER, VICTIM_CATEGORY, { name: "X", description: "Y", instructions: "" }),
  setCategoryEnabled: () => categories.setCategoryEnabled(ATTACKER, VICTIM_CATEGORY, false),
  setCategoryLabelId: () => categories.setCategoryLabelId(ATTACKER, oid(VICTIM_CATEGORY), null),
  deleteCategoryDoc: () => categories.deleteCategoryDoc(ATTACKER, oid(VICTIM_CATEGORY)),
  findCategoriesWithoutLabel: () => categories.findCategoriesWithoutLabel(ATTACKER),

  findProcessedMessageIds: () => classifications.findProcessedMessageIds(ATTACKER, VICTIM_ACCOUNT, ["1"]),
  findPendingLabels: () => classifications.findPendingLabels(ATTACKER, VICTIM_ACCOUNT),
  markLabelsApplied: () => classifications.markLabelsApplied(ATTACKER, [oid(VICTIM_RECORD)]),
  markLabelError: () => classifications.markLabelError(ATTACKER, [oid(VICTIM_RECORD)], "MESSAGE_NOT_FOUND"),
  findMatchesWithoutHeaders: () => classifications.findMatchesWithoutHeaders(ATTACKER, VICTIM_ACCOUNT),
  setMatchHeaders: () => classifications.setMatchHeaders(ATTACKER, VICTIM_ACCOUNT, new Map([["1", null]])),
  saveClassification: () =>
    classifications.saveClassification(ATTACKER, VICTIM_ACCOUNT, { id: "1", threadId: "1" }, { status: "failed", errorCode: "AI_ERROR" }),
  getDashboardStats: () => classifications.getDashboardStats(ATTACKER),
  listCollection: () => classifications.listCollection(ATTACKER, VICTIM_CATEGORY, 1),
  getClassificationDetail: () => classifications.getClassificationDetail(ATTACKER, VICTIM_RECORD),

  getMatch: () => corrections.getMatch(ATTACKER, VICTIM_RECORD),
  listMatches: () => corrections.listMatches(ATTACKER, oid(VICTIM_ACCOUNT), "1"),
}

beforeEach(() => {
  recorded.length = 0
})

describe("user isolation: every query is scoped to the caller's userId", () => {
  it.each(Object.keys(CALLS))("%s", async (name) => {
    await CALLS[name]()
    expect(recorded.length, "made no query").toBeGreaterThan(0)
    for (const { method, filter } of recorded) {
      expect(filter.userId, `${method} filter ${JSON.stringify(filter)}`).toBe(ATTACKER)
    }
  })
})
