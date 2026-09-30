import { ArrowLeft, CircleCheck, Clock, ExternalLink, TriangleAlert } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { CategoryDot } from "@/components/category-dot"
import { ConfidenceBadge } from "@/components/confidence-badge"
import { CorrectionActions } from "@/components/emails/correction-actions"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { requireSession } from "@/lib/auth/session"
import { listCategories } from "@/lib/db/categories"
import { getClassificationDetail } from "@/lib/db/classifications"
import { listEmailAccounts } from "@/lib/db/email-accounts"
import { formatDateTime } from "@/lib/format"
import { gmailWebUrl } from "@/lib/gmail/types"

async function load(id: string) {
  const { user } = await requireSession()
  const detail = await getClassificationDetail(user.id, id)
  return { user, detail }
}

export async function generateMetadata({ params }: PageProps<"/emails/[id]">): Promise<Metadata> {
  const { detail } = await load((await params).id)
  return { title: detail?.subject || "Email" }
}

/** One classified email (PRD UI-3, DESIGN.md §6.4 Email detail). */
export default async function EmailDetailPage({ params }: PageProps<"/emails/[id]">) {
  const { user, detail } = await load((await params).id)
  if (!detail) notFound()

  const [categories, accounts] = await Promise.all([listCategories(user.id), listEmailAccounts(user.id)])
  const byId = new Map(categories.map((c) => [c.id, c]))
  const category = byId.get(detail.categoryId)
  const account = accounts.find((a) => a.id === detail.emailAccountId)
  const others = detail.otherCategoryIds.flatMap((id) => byId.get(id) ?? [])

  return (
    <>
      {category && (
        <Link
          href={`/collections/${category.id}`}
          className="-mb-4 inline-flex w-fit items-center gap-1 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {category.name}
        </Link>
      )}

      <PageHeader
        title={detail.hasHeaders ? detail.subject || "(no subject)" : "Email"}
        description={
          detail.hasHeaders
            ? `${detail.from || "Unknown sender"} · ${formatDateTime(detail.date)}`
            : "Sender, subject and date appear after your next scan."
        }
        actions={
          account && (
            <Button asChild>
              <a href={gmailWebUrl(detail.gmailMessageId, account.email)} target="_blank" rel="noopener noreferrer">
                <ExternalLink aria-hidden="true" />
                Open in Gmail
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </Button>
          )
        }
      />

      <section aria-label="Fix this email's category" className="-mt-2">
        <CorrectionActions
          classificationId={detail.id}
          category={category ? { id: category.id, name: category.name } : null}
          categories={categories.map(({ id, name, colorIndex, enabled }) => ({ id, name, colorIndex, enabled }))}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Why it&apos;s here</CardTitle>
          <CardDescription>MailBrain&apos;s decision for this email.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-5 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground">Category</dt>
            <dd className="flex items-center gap-2 font-medium">
              {category ? (
                <>
                  <CategoryDot colorIndex={category.colorIndex} />
                  {category.name}
                </>
              ) : (
                <span className="text-muted-foreground">Deleted category</span>
              )}
            </dd>

            <dt className="text-muted-foreground">Confidence</dt>
            <dd>
              {detail.setByUser || detail.confidence === null ? (
                <Badge variant="outline">Set by you</Badge>
              ) : (
                <ConfidenceBadge confidence={detail.confidence} threshold={category?.minConfidence ?? 0.8} />
              )}
            </dd>

            <dt className="text-muted-foreground">Reason</dt>
            <dd className="leading-relaxed">
              {detail.setByUser ? "You moved this email here." : (detail.reason ?? "—")}
            </dd>

            <dt className="text-muted-foreground">Gmail label</dt>
            <dd className="flex items-center gap-2">
              <LabelStatus
                labelId={category?.gmailLabelId ?? null}
                applied={detail.labelApplied}
                error={detail.labelError}
              />
            </dd>

            {others.length > 0 && (
              <>
                <dt className="text-muted-foreground">Also in</dt>
                <dd className="flex flex-wrap gap-x-4 gap-y-2">
                  {others.map((other) => (
                    <Link
                      key={other.id}
                      href={`/collections/${other.id}`}
                      className="inline-flex items-center gap-2 rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <CategoryDot colorIndex={other.colorIndex} />
                      {other.name}
                    </Link>
                  ))}
                </dd>
              </>
            )}

            <dt className="text-muted-foreground">{detail.setByUser ? "Moved" : "Classified"}</dt>
            <dd className="text-muted-foreground">
              <time dateTime={detail.classifiedAt}>{formatDateTime(detail.classifiedAt)}</time>
              {detail.model && !detail.setByUser && (
                <>
                  {" · "}
                  <span className="font-mono text-xs">{detail.model}</span>
                </>
              )}
            </dd>
          </dl>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        MailBrain doesn&apos;t keep a copy of your emails. Open the email in Gmail to read it.
      </p>
    </>
  )
}

function LabelStatus({ labelId, applied, error }: { labelId: string | null; applied: boolean; error: string | null }) {
  const label = labelId ? <span className="font-mono text-xs">{labelId}</span> : "the category's label"
  if (applied) {
    return (
      <>
        <CircleCheck className="size-4 shrink-0" aria-hidden="true" />
        <span>{label} applied</span>
      </>
    )
  }
  if (error === "MESSAGE_NOT_FOUND") {
    return (
      <>
        <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
        <span>Not applied: the email is no longer in Gmail</span>
      </>
    )
  }
  return (
    <>
      <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span>{label} will be applied on your next scan</span>
    </>
  )
}
