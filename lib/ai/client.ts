import "server-only"

import type { z } from "zod"

import { AiError } from "@/lib/ai/errors"
import { getEnv } from "@/lib/env"

// An OpenAI-compatible Chat Completions client for the AI providers MailBrain
// supports (AI_PROVIDER):
// - openrouter: https://openrouter.ai/docs/api-reference/overview
// - gemini:     https://ai.google.dev/gemini-api/docs/openai

const REQUEST_TIMEOUT_MS = 30_000
/** Retries for 429, 5xx, timeouts and network errors. */
const MAX_TRANSIENT_RETRIES = 3
/** Retries when the reply isn't schema-valid JSON (ROADMAP Phase 7). */
const MAX_INVALID_RETRIES = 2
const BASE_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000
/** A limit that resets later than this isn't worth waiting for inside a scan. */
const MAX_QUOTA_WAIT_MS = 60_000

export type AiProvider = "openrouter" | "gemini"

export type ChatMessage = { role: "system" | "user"; content: string }

export type JsonSchemaFormat = {
  name: string
  strict: boolean
  schema: Record<string, unknown>
}

export type JsonCompletion<T> = {
  data: T
  /** The model that actually answered (a provider may resolve aliases). */
  model: string
  usage?: { promptTokens: number; completionTokens: number }
  attempts: number
}

type ChatResponse = {
  model?: string
  choices?: {
    message?: { content?: string | null }
    finish_reason?: string | null
    error?: { code?: number; message?: string }
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { code?: number; message?: string }
}

export type AiClientConfig = {
  provider: AiProvider
  apiKey: string
  model: string
  /** OpenRouter: sent as HTTP-Referer for app attribution. */
  appUrl?: string
  /**
   * OpenRouter: allow providers that keep or train on prompts (needed for
   * free models). Default false: only providers that don't retain data.
   */
  allowDataCollection?: boolean
  /** Minimum gap between request starts, to stay under a per-minute limit. */
  minIntervalMs?: number
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const PROVIDERS = {
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
    label: "OpenRouter",
    // Room for the JSON reply.
    maxTokens: 800,
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    label: "Gemini",
    // Gemini 3 models always think, and thinking tokens count towards the limit.
    maxTokens: 4_096,
  },
} as const

/** Request gaps that keep free tiers under their per-minute limits. */
export const FREE_TIER_MIN_INTERVAL_MS = {
  /** OpenRouter `:free` models: 20 requests/minute. */
  openrouter: 3_100,
  /** Gemini free tier: Flash-Lite allows about 15 requests/minute. */
  gemini: 4_100,
} as const

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function backoff(attempt: number, retryAfterMs: number | null) {
  if (retryAfterMs !== null && retryAfterMs > 0) return Math.min(retryAfterMs, MAX_BACKOFF_MS)
  const exponential = BASE_BACKOFF_MS * 2 ** attempt
  return Math.min(exponential + Math.random() * BASE_BACKOFF_MS, MAX_BACKOFF_MS)
}

/** Retry-After header (seconds), or Gemini's RetryInfo `"retryDelay": "30s"`. */
function retryAfterMs(headers: Headers, body: string) {
  const header = Number(headers.get("Retry-After"))
  if (Number.isFinite(header) && header > 0) return header * 1000
  const delay = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/)
  return delay ? Number(delay[1]) * 1000 : null
}

/**
 * A 429 that won't clear within the scan, so retrying only burns more quota
 * (failed requests count too):
 * - OpenRouter: X-RateLimit-Remaining 0 with a reset more than a minute away
 * - Gemini: a per-day quota violation (quotaId "...PerDay...")
 * Returns a note for the logs, or null if it's worth retrying.
 */
function quotaExhausted(headers: Headers, body: string, now: number): string | null {
  if (headers.get("X-RateLimit-Remaining") === "0") {
    const raw = Number(headers.get("X-RateLimit-Reset"))
    if (Number.isFinite(raw) && raw > 0) {
      const resetAt = raw < 1e12 ? raw * 1000 : raw // seconds or milliseconds
      if (resetAt - now > MAX_QUOTA_WAIT_MS) return `resets at ${new Date(resetAt).toISOString()}`
    }
  }
  if (/PerDay/i.test(body)) return "daily quota exceeded"
  return null
}

function errorForStatus(
  status: number,
  body: string,
  hasRetryAfter: boolean,
  label: string
): { error: AiError; retry: boolean } {
  // Gemini reports a bad key as 400 INVALID_ARGUMENT / API_KEY_INVALID.
  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid/i.test(body))
    return { error: new AiError("AI_AUTH_FAILED", `${label} rejected the API key`, status), retry: false }
  if (status === 402)
    return {
      error: new AiError("AI_NO_CREDITS", `${label} account is out of credits`, status),
      // A 402 with Retry-After is OpenRouter's temporary in-flight budget limit.
      retry: hasRetryAfter,
    }
  if (status === 429)
    return { error: new AiError("AI_RATE_LIMITED", `${label} rate limit reached`, status), retry: true }
  if (status === 408 || status >= 500)
    return { error: new AiError("AI_UNAVAILABLE", "The AI provider is unavailable", status), retry: true }
  if (status === 400 || status === 404)
    return { error: new AiError("AI_BAD_REQUEST", `${label} refused the request. Check the model setting.`, status), retry: false }
  return { error: new AiError("AI_ERROR", `${label} returned HTTP ${status}`, status), retry: false }
}

/**
 * The provider's error message from a failed response. It describes the
 * request (model, parameters, quota), never message content. Short, for logs only.
 */
function errorDetail(body: string) {
  try {
    const parsed = JSON.parse(body) as ChatResponse | ChatResponse[]
    const first = Array.isArray(parsed) ? parsed[0] : parsed // Gemini may wrap errors in an array
    return first?.error?.message?.slice(0, 200)
  } catch {
    return undefined
  }
}

/** Parses JSON from a reply, tolerating a Markdown code fence or text around the object. */
export function extractJson(content: string): unknown {
  const trimmed = content.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const text = fenced ? fenced[1] : trimmed
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1))
      } catch {
        // fall through
      }
    }
    throw new AiError("AI_INVALID_RESPONSE", "The AI reply wasn't valid JSON")
  }
}

const RETRY_INSTRUCTION: ChatMessage = {
  role: "system",
  content:
    "Your previous reply was not valid JSON matching the required schema. Reply again with only the JSON object, no other text.",
}

export function createAiClient({
  provider,
  apiKey,
  model,
  appUrl,
  allowDataCollection = false,
  minIntervalMs = 0,
  fetch: fetchImpl = fetch,
  sleep = wait,
  now = Date.now,
}: AiClientConfig) {
  const { url, label, maxTokens } = PROVIDERS[provider]

  // Spaces out request starts (shared by concurrent callers of this client).
  let nextSlot = 0
  async function pace() {
    if (minIntervalMs <= 0) return
    const current = now()
    const start = Math.max(current, nextSlot)
    nextSlot = start + minIntervalMs
    if (start > current) await sleep(start - current)
  }

  function requestBody(messages: ChatMessage[], jsonSchema: JsonSchemaFormat) {
    return {
      model,
      messages,
      temperature: 0,
      max_tokens: maxTokens,
      // Enforced by models that support structured outputs; every reply is
      // validated anyway.
      response_format: { type: "json_schema", json_schema: jsonSchema },
      ...(provider === "openrouter" && {
        // Email content only goes to providers that don't store or train on
        // it, unless OPENROUTER_ALLOW_DATA_COLLECTION opts out (free models).
        provider: { data_collection: allowDataCollection ? "allow" : "deny" },
      }),
      // Classification needs little reasoning; less thinking is faster and cheaper.
      ...(provider === "gemini" && { reasoning_effort: "low" }),
    }
  }

  /** One completion, retrying transient failures. Returns the raw reply text. */
  async function complete(messages: ChatMessage[], jsonSchema: JsonSchemaFormat) {
    for (let attempt = 0; ; attempt++) {
      let response: Response
      await pace()
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            ...(provider === "openrouter" && {
              ...(appUrl && { "HTTP-Referer": appUrl }),
              "X-OpenRouter-Title": "MailBrain",
            }),
          },
          body: JSON.stringify(requestBody(messages, jsonSchema)),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch {
        // Network error or timeout.
        if (attempt < MAX_TRANSIENT_RETRIES) {
          await sleep(backoff(attempt, null))
          continue
        }
        throw new AiError("AI_UNAVAILABLE", `Couldn't reach ${label}`)
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "")
        const quota = response.status === 429 ? quotaExhausted(response.headers, body, now()) : null
        if (quota) throw new AiError("AI_QUOTA_EXCEEDED", `${label} request quota used up`, 429, quota)

        const hint = retryAfterMs(response.headers, body)
        const { error, retry } = errorForStatus(response.status, body, response.headers.has("Retry-After"), label)
        if (retry && attempt < MAX_TRANSIENT_RETRIES) {
          await sleep(backoff(attempt, hint))
          continue
        }
        throw new AiError(error.code, error.message, error.status, errorDetail(body))
      }

      let body: ChatResponse
      try {
        body = (await response.json()) as ChatResponse
      } catch {
        throw new AiError("AI_INVALID_RESPONSE", `${label} returned a non-JSON body`)
      }

      const choice = body.choices?.[0]
      // A provider can fail after the response started: 200 with finish_reason "error".
      if (body.error || choice?.finish_reason === "error" || choice?.error) {
        if (attempt < MAX_TRANSIENT_RETRIES) {
          await sleep(backoff(attempt, null))
          continue
        }
        throw new AiError("AI_UNAVAILABLE", "The AI provider failed mid-response")
      }

      return {
        content: choice?.message?.content ?? null,
        truncated: choice?.finish_reason === "length",
        model: body.model ?? model,
        usage: body.usage && {
          promptTokens: body.usage.prompt_tokens ?? 0,
          completionTokens: body.usage.completion_tokens ?? 0,
        },
      }
    }
  }

  /**
   * Requests JSON matching `jsonSchema` and validates it with `schema`.
   * Invalid output is retried up to MAX_INVALID_RETRIES times, then thrown as
   * AI_INVALID_RESPONSE. Unvalidated output is never returned.
   */
  async function completeJson<S extends z.ZodType>(
    messages: ChatMessage[],
    { jsonSchema, schema }: { jsonSchema: JsonSchemaFormat; schema: S }
  ): Promise<JsonCompletion<z.output<S>>> {
    for (let attempt = 1; ; attempt++) {
      const reply = await complete(attempt === 1 ? messages : [...messages, RETRY_INSTRUCTION], jsonSchema)
      try {
        if (reply.content === null || reply.truncated) {
          throw new AiError("AI_INVALID_RESPONSE", "The AI reply was empty or cut off")
        }
        const parsed = schema.safeParse(extractJson(reply.content))
        if (!parsed.success) throw new AiError("AI_INVALID_RESPONSE", "The AI reply didn't match the schema")
        return { data: parsed.data, model: reply.model, usage: reply.usage, attempts: attempt }
      } catch (error) {
        if (attempt > MAX_INVALID_RETRIES) throw error
      }
    }
  }

  return { provider, model, completeJson }
}

export type AiClient = ReturnType<typeof createAiClient>

let client: AiClient | undefined

/**
 * The app's AI client, chosen by AI_PROVIDER. The model comes from env
 * (GEMINI_MODEL or OPENROUTER_MODEL), so switching needs only an env change
 * and a restart.
 */
export function getAiClient(): AiClient {
  if (client) return client
  const env = getEnv()
  const intervalOverride = env.AI_MIN_INTERVAL_MS

  if (env.AI_PROVIDER === "gemini") {
    client = createAiClient({
      provider: "gemini",
      apiKey: env.GEMINI_API_KEY!,
      model: env.GEMINI_MODEL,
      minIntervalMs: intervalOverride ?? FREE_TIER_MIN_INTERVAL_MS.gemini,
    })
  } else {
    const model = env.OPENROUTER_MODEL!
    client = createAiClient({
      provider: "openrouter",
      apiKey: env.OPENROUTER_API_KEY!,
      model,
      appUrl: env.BETTER_AUTH_URL,
      allowDataCollection: env.OPENROUTER_ALLOW_DATA_COLLECTION,
      minIntervalMs: intervalOverride ?? (model.endsWith(":free") ? FREE_TIER_MIN_INTERVAL_MS.openrouter : 0),
    })
  }
  return client
}
