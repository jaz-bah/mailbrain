import "server-only"

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

import { getEnv } from "@/lib/env"

const ALGORITHM = "aes-256-gcm"
const VERSION = "v1"
const IV_BYTES = 12
const TAG_BYTES = 16

/** The current key first, then the previous one while a rotation is under way. */
function keys(): Buffer[] {
  const env = getEnv()
  return [env.TOKEN_ENCRYPTION_KEY, env.TOKEN_ENCRYPTION_KEY_PREVIOUS]
    .filter((key): key is string => Boolean(key))
    .map((key) => Buffer.from(key, "base64"))
}

/**
 * Encrypts a secret with AES-256-GCM. Output: `v1.<iv>.<tag>.<ciphertext>`
 * (base64url). `context` is bound as additional authenticated data, so a
 * value encrypted for one purpose can't be decrypted as another. Always uses
 * the current key.
 */
export function encryptSecret(plaintext: string, context: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, keys()[0], iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(context))
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv, tag, ciphertext].map((part) =>
    typeof part === "string" ? part : part.toString("base64url")
  ).join(".")
}

/**
 * Decrypts with the current key, falling back to `TOKEN_ENCRYPTION_KEY_PREVIOUS`.
 * `stale` is true when the previous key was needed, so the caller can
 * re-encrypt the value with the current one. Throws if the value was tampered
 * with, encrypted for another context, malformed, or matches neither key.
 */
export function decryptSecretWithStatus(encrypted: string, context: string): { plaintext: string; stale: boolean } {
  const [version, ivPart, tagPart, ciphertext] = encrypted.split(".")
  const iv = Buffer.from(ivPart ?? "", "base64url")
  const tag = Buffer.from(tagPart ?? "", "base64url")
  // A truncated tag would make forgery easier, so only full-length tags are accepted.
  if (version !== VERSION || iv.length !== IV_BYTES || tag.length !== TAG_BYTES || !ciphertext) {
    throw new Error("Malformed encrypted value")
  }

  const candidates = keys()
  for (const [index, key] of candidates.entries()) {
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })
      decipher.setAAD(Buffer.from(context))
      decipher.setAuthTag(tag)
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8")
      return { plaintext, stale: index > 0 }
    } catch (error) {
      if (index === candidates.length - 1) throw error
    }
  }
  throw new Error("No encryption key configured")
}

/** Throws if the value was tampered with, encrypted for another context, or malformed. */
export function decryptSecret(encrypted: string, context: string): string {
  return decryptSecretWithStatus(encrypted, context).plaintext
}
