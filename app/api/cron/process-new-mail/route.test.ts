import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ env: {} as { CRON_SECRET?: string }, runAutoProcessing: vi.fn() }))

vi.mock("@/lib/env", () => ({ getEnv: () => mocks.env }))
vi.mock("@/lib/pipeline/auto-process", () => ({ runAutoProcessing: mocks.runAutoProcessing }))

import { GET } from "./route"

const SECRET = "s".repeat(40)
const call = (authorization?: string) =>
  GET(new Request("http://localhost/api/cron/process-new-mail", { headers: authorization ? { authorization } : {} }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.env = { CRON_SECRET: SECRET }
  mocks.runAutoProcessing.mockResolvedValue([
    { accountId: "a1", status: "processed", processed: 3, classified: 2, remaining: false },
    { accountId: "a2", status: "error", processed: 0, classified: 0, remaining: false, error: "AI_QUOTA_EXCEEDED" },
  ])
})

describe("GET /api/cron/process-new-mail", () => {
  it("is off (404) when CRON_SECRET isn't configured", async () => {
    mocks.env = {}
    expect((await call(`Bearer ${SECRET}`)).status).toBe(404)
    expect(mocks.runAutoProcessing).not.toHaveBeenCalled()
  })

  it.each([undefined, "Bearer wrong", `Bearer ${SECRET}x`, SECRET])("rejects %s", async (header) => {
    expect((await call(header)).status).toBe(401)
    expect(mocks.runAutoProcessing).not.toHaveBeenCalled()
  })

  it("runs with the right secret and returns counts only", async () => {
    const response = await call(`Bearer ${SECRET}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      mailboxes: 2,
      processed: 3,
      classified: 2,
      errors: ["AI_QUOTA_EXCEEDED"],
    })
  })
})
