import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

export default function EmailDetailLoading() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-4 w-28" />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-8 w-96 max-w-full" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <Skeleton className="h-9 w-36" />
      </div>
      <Card>
        <CardHeader className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-56" />
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-[10rem_1fr]">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="contents">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-full max-w-md" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
