import { AppSidebar } from "@/components/app-sidebar"
import { ScanButton } from "@/components/scan-button"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { UserMenu } from "@/components/user-menu"
import { requireSession } from "@/lib/auth/session"
import { listCategories } from "@/lib/db/categories"
import { getDashboardStats } from "@/lib/db/classifications"
import { listEmailAccounts } from "@/lib/db/email-accounts"

export default async function DashboardLayout({ children }: LayoutProps<"/">) {
  const { user } = await requireSession()
  const [[gmailAccount], categories, stats] = await Promise.all([
    listEmailAccounts(user.id),
    listCategories(user.id),
    getDashboardStats(user.id),
  ])

  return (
    <SidebarProvider>
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:ring-2 focus:ring-ring"
      >
        Skip to main content
      </a>
      <AppSidebar
        gmailAccount={gmailAccount ?? null}
        categories={categories.map(({ id, name, colorIndex, enabled }) => ({
          id,
          name,
          colorIndex,
          enabled,
          count: stats.perCategory[id] ?? 0,
        }))}
      />
      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
          <div className="ml-auto flex items-center gap-2">
            <ScanButton
              blockedReason={
                !gmailAccount
                  ? "Connect Gmail in Settings first"
                  : !categories.some((c) => c.enabled)
                    ? "Create a category first"
                    : undefined
              }
            />
            <UserMenu user={user} />
          </div>
        </header>
        <main id="main" tabIndex={-1} className="flex-1 px-4 py-8 outline-none md:px-8">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">{children}</div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
