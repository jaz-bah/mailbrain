// Server-rendered dates. Formatting on the server avoids hydration mismatches;
// times are shown in the server's time zone until user time zones exist.

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" })
const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" })

export function formatDate(iso: string | null) {
  return iso ? dateFormat.format(new Date(iso)) : "—"
}

export function formatDateTime(iso: string | null) {
  return iso ? dateTimeFormat.format(new Date(iso)) : "—"
}

/** "Jane Doe <jane@x.com>" → "Jane Doe"; a bare address stays as it is. */
export function senderName(from: string | null) {
  if (!from) return "Unknown sender"
  const name = from.replace(/\s*<[^>]*>\s*$/, "").trim()
  return name || from
}
