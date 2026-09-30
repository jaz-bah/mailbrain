"use client"

import { Loader2 } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { GoogleIcon } from "@/components/brand-logo"
import { Button } from "@/components/ui/button"
import { authClient } from "@/lib/auth/auth-client"

export function GoogleSignInButton() {
  const [pending, setPending] = useState(false)

  async function signIn() {
    setPending(true)
    const { error } = await authClient.signIn.social({
      provider: "google",
      callbackURL: "/dashboard",
      errorCallbackURL: "/sign-in",
    })
    // On success the browser is already navigating to Google.
    if (error) {
      setPending(false)
      toast.error("Couldn't start Google sign-in. Please try again.")
    }
  }

  return (
    <Button
      variant="outline"
      size="lg"
      className="w-full"
      onClick={signIn}
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? (
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        <GoogleIcon className="size-4" />
      )}
      {pending ? "Redirecting to Google…" : "Continue with Google"}
    </Button>
  )
}
