import { describe, expect, it } from "vitest"

import { isForeignOrigin } from "./origin"

const APP = "http://localhost:3001"
const request = (origin?: string) =>
  new Request(`${APP}/api/auth/sign-in/social`, { method: "POST", headers: origin ? { origin } : {} })

describe("isForeignOrigin", () => {
  it("allows the app's own origin and requests without one", () => {
    expect(isForeignOrigin(request(APP), APP)).toBe(false)
    expect(isForeignOrigin(request(), APP)).toBe(false)
  })

  it.each(["https://evil.example", "http://localhost:3000", "https://localhost:3001", "null", "not a url"])(
    "rejects %s",
    (origin) => {
      expect(isForeignOrigin(request(origin), APP)).toBe(true)
    }
  )
})
