import "server-only"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { cache } from "react"

import { getAuth } from "@/lib/auth/auth"

export type SessionUser = {
  id: string
  name: string
  email: string
  image?: string | null
}

export type Session = {
  user: SessionUser
}

/** Returns the current session, or null when signed out. Cached per request. */
export const getSession = cache(async (): Promise<Session | null> => {
  const result = await getAuth().api.getSession({ headers: await headers() })
  if (!result) return null

  const { id, name, email, image } = result.user
  return { user: { id, name, email, image } }
})

/** Use in protected layouts, pages and server actions. */
export async function requireSession(): Promise<Session> {
  const session = await getSession()
  if (!session) redirect("/sign-in")
  return session
}
