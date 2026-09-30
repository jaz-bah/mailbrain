import { NextResponse } from "next/server"

import { getDb } from "@/lib/db/mongodb"

export async function GET() {
  try {
    await getDb().command({ ping: 1 })
    return NextResponse.json({ status: "ok", database: "ok" })
  } catch (error) {
    // Name only: driver errors can include the connection string's host and user.
    console.error("Health check: database unreachable", error instanceof Error ? error.name : "unknown")
    return NextResponse.json({ status: "error", database: "unreachable" }, { status: 503 })
  }
}
