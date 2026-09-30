import { describe, expect, it } from "vitest"

import { categoryColorClass, parseCategoryForm } from "./schema"

function form(values: Record<string, string>) {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) data.set(key, value)
  return data
}

describe("parseCategoryForm", () => {
  it("accepts and trims a valid category, with instructions optional", () => {
    const result = parseCategoryForm(form({ name: "  Invoices ", description: " Bills. ", instructions: "" }))
    expect(result.success && result.data).toEqual({
      name: "Invoices",
      description: "Bills.",
      instructions: "",
    })
  })

  it("requires a name and description", () => {
    const result = parseCategoryForm(form({ name: " ", description: "" }))
    expect(result.success).toBe(false)
    const fields = result.error?.issues.map((i) => i.path[0])
    expect(fields).toEqual(expect.arrayContaining(["name", "description"]))
  })

  it("rejects '/' in names so Gmail labels don't nest", () => {
    const result = parseCategoryForm(form({ name: "Work/Clients", description: "x" }))
    expect(result.success).toBe(false)
  })

  it("enforces length limits", () => {
    const result = parseCategoryForm(
      form({ name: "x".repeat(51), description: "x".repeat(201), instructions: "x".repeat(1001) })
    )
    expect(result.error?.issues.map((i) => i.path[0]).sort()).toEqual([
      "description",
      "instructions",
      "name",
    ])
  })
})

describe("categoryColorClass", () => {
  it("cycles through the five chart colours", () => {
    expect(categoryColorClass(0)).toBe("bg-chart-1")
    expect(categoryColorClass(4)).toBe("bg-chart-5")
    expect(categoryColorClass(5)).toBe("bg-chart-1")
  })
})
