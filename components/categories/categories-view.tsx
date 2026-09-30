"use client"

import { MoreHorizontal, Pencil, Plus, Tags, Trash2 } from "lucide-react"
import { startTransition, useOptimistic, useState } from "react"
import { toast } from "sonner"

import { toggleCategoryAction } from "@/app/(dashboard)/categories/actions"
import {
  CategoryFormDialog,
  type CategoryFormInitial,
} from "@/components/categories/category-form-dialog"
import { DeleteCategoryDialog } from "@/components/categories/delete-category-dialog"
import { EmptyState } from "@/components/empty-state"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import { categoryColorClass, type CategoryView } from "@/lib/categories/schema"
import { STARTER_CATEGORIES } from "@/lib/categories/starters"
import { cn } from "@/lib/utils"

export function CategoriesView({
  categories,
  gmailConnected,
}: {
  categories: CategoryView[]
  gmailConnected: boolean
}) {
  // A new key per open resets the form's state and inputs.
  const [form, setForm] = useState<{ key: number; initial?: CategoryFormInitial } | null>(null)
  const [deleting, setDeleting] = useState<CategoryView | null>(null)

  const [optimistic, setOptimisticEnabled] = useOptimistic(
    categories,
    (state, change: { id: string; enabled: boolean }) =>
      state.map((c) => (c.id === change.id ? { ...c, enabled: change.enabled } : c))
  )

  function openForm(initial?: CategoryFormInitial) {
    setForm({ key: Date.now(), initial })
  }

  function toggle(category: CategoryView, enabled: boolean) {
    startTransition(async () => {
      setOptimisticEnabled({ id: category.id, enabled })
      const result = await toggleCategoryAction(category.id, enabled)
      if (!result.ok) toast.error("Couldn't update the category. Please try again.")
    })
  }

  return (
    <>
      <PageHeader
        title="Categories"
        description="Tell MailBrain what to look for. Each category gets its own Gmail label."
        actions={
          <Button onClick={() => openForm()}>
            <Plus aria-hidden="true" />
            New category
          </Button>
        }
      />

      {optimistic.length === 0 ? (
        <EmptyState
          icon={Tags}
          title="No categories yet"
          description="Start from a suggestion or create your own. You can edit everything later."
        >
          <div className="flex flex-wrap justify-center gap-2" role="group" aria-label="Starter categories">
            {STARTER_CATEGORIES.map((starter) => (
              <Button key={starter.name} variant="outline" size="sm" onClick={() => openForm(starter)}>
                <Plus aria-hidden="true" />
                {starter.name}
              </Button>
            ))}
          </div>
        </EmptyState>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border" aria-label="Your categories">
          {optimistic.map((category) => (
            <li key={category.id} className="flex items-start gap-4 p-4">
              <span
                className={cn("mt-1.5 size-2.5 shrink-0 rounded-full", categoryColorClass(category.colorIndex))}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className={cn("font-medium", !category.enabled && "text-muted-foreground")}>
                    {category.name}
                  </h2>
                  {category.gmailLabelId ? (
                    <span className="font-mono text-xs text-muted-foreground">AI/{category.name}</span>
                  ) : (
                    <Badge variant="outline">
                      {gmailConnected ? "Label not created yet" : "Label added when Gmail is connected"}
                    </Badge>
                  )}
                  {!category.enabled && <Badge variant="secondary">Paused</Badge>}
                </div>
                <p className="text-sm text-muted-foreground">{category.description}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Switch
                  checked={category.enabled}
                  onCheckedChange={(checked) => toggle(category, checked)}
                  aria-label={`${category.enabled ? "Pause" : "Resume"} ${category.name}`}
                />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label={`Actions for ${category.name}`}>
                      <MoreHorizontal aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => openForm(category)}>
                      <Pencil aria-hidden="true" /> Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(category)}>
                      <Trash2 aria-hidden="true" /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </li>
          ))}
        </ul>
      )}

      {form && (
        <CategoryFormDialog
          key={form.key}
          open
          onOpenChange={(open) => !open && setForm(null)}
          initial={form.initial}
        />
      )}
      <DeleteCategoryDialog
        key={deleting?.id ?? "none"}
        category={deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
      />
    </>
  )
}
