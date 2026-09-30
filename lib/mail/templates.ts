import type { Mail } from "@/lib/mail/transport"

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

/** Sent once, when a user first signs in (PRD NTF-1). Plain, with a text version. */
export function welcomeEmail({ to, name, appUrl }: { to: string; name: string; appUrl: string }): Mail {
  const firstName = name.trim().split(/\s+/)[0] || "there"
  const settingsUrl = new URL("/settings", appUrl).toString()
  const steps = [
    "Connect Gmail in Settings with a Google app password.",
    "Create a few categories, like Invoices or Job Interviews.",
    "Click Scan Emails. MailBrain labels matching emails AI/<Category> in Gmail.",
  ]

  const text = [
    `Hi ${firstName},`,
    "",
    "Welcome to MailBrain. Here's how to get started:",
    "",
    ...steps.map((step, i) => `${i + 1}. ${step}`),
    "",
    `Start here: ${settingsUrl}`,
    "",
    "MailBrain only adds and removes its own AI/ labels. It never deletes or sends email.",
    "",
    "— MailBrain",
  ].join("\n")

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f1f1f;background:#fafafa">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e5;border-radius:8px;padding:24px">
      <p>Hi ${escapeHtml(firstName)},</p>
      <p>Welcome to MailBrain. Here's how to get started:</p>
      <ol>${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>
      <p><a href="${escapeHtml(settingsUrl)}" style="color:#1f1f1f;font-weight:bold">Open MailBrain settings</a></p>
      <p style="color:#555555;font-size:13px">MailBrain only adds and removes its own AI/ labels. It never deletes or sends email.</p>
    </div>
  </body>
</html>`

  return { to, subject: "Welcome to MailBrain", text, html }
}
