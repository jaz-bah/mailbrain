import { randomBytes } from "node:crypto"

import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({}) as { TOKEN_ENCRYPTION_KEY?: string; TOKEN_ENCRYPTION_KEY_PREVIOUS?: string })
vi.mock("@/lib/env", () => ({ getEnv: () => env }))

import { decryptSecretWithStatus, encryptSecret } from "./tokens"

const OLD = randomBytes(32).toString("base64")
const NEW = randomBytes(32).toString("base64")

beforeEach(() => {
  env.TOKEN_ENCRYPTION_KEY = OLD
  delete env.TOKEN_ENCRYPTION_KEY_PREVIOUS
})

describe("encryption key rotation", () => {
  it("decrypts old values with the previous key and flags them as stale", () => {
    const encrypted = encryptSecret("abcdabcdabcdabcd", "ctx")
    env.TOKEN_ENCRYPTION_KEY = NEW
    env.TOKEN_ENCRYPTION_KEY_PREVIOUS = OLD
    expect(decryptSecretWithStatus(encrypted, "ctx")).toEqual({ plaintext: "abcdabcdabcdabcd", stale: true })
  })

  it("encrypts with the new key, so re-encrypted values aren't stale", () => {
    env.TOKEN_ENCRYPTION_KEY = NEW
    env.TOKEN_ENCRYPTION_KEY_PREVIOUS = OLD
    const encrypted = encryptSecret("abcdabcdabcdabcd", "ctx")
    expect(decryptSecretWithStatus(encrypted, "ctx").stale).toBe(false)

    // Once the previous key is removed, only new-key values still decrypt.
    delete env.TOKEN_ENCRYPTION_KEY_PREVIOUS
    expect(decryptSecretWithStatus(encrypted, "ctx").plaintext).toBe("abcdabcdabcdabcd")
  })

  it("fails when neither key matches", () => {
    const encrypted = encryptSecret("abcdabcdabcdabcd", "ctx")
    env.TOKEN_ENCRYPTION_KEY = NEW
    expect(() => decryptSecretWithStatus(encrypted, "ctx")).toThrow()
  })

  it("still binds the context with the previous key", () => {
    const encrypted = encryptSecret("abcdabcdabcdabcd", "ctx")
    env.TOKEN_ENCRYPTION_KEY = NEW
    env.TOKEN_ENCRYPTION_KEY_PREVIOUS = OLD
    expect(() => decryptSecretWithStatus(encrypted, "other")).toThrow()
  })
})
