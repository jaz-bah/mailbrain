import "server-only"

import { MongoServerError, ObjectId } from "mongodb"
import { cache } from "react"

import type { CategoryInput, CategoryView } from "@/lib/categories/schema"
import { getDb } from "@/lib/db/mongodb"

export const CATEGORIES_COLLECTION = "categories"

export const DEFAULT_MIN_CONFIDENCE = 0.8

export type CategoryDoc = {
  _id: ObjectId
  userId: string
  name: string
  /** Lowercased name. Unique per user, matching Gmail's case-insensitive label names. */
  nameKey: string
  description: string
  instructions: string
  gmailLabelId: string | null
  minConfidence: number
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

export class DuplicateCategoryNameError extends Error {
  constructor() {
    super("A category with this name already exists")
  }
}

function collection() {
  return getDb().collection<CategoryDoc>(CATEGORIES_COLLECTION)
}

function toObjectId(id: string) {
  return ObjectId.isValid(id) ? new ObjectId(id) : null
}

function isDuplicateKey(error: unknown) {
  return error instanceof MongoServerError && error.code === 11000
}

/** All of a user's categories, oldest first (which also sets their colours). Cached per request. */
export const listCategories = cache(async (userId: string): Promise<CategoryView[]> => {
  const docs = await collection().find({ userId }, { sort: { createdAt: 1, _id: 1 } }).toArray()
  return docs.map((doc, index) => ({
    id: doc._id.toHexString(),
    name: doc.name,
    description: doc.description,
    instructions: doc.instructions,
    gmailLabelId: doc.gmailLabelId,
    enabled: doc.enabled,
    colorIndex: index,
    minConfidence: doc.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
  }))
})

/** A category as the classifier needs it. */
export type ClassifierCategory = {
  id: string
  name: string
  description: string
  instructions: string
  minConfidence: number
  gmailLabelId: string | null
}

/** Enabled categories, oldest first (a stable order keeps the prompt stable). */
export async function listEnabledCategories(userId: string): Promise<ClassifierCategory[]> {
  const docs = await collection()
    .find({ userId, enabled: true }, { sort: { createdAt: 1, _id: 1 } })
    .toArray()
  return docs.map((doc) => ({
    id: doc._id.toHexString(),
    name: doc.name,
    description: doc.description,
    instructions: doc.instructions,
    minConfidence: doc.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
    gmailLabelId: doc.gmailLabelId,
  }))
}

/** Every category's Gmail label (disabled ones too: their earlier matches still get labelled). */
export async function listCategoryLabels(userId: string) {
  const docs = await collection()
    .find({ userId }, { projection: { name: 1, gmailLabelId: 1 } })
    .toArray()
  return docs.map((doc) => ({ id: doc._id.toHexString(), name: doc.name, gmailLabelId: doc.gmailLabelId }))
}

export async function getCategory(userId: string, id: string): Promise<CategoryDoc | null> {
  const _id = toObjectId(id)
  return _id ? collection().findOne({ _id, userId }) : null
}

export async function insertCategory(userId: string, input: CategoryInput): Promise<CategoryDoc> {
  const now = new Date()
  const doc: CategoryDoc = {
    _id: new ObjectId(),
    userId,
    name: input.name,
    nameKey: input.name.toLowerCase(),
    description: input.description,
    instructions: input.instructions,
    gmailLabelId: null,
    minConfidence: input.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }
  try {
    await collection().insertOne(doc)
  } catch (error) {
    if (isDuplicateKey(error)) throw new DuplicateCategoryNameError()
    throw error
  }
  return doc
}

export async function updateCategoryFields(userId: string, id: string, input: CategoryInput) {
  const _id = toObjectId(id)
  if (!_id) return
  try {
    await collection().updateOne(
      { _id, userId },
      {
        $set: {
          name: input.name,
          nameKey: input.name.toLowerCase(),
          description: input.description,
          instructions: input.instructions,
          ...(input.minConfidence !== undefined && { minConfidence: input.minConfidence }),
          updatedAt: new Date(),
        },
      }
    )
  } catch (error) {
    if (isDuplicateKey(error)) throw new DuplicateCategoryNameError()
    throw error
  }
}

export async function setCategoryEnabled(userId: string, id: string, enabled: boolean) {
  const _id = toObjectId(id)
  if (!_id) return false
  const result = await collection().updateOne(
    { _id, userId },
    { $set: { enabled, updatedAt: new Date() } }
  )
  return result.matchedCount === 1
}

export async function setCategoryLabelId(userId: string, id: ObjectId, gmailLabelId: string | null) {
  await collection().updateOne(
    { _id: id, userId },
    { $set: { gmailLabelId, updatedAt: new Date() } }
  )
}

export async function deleteCategoryDoc(userId: string, id: ObjectId) {
  await collection().deleteOne({ _id: id, userId })
}

export async function findCategoriesWithoutLabel(userId: string): Promise<CategoryDoc[]> {
  return collection().find({ userId, gmailLabelId: null }).toArray()
}
