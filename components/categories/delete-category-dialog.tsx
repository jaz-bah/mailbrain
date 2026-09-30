"use client"

import { Loader2 } from "lucide-react"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { deleteCategoryAction } from "@/app/(dashboard)/categories/actions"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import type { CategoryView } from "@/lib/categories/schema"

export function DeleteCategoryDialog({
  category,
  onOpenChange,
}: {
  category: CategoryView | null
  onOpenChange: (open: boolean) => void
}) {
  // Off by default: deleting the Gmail label removes it from every email.
  const [deleteLabel, setDeleteLabel] = useState(false)
  const [pending, startTransition] = useTransition()

  function confirm() {
    if (!category) return
    startTransition(async () => {
      const result = await deleteCategoryAction(category.id, deleteLabel && Boolean(category.gmailLabelId))
      if (result.ok) {
        toast.success(`Deleted “${category.name}”.`)
        onOpenChange(false)
      } else {
        toast.error(result.message)
      }
    })
  }

  return (
    <AlertDialog open={category !== null} onOpenChange={(open) => !pending && onOpenChange(open)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{category?.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            MailBrain will stop sorting emails into this category. This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {category?.gmailLabelId && (
          <Field orientation="horizontal">
            <Checkbox
              id="delete-gmail-label"
              checked={deleteLabel}
              onCheckedChange={(checked) => setDeleteLabel(checked === true)}
            />
            <FieldContent>
              <FieldLabel htmlFor="delete-gmail-label">
                Also delete the Gmail label{" "}
                <span className="font-mono text-xs">AI/{category.name}</span>
              </FieldLabel>
              <FieldDescription>
                The label is removed from every email that has it. The emails themselves aren&apos;t
                deleted.
              </FieldDescription>
            </FieldContent>
          </Field>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          {/* A plain Button, so the dialog stays open while the delete runs. */}
          <Button variant="destructive" onClick={confirm} disabled={pending} aria-busy={pending}>
            {pending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
            Delete category
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
