import { describe, expect, it } from "vitest"

import { toInboxItem } from "./inbox"
import type { GmailMessage } from "./types"

const message = (overrides: Partial<GmailMessage> = {}): GmailMessage => ({
  id: "1766",
  threadId: "1765",
  labels: ["\\Inbox"],
  flags: ["\\Seen"],
  internalDate: new Date("2026-09-30T08:15:00Z"),
  size: 1200,
  envelope: {
    date: new Date("2026-09-30T08:14:00Z"),
    subject: "  Your invoice  ",
    messageId: null,
    from: [{ name: "Acme Billing", address: "billing@acme.test" }],
    to: [],
    cc: [],
  },
  ...overrides,
})

describe("toInboxItem", () => {
  it("maps headers to a row with a Gmail link for the account", () => {
    expect(toInboxItem(message(), "me@example.com")).toEqual({
      id: "1766",
      from: "Acme Billing",
      subject: "Your invoice",
      date: "2026-09-30T08:15:00.000Z",
      unread: false,
      gmailUrl: "https://mail.google.com/mail/?authuser=me%40example.com#all/6e6",
    })
  })

  it("falls back to the address, the Date header and marks unread mail", () => {
    const item = toInboxItem(
      message({
        flags: [],
        internalDate: null,
        envelope: { ...message().envelope, from: [{ address: "noreply@x.test" }] },
      }),
      "me@example.com"
    )
    expect(item).toMatchObject({ from: "noreply@x.test", date: "2026-09-30T08:14:00.000Z", unread: true })
  })

  it("handles a missing sender and date", () => {
    const item = toInboxItem(
      message({ internalDate: null, envelope: { ...message().envelope, from: [], date: null } }),
      "me@example.com"
    )
    expect(item).toMatchObject({ from: "Unknown sender", date: null })
  })
})
