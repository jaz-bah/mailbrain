import "server-only"

import { convert, type HtmlToTextOptions } from "html-to-text"
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser"

import type { GmailMessage, MailAddress } from "@/lib/gmail/types"

/**
 * The only email content the AI ever sees (ARCHITECTURE §6): headers and a
 * cleaned, truncated plain-text body. No HTML, images, tracking pixels or
 * attachment data. Never stored in MongoDB.
 */
export type NormalizedEmail = {
  /** X-GM-MSGID */
  id: string
  threadId: string
  from: string
  to: string[]
  cc: string[]
  subject: string
  /** ISO 8601, or null when the message has no usable date. */
  date: string | null
  body: string
  bodyTruncated: boolean
  /** File names only, never content. */
  attachments: string[]
}

/** Character budget for the body sent to the AI. */
export const BODY_CHAR_BUDGET = 4000
/** Raw bytes fetched per message. Text parts come before attachments, so this rarely cuts text. */
export const MAX_SOURCE_BYTES = 256 * 1024

const MAX_SUBJECT_CHARS = 300
const MAX_ADDRESS_CHARS = 200
const MAX_RECIPIENTS = 10
const MAX_ATTACHMENTS = 10
const MAX_FILENAME_CHARS = 100
/** A text part shorter than this is often a stub ("View this email in your browser"); compare with the HTML. */
const MIN_USEFUL_PLAIN_CHARS = 200

const HTML_OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  selectors: [
    // Images (including tracking pixels) carry no text worth sending.
    { selector: "img", format: "skip" },
    { selector: "a", options: { ignoreHref: true } },
    { selector: "style", format: "skip" },
    { selector: "script", format: "skip" },
    { selector: "head", format: "skip" },
    // Hidden text: preheaders, and a place to hide instructions aimed at the AI.
    { selector: '[style*="display:none"]', format: "skip" },
    { selector: '[style*="display: none"]', format: "skip" },
    { selector: "[hidden]", format: "skip" },
    // Quoted replies repeat earlier messages.
    { selector: ".gmail_quote", format: "skip" },
    { selector: 'blockquote[type="cite"]', format: "skip" },
    // Emails use tables for layout; render cells as plain blocks instead of grids.
    { selector: "table", format: "block" },
    { selector: "tr", format: "block" },
    { selector: "td", format: "block" },
    { selector: "th", format: "block" },
    ...(["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({
      selector,
      options: { uppercase: false },
    })) satisfies HtmlToTextOptions["selectors"]),
  ],
}

// Zero-width and other invisible characters, used as preheader padding.
const INVISIBLE_CHARS = /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁤⁪-⁯ㅤ﻿ﾠ]/g
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/gi

/**
 * Real HTML tags (not `<someone@example.com>` or `<3`). Some senders put
 * HTML in the text/plain part, so plain text is checked too.
 */
export const HTML_TAG_PATTERN =
  /<\/?(?:html|head|body|div|span|p|br|hr|table|tbody|thead|tr|td|th|a|img|style|script|font|b|i|u|strong|em|ul|ol|li|h[1-6]|center|meta|link|title|blockquote|pre|section|article|header|footer|button|input|form|iframe|svg|o:p)\b[^>]*>/gi

export function looksLikeHtml(text: string) {
  return new RegExp(HTML_TAG_PATTERN.source, "i").test(text)
}

/** Replaces a URL with its host: long tracking URLs waste the budget, the domain is what's useful. */
function linkLabel(url: string) {
  try {
    return `[link: ${new URL(url).hostname}]`
  } catch {
    return "[link]"
  }
}

function collapse(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

function clip(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

export function cleanText(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE_CHARS, "")
    .replace(/ /g, " ")
    .replace(URL_PATTERN, linkLabel)
    .split("\n")
    .filter((line) => !/^\s*>/.test(line)) // quoted reply lines
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function htmlToPlainText(html: string) {
  return cleanText(convert(html, HTML_OPTIONS))
}

/** Cuts to at most `max` characters, at a word boundary where one is close. */
export function truncateBody(text: string, max = BODY_CHAR_BUDGET) {
  if (text.length <= max) return { body: text, bodyTruncated: false }
  const marker = " …"
  let cut = text.slice(0, max - marker.length)
  const boundary = cut.search(/\s\S*$/)
  if (boundary > cut.length * 0.8) cut = cut.slice(0, boundary)
  // Don't leave half of a surrogate pair (e.g. an emoji) at the end.
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1)
  return { body: cut.trimEnd() + marker, bodyTruncated: true }
}

/** Headers only, from the IMAP envelope (used to backfill matches saved before Phase 11). */
export function headersFromEnvelope(message: GmailMessage) {
  const date = message.envelope.date ?? message.internalDate
  return {
    from: message.envelope.from.map(formatAddress).find(Boolean) ?? "",
    subject: clip(collapse(message.envelope.subject), MAX_SUBJECT_CHARS),
    date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
  }
}

function formatAddress({ name, address }: MailAddress) {
  const cleanName = collapse(name ?? "").replace(/^"|"$/g, "")
  const cleanAddress = collapse(address ?? "")
  const formatted = cleanName && cleanAddress ? `${cleanName} <${cleanAddress}>` : cleanName || cleanAddress
  return clip(formatted, MAX_ADDRESS_CHARS)
}

function parsedAddresses(field: AddressObject | AddressObject[] | undefined): MailAddress[] {
  return [field ?? []].flat().flatMap((group) => group.value)
}

function addressList(parsed: MailAddress[], fallback: MailAddress[]) {
  return (parsed.length ? parsed : fallback)
    .map(formatAddress)
    .filter(Boolean)
    .slice(0, MAX_RECIPIENTS)
}

function pickBody(parsed: ParsedMail) {
  const text = parsed.text ?? ""
  const plain = looksLikeHtml(text) ? htmlToPlainText(text) : cleanText(text)
  if (plain.length >= MIN_USEFUL_PLAIN_CHARS || !parsed.html) return stripStrayTags(plain)
  const fromHtml = htmlToPlainText(parsed.html)
  return stripStrayTags(fromHtml.length > plain.length ? fromHtml : plain)
}

/** Last line of defence: removes any tag that survived conversion (e.g. HTML-escaped markup). */
function stripStrayTags(text: string) {
  return text.replace(HTML_TAG_PATTERN, "")
}

function attachmentNames(parsed: ParsedMail) {
  return parsed.attachments
    .filter((a) => !a.related && a.contentDisposition !== "inline")
    .map((a) => clip(collapse(a.filename ?? ""), MAX_FILENAME_CHARS))
    .filter(Boolean)
    .slice(0, MAX_ATTACHMENTS)
}

/** Raw Gmail message (with `source`) → NormalizedEmail. */
export async function normalizeEmail(message: GmailMessage): Promise<NormalizedEmail> {
  if (!message.source) throw new Error("normalizeEmail needs the message source")

  const parsed = await simpleParser(message.source, {
    // We convert HTML ourselves, with images, links and hidden text removed.
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipTextLinks: true,
    // Keep cid: references instead of inlining images as data URIs.
    skipImageLinks: true,
  })

  const envelope = message.envelope
  const date = parsed.date ?? envelope.date ?? message.internalDate
  const validDate = date && !Number.isNaN(date.getTime()) ? date : null

  return {
    id: message.id,
    threadId: message.threadId,
    from: addressList(parsedAddresses(parsed.from), envelope.from)[0] ?? "",
    to: addressList(parsedAddresses(parsed.to), envelope.to),
    cc: addressList(parsedAddresses(parsed.cc), envelope.cc),
    subject: clip(collapse(parsed.subject ?? envelope.subject), MAX_SUBJECT_CHARS),
    date: validDate?.toISOString() ?? null,
    ...truncateBody(pickBody(parsed)),
    attachments: attachmentNames(parsed),
  }
}
