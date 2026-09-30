"use client"

import { Inbox, LayoutDashboard, Mail, MailCheck, Settings, Tags } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"

import { BrandMark } from "@/components/brand-logo"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { categoryColorClass, type CategoryView } from "@/lib/categories/schema"
import type { EmailAccountSummary } from "@/lib/db/email-accounts"
import { cn } from "@/lib/utils"

const navItems = [
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { title: "Mail", href: "/mail", icon: Inbox },
  { title: "Categories", href: "/categories", icon: Tags },
  { title: "Settings", href: "/settings", icon: Settings },
]

export function AppSidebar({
  gmailAccount,
  categories,
}: {
  gmailAccount: EmailAccountSummary | null
  categories: (Pick<CategoryView, "id" | "name" | "colorIndex" | "enabled"> & { count: number })[]
}) {
  const pathname = usePathname()
  const gmailLabel = !gmailAccount
    ? "Gmail not connected"
    : gmailAccount.status === "active"
      ? gmailAccount.email
      : "Gmail needs reconnecting"

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/dashboard">
                <BrandMark />
                <span className="text-base font-semibold text-foreground">MailBrain</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`)
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={isActive} tooltip={item.title}>
                      <Link href={item.href} aria-current={isActive ? "page" : undefined}>
                        <item.icon aria-hidden="true" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>Collections</SidebarGroupLabel>
          <SidebarGroupContent>
            {categories.length === 0 ? (
              <p className="px-2 text-xs text-sidebar-foreground">No categories yet</p>
            ) : (
              <SidebarMenu>
                {categories.map((category) => {
                  const href = `/collections/${category.id}`
                  const isActive = pathname === href
                  return (
                    <SidebarMenuItem key={category.id}>
                      <SidebarMenuButton asChild size="sm" isActive={isActive}>
                        <Link href={href} aria-current={isActive ? "page" : undefined}>
                          <span
                            className={cn(
                              "size-2 shrink-0 rounded-full",
                              categoryColorClass(category.colorIndex),
                              !category.enabled && "opacity-40"
                            )}
                            aria-hidden="true"
                          />
                          <span className="truncate">{category.name}</span>
                        </Link>
                      </SidebarMenuButton>
                      <SidebarMenuBadge className="tabular-nums">
                        {category.count}
                        <span className="sr-only"> emails</span>
                      </SidebarMenuBadge>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip={gmailLabel}>
              <Link href="/settings">
                {gmailAccount?.status === "active" ? (
                  <MailCheck aria-hidden="true" />
                ) : (
                  <Mail aria-hidden="true" />
                )}
                <span>{gmailLabel}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
