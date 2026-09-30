import { ChevronLeft, ChevronRight, Inbox, Pencil } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { CategoryDot } from "@/components/category-dot"
import { ConfidenceBadge } from "@/components/confidence-badge"
import { EmptyState } from "@/components/empty-state"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { requireSession } from "@/lib/auth/session"
import { listCategories } from "@/lib/db/categories"
import { COLLECTION_PAGE_SIZE, listCollection } from "@/lib/db/classifications"
import { formatDate, senderName } from "@/lib/format"

async function findCategory(categoryId: string) {
  const { user } = await requireSession()
  const category = (await listCategories(user.id)).find((c) => c.id === categoryId)
  return { user, category }
}

export async function generateMetadata({ params }: PageProps<"/collections/[categoryId]">): Promise<Metadata> {
  const { category } = await findCategory((await params).categoryId)
  return { title: category?.name ?? "Collection" }
}

/** A category's emails, newest first (PRD UI-2, DESIGN.md §6.4 Collection). */
export default async function CollectionPage({ params, searchParams }: PageProps<"/collections/[categoryId]">) {
  const { categoryId } = await params
  const { user, category } = await findCategory(categoryId)
  if (!category) notFound()

  const rawPage = Number((await searchParams).page)
  const page = Number.isInteger(rawPage) && rawPage > 1 ? rawPage : 1
  const { items, total } = await listCollection(user.id, category.id, page)
  const pageCount = Math.max(1, Math.ceil(total / COLLECTION_PAGE_SIZE))
  if (page > pageCount) notFound()

  const first = (page - 1) * COLLECTION_PAGE_SIZE + 1
  const last = first + items.length - 1

  return (
    <>
      <PageHeader
        title={category.name}
        description={category.description}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/categories">
              <Pencil aria-hidden="true" />
              Edit category
            </Link>
          </Button>
        }
      />

      <div className="-mt-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <CategoryDot colorIndex={category.colorIndex} />
        {category.gmailLabelId ? (
          <span>
            Labelled <span className="font-mono text-xs text-foreground">{category.gmailLabelId}</span> in Gmail
          </span>
        ) : (
          <span>Gmail label pending</span>
        )}
        {!category.enabled && <Badge variant="outline">Paused</Badge>}
      </div>

      {total === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No emails here yet"
          description={
            category.enabled
              ? "Nothing has matched this category so far. Use Scan Emails at the top of the page to sort more of your recent email."
              : "This category is paused, so new emails aren't sorted into it. Turn it back on in Categories."
          }
        />
      ) : (
        <Card className="py-0">
          <CardContent className="px-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="hidden w-48 pl-6 md:table-cell">Sender</TableHead>
                    <TableHead className="pl-6 md:pl-2">Subject</TableHead>
                    <TableHead className="hidden sm:table-cell">Confidence</TableHead>
                    <TableHead className="pr-6 text-right">Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.id} className="relative">
                      <TableCell className="hidden max-w-48 truncate pl-6 font-medium md:table-cell">
                        {item.hasHeaders ? senderName(item.from) : "—"}
                      </TableCell>
                      <TableCell className="max-w-0 min-w-48 pl-6 md:pl-2">
                        {/* The link covers the row, so the whole row is clickable but reads as one link. */}
                        <Link
                          href={`/emails/${item.id}`}
                          className="block truncate outline-none after:absolute after:inset-0 focus-visible:underline hover:underline"
                        >
                          {item.hasHeaders ? item.subject || "(no subject)" : "Details appear after your next scan"}
                        </Link>
                        <span className="block truncate text-xs text-muted-foreground md:hidden">
                          {item.hasHeaders ? senderName(item.from) : ""}
                        </span>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        {item.setByUser || item.confidence === null ? (
                          <Badge variant="outline">Set by you</Badge>
                        ) : (
                          <ConfidenceBadge confidence={item.confidence} threshold={category.minConfidence} />
                        )}
                      </TableCell>
                      <TableCell className="pr-6 text-right whitespace-nowrap text-muted-foreground tabular-nums">
                        {item.date ? <time dateTime={item.date}>{formatDate(item.date)}</time> : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {total > 0 && (
        <nav aria-label="Pages" className="flex items-center justify-between gap-4 text-sm text-muted-foreground">
          <p className="tabular-nums">
            {first.toLocaleString("en")}–{last.toLocaleString("en")} of {total.toLocaleString("en")}
          </p>
          {pageCount > 1 && (
            <div className="flex gap-2">
              <PageLink categoryId={category.id} page={page - 1} disabled={page <= 1} label="Previous" />
              <PageLink categoryId={category.id} page={page + 1} disabled={page >= pageCount} label="Next" />
            </div>
          )}
        </nav>
      )}
    </>
  )
}

function PageLink({
  categoryId,
  page,
  disabled,
  label,
}: {
  categoryId: string
  page: number
  disabled: boolean
  label: "Previous" | "Next"
}) {
  const icon = label === "Previous" ? <ChevronLeft aria-hidden="true" /> : <ChevronRight aria-hidden="true" />
  if (disabled) {
    return (
      <Button variant="outline" size="sm" disabled>
        {label === "Previous" && icon}
        {label}
        {label === "Next" && icon}
      </Button>
    )
  }
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={page === 1 ? `/collections/${categoryId}` : `/collections/${categoryId}?page=${page}`}>
        {label === "Previous" && icon}
        {label}
        {label === "Next" && icon}
      </Link>
    </Button>
  )
}
