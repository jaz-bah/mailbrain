// Dev diagnostic (Phase 14): are stored app passwords encrypted at rest?
// Prints counts only, never values. Usage: node --env-file=.env scripts/check-encryption.mjs
import { MongoClient } from "mongodb"

const client = new MongoClient(process.env.MONGODB_URI)
try {
  const accounts = await client.db().collection("emailAccounts").find({}, { projection: { appPassword: 1 } }).toArray()
  const encrypted = accounts.filter((a) => /^v1\.[\w-]{16}\.[\w-]{22}\.[\w-]+$/.test(a.appPassword ?? ""))
  const plaintextLooking = accounts.filter((a) => /^[a-z]{16}$/.test((a.appPassword ?? "").replace(/\s/g, "")))
  console.log(JSON.stringify({ accounts: accounts.length, encryptedV1: encrypted.length, plaintextLooking: plaintextLooking.length }))
} finally {
  await client.close()
}
