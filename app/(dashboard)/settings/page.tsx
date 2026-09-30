import type { Metadata } from "next"

import { PageHeader } from "@/components/page-header"
import { AutoProcessCard } from "@/components/settings/auto-process-card"
import { GmailAccountCard } from "@/components/settings/gmail-account-card"
import { requireSession } from "@/lib/auth/session"
import { listEmailAccounts } from "@/lib/db/email-accounts"
import { getEnv } from "@/lib/env"

export const metadata: Metadata = { title: "Settings" }

export default async function SettingsPage() {
  const { user } = await requireSession()
  const [account] = await listEmailAccounts(user.id)
  const env = getEnv()

  return (
    <>
      <PageHeader title="Settings" description="Manage your connected mailbox and account." />
      <GmailAccountCard account={account ?? null} defaultEmail={user.email} />
      {account && (
        <AutoProcessCard
          account={account}
          scheduleMinutes={env.AUTO_PROCESS_INTERVAL_MINUTES ?? null}
          scheduled={Boolean(env.AUTO_PROCESS_INTERVAL_MINUTES || env.CRON_SECRET)}
        />
      )}
    </>
  )
}
