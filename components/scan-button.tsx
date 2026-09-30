"use client"

import { Loader2, ScanSearch } from "lucide-react"
import { useRouter } from "next/navigation"
import { useTransition } from "react"
import { toast } from "sonner"

import { scanEmailsAction } from "@/app/(dashboard)/actions"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

const FIX_LABELS = { "/settings": "Open Settings", "/categories": "Open Categories" } as const

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`
}

/**
 * Top-bar Scan Emails button (DESIGN.md §6.1). When scanning isn't possible
 * yet, it stays focusable (aria-disabled) so the tooltip can say why.
 */
export function ScanButton({ blockedReason }: { blockedReason?: string }) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function scan() {
    if (blockedReason || pending) return
    startTransition(async () => {
      const result = await scanEmailsAction()
      if (!result.ok) {
        const fixAt = result.fixAt
        toast.error(result.message, fixAt && { action: { label: FIX_LABELS[fixAt], onClick: () => router.push(fixAt) } })
        return
      }

      const { processed, classified, noMatch, failed, hasMore, labelled, labelsPending, labelStepFailed } = result.summary
      const more = hasMore ? "Scan again to continue with older emails." : "That's everything from the last 30 days."
      const labelNote = labelStepFailed || labelsPending > 0 ? "Some Gmail labels will be applied on the next scan." : ""
      if (processed === 0) {
        toast.info("No new emails to scan", {
          description: [labelled > 0 && `Applied ${plural(labelled, "missing Gmail label")}.`, labelNote, more]
            .filter(Boolean)
            .join(" "),
        })
        return
      }
      const details = [
        labelled > 0 && `${labelled} labelled in Gmail`,
        noMatch > 0 && `${noMatch} with no match`,
        failed > 0 && `${failed} failed`,
      ].filter(Boolean)
      toast.success(`Scan complete: ${plural(classified, "email")} classified`, {
        description: [details.join(" · ") && `${details.join(" · ")}.`, labelNote, more].filter(Boolean).join(" "),
      })
    })
  }

  const button = (
    <Button onClick={scan} aria-disabled={Boolean(blockedReason) || pending} aria-busy={pending} className="aria-disabled:opacity-50">
      {pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <ScanSearch aria-hidden="true" />}
      {pending ? "Scanning…" : "Scan Emails"}
    </Button>
  )

  if (!blockedReason) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{blockedReason}</TooltipContent>
    </Tooltip>
  )
}
