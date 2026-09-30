import { beforeEach, describe, expect, it, vi } from "vitest"

import type { GmailMessage } from "@/lib/gmail/types"

const mocks = vi.hoisted(() => ({
  findMatchesWithoutHeaders: vi.fn(),
  setMatchHeaders: vi.fn(),
  getMessageHeaders: vi.fn(),
}))

vi.mock("@/lib/db/classifications", () => ({
  findMatchesWithoutHeaders: mocks.findMatchesWithoutHeaders,
  setMatchHeaders: mocks.setMatchHeaders,
}))
vi.mock("@/lib/gmail/client", () => ({ withGmail: vi.fn(async (_u: string, _a: string, fn: (g: object) => unknown) => fn({})) }))
vi.mock("@/lib/gmail/messages", () => ({ getMessageHeaders: mocks.getMessageHeaders }))

import { backfillMatchHeaders } from "./backfill-headers"

function message(id: string): GmailMessage {
  return {
    id,
    threadId: "t",
    labels: [],
    flags: [],
    internalDate: new Date("2026-09-29T10:00:00Z"),
    size: 100,
    envelope: {
      date: new Date("2026-09-29T09:59:00Z"),
      subject: "  Invoice   #12 ",
      messageId: null,
      from: [{ name: "Acme Billing", address: "billing@acme.test" }],
      to: [],
      cc: [],
    },
  }
}

beforeEach(() => vi.clearAllMocks())

describe("backfillMatchHeaders", () => {
  it("does nothing, without a Gmail session, when every match has headers", async () => {
    mocks.findMatchesWithoutHeaders.mockResolvedValue([])
    expect(await backfillMatchHeaders("u1", "a1")).toBe(0)
    expect(mocks.getMessageHeaders).not.toHaveBeenCalled()
  })

  it("fills headers from the envelope and marks emails that are gone", async () => {
    mocks.findMatchesWithoutHeaders.mockResolvedValue(["1", "2"])
    mocks.getMessageHeaders.mockResolvedValue([message("1")])

    await backfillMatchHeaders("u1", "a1")

    const headers: Map<string, unknown> = mocks.setMatchHeaders.mock.calls[0][2]
    expect(headers.get("1")).toEqual({
      from: "Acme Billing <billing@acme.test>",
      subject: "Invoice #12",
      date: "2026-09-29T09:59:00.000Z",
    })
    expect(headers.get("2")).toBeNull()
  })
})
