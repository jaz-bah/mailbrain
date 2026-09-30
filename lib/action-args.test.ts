import { describe, expect, it } from "vitest"

import { boolArg, idArg } from "./action-args"

describe("idArg", () => {
  it("accepts a 24-character hex ObjectId", () => {
    expect(idArg("65a1b2c3d4e5f6a7b8c9d0e1")).toBe("65a1b2c3d4e5f6a7b8c9d0e1")
  })

  it.each([{ $ne: null }, ["65a1b2c3d4e5f6a7b8c9d0e1"], "65a1b2c3d4e5f6a7b8c9d0e", "zza1b2c3d4e5f6a7b8c9d0e1", 42, null, undefined])(
    "rejects %j",
    (value) => {
      expect(idArg(value)).toBeNull()
    }
  )
})

describe("boolArg", () => {
  it("only accepts real booleans", () => {
    expect(boolArg(true)).toBe(true)
    expect(boolArg(false)).toBe(false)
    expect(boolArg("true")).toBeNull()
    expect(boolArg({ $set: 1 })).toBeNull()
    expect(boolArg(1)).toBeNull()
  })
})
