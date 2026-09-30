import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

export default function MailLoading() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true" aria-label="Loading">
      <div className="space-y-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Card className="py-0">
        <CardContent className="divide-y px-0">
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 px-6 py-3">
              <Skeleton className="hidden h-4 w-36 md:block" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="hidden h-4 w-32 sm:block" />
              <Skeleton className="h-8 w-16" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
