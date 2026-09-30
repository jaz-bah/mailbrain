import { describe, expect, it } from "vitest"

import { decryptSecret, encryptSecret } from "./tokens"

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a value", () => {
    const encrypted = encryptSecret("ya29.secret-token", "ctx")
    expect(decryptSecret(encrypted, "ctx")).toBe("ya29.secret-token")
  })

  it("never contains the plaintext and uses a fresh IV each time", () => {
    const a = encryptSecret("ya29.secret-token", "ctx")
    const b = encryptSecret("ya29.secret-token", "ctx")
    expect(a).not.toContain("secret-token")
    expect(a).not.toBe(b)
    expect(a.startsWith("v1.")).toBe(true)
  })

  it("rejects a value encrypted for a different context", () => {
    const encrypted = encryptSecret("refresh", "emailAccount.refreshToken")
    expect(() => decryptSecret(encrypted, "emailAccount.accessToken")).toThrow()
  })

  it("rejects tampered ciphertext", () => {
    const [version, iv, tag, ciphertext] = encryptSecret("value", "ctx").split(".")
    const flipped = Buffer.from(ciphertext, "base64url")
    flipped[0] ^= 0xff
    const tampered = [version, iv, tag, flipped.toString("base64url")].join(".")
    expect(() => decryptSecret(tampered, "ctx")).toThrow()
  })

  it("rejects a truncated auth tag", () => {
    const [version, iv, tag, ciphertext] = encryptSecret("value", "ctx").split(".")
    const shortTag = Buffer.from(tag, "base64url").subarray(0, 4).toString("base64url")
    expect(() => decryptSecret([version, iv, shortTag, ciphertext].join("."), "ctx")).toThrow(
      "Malformed"
    )
  })

  it("rejects malformed input", () => {
    expect(() => decryptSecret("not-encrypted", "ctx")).toThrow("Malformed")
    expect(() => decryptSecret("v2.a.b.c", "ctx")).toThrow("Malformed")
  })
})
