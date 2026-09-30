import { categoryColorClass } from "@/lib/categories/schema"
import { cn } from "@/lib/utils"

/** Category colour marker (DESIGN.md §6.2). Decorative: always shown next to the name. */
export function CategoryDot({ colorIndex, className }: { colorIndex: number; className?: string }) {
  return (
    <span
      className={cn("size-2.5 shrink-0 rounded-full", categoryColorClass(colorIndex), className)}
      aria-hidden="true"
    />
  )
}
