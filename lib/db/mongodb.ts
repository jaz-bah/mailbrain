import "server-only"

import { MongoClient, type Db } from "mongodb"

import { getEnv } from "@/lib/env"

// Reuse one client across hot reloads in development and across requests in
// production. The driver connects on the first operation.
const globalForMongo = globalThis as typeof globalThis & {
  _mongoClient?: MongoClient
}

export function getMongoClient(): MongoClient {
  if (!globalForMongo._mongoClient) {
    globalForMongo._mongoClient = new MongoClient(getEnv().MONGODB_URI, {
      appName: "mailbrain",
    })
  }
  return globalForMongo._mongoClient
}

/** The database named in MONGODB_URI (e.g. `.../mailbrain`). */
export function getDb(): Db {
  return getMongoClient().db()
}
