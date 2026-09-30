"use server"

import { refresh } from "next/cache"

import { boolArg, idArg } from "@/lib/action-args"
import { requireSession } from "@/lib/auth/session"
import { parseCategoryForm, type CategoryFieldErrors } from "@/lib/categories/schema"
import {
  CategoryNotFoundError,
  createCategory,
  deleteCategory,
  LabelDeleteError,
  updateCategory,
  type LabelSync,
} from "@/lib/categories/service"
import { DuplicateCategoryNameError, setCategoryEnabled } from "@/lib/db/categories"

export type CategoryFormState =
  | { status: "idle" }
  | { status: "success"; label: LabelSync }
  | { status: "error"; message?: string; fieldErrors?: CategoryFieldErrors; values?: Record<string, string> }

function formValues(formData: FormData) {
  return {
    name: String(formData.get("name") ?? ""),
    description: String(formData.get("description") ?? ""),
    instructions: String(formData.get("instructions") ?? ""),
    minConfidence: String(formData.get("minConfidence") ?? ""),
  }
}

function fieldErrorsFrom(issues: { path: PropertyKey[]; message: string }[]): CategoryFieldErrors {
  const errors: CategoryFieldErrors = {}
  for (const issue of issues) {
    const field = issue.path[0] as keyof CategoryFieldErrors
    errors[field] ??= issue.message
  }
  return errors
}

/** Create when `id` is empty, otherwise update. Used with useActionState. */
export async function saveCategoryAction(
  _prev: CategoryFormState,
  formData: FormData
): Promise<CategoryFormState> {
  const { user } = await requireSession()
  const values = formValues(formData)
  const parsed = parseCategoryForm(formData)
  if (!parsed.success) {
    return { status: "error", fieldErrors: fieldErrorsFrom(parsed.error.issues), values }
  }

  const id = String(formData.get("id") ?? "")
  try {
    const { label } = id
      ? await updateCategory(user.id, id, parsed.data)
      : await createCategory(user.id, parsed.data)
    refresh()
    return { status: "success", label }
  } catch (error) {
    if (error instanceof DuplicateCategoryNameError) {
      return {
        status: "error",
        fieldErrors: { name: "You already have a category with this name" },
        values,
      }
    }
    if (error instanceof CategoryNotFoundError) {
      return { status: "error", message: "This category no longer exists.", values }
    }
    console.error("Saving category failed:", error instanceof Error ? error.name : "unknown")
    return { status: "error", message: "Couldn't save the category. Please try again.", values }
  }
}

export async function toggleCategoryAction(id: unknown, enabled: unknown) {
  const { user } = await requireSession()
  const categoryId = idArg(id)
  const on = boolArg(enabled)
  if (categoryId === null || on === null) return { ok: false }
  const updated = await setCategoryEnabled(user.id, categoryId, on)
  refresh()
  return { ok: updated }
}

export type DeleteCategoryResult =
  | { ok: true }
  | { ok: false; message: string }

export async function deleteCategoryAction(
  id: unknown,
  deleteGmailLabel: unknown
): Promise<DeleteCategoryResult> {
  const { user } = await requireSession()
  const categoryId = idArg(id)
  const withLabel = boolArg(deleteGmailLabel)
  if (categoryId === null || withLabel === null) {
    return { ok: false, message: "Couldn't delete the category. Please try again." }
  }
  try {
    await deleteCategory(user.id, categoryId, { deleteGmailLabel: withLabel })
    refresh()
    return { ok: true }
  } catch (error) {
    if (error instanceof CategoryNotFoundError) {
      refresh()
      return { ok: true }
    }
    if (error instanceof LabelDeleteError) {
      return {
        ok: false,
        message:
          error.reason === "not_connected"
            ? "Gmail isn't connected, so the label couldn't be deleted. Reconnect Gmail, or delete the category without its label."
            : "Gmail didn't delete the label. Nothing was deleted. Please try again.",
      }
    }
    console.error("Deleting category failed:", error instanceof Error ? error.name : "unknown")
    return { ok: false, message: "Couldn't delete the category. Please try again." }
  }
}
