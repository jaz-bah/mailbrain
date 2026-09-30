/**
 * True when a browser request comes from another site. BetterAuth only checks
 * Origin on requests that carry its cookies, so a cookie-less POST (e.g.
 * sign-in/social) from any page would otherwise be accepted. Requests without
 * an Origin header (server-to-server, same-origin GETs) are allowed.
 */
export function isForeignOrigin(request: Request, appUrl: string): boolean {
  const origin = request.headers.get("origin")
  if (!origin) return false
  try {
    return new URL(origin).origin !== new URL(appUrl).origin
  } catch {
    return true
  }
}
