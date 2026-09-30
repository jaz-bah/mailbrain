import { describe, expect, it } from "vitest"

import { confidenceLevel } from "@/components/confidence-badge"

import { senderName } from "./format"

describe("confidenceLevel (DESIGN.md §6.3)", () => {
  it.each([
    [0.97, 0.8, "High"],
    [0.9, 0.8, "High"],
    [0.84, 0.8, "Medium"],
    [0.8, 0.8, "Medium"],
    [0.62, 0.8, "Low"],
    [0.65, 0.6, "Medium"],
  ])("%d with threshold %d is %s", (confidence, threshold, level) => {
    expect(confidenceLevel(confidence, threshold)).toBe(level)
  })
})

describe("senderName", () => {
  it("shows the display name, or the address when there's no name", () => {
    expect(senderName("Acme Billing <billing@acme.test>")).toBe("Acme Billing")
    expect(senderName("billing@acme.test")).toBe("billing@acme.test")
    expect(senderName(null)).toBe("Unknown sender")
  })
})
