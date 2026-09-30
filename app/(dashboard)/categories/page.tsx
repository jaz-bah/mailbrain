import type { Metadata } from "next"

import { CategoriesView } from "@/components/categories/categories-view"
import { requireSession } from "@/lib/auth/session"
import { listCategories } from "@/lib/db/categories"
import { listEmailAccounts } from "@/lib/db/email-accounts"

export const metadata: Metadata = { title: "Categories" }

export default async function CategoriesPage() {
  const { user } = await requireSession()
  const [categories, accounts] = await Promise.all([
    listCategories(user.id),
    listEmailAccounts(user.id),
  ])

  return (
    <CategoriesView
      categories={categories}
      gmailConnected={accounts.some((a) => a.status === "active")}
    />
  )
}
