import { resolve } from "node:path"

import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname),
      // `server-only` throws outside React Server Components; tests run in plain Node.
      "server-only": resolve(import.meta.dirname, "test/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
    setupFiles: ["test/setup-env.ts"],
  },
})
