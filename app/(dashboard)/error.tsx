"use client"

import { TriangleAlert } from "lucide-react"
import { useEffect } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

export default function DashboardError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <Alert variant="destructive">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>Something went wrong</AlertTitle>
      <AlertDescription>
        <p>This page couldn&apos;t be loaded. Try again, and if it keeps happening, reload the app.</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => retry()}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  )
}
