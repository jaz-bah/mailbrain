"use client"

// Replaces the root layout when it fails, so it can't rely on globals.css or
// the theme. Styles are inline and follow the OS colour scheme.
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  console.error(error)

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          fontFamily: "system-ui, sans-serif",
          colorScheme: "light dark",
        }}
      >
        <title>Something went wrong · MailBrain</title>
        <main style={{ textAlign: "center", padding: "1rem" }}>
          <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>Something went wrong</h1>
          <p style={{ marginBottom: "1rem" }}>MailBrain hit an unexpected error.</p>
          <button type="button" onClick={() => retry()} style={{ padding: "0.5rem 1rem" }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  )
}
