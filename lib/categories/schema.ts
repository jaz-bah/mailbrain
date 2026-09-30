import { z } from "zod"

/** Shared by the form (client) and the server actions. */
export const categoryInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter a name")
    .max(50, "Keep the name under 50 characters")
    // "/" would nest the Gmail label (AI/Work/Clients) instead of naming it.
    .refine((name) => !name.includes("/"), "The name can't contain “/”"),
  description: z
    .string()
    .trim()
    .min(1, "Describe what belongs in this category")
    .max(200, "Keep the description under 200 characters"),
  instructions: z.string().trim().max(1000, "Keep the instructions under 1,000 characters"),
  /** 0.5–1. Matches below it aren't applied (CAT-4). Omitted → unchanged, or 0.8 for new categories. */
  minConfidence: z
    .number("Choose a minimum confidence")
    .min(0.5, "Choose at least 50%")
    .max(1, "Choose at most 100%")
    .optional(),
})

export type CategoryInput = z.infer<typeof categoryInputSchema>

export type CategoryFieldErrors = Partial<Record<keyof CategoryInput, string>>

/** The form sends a whole percentage (50–100). */
function percentToConfidence(value: FormDataEntryValue | null) {
  if (value === null || value === "") return undefined
  const percent = Number(value)
  return Number.isFinite(percent) ? Math.round(percent) / 100 : Number.NaN
}

export function parseCategoryForm(formData: FormData) {
  return categoryInputSchema.safeParse({
    name: formData.get("name") ?? "",
    description: formData.get("description") ?? "",
    instructions: formData.get("instructions") ?? "",
    minConfidence: percentToConfidence(formData.get("minConfidence")),
  })
}

/** Category colours cycle through the five chart tokens (DESIGN.md §6.2). */
export const CATEGORY_COLOR_CLASSES = [
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-3",
  "bg-chart-4",
  "bg-chart-5",
] as const

export function categoryColorClass(index: number) {
  return CATEGORY_COLOR_CLASSES[index % CATEGORY_COLOR_CLASSES.length]
}

/** Category data that is safe to send to the client. */
export type CategoryView = {
  id: string
  name: string
  description: string
  instructions: string
  gmailLabelId: string | null
  enabled: boolean
  colorIndex: number
  /** Matches below this aren't applied (DESIGN.md §6.3 uses it for badge levels). */
  minConfidence: number
}
