"use client"

import { ChevronDown, FolderInput, Loader2, RotateCcw, X } from "lucide-react"
import { useRouter } from "next/navigation"
import { useTransition } from "react"
import { toast } from "sonner"

import {
  moveEmailAction,
  reclassifyEmailAction,
  removeFromCategoryAction,
  type CorrectionActionResult,
} from "@/app/(dashboard)/emails/[id]/actions"
import { CategoryDot } from "@/components/category-dot"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

type CategoryOption = { id: string; name: string; colorIndex: number; enabled: boolean }

/**
 * Reclassify, Move to… and Remove (PRD UI-4, DESIGN.md §2.3: one click away).
 * Each one updates Gmail, the record and the correction log, then goes to
 * wherever the email now is.
 */
export function CorrectionActions({
  classificationId,
  category,
  categories,
}: {
  classificationId: string
  category: { id: string; name: string } | null
  categories: CategoryOption[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const targets = categories.filter((c) => c.id !== category?.id)

  function run(action: () => Promise<CorrectionActionResult>, success: (r: Extract<CorrectionActionResult, { ok: true }>) => string) {
    startTransition(async () => {
      const result = await action()
      if (!result.ok) {
        toast.error(result.message)
        return
      }
      toast.success(success(result))
      if (result.classificationId && result.classificationId !== classificationId) {
        router.replace(`/emails/${result.classificationId}`)
      } else if (!result.classificationId) {
        // No category left for this email: back to where the user came from.
        router.replace(category ? `/collections/${category.id}` : "/dashboard")
      }
    })
  }

  const nameOf = (id: string | null) => categories.find((c) => c.id === id)?.name

  return (
    <div className="flex flex-wrap items-center gap-2" aria-busy={pending}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" disabled={pending || targets.length === 0}>
            <FolderInput aria-hidden="true" />
            Move to…
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuLabel>Move to category</DropdownMenuLabel>
          {targets.map((target) => (
            <DropdownMenuItem
              key={target.id}
              onSelect={() =>
                run(() => moveEmailAction(classificationId, target.id), () => `Moved to ${target.name}`)
              }
            >
              <CategoryDot colorIndex={target.colorIndex} />
              {target.name}
              {!target.enabled && <span className="ml-auto text-xs text-muted-foreground">Paused</span>}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {category && (
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => run(() => removeFromCategoryAction(classificationId), () => `Removed from ${category.name}`)}
        >
          <X aria-hidden="true" />
          Remove from {category.name}
        </Button>
      )}

      <Button
        variant="outline"
        disabled={pending}
        onClick={() =>
          run(
            () => reclassifyEmailAction(classificationId),
            (r) =>
              !r.changed
                ? "Reclassified: no change"
                : r.categoryId
                  ? `Reclassified: now in ${nameOf(r.categoryId) ?? "a new category"}`
                  : "Reclassified: no category fits this email"
          )
        }
      >
        {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}
        Reclassify
      </Button>
    </div>
  )
}
