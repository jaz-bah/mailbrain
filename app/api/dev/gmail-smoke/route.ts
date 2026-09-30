import { NextResponse } from "next/server"

import { getSession } from "@/lib/auth/session"
import { listEmailAccounts } from "@/lib/db/email-accounts"
import { withGmail } from "@/lib/gmail/client"
import { GmailError } from "@/lib/gmail/errors"
import { addLabel, createLabel, deleteLabel, getLabels, removeLabel } from "@/lib/gmail/labels"
import { getMessage, getMessages } from "@/lib/gmail/messages"
import { getThread } from "@/lib/gmail/threads"
import { fetchEmailBatch } from "@/lib/pipeline/fetch"
import { BODY_CHAR_BUDGET, HTML_TAG_PATTERN, looksLikeHtml } from "@/lib/pipeline/normalize"

const TEST_LABEL = "AI/MailBrain Smoke Test"

/**
 * Development only: runs every Gmail operation against the signed-in user's
 * connected mailbox (ROADMAP Phase 4 exit criteria). Returns counts and IDs
 * only, never email content, and deletes its test label afterwards.
 */
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Sign in first" }, { status: 401 })

  const [account] = await listEmailAccounts(session.user.id)
  if (!account) return NextResponse.json({ error: "Connect Gmail first" }, { status: 400 })

  const steps: Record<string, unknown> = {}
  try {
    await withGmail(session.user.id, account.id, async (gmail) => {
      steps.allMail = await gmail.allMail()

      const page = await getMessages(gmail, { maxResults: 5, query: "in:inbox" })
      steps.getMessages = { count: page.messages.length, hasNextPage: Boolean(page.nextPageToken) }

      const first = page.messages[0]
      if (first) {
        const message = await getMessage(gmail, first.id)
        steps.getMessage = { id: message.id, labelCount: message.labels.length, hasSubject: Boolean(message.envelope.subject) }

        const withSource = await getMessage(gmail, first.id, { source: true })
        steps.getMessageSource = { bytes: withSource.source?.length ?? 0 }

        const thread = await getThread(gmail, first.threadId)
        steps.getThread = { id: thread.id, messageCount: thread.messages.length }
      }

      // Phase 6: two batches of the default scan window, normalised.
      const batch = await fetchEmailBatch(gmail, { batchSize: 10 })
      const next = batch.nextPageToken
        ? await fetchEmailBatch(gmail, { batchSize: 10, pageToken: batch.nextPageToken })
        : undefined
      const scanned = [...batch.emails, ...(next?.emails ?? [])]
      steps.fetchEmailBatch = {
        count: scanned.length,
        failed: batch.failed.length + (next?.failed.length ?? 0),
        secondPageDistinct: !next || next.emails.every((e) => !batch.emails.some((b) => b.id === e.id)),
        truncated: scanned.filter((e) => e.bodyTruncated).length,
        maxBodyChars: Math.max(0, ...scanned.map((e) => e.body.length)),
        withinBudget: scanned.every((e) => e.body.length <= BODY_CHAR_BUDGET),
        noHtml: scanned.every((e) => !looksLikeHtml(e.body)),
        // Tag names only (never text), to diagnose a failing noHtml.
        htmlTagsFound: [
          ...new Set(
            scanned.flatMap((e) =>
              [...e.body.matchAll(HTML_TAG_PATTERN)].map((m) => m[0].match(/^<\/?([a-z0-9:]+)/i)?.[1]?.toLowerCase())
            )
          ),
        ],
        withAttachments: scanned.filter((e) => e.attachments.length > 0).length,
      }

      // Phase 13: the automatic-processing cursor and its combined UID + X-GM-RAW search.
      const box = await gmail.allMailStatus()
      const recentUids = await gmail.inAllMail(
        async () =>
          (await gmail.imap.search({ uid: `${Math.max(1, box.uidNext - 50)}:*`, gmraw: "-in:sent -in:drafts -in:chats" }, { uid: true })) || []
      )
      steps.autoProcessCursor = {
        hasUidValidity: box.uidValidity.length > 0,
        uidNext: box.uidNext,
        newestFiftyUidsMatchingFilter: recentUids.length,
        allBelowUidNext: recentUids.every((uid) => uid < box.uidNext),
      }

      steps.getLabels = { count: (await getLabels(gmail)).length }

      const label = await createLabel(gmail, TEST_LABEL)
      const again = await createLabel(gmail, TEST_LABEL)
      steps.createLabel = { id: label.id, reusedOnSecondCall: again.id === label.id }

      if (first) {
        await addLabel(gmail, first.id, [label.id])
        const labelled = await getMessage(gmail, first.id)
        await removeLabel(gmail, first.id, [label.id])
        const unlabelled = await getMessage(gmail, first.id)
        steps.addLabel = labelled.labels.includes(label.id)
        steps.removeLabel = !unlabelled.labels.includes(label.id)
      }

      await deleteLabel(gmail, label.id)
      steps.deleteLabel = !(await getLabels(gmail)).some((l) => l.id === label.id)
    })

    return NextResponse.json({ ok: true, account: account.email, steps })
  } catch (error) {
    const code = error instanceof GmailError ? error.code : "UNKNOWN"
    return NextResponse.json({ ok: false, code, completedSteps: steps }, { status: 500 })
  }
}
