// Dev diagnostic: aggregate classification outcomes (counts only, no content).
// Usage: node scripts/scan-stats.mjs
import { readFileSync } from "node:fs"

import { MongoClient } from "mongodb"

const env = readFileSync(new URL("../.env", import.meta.url), "utf8")
const uri = env.match(/^\s*MONGODB_URI\s*=\s*(.+?)\s*$/m)?.[1]?.replace(/^["']|["']$/g, "")
if (!uri) throw new Error("MONGODB_URI not found in .env")

const client = new MongoClient(uri)
try {
  const col = client.db().collection("emailClassifications")
  const byStatus = await col
    .aggregate([{ $group: { _id: { status: "$status", errorCode: "$errorCode" }, count: { $sum: 1 }, maxAttempts: { $max: "$attempts" } } }])
    .toArray()
  console.log("by status/errorCode:", JSON.stringify(byStatus))

  const noMatch = await col
    .aggregate([
      { $match: { status: "no_match" } },
      {
        $bucket: {
          groupBy: { $ifNull: ["$confidence", -1] },
          boundaries: [-1, 0, 0.5, 0.7, 0.8, 1.01],
          default: "other",
          output: { count: { $sum: 1 } },
        },
      },
    ])
    .toArray()
  console.log("no_match best-candidate confidence buckets (-1 = no candidate):", JSON.stringify(noMatch))

  const classified = await col
    .aggregate([{ $match: { status: "classified" } }, { $group: { _id: null, count: { $sum: 1 }, avg: { $avg: "$confidence" } } }])
    .toArray()
  console.log("classified:", JSON.stringify(classified))

  const labels = await col
    .aggregate([
      { $match: { status: "classified" } },
      { $group: { _id: { labelApplied: "$labelApplied", labelError: "$labelError" }, count: { $sum: 1 } } },
    ])
    .toArray()
  console.log("labels:", JSON.stringify(labels))

  // Phase 10: exactly one record per email per category, and one outcome kind per email.
  const duplicates = await col
    .aggregate([
      { $group: { _id: { a: "$emailAccountId", m: "$gmailMessageId", c: "$categoryId" }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $count: "duplicates" },
    ])
    .toArray()
  const mixed = await col
    .aggregate([
      { $group: { _id: { a: "$emailAccountId", m: "$gmailMessageId" }, nullCat: { $sum: { $cond: [{ $eq: ["$categoryId", null] }, 1, 0] } }, matched: { $sum: { $cond: [{ $ne: ["$categoryId", null] }, 1, 0] } } } },
      { $match: { nullCat: { $gt: 0 }, matched: { $gt: 0 } } },
      { $count: "emailsWithBothMatchAndNoMatch" },
    ])
    .toArray()
  const contentFields = await col.countDocuments({
    $or: [{ subject: { $exists: true } }, { body: { $exists: true } }, { from: { $exists: true } }, { snippet: { $exists: true } }],
  })
  console.log("integrity:", JSON.stringify({ duplicates: duplicates[0]?.duplicates ?? 0, mixed: mixed[0]?.emailsWithBothMatchAndNoMatch ?? 0, recordsWithContentFields: contentFields }))
} finally {
  await client.close()
}
