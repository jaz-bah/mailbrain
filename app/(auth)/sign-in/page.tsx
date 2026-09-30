import { ShieldCheck, TriangleAlert } from "lucide-react"
import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { BrandMark } from "@/components/brand-logo"
import { GoogleSignInButton } from "@/components/google-sign-in-button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { getSession } from "@/lib/auth/session"

export const metadata: Metadata = { title: "Sign in" }

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  // Checked here with a real session lookup, not in proxy.ts: a stale cookie
  // would otherwise bounce between /sign-in and /dashboard.
  if (await getSession()) redirect("/dashboard")

  // BetterAuth appends ?error=<code> when the OAuth flow fails or is cancelled.
  const { error } = await searchParams

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 px-4 py-12">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <div className="mx-auto mb-2">
            <BrandMark />
          </div>
          <CardTitle>
            <h1 className="text-2xl font-semibold tracking-tight">Sign in to MailBrain</h1>
          </CardTitle>
          <CardDescription>AI that sorts your Gmail into the categories you care about.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error && (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>Sign-in didn&apos;t complete</AlertTitle>
              <AlertDescription>
                Google sign-in was cancelled or failed. Please try again.
              </AlertDescription>
            </Alert>
          )}
          <GoogleSignInButton />
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            Signing in doesn&apos;t give MailBrain access to your email. You&apos;ll connect Gmail
            separately and can disconnect it at any time.
          </p>
        </CardContent>
      </Card>
    </main>
  )
}
