import { describe, expect, it } from "vitest"

import { welcomeEmail } from "./templates"

describe("welcomeEmail", () => {
  it("greets by first name and links to settings, in text and HTML", () => {
    const mail = welcomeEmail({ to: "me@example.com", name: "Ada Lovelace", appUrl: "http://localhost:3001" })
    expect(mail.subject).toBe("Welcome to MailBrain")
    expect(mail.text).toContain("Hi Ada,")
    expect(mail.text).toContain("http://localhost:3001/settings")
    expect(mail.html).toContain('href="http://localhost:3001/settings"')
  })

  it("escapes the user's name in HTML", () => {
    const mail = welcomeEmail({ to: "x@example.com", name: "<script>alert(1)</script>", appUrl: "http://localhost:3001" })
    expect(mail.html).not.toContain("<script>")
    expect(mail.html).toContain("&lt;script&gt;")
  })
})
