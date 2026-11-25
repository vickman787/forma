export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { config } = await import("./lib/config");
    config();
  }
}
