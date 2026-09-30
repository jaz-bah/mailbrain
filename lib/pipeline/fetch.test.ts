import { describe, expect, it, vi } from "vitest"

import { GmailClient, type ImapSession } from "@/lib/gmail/client"

import { DEFAULT_SCAN_QUERY, MAX_BATCH_SIZE, fetchEmailBatch } from "./fetch"
import { MAX_SOURCE_BYTES } from "./normalize"

type SearchQuery = { gmraw?: string; or?: { emailId: string }[] }

const ALL_UIDS = [101, 102, 103, 104, 105]
const emailId = (uid: number) => `1${uid}`

function source(uid: number) {
  return Buffer.from(`From: sender${uid}@example.com\r\nSubject: Message ${uid}\r\nContent-Type: text/plain\r\n\r\nBody ${uid}`)
}

function fakeGmail({ brokenUid }: { brokenUid?: number } = {}) {
  const session = {
    list: vi.fn(async () => [{ path: "[Gmail]/All Mail", specialUse: "\\All", flags: new Set() }]),
    getMailboxLock: vi.fn(async () => ({ path: "", release: vi.fn() })),
    search: vi.fn(async (query: SearchQuery) => {
      if (query.or) {
        const wanted = new Set(query.or.map((q) => q.emailId))
        return ALL_UIDS.filter((uid) => wanted.has(emailId(uid)))
      }
      return ALL_UIDS
    }),
    fetchAll: vi.fn(async (uids: number[], fields: { source?: unknown }) =>
      uids.map((uid) => ({
        seq: uid,
        uid,
        emailId: emailId(uid),
        threadId: `9${uid}`,
        ...(fields.source ? { source: uid === brokenUid ? undefined : source(uid), envelope: {} } : {}),
      }))
    ),
  }
  return { session, gmail: new GmailClient(session as unknown as ImapSession) }
}

describe("fetchEmailBatch", () => {
  it("fetches, normalises and pages newest first with the default scan window", async () => {
    const { gmail, session } = fakeGmail()
    const first = await fetchEmailBatch(gmail, { batchSize: 2 })

    expect(session.search).toHaveBeenCalledWith({ gmraw: DEFAULT_SCAN_QUERY }, { uid: true })
    expect(first.emails.map((e) => [e.id, e.subject, e.body])).toEqual([
      ["1105", "Message 105", "Body 105"],
      ["1104", "Message 104", "Body 104"],
    ])
    expect(first.nextPageToken).toBe("104")

    const second = await fetchEmailBatch(gmail, { batchSize: 2, pageToken: first.nextPageToken })
    const third = await fetchEmailBatch(gmail, { batchSize: 2, pageToken: second.nextPageToken })
    expect([...second.emails, ...third.emails].map((e) => e.id)).toEqual(["1103", "1102", "1101"])
    expect(third.nextPageToken).toBeUndefined()
  })

  it("caps the source size per message", async () => {
    const { gmail, session } = fakeGmail()
    await fetchEmailBatch(gmail)
    const [, fields] = session.fetchAll.mock.calls.at(-1)!
    expect(fields).toMatchObject({ source: { maxLength: MAX_SOURCE_BYTES } })
  })

  it("clamps the batch size", async () => {
    const { gmail } = fakeGmail()
    ALL_UIDS.push(...Array.from({ length: 60 }, (_, i) => 200 + i))
    try {
      const batch = await fetchEmailBatch(gmail, { batchSize: 500 })
      expect(batch.emails).toHaveLength(MAX_BATCH_SIZE)
      expect(batch.nextPageToken).toBeDefined()
    } finally {
      ALL_UIDS.length = 5
    }
  })

  it("skips known messages before downloading anything", async () => {
    const { gmail, session } = fakeGmail()
    const isKnown = vi.fn(async () => new Set(["1105", "1103"]))
    const batch = await fetchEmailBatch(gmail, { batchSize: 3, isKnown })

    expect(isKnown).toHaveBeenCalledWith(["1105", "1104", "1103"])
    expect(batch.skipped).toBe(2)
    expect(batch.emails.map((e) => e.id)).toEqual(["1104"])
    const sourceFetch = session.fetchAll.mock.calls.find(([, fields]) => fields.source)!
    expect(sourceFetch[0]).toEqual([104])
  })

  it("doesn't fetch sources when everything is known", async () => {
    const { gmail, session } = fakeGmail()
    const batch = await fetchEmailBatch(gmail, { batchSize: 2, isKnown: async (ids) => new Set(ids) })
    expect(batch).toMatchObject({ emails: [], skipped: 2, nextPageToken: "104" })
    expect(session.fetchAll.mock.calls.some(([, fields]) => fields.source)).toBe(false)
  })

  it("reports messages that can't be normalised without failing the batch", async () => {
    const { gmail } = fakeGmail({ brokenUid: 104 })
    vi.spyOn(console, "error").mockImplementation(() => {})
    const batch = await fetchEmailBatch(gmail, { batchSize: 2 })
    expect(batch.emails.map((e) => e.id)).toEqual(["1105"])
    expect(batch.failed).toEqual([{ id: "1104", threadId: "9104" }])
  })
})
