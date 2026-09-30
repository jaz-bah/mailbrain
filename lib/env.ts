import "server-only"

import { z } from "zod"

const base64Key32 = z
  .string()
  .refine((value) => Buffer.from(value, "base64").length === 32, {
    message: "must be a base64-encoded 32-byte key",
  })

const envSchema = z
  .object({
    MONGODB_URI: z
      .string()
      .regex(/^mongodb(\+srv)?:\/\//, "must be a mongodb:// or mongodb+srv:// URI"),

    BETTER_AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
    BETTER_AUTH_URL: z.url(),

    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),

    // Which AI service classifies email. Its key (and model) are required.
    AI_PROVIDER: z.enum(["openrouter", "gemini"]).default("openrouter"),
    // Optional override of the gap between AI requests (ms), for per-minute limits.
    AI_MIN_INTERVAL_MS: z.coerce.number().int().min(0).optional(),

    // Google AI Studio key (https://aistudio.google.com/apikey).
    GEMINI_API_KEY: z.string().min(1).optional(),
    GEMINI_MODEL: z.string().min(1).default("gemini-3.1-flash-lite"),

    OPENROUTER_API_KEY: z.string().min(1).optional(),
    OPENROUTER_MODEL: z.string().min(1).optional(),
    // "true" lets providers keep or train on prompts (email text). Required by
    // OpenRouter's free models. Off by default: see PRD §11.
    OPENROUTER_ALLOW_DATA_COLLECTION: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),

    TOKEN_ENCRYPTION_KEY: base64Key32,
    // Key rotation: the old key, kept only until every stored secret has been
    // re-encrypted with TOKEN_ENCRYPTION_KEY (done at server start).
    TOKEN_ENCRYPTION_KEY_PREVIOUS: base64Key32.optional(),

    // Automatic new-email processing (Phase 13). Both optional.
    // A scheduler (e.g. Vercel Cron) calls /api/cron/process-new-mail with
    // "Authorization: Bearer <CRON_SECRET>"; without it the route is off.
    CRON_SECRET: z.string().min(32, "must be at least 32 characters").optional(),
    // Runs the same processing in-process every N minutes (local and self-hosted servers).
    AUTO_PROCESS_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).optional(),

    // SMTP is only needed for transactional email (ROADMAP Phase 12).
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().positive().optional(),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    const aiKeys =
      env.AI_PROVIDER === "gemini"
        ? (["GEMINI_API_KEY"] as const)
        : (["OPENROUTER_API_KEY", "OPENROUTER_MODEL"] as const)
    for (const key of aiKeys.filter((k) => env[k] === undefined)) {
      ctx.addIssue({ code: "custom", path: [key], message: `is required when AI_PROVIDER is ${env.AI_PROVIDER}` })
    }

    const smtpKeys = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"] as const
    const provided = smtpKeys.filter((key) => env[key] !== undefined)
    if (provided.length > 0 && provided.length < smtpKeys.length) {
      for (const key of smtpKeys.filter((k) => env[k] === undefined)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "is required when any SMTP_* variable is set",
        })
      }
    }
  })

export type Env = z.infer<typeof envSchema>

let cached: Env | undefined

/**
 * Validated server-side environment. Throws on first access if anything is
 * missing or malformed. Error messages name the variables but never include
 * their values.
 */
export function getEnv(): Env {
  if (cached) return cached

  // Treat empty strings (e.g. `SMTP_HOST=` in .env) as unset.
  const raw = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== "")
  )

  const result = envSchema.safeParse(raw)
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => {
        const key = issue.path.join(".")
        const message = raw[key] === undefined ? "is missing" : issue.message
        return `  - ${key}: ${message}`
      })
      .join("\n")
    throw new Error(
      `Invalid environment configuration:\n${problems}\n\nSee .env.example for the expected variables.`
    )
  }

  cached = result.data
  return cached
}
