// Fake values so getEnv() validates in tests. Tests never touch real services.
Object.assign(process.env, {
  MONGODB_URI: "mongodb://127.0.0.1:27017/mailbrain-test",
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
  BETTER_AUTH_URL: "http://localhost:3001",
  GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  OPENROUTER_API_KEY: "test-openrouter-key",
  OPENROUTER_MODEL: "test/model",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
})
