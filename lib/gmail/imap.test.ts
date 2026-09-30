import { beforeEach, describe, expect, it, vi } from "vitest"

const fakeImapFlow = vi.hoisted(() => ({
  instance: null as null | {
    usable: boolean
    connect: ReturnType<typeof vi.fn>
    logout: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    list: ReturnType<typeof vi.fn>
  },
}))

vi.mock("imapflow", () => ({
  ImapFlow: vi.fn(function ImapFlow() {
    return fakeImapFlow.instance
  }),
}))

import { GmailClient, withGmailCredentials, type ImapSession } from "./client"
import { gmailConnectSchema } from "./connect-schema"
import { GmailError, toGmailError } from "./errors"
import { addLabel, addLabelToMessages, createLabel, deleteLabel, getLabels, removeLabel, renameLabel } from "./labels"
import { getMessage, getMessages } from "./messages"
import { gmailWebUrl } from "./types"

type Mailbox = { path: string; specialUse?: string; flags: Set<string> }

const MAILBOXES: Mailbox[] = [
  { path: "INBOX", specialUse: "\\Inbox", flags: new Set() },
  { path: "[Gmail]", flags: new Set(["\\Noselect"]) },
  // Localised name: must be found by special-use flag, not by name.
  { path: "[Gmail]/Alle Nachrichten", specialUse: "\\All", flags: new Set() },
  { path: "AI/Invoices", flags: new Set() },
]

function imapError(fields: Record<string, unknown>) {
  return Object.assign(new Error("Command failed"), fields)
}

function fakeSession(overrides: Partial<Record<keyof ImapSession, unknown>> = {}) {
  const release = vi.fn()
  const session = {
    list: vi.fn(async () => MAILBOXES),
    getMailboxLock: vi.fn(async () => ({ path: "", release })),
    search: vi.fn(async () => [] as number[]),
    fetchAll: vi.fn(async () => []),
    fetchOne: vi.fn(async () => false),
    messageFlagsAdd: vi.fn(async () => true),
    messageFlagsRemove: vi.fn(async () => true),
    mailboxCreate: vi.fn(async (path: string) => ({ path, created: true })),
    mailboxRename: vi.fn(async (path: string, newPath: string) => ({ path, newPath })),
    mailboxDelete: vi.fn(async (path: string) => ({ path })),
    ...overrides,
  }
  return { session, release, gmail: new GmailClient(session as unknown as ImapSession) }
}

describe("GmailClient", () => {
  it("finds All Mail by its special-use flag and releases the lock", async () => {
    const { gmail, session, release } = fakeSession()
    await gmail.inAllMail(async () => "done")
    expect(session.getMailboxLock).toHaveBeenCalledWith("[Gmail]/Alle Nachrichten")
    expect(release).toHaveBeenCalledOnce()
  })

  it("reads All Mail's UIDVALIDITY (a bigint) and UIDNEXT for the automatic-processing cursor", async () => {
    const { gmail } = fakeSession({ mailbox: { path: "[Gmail]/Alle Nachrichten", uidValidity: BigInt("123456789012345"), uidNext: 5001 } })
    expect(await gmail.allMailStatus()).toEqual({ uidValidity: "123456789012345", uidNext: 5001 })
  })

  it("reports IMAP_DISABLED when All Mail is hidden from IMAP", async () => {
    const { gmail } = fakeSession({ list: vi.fn(async () => MAILBOXES.filter((m) => m.specialUse !== "\\All")) })
    await expect(gmail.allMail()).rejects.toMatchObject({ code: "IMAP_DISABLED" })
  })
})

describe("withGmailCredentials", () => {
  const credentials = { email: "me@gmail.com", appPassword: "abcdefghijklmnop" }

  function setInstance(connect: () => Promise<void>, usableAfterConnect: boolean) {
    const instance = {
      usable: false,
      connect: vi.fn(async () => {
        await connect()
        instance.usable = usableAfterConnect
      }),
      logout: vi.fn(async () => {}),
      close: vi.fn(),
      on: vi.fn(),
      list: vi.fn(async () => MAILBOXES),
    }
    fakeImapFlow.instance = instance
    return instance
  }

  it("closes the socket (not logout) after a failed login, and maps the error", async () => {
    const imap = setInstance(async () => {
      throw imapError({ authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" })
    }, false)

    await expect(withGmailCredentials(credentials, async () => "never")).rejects.toMatchObject({
      code: "GMAIL_AUTH_FAILED",
    })
    expect(imap.close).toHaveBeenCalledOnce()
    expect(imap.logout).not.toHaveBeenCalled()
  })

  it("logs out after a successful session, even when the callback throws", async () => {
    const imap = setInstance(async () => {}, true)

    await expect(
      withGmailCredentials(credentials, async () => {
        throw imapError({ serverResponseCode: "NONEXISTENT" })
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(imap.logout).toHaveBeenCalledOnce()
  })
})

describe("getMessages", () => {
  let uids: number[]
  beforeEach(() => {
    uids = [101, 105, 103, 104, 102]
  })

  function sessionWithMessages() {
    return fakeSession({
      search: vi.fn(async () => uids),
      fetchAll: vi.fn(async (range: number[]) =>
        range.map((uid) => ({ seq: uid, uid, emailId: `1${uid}`, threadId: `9${uid}` }))
      ),
    })
  }

  it("searches with Gmail syntax and returns newest first", async () => {
    const { gmail, session } = sessionWithMessages()
    const page = await getMessages(gmail, { query: "newer_than:30d", maxResults: 2 })

    expect(session.search).toHaveBeenCalledWith({ gmraw: "newer_than:30d" }, { uid: true })
    expect(page.messages).toEqual([
      { id: "1105", threadId: "9105" },
      { id: "1104", threadId: "9104" },
    ])
    expect(page.nextPageToken).toBe("104")
  })

  it("pages by UID until there are no more", async () => {
    const { gmail } = sessionWithMessages()
    const second = await getMessages(gmail, { maxResults: 2, pageToken: "104" })
    expect(second.messages.map((m) => m.id)).toEqual(["1103", "1102"])
    const last = await getMessages(gmail, { maxResults: 2, pageToken: second.nextPageToken })
    expect(last.messages.map((m) => m.id)).toEqual(["1101"])
    expect(last.nextPageToken).toBeUndefined()
  })

  it("searches everything when no query is given", async () => {
    const { gmail, session } = sessionWithMessages()
    await getMessages(gmail)
    expect(session.search).toHaveBeenCalledWith({ all: true }, { uid: true })
  })
})

describe("getMessage", () => {
  it("looks the message up by X-GM-MSGID and maps the envelope", async () => {
    const { gmail, session } = fakeSession({
      search: vi.fn(async () => [42]),
      fetchOne: vi.fn(async () => ({
        seq: 1,
        uid: 42,
        emailId: "1766",
        threadId: "1765",
        labels: new Set(["\\Inbox", "AI/Invoices"]),
        flags: new Set(["\\Seen"]),
        internalDate: new Date("2026-09-29T10:00:00Z"),
        size: 2048,
        envelope: {
          subject: "Invoice #12",
          date: new Date("2026-09-29T09:59:00Z"),
          from: [{ name: "Acme", address: "billing@acme.test" }],
          to: [{ address: "me@example.com" }],
        },
      })),
    })

    const message = await getMessage(gmail, "1766")

    expect(session.search).toHaveBeenCalledWith({ emailId: "1766" }, { uid: true })
    expect(session.fetchOne).toHaveBeenCalledWith("42", expect.objectContaining({ source: false }), { uid: true })
    expect(message).toMatchObject({
      id: "1766",
      threadId: "1765",
      labels: ["\\Inbox", "AI/Invoices"],
      envelope: { subject: "Invoice #12", from: [{ name: "Acme", address: "billing@acme.test" }], cc: [] },
    })
  })

  it("throws NOT_FOUND for an unknown message", async () => {
    const { gmail } = fakeSession({ search: vi.fn(async () => []) })
    await expect(getMessage(gmail, "404")).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("labels", () => {
  it("lists selectable labels and classifies system ones", async () => {
    const { gmail } = fakeSession()
    const labels = await getLabels(gmail)
    expect(labels.map((l) => [l.id, l.type])).toEqual([
      ["INBOX", "system"],
      ["[Gmail]/Alle Nachrichten", "system"],
      ["AI/Invoices", "user"],
    ])
  })

  it("reuses an existing label regardless of case", async () => {
    const { gmail, session } = fakeSession()
    const label = await createLabel(gmail, "ai/invoices")
    expect(label.id).toBe("AI/Invoices")
    expect(session.mailboxCreate).not.toHaveBeenCalled()
  })

  it("creates a missing label", async () => {
    const { gmail, session } = fakeSession()
    const label = await createLabel(gmail, "AI/Travel")
    expect(session.mailboxCreate).toHaveBeenCalledWith("AI/Travel")
    expect(label.id).toBe("AI/Travel")
  })

  it("recovers when the label was created concurrently", async () => {
    let lists = 0
    const { gmail } = fakeSession({
      list: vi.fn(async () =>
        ++lists === 1 ? MAILBOXES : [...MAILBOXES, { path: "AI/Travel", flags: new Set() }]
      ),
      mailboxCreate: vi.fn(async () => {
        throw imapError({ serverResponseCode: "ALREADYEXISTS" })
      }),
    })
    expect((await createLabel(gmail, "AI/Travel")).id).toBe("AI/Travel")
  })

  it("returns the new path as the ID after a rename", async () => {
    const { gmail } = fakeSession()
    expect((await renameLabel(gmail, "AI/Invoices", "AI/Bills")).id).toBe("AI/Bills")
  })

  it("refuses to rename or delete labels MailBrain doesn't own", async () => {
    const { gmail, session } = fakeSession()
    await expect(renameLabel(gmail, "INBOX", "AI/x")).rejects.toBeInstanceOf(GmailError)
    await expect(deleteLabel(gmail, "[Gmail]/Alle Nachrichten")).rejects.toBeInstanceOf(GmailError)
    await expect(deleteLabel(gmail, "AI/")).rejects.toBeInstanceOf(GmailError)
    expect(session.mailboxRename).not.toHaveBeenCalled()
    expect(session.mailboxDelete).not.toHaveBeenCalled()
  })

  it("treats deleting a missing label as done", async () => {
    const { gmail } = fakeSession({
      mailboxDelete: vi.fn(async () => {
        throw imapError({ serverResponseCode: "NONEXISTENT" })
      }),
    })
    await expect(deleteLabel(gmail, "AI/Gone")).resolves.toBeUndefined()
  })

  it("labels many messages with one search and one STORE, reporting missing ones", async () => {
    const { gmail, session } = fakeSession({
      search: vi.fn(async () => [7, 9]),
      fetchAll: vi.fn(async () => [
        { seq: 1, uid: 7, emailId: "1766", threadId: "1" },
        { seq: 2, uid: 9, emailId: "1767", threadId: "2" },
      ]),
    })
    const result = await addLabelToMessages(gmail, ["1766", "1767", "1768"], "AI/Invoices")

    expect(session.search).toHaveBeenCalledWith(
      { or: [{ emailId: "1766" }, { emailId: "1767" }, { emailId: "1768" }] },
      { uid: true }
    )
    expect(session.messageFlagsAdd).toHaveBeenCalledOnce()
    expect(session.messageFlagsAdd).toHaveBeenCalledWith("7,9", ["AI/Invoices"], { uid: true, useLabels: true })
    expect(result).toEqual({ labelled: ["1766", "1767"], missing: ["1768"] })
  })

  it("only ever applies MailBrain's own labels in bulk", async () => {
    const { gmail, session } = fakeSession()
    await expect(addLabelToMessages(gmail, ["1766"], "INBOX")).rejects.toBeInstanceOf(GmailError)
    await expect(addLabelToMessages(gmail, ["1766"], "[Gmail]/Trash")).rejects.toBeInstanceOf(GmailError)
    expect(session.messageFlagsAdd).not.toHaveBeenCalled()
  })

  it("adds and removes Gmail labels (not IMAP flags) by UID", async () => {
    const { gmail, session } = fakeSession({ search: vi.fn(async () => [7]) })
    await addLabel(gmail, "1766", ["AI/Invoices"])
    await removeLabel(gmail, "1766", ["AI/Invoices"])
    expect(session.messageFlagsAdd).toHaveBeenCalledWith("7", ["AI/Invoices"], { uid: true, useLabels: true })
    expect(session.messageFlagsRemove).toHaveBeenCalledWith("7", ["AI/Invoices"], { uid: true, useLabels: true })
  })
})

describe("toGmailError", () => {
  it.each([
    [{ authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" }, "GMAIL_AUTH_FAILED"],
    [{ authenticationFailed: true, response: "[ALERT] Application-specific password required" }, "APP_PASSWORD_REQUIRED"],
    [{ authenticationFailed: true, response: "[ALERT] Your account is not enabled for IMAP use." }, "IMAP_DISABLED"],
    [{ serverResponseCode: "OVERQUOTA" }, "RATE_LIMITED"],
    [{ response: "Too many simultaneous connections. (Failure)" }, "RATE_LIMITED"],
    [{ serverResponseCode: "NONEXISTENT" }, "NOT_FOUND"],
    [{ serverResponseCode: "ALREADYEXISTS" }, "CONFLICT"],
    [{ code: "ETIMEDOUT" }, "GMAIL_ERROR"],
  ])("maps %o to %s", (fields, code) => {
    expect(toGmailError(imapError(fields)).code).toBe(code)
  })

  it("never includes the server's raw response text in the message", () => {
    const error = toGmailError(imapError({ authenticationFailed: true, response: "secret-ish details" }))
    expect(error.message).not.toContain("secret-ish")
  })
})

describe("gmailConnectSchema", () => {
  it("accepts app passwords with or without spaces and normalises the email", () => {
    const result = gmailConnectSchema.parse({ email: " Me@Gmail.com ", appPassword: "abcd efgh ijkl mnop" })
    expect(result).toEqual({ email: "me@gmail.com", appPassword: "abcdefghijklmnop" })
  })

  it("rejects things that aren't app passwords", () => {
    expect(gmailConnectSchema.safeParse({ email: "me@gmail.com", appPassword: "hunter2" }).success).toBe(false)
    expect(gmailConnectSchema.safeParse({ email: "not-an-email", appPassword: "abcdefghijklmnop" }).success).toBe(false)
  })
})

describe("gmailWebUrl", () => {
  it("converts X-GM-MSGID to the hex ID the Gmail web UI uses, without precision loss", () => {
    // 2^64 - 1: far beyond Number.MAX_SAFE_INTEGER, so this fails if the conversion uses floats.
    expect(gmailWebUrl("18446744073709551615")).toBe("https://mail.google.com/mail/#all/ffffffffffffffff")
    expect(gmailWebUrl("255", "me@gmail.com")).toBe(
      "https://mail.google.com/mail/?authuser=me%40gmail.com#all/ff"
    )
  })
})
