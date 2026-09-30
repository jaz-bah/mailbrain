import { ChevronRight, Inbox, Mail, RotateCw, Tags } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { CategoryDot } from "@/components/category-dot"
import { EmptyState } from "@/components/empty-state"
import { PageHeader } from "@/components/page-header"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { requireSession } from "@/lib/auth/session"
import { listCategories } from "@/lib/db/categories"
import { getDashboardStats } from "@/lib/db/classifications"
import { listEmailAccounts } from "@/lib/db/email-accounts"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Dashboard" }

function plural(count: number, word: string) {
  return `${count.toLocaleString("en")} ${word}${count === 1 ? "" : "s"}`
}

export default async function DashboardPage() {
  const { user } = await requireSession()
  const [[gmailAccount], categories, stats] = await Promise.all([
    listEmailAccounts(user.id),
    listCategories(user.id),
    getDashboardStats(user.id),
  ])

  const classifiedShare = stats.scanned > 0 ? Math.round((stats.classified / stats.scanned) * 100) : 0
  const cards = [
    { label: "Emails scanned", value: stats.scanned, note: "Across all your scans" },
    {
      label: "Classified",
      value: stats.classified,
      note: stats.scanned > 0 ? `${classifiedShare}% of scanned emails` : "Matched to a category",
    },
    { label: "No match", value: stats.noMatch, note: "Didn't fit any category" },
  ]

  return (
    <>
      <PageHeader title="Dashboard" description="Your inbox, sorted into the categories you care about." />

      {gmailAccount?.status !== "active" && (
        <Alert>
          <Mail aria-hidden="true" />
          <AlertTitle>{gmailAccount ? "Gmail needs reconnecting" : "Gmail isn't connected yet"}</AlertTitle>
          <AlertDescription>
            <p>
              {gmailAccount
                ? "MailBrain lost access to your Gmail. Reconnect it to keep sorting your email."
                : "Connect your Gmail account so MailBrain can start sorting your email."}
            </p>
            <Button asChild variant="outline" size="sm" className="mt-3">
              <Link href="/settings">Go to settings</Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {stats.retrying > 0 && (
        <Alert>
          <RotateCw aria-hidden="true" />
          <AlertTitle>{plural(stats.retrying, "email")} couldn&apos;t be classified yet</AlertTitle>
          <AlertDescription>MailBrain retries them automatically on your next scan.</AlertDescription>
        </Alert>
      )}

      <section aria-label="Overview" className="grid gap-4 sm:grid-cols-3">
        {cards.map((card) => (
          <Card key={card.label}>
            <CardHeader>
              <CardDescription>{card.label}</CardDescription>
              <CardTitle className="text-3xl font-semibold tabular-nums">{card.value.toLocaleString("en")}</CardTitle>
              <p className="text-xs text-muted-foreground">{card.note}</p>
            </CardHeader>
          </Card>
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Collections</CardTitle>
          <CardDescription>Emails MailBrain has labelled, by category.</CardDescription>
        </CardHeader>
        <CardContent>
          {categories.length === 0 ? (
            <EmptyState
              icon={Tags}
              title="No categories yet"
              description="Create categories like Job Interview or Invoices, and MailBrain will label matching emails in Gmail."
            >
              <Button asChild>
                <Link href="/categories">Create a category</Link>
              </Button>
            </EmptyState>
          ) : stats.scanned === 0 ? (
            <EmptyState
              icon={Inbox}
              title="Nothing scanned yet"
              description="Use Scan Emails at the top of the page. MailBrain sorts your recent emails into your categories and labels them in Gmail."
            />
          ) : (
            <ul className="flex flex-col divide-y">
              {categories.map((category) => {
                const count = stats.perCategory[category.id] ?? 0
                return (
                  <li key={category.id}>
                    <Link
                      href={`/collections/${category.id}`}
                      className="-mx-2 flex items-center gap-3 rounded-md px-2 py-3 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <CategoryDot colorIndex={category.colorIndex} />
                      <span className={cn("flex-1 text-sm font-medium", !category.enabled && "text-muted-foreground")}>
                        {category.name}
                      </span>
                      {!category.enabled && <Badge variant="outline">Paused</Badge>}
                      <span className="text-sm text-muted-foreground tabular-nums">{plural(count, "email")}</span>
                      <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  )
}
