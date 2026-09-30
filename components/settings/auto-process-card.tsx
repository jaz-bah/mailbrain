"use client"

import { useOptimistic, useTransition } from "react"
import { toast } from "sonner"

import { setAutoProcessAction } from "@/app/(dashboard)/settings/actions"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import type { EmailAccountSummary } from "@/lib/db/email-accounts"

const timeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" })

const RUN_ERRORS: Record<string, string> = {
  AI_QUOTA_EXCEEDED: "the daily AI quota was used up",
  AI_RATE_LIMITED: "the AI service was busy",
  GMAIL_AUTH_FAILED: "Gmail rejected the app password",
  RATE_LIMITED: "Gmail was limiting connections",
}

/**
 * Automatic processing of new mail (PRD CLS-8). Off by default because it
 * uses AI quota. `scheduleMinutes` is null when this server has no timer
 * (it may still run from a cron scheduler).
 */
export function AutoProcessCard({
  account,
  scheduleMinutes,
  scheduled,
}: {
  account: EmailAccountSummary
  scheduleMinutes: number | null
  /** Some trigger (timer or cron) is configured on this server. */
  scheduled: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [enabled, setEnabled] = useOptimistic(account.autoProcess)

  function toggle(next: boolean) {
    startTransition(async () => {
      setEnabled(next)
      const result = await setAutoProcessAction(account.id, next)
      if (!result.ok) toast.error("Couldn't change automatic processing. Please try again.")
      else toast.success(next ? "New emails will be labelled automatically." : "Automatic processing is off.")
    })
  }

  const run = account.lastAutoRun
  const cadence = scheduleMinutes ? `every ${scheduleMinutes} minute${scheduleMinutes === 1 ? "" : "s"}` : "on a schedule"

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">
          <label htmlFor="auto-process">Label new emails automatically</label>
        </CardTitle>
        <CardDescription id="auto-process-help">
          MailBrain checks Gmail {cadence} and sorts emails that arrived since the last check, up to 25 at a
          time. The first check also picks up the last day&apos;s unsorted mail; use Scan Emails for older mail.
          Each email uses your AI quota.
        </CardDescription>
        <CardAction>
          <Switch
            id="auto-process"
            checked={enabled}
            onCheckedChange={toggle}
            disabled={pending || !scheduled || account.status !== "active"}
            aria-describedby="auto-process-help"
          />
        </CardAction>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        {!scheduled ? (
          <p>
            Not set up on this server yet: set <span className="font-mono text-xs">AUTO_PROCESS_INTERVAL_MINUTES</span>{" "}
            (or <span className="font-mono text-xs">CRON_SECRET</span> for a cron scheduler).
          </p>
        ) : account.status !== "active" ? (
          <p>Paused until Gmail is reconnected.</p>
        ) : !enabled ? (
          <p>Off. New emails are only sorted when you click Scan Emails.</p>
        ) : !run ? (
          <p>On. Waiting for the first check, which also sorts the last day&apos;s unsorted mail.</p>
        ) : (
          <p>
            Last check <time dateTime={run.at}>{timeFormat.format(new Date(run.at))}</time>:{" "}
            {run.error
              ? `stopped because ${RUN_ERRORS[run.error] ?? "of an error"}. It will try again next time.`
              : run.processed === 0
                ? "no new emails."
                : `${run.processed} new, ${run.classified} labelled.`}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
