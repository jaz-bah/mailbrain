import "server-only"

import { betterAuth } from "better-auth"
import { mongodbAdapter } from "better-auth/adapters/mongodb"
import { nextCookies } from "better-auth/next-js"

import { getMongoClient } from "@/lib/db/mongodb"
import { getEnv } from "@/lib/env"
import { welcomeEmail } from "@/lib/mail/templates"
import { sendMail } from "@/lib/mail/transport"

function createAuth() {
  const env = getEnv()
  const client = getMongoClient()

  return betterAuth({
    appName: "MailBrain",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: mongodbAdapter(client.db(), { client }),
    // Sign-in only asks for the basic profile scopes. Gmail access is a
    // separate consent flow with its own token storage (ROADMAP Phase 3).
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        prompt: "select_account",
      },
    },
    account: {
      encryptOAuthTokens: true,
    },
    databaseHooks: {
      user: {
        create: {
          // Welcome email (PRD NTF-1). Never blocks or fails sign-in.
          after: async (user) => {
            // Not awaited: SMTP latency shouldn't slow down the first sign-in.
            void sendMail(welcomeEmail({ to: user.email, name: user.name, appUrl: env.BETTER_AUTH_URL })).catch(
              (error: unknown) => {
                console.error("Welcome email failed:", error instanceof Error ? error.name : "unknown")
              }
            )
          },
        },
      },
    },
    plugins: [nextCookies()], // Must stay last.
  })
}

type Auth = ReturnType<typeof createAuth>

let authInstance: Auth | undefined

/** Created on first use so `next build` doesn't need secrets. */
export function getAuth(): Auth {
  authInstance ??= createAuth()
  return authInstance
}
