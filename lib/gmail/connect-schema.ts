import { z } from "zod"

/** Shared by the connect form (client) and the server action. */
export const gmailConnectSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address")),
  // Google shows app passwords as "abcd efgh ijkl mnop"; spaces are optional.
  appPassword: z
    .string()
    .transform((value) => value.replace(/\s+/g, ""))
    .pipe(z.string().regex(/^[a-z]{16}$/i, "An app password is 16 letters, like “abcd efgh ijkl mnop”")),
})

export type GmailConnectInput = z.infer<typeof gmailConnectSchema>
