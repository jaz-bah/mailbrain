import "server-only"

import nodemailer, { type Transporter } from "nodemailer"

import { getEnv } from "@/lib/env"

// MailBrain's own transactional email (PRD NTF-1), sent from the app's SMTP
// account in SMTP_*. Not the user's mailbox. Optional: without SMTP config,
// sending is skipped.

let transporter: Transporter | null | undefined

function getTransporter(): Transporter | null {
  if (transporter !== undefined) return transporter
  const env = getEnv()
  if (!env.SMTP_HOST || !env.SMTP_PORT || !env.SMTP_USER || !env.SMTP_PASSWORD) {
    transporter = null
    return transporter
  }
  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // 465 is implicit TLS; other ports (587) upgrade with STARTTLS.
    secure: env.SMTP_PORT === 465,
    requireTLS: env.SMTP_PORT !== 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
  })
  return transporter
}

export type Mail = { to: string; subject: string; text: string; html: string }

/** Sends one email. Returns false when SMTP isn't configured. Never logs content or addresses. */
export async function sendMail(mail: Mail): Promise<boolean> {
  const smtp = getTransporter()
  if (!smtp) return false
  await smtp.sendMail({ from: { name: "MailBrain", address: getEnv().SMTP_USER! }, ...mail })
  return true
}
