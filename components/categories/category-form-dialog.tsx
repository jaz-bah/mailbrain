"use client"

import { Loader2 } from "lucide-react"
import { useActionState, useState } from "react"
import { toast } from "sonner"

import {
  saveCategoryAction,
  type CategoryFormState,
} from "@/app/(dashboard)/categories/actions"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import type { CategoryInput } from "@/lib/categories/schema"

export type CategoryFormInitial = Partial<CategoryInput> & { id?: string }

const LABEL_TOASTS = {
  synced: (name: string) => toast.success(`Saved. Gmail label AI/${name} is ready.`),
  pending: () => toast.success("Saved. Its Gmail label will be added when you connect Gmail."),
  failed: () =>
    toast.warning("Saved, but the Gmail label couldn't be updated. It'll be retried on the next save."),
}

export function CategoryFormDialog({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initial?: CategoryFormInitial
}) {
  const isEdit = Boolean(initial?.id)
  const [name, setName] = useState(initial?.name ?? "")
  // Shown as a whole percentage; the server stores 0.5–1.
  const [minConfidence, setMinConfidence] = useState(Math.round((initial?.minConfidence ?? 0.8) * 100))

  const [state, formAction, pending] = useActionState(
    async (prev: CategoryFormState, formData: FormData) => {
      const result = await saveCategoryAction(prev, formData)
      if (result.status === "success") {
        LABEL_TOASTS[result.label](String(formData.get("name")).trim())
        onOpenChange(false)
      }
      return result
    },
    { status: "idle" }
  )

  const errors = state.status === "error" ? state.fieldErrors : undefined
  // After a failed submit, show what the user typed rather than the initial values.
  const values = state.status === "error" ? state.values : undefined

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form action={formAction} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{isEdit ? "Edit category" : "New category"}</DialogTitle>
            <DialogDescription>
              Describe what belongs here in plain language. MailBrain labels matching emails in
              Gmail.
            </DialogDescription>
          </DialogHeader>

          {initial?.id && <input type="hidden" name="id" value={initial.id} />}

          {state.status === "error" && state.message && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
          )}

          <FieldGroup>
            <Field data-invalid={Boolean(errors?.name)}>
              <FieldLabel htmlFor="category-name">Name</FieldLabel>
              <Input
                id="category-name"
                name="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={50}
                placeholder="Job Interview"
                aria-invalid={Boolean(errors?.name)}
                autoFocus
                required
              />
              <FieldDescription>
                Gmail label:{" "}
                <span className="font-mono text-xs">AI/{name.trim() || "…"}</span>
              </FieldDescription>
              <FieldError errors={errors?.name ? [{ message: errors.name }] : undefined} />
            </Field>

            <Field data-invalid={Boolean(errors?.description)}>
              <FieldLabel htmlFor="category-description">Description</FieldLabel>
              <Input
                id="category-description"
                name="description"
                defaultValue={values?.description ?? initial?.description ?? ""}
                maxLength={200}
                placeholder="Emails related to job interviews."
                aria-invalid={Boolean(errors?.description)}
                required
              />
              <FieldError
                errors={errors?.description ? [{ message: errors.description }] : undefined}
              />
            </Field>

            <Field data-invalid={Boolean(errors?.instructions)}>
              <FieldLabel htmlFor="category-instructions">AI instructions</FieldLabel>
              <Textarea
                id="category-instructions"
                name="instructions"
                defaultValue={values?.instructions ?? initial?.instructions ?? ""}
                maxLength={1000}
                rows={4}
                placeholder="Identify emails that invite, schedule, confirm, reschedule, or discuss a job interview."
                aria-invalid={Boolean(errors?.instructions)}
              />
              <FieldDescription>
                Optional. Tell the AI exactly what to look for, and what to leave out.
              </FieldDescription>
              <FieldError
                errors={errors?.instructions ? [{ message: errors.instructions }] : undefined}
              />
            </Field>

            <Field data-invalid={Boolean(errors?.minConfidence)}>
              <div className="flex items-center justify-between gap-4">
                <FieldLabel id="min-confidence-label" htmlFor="category-min-confidence">
                  Minimum confidence
                </FieldLabel>
                <div className="flex items-center gap-1">
                  <Input
                    id="category-min-confidence"
                    name="minConfidence"
                    type="number"
                    inputMode="numeric"
                    min={50}
                    max={100}
                    step={1}
                    value={minConfidence}
                    onChange={(e) => setMinConfidence(Number(e.target.value))}
                    className="h-8 w-16 text-right tabular-nums"
                    aria-describedby="min-confidence-help"
                    aria-invalid={Boolean(errors?.minConfidence)}
                  />
                  <span className="text-sm text-muted-foreground" aria-hidden="true">
                    %
                  </span>
                </div>
              </div>
              <Slider
                value={[Math.min(100, Math.max(50, minConfidence || 50))]}
                onValueChange={([value]) => setMinConfidence(value)}
                min={50}
                max={100}
                step={5}
                aria-labelledby="min-confidence-label"
              />
              <FieldDescription id="min-confidence-help">
                Emails are only labelled when the AI is at least this sure. Raise it if this
                category picks up the wrong emails; lower it if it misses some.
              </FieldDescription>
              <FieldError
                errors={errors?.minConfidence ? [{ message: errors.minConfidence }] : undefined}
              />
            </Field>

            {/* Future per-category actions (PRD CAT-6), shown so users know what's coming. */}
            <fieldset className="flex flex-col gap-3" disabled>
              <legend className="mb-2 text-sm font-medium">
                Also do with matching emails <span className="font-normal text-muted-foreground">(coming later)</span>
              </legend>
              {[
                { id: "future-archive", label: "Archive them (skip the inbox)" },
                { id: "future-read", label: "Mark them as read" },
              ].map((action) => (
                <div key={action.id} className="flex items-center justify-between gap-4 opacity-60">
                  <label htmlFor={action.id} className="text-sm">
                    {action.label}
                  </label>
                  <Switch id={action.id} disabled />
                </div>
              ))}
            </fieldset>
          </FieldGroup>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending} aria-busy={pending}>
              {pending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              {isEdit ? "Save changes" : "Create category"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
