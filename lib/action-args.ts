/**
 * Server actions are public endpoints: their arguments come from the client
 * and can be any serialisable value, whatever the TypeScript types say. These
 * guards stop an object such as `{ "$ne": null }` from reaching a MongoDB
 * filter or update.
 */

/** A MongoDB ObjectId in hex, or null. */
export function idArg(value: unknown): string | null {
  return typeof value === "string" && /^[a-f\d]{24}$/i.test(value) ? value : null
}

/** A real boolean, or null. */
export function boolArg(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}
