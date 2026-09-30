import "server-only"

import type { CategoryInput } from "@/lib/categories/schema"
import {
  deleteCategoryDoc,
  findCategoriesWithoutLabel,
  getCategory,
  insertCategory,
  setCategoryLabelId,
  updateCategoryFields,
  type CategoryDoc,
} from "@/lib/db/categories"
import { listEmailAccounts } from "@/lib/db/email-accounts"
import { withGmail, type GmailClient } from "@/lib/gmail/client"
import { GmailError, isCredentialError } from "@/lib/gmail/errors"
import { categoryLabelName, createLabel, deleteLabel, renameLabel } from "@/lib/gmail/labels"

/**
 * What happened to the category's Gmail label:
 * - `synced`: the label exists and matches the category
 * - `pending`: no working Gmail connection; created when Gmail is connected
 * - `failed`: Gmail call failed; retried on the next save or when Gmail reconnects
 */
export type LabelSync = "synced" | "pending" | "failed"

export class CategoryNotFoundError extends Error {
  constructor() {
    super("Category not found")
  }
}

/** Deleting the label was requested but couldn't be done, so nothing was deleted. */
export class LabelDeleteError extends Error {
  constructor(readonly reason: "not_connected" | "gmail_error") {
    super(`Could not delete the Gmail label (${reason})`)
  }
}

async function activeAccountId(userId: string): Promise<string | null> {
  const account = (await listEmailAccounts(userId)).find((a) => a.status === "active")
  return account?.id ?? null
}

/** Runs Gmail steps in one IMAP session. "Not connected" → `pending`, Gmail errors → `failed`. */
async function syncWithGmail(
  userId: string,
  steps: (gmail: GmailClient) => Promise<void>
): Promise<LabelSync> {
  const accountId = await activeAccountId(userId)
  if (!accountId) return "pending"
  try {
    await withGmail(userId, accountId, steps)
    return "synced"
  } catch (error) {
    if (!(error instanceof GmailError)) throw error
    console.error("Category label sync failed:", error.code)
    return isCredentialError(error) || error.code === "GMAIL_NOT_CONNECTED" ? "pending" : "failed"
  }
}

async function attachLabel(gmail: GmailClient, userId: string, category: CategoryDoc, name: string) {
  const label = await createLabel(gmail, categoryLabelName(name))
  await setCategoryLabelId(userId, category._id, label.id)
}

export async function createCategory(userId: string, input: CategoryInput) {
  const category = await insertCategory(userId, input)
  const label = await syncWithGmail(userId, (gmail) => attachLabel(gmail, userId, category, input.name))
  return { id: category._id.toHexString(), label }
}

export async function updateCategory(userId: string, id: string, input: CategoryInput) {
  const existing = await getCategory(userId, id)
  if (!existing) throw new CategoryNotFoundError()

  await updateCategoryFields(userId, id, input)

  const renamed = existing.name !== input.name
  if (existing.gmailLabelId && !renamed) return { label: "synced" as LabelSync }

  const label = await syncWithGmail(userId, async (gmail) => {
    if (!existing.gmailLabelId) return attachLabel(gmail, userId, existing, input.name)
    try {
      // Over IMAP a label's ID is its path, so a rename changes the ID.
      const renamedLabel = await renameLabel(gmail, existing.gmailLabelId, categoryLabelName(input.name))
      await setCategoryLabelId(userId, existing._id, renamedLabel.id)
    } catch (error) {
      // NOT_FOUND: the label was deleted in Gmail. CONFLICT: a label with the
      // new name already exists. Either way, point the category at the right label.
      if (error instanceof GmailError && (error.code === "NOT_FOUND" || error.code === "CONFLICT")) {
        return attachLabel(gmail, userId, existing, input.name)
      }
      throw error
    }
  })
  return { label }
}

export async function deleteCategory(
  userId: string,
  id: string,
  { deleteGmailLabel }: { deleteGmailLabel: boolean }
) {
  const existing = await getCategory(userId, id)
  if (!existing) throw new CategoryNotFoundError()

  // Delete the label first, so a Gmail failure leaves the category intact to retry.
  if (deleteGmailLabel && existing.gmailLabelId) {
    const labelId = existing.gmailLabelId
    const accountId = await activeAccountId(userId)
    if (!accountId) throw new LabelDeleteError("not_connected")
    try {
      await withGmail(userId, accountId, (gmail) => deleteLabel(gmail, labelId))
    } catch (error) {
      if (error instanceof GmailError) {
        throw new LabelDeleteError(isCredentialError(error) ? "not_connected" : "gmail_error")
      }
      throw error
    }
  }

  await deleteCategoryDoc(userId, existing._id)
}

/**
 * Creates Gmail labels for categories that don't have one yet, e.g. categories
 * made before Gmail was connected. Safe to call repeatedly.
 */
export async function syncMissingLabels(userId: string): Promise<LabelSync> {
  const missing = await findCategoriesWithoutLabel(userId)
  if (missing.length === 0) return "synced"
  return syncWithGmail(userId, async (gmail) => {
    for (const category of missing) {
      await attachLabel(gmail, userId, category, category.name)
    }
  })
}
