"use client"

import { Loader2 } from "lucide-react"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { disconnectGmailAction } from "@/app/(dashboard)/settings/actions"
import { GmailConnectForm } from "@/components/settings/gmail-connect-form"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { EmailAccountStatus, EmailAccountSummary } from "@/lib/db/email-accounts"

const STATUS_BADGE: Record<EmailAccountStatus, { label: string; variant: "default" | "destructive" }> = {
  active: { label: "Connected", variant: "default" },
  revoked: { label: "App password rejected", variant: "destructive" },
  error: { label: "IMAP unavailable", variant: "destructive" },
}

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" })

export function GmailAccountCard({
  account,
  defaultEmail,
}: {
  account: EmailAccountSummary | null
  defaultEmail: string
}) {
  const [updating, setUpdating] = useState(false)
  const [pending, startTransition] = useTransition()
  const needsNewPassword = account !== null && account.status !== "active"

  function disconnect() {
    if (!account) return
    startTransition(async () => {
      const result = await disconnectGmailAction(account.id)
      if (result.ok) toast.success("Gmail disconnected. The app password and classification history were deleted.")
      else toast.error(result.message)
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Gmail account</CardTitle>
        <CardDescription>
          MailBrain reads your email to classify it and adds labels such as{" "}
          <span className="font-mono text-xs">AI/Job Interview</span>. It never deletes or sends
          email.
        </CardDescription>
        <CardAction>
          {account ? (
            <Badge variant={STATUS_BADGE[account.status].variant}>
              {STATUS_BADGE[account.status].label}
            </Badge>
          ) : (
            <Badge variant="outline">Not connected</Badge>
          )}
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        {account && (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{account.email}</p>
              <p className="text-xs text-muted-foreground">
                Connected {dateFormat.format(new Date(account.connectedAt))}
              </p>
            </div>
            <div className="flex gap-2">
              {!needsNewPassword && !updating && (
                <Button variant="outline" onClick={() => setUpdating(true)}>
                  Update app password
                </Button>
              )}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" disabled={pending}>
                    {pending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
                    Disconnect
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Disconnect {account.email}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      MailBrain deletes the stored app password and this mailbox&apos;s
                      classification history (collections, reasons and corrections), and stops
                      reading it. Labels already added in Gmail stay. Your categories are kept.
                      For extra safety, also revoke the app password in your Google account.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={disconnect}>
                      Disconnect
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        )}

        {needsNewPassword && (
          <p className="text-sm">
            {account.status === "revoked"
              ? "Gmail stopped accepting the saved app password (it may have been revoked or 2-Step Verification was turned off). Enter a new one."
              : "Gmail's IMAP access isn't available. Turn on IMAP in Gmail settings and show All Mail in IMAP, then enter the app password again."}
          </p>
        )}

        {(!account || needsNewPassword || updating) && (
          <GmailConnectForm
            defaultEmail={account?.email ?? defaultEmail}
            lockEmail={Boolean(account)}
            onDone={() => setUpdating(false)}
          />
        )}
      </CardContent>
    </Card>
  )
}
