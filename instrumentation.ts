export async function register() {
  // Node-only code lives in its own file so it stays out of the Edge build.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node")
  }
}
