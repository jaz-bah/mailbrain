import { redirect } from "next/navigation"

// No marketing page yet. Signed-out visitors are sent on to /sign-in.
export default function Home() {
  redirect("/dashboard")
}
