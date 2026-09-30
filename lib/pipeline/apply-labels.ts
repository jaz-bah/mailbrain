import "server-only"

import { ObjectId } from "mongodb"

import { listCategoryLabels, setCategoryLabelId } from "@/lib/db/categories"
import { findPendingLabels, markLabelError, markLabelsApplied, type PendingLabel } from "@/lib/db/classifications"
import { withGmail } from "@/lib/gmail/client"
import { isCredentialError, toGmailError } from "@/lib/gmail/errors"
import { addLabelToMessages, categoryLabelName, createLabel } from "@/lib/gmail/labels"

export type LabelResult = {
  /** Emails that got their `AI/<Category>` label in this run. */
  labelled: number
  /** Still waiting (a Gmail error); retried on the next scan without the AI. */
  pending: number
}

/**
 * Applies Gmail labels for classified emails whose label isn't on yet (CLS-6).
 * Runs after the classifications are saved, so a failure here never costs a
 * second AI call: the records keep `labelApplied: false` and are retried.
 */
export async function applyPendingLabels(userId: string, accountId: string): Promise<LabelResult> {
  const pending = await findPendingLabels(userId, accountId)
  if (pending.length === 0) return { labelled: 0, pending: 0 }

  const categories = new Map((await listCategoryLabels(userId)).map((c) => [c.id, c]))
  const byCategory = new Map<string, PendingLabel[]>()
  const orphaned: ObjectId[] = []
  for (const record of pending) {
    const id = record.categoryId.toHexString()
    if (!categories.has(id)) orphaned.push(record._id)
    else byCategory.set(id, [...(byCategory.get(id) ?? []), record])
  }
  // The category was deleted after classifying; there's no label to apply.
  await markLabelError(userId, orphaned, "CATEGORY_DELETED")

  let labelled = 0
  let failed = 0
  await withGmail(userId, accountId, async (gmail) => {
    for (const [categoryId, records] of byCategory) {
      const category = categories.get(categoryId)!
      try {
        // A category created while Gmail was unreachable may not have its label yet.
        let labelId = category.gmailLabelId
        if (!labelId) {
          labelId = (await createLabel(gmail, categoryLabelName(category.name))).id
          await setCategoryLabelId(userId, new ObjectId(categoryId), labelId)
        }

        const result = await addLabelToMessages(gmail, records.map((r) => r.gmailMessageId), labelId)
        const done = new Set(result.labelled)
        const gone = new Set(result.missing)
        await markLabelsApplied(userId, records.filter((r) => done.has(r.gmailMessageId)).map((r) => r._id))
        await markLabelError(userId, records.filter((r) => gone.has(r.gmailMessageId)).map((r) => r._id), "MESSAGE_NOT_FOUND")
        labelled += done.size
      } catch (error) {
        // A rejected password ends the session for every label; anything else
        // only affects this label, and its records are retried next scan.
        if (isCredentialError(toGmailError(error))) throw error
        console.error("Applying a Gmail label failed:", toGmailError(error).code)
        failed += records.length
      }
    }
  })

  return { labelled, pending: failed }
}
