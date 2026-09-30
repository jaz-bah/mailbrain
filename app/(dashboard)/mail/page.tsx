import { ArrowLeft, ChevronRight, ExternalLink, Inbox, Mail, TriangleAlert } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { EmptyState } from "@/components/empty-state"
import { PageHeader } from "@/components/page-header"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { requireSession } from "@/lib/auth/session"
import { listEmailAccounts } from "@/lib/db/email-accounts"
import { formatDateTime } from "@/lib/format"
import { GmailError, isCredentialError } from "@/lib/gmail/errors"
import { loadInboxPage, type InboxItem } from "@/lib/gmail/inbox"

export const metadata: Metadata = { title: "Mail" }

const GMAIL_PROBLEMS: Record<string, { title: string; description: string; fixInSettings?: boolean }> = {
  credentials: {
    title: "Gmail rejected the saved app password",
    description: "Enter a new app password in Settings to see your mail here.",
    fixInSettings: true,
  },
  IMAP_DISABLED: {
    title: "IMAP isn't available for this Gmail account",
    description: "Turn on IMAP in Gmail's settings and show All Mail in IMAP, then reload this page.",
    fixInSettings: true,
  },
  RATE_LIMITED: {
    title: "Gmail is limiting connections right now",
    description: "Try again in a minute.",
  },
  other: {
    title: "Couldn't load your mail",
    description: "MailBrain couldn't reach Gmail. Reload the page to try again.",
  },
}

/** The Gmail inbox, newest first: headers read live from Gmail, never stored. */
export default async function MailPage({ searchParams }: PageProps<"/mail">) {
  const { user } = await requireSession()
  const [account] = await listEmailAccounts(user.id)
  const rawBefore = (await searchParams).before
  // A UID from the previous page; anything else starts from the newest mail.
  const before = typeof rawBefore === "string" && /^\d{1,10}$/.test(rawBefore) ? rawBefore : undefined

  const header = <PageHeader title="Mail" description="Your Gmail inbox, newest first. Open an email to read it in Gmail." />

  if (!account) {
    return (
      <>
        {header}
        <EmptyState
          icon={Mail}
          title="Gmail isn't connected yet"
          description="Connect your Gmail account in Settings to see your inbox here."
        >
          <Button asChild>
            <Link href="/settings">Connect Gmail</Link>
          </Button>
        </EmptyState>
      </>
    )
  }

  let page: Awaited<ReturnType<typeof loadInboxPage>>
  try {
    page = await loadInboxPage(user.id, account, before)
  } catch (error) {
    const code = error instanceof GmailError ? (isCredentialError(error) ? "credentials" : error.code) : "other"
    const problem = GMAIL_PROBLEMS[code] ?? GMAIL_PROBLEMS.other
    return (
      <>
        {header}
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{problem.title}</AlertTitle>
          <AlertDescription>
            <p>{problem.description}</p>
            {problem.fixInSettings && (
              <Button asChild variant="outline" size="sm" className="mt-2">
                <Link href="/settings">Go to Settings</Link>
              </Button>
            )}
          </AlertDescription>
        </Alert>
      </>
    )
  }

  return (
    <>
      {header}

      {page.items.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={before ? "No older emails" : "Your inbox is empty"}
          description={before ? "You've reached the end of your inbox." : "New emails will appear here as they arrive."}
        >
          {before && (
            <Button asChild variant="outline">
              <Link href="/mail">Back to newest</Link>
            </Button>
          )}
        </EmptyState>
      ) : (
        <Card className="py-0">
          <CardContent className="px-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="hidden w-48 pl-6 md:table-cell">Sender</TableHead>
                    <TableHead className="pl-6 md:pl-2">Subject</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Time</TableHead>
                    <TableHead className="w-24 pr-6 text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {page.items.map((item) => (
                    <MailRow key={item.id} item={item} />
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {page.items.length > 0 && (
        <nav aria-label="Pages" className="flex items-center justify-between gap-4 text-sm text-muted-foreground">
          <p>{before ? "Older emails" : "Newest emails"}</p>
          <div className="flex gap-2">
            {before && (
              <Button asChild variant="outline" size="sm">
                <Link href="/mail">
                  <ArrowLeft aria-hidden="true" />
                  Newest
                </Link>
              </Button>
            )}
            {page.olderToken ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/mail?before=${page.olderToken}`}>
                  Older
                  <ChevronRight aria-hidden="true" />
                </Link>
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled>
                Older
                <ChevronRight aria-hidden="true" />
              </Button>
            )}
          </div>
        </nav>
      )}

      <p className="text-xs text-muted-foreground">
        MailBrain reads these headers from Gmail when you open this page and doesn&apos;t store them.
      </p>
    </>
  )
}

function MailRow({ item }: { item: InboxItem }) {
  const subject = item.subject || "(no subject)"
  return (
    <TableRow>
      <TableCell className={`hidden max-w-48 truncate pl-6 md:table-cell ${item.unread ? "font-semibold" : ""}`}>
        {item.from}
      </TableCell>
      <TableCell className="max-w-0 min-w-48 pl-6 md:pl-2">
        <span className={`block truncate ${item.unread ? "font-semibold" : ""}`}>
          {item.unread && <span className="sr-only">Unread: </span>}
          {subject}
        </span>
        <span className="block truncate text-xs text-muted-foreground md:hidden">
          {item.from}
          {item.date && <> · {formatDateTime(item.date)}</>}
        </span>
      </TableCell>
      <TableCell className="hidden text-right whitespace-nowrap text-muted-foreground tabular-nums sm:table-cell">
        {item.date ? <time dateTime={item.date}>{formatDateTime(item.date)}</time> : "—"}
      </TableCell>
      <TableCell className="pr-6 text-right">
        <Button asChild variant="outline" size="sm">
          <a href={item.gmailUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink aria-hidden="true" />
            View
            <span className="sr-only">
              {" "}
              {subject} in Gmail (opens in a new tab)
            </span>
          </a>
        </Button>
      </TableCell>
    </TableRow>
  )
}
