import { toNextJsHandler } from "better-auth/next-js"

import { getAuth } from "@/lib/auth/auth"
import { isForeignOrigin } from "@/lib/auth/origin"
import { getEnv } from "@/lib/env"

export async function GET(request: Request) {
  return toNextJsHandler(getAuth()).GET(request)
}

export async function POST(request: Request) {
  // Only MailBrain's own pages may start a sign-in or sign-out (CSRF).
  if (isForeignOrigin(request, getEnv().BETTER_AUTH_URL)) {
    return Response.json({ error: "Forbidden" }, { status: 403 })
  }
  return toNextJsHandler(getAuth()).POST(request)
}
