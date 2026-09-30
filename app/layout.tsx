import type { Metadata } from "next"
import { Outfit } from "next/font/google"

import { Providers } from "./providers"
import "./globals.css"

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: {
    default: "MailBrain",
    template: "%s · MailBrain",
  },
  description: "AI that sorts your Gmail into the categories you care about.",
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${outfit.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="min-h-full">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
