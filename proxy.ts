import { getSessionCookie } from "better-auth/cookies"
import { NextResponse, type NextRequest } from "next/server"

/**
 * Optimistic check only: redirects visitors with no session cookie. It does
 * not validate the session. Protected layouts call requireSession() for that.
 */
export function proxy(request: NextRequest) {
  if (!getSessionCookie(request)) {
    return NextResponse.redirect(new URL("/sign-in", request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ["/dashboard/:path*", "/categories/:path*", "/collections/:path*", "/emails/:path*", "/mail/:path*", "/settings/:path*"],
}
