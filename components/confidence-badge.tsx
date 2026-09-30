import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

/** DESIGN.md §6.3: High ≥ 90%, Medium from the category's threshold, Low below it. */
export function confidenceLevel(confidence: number, threshold: number) {
  if (confidence >= 0.9) return "High"
  if (confidence >= threshold) return "Medium"
  return "Low"
}

/** Always shows the level as text next to the number, never colour alone. */
export function ConfidenceBadge({
  confidence,
  threshold,
  className,
}: {
  confidence: number
  threshold: number
  className?: string
}) {
  const level = confidenceLevel(confidence, threshold)
  return (
    <Badge
      variant={level === "High" ? "default" : level === "Medium" ? "secondary" : "outline"}
      className={cn("tabular-nums", level === "Low" && "text-muted-foreground", className)}
    >
      {level} · {Math.round(confidence * 100)}%
    </Badge>
  )
}
