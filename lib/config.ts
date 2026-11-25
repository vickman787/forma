import path from "node:path";
export function config() {
  const mode = process.env.APP_MODE || "live";
  const role = process.env.PROCESS_ROLE || "all";
  if (
    !["all", "web", "generation", "operator", "chain", "preview"].includes(role)
  )
    throw new Error("Invalid Forma process role");
  const fixtures =
    process.env.NODE_ENV === "test" &&
    process.env.FORMA_TEST_FIXTURES === "true";
  if (mode === "demo" && !fixtures)
    throw new Error(
      "Non-production fixtures are restricted to the automated test runner",
    );
  if (!["demo", "live"].includes(mode))
    throw new Error("APP_MODE must be demo or live");
  const generation = process.env.GENERATION_PROVIDER || "openai";
  if (!["template", "openai"].includes(generation))
    throw new Error("GENERATION_PROVIDER must be template or openai");
  if (!fixtures && generation !== "openai")
    throw new Error("Live orders require OpenAI generation");
  const appUrl = process.env.APP_URL || "http://127.0.0.1:3000";
  const localOnly = process.env.LOCAL_ONLY === "true";
  const localCheckoutOrder = process.env.LOCAL_CHECKOUT_ORDER_ID || "";
  if (
    localCheckoutOrder &&
    (!localOnly ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        localCheckoutOrder,
      ))
  )
    throw new Error(
      "A local checkout validation order requires loopback-only configuration and an exact order ID",
    );
  const loopback = (url: string) => {
    const u = new URL(url);
    return (
      ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) &&
      ["http:", "https:"].includes(u.protocol)
    );
  };
  if (
    localOnly &&
    (!loopback(appUrl) ||
      !loopback(process.env.PREVIEW_ORIGIN || "http://127.0.0.1:4317"))
  )
    throw new Error(
      "Local-only storage requires loopback app and preview origins",
    );
  const data = path.resolve(
    /*turbopackIgnore: true*/ process.env.DATA_DIRECTORY || `.forma/${mode}`,
  );
  if (mode === "live") {
    for (const k of [
      "SESSION_SECRET",
      "APP_URL",
      "OPENAI_TEXT_MODEL",
      "OPENAI_RESEARCH_MODEL",
      "ESCROW_ADDRESS",
      "TREASURY_ADDRESS",
      "OPERATOR_ADDRESS",
      "PREVIEW_ORIGIN",
      "MAX_JOB_COST_USD",
      "MAX_INPUT_COST_PER_MILLION",
      "MAX_OUTPUT_COST_PER_MILLION",
      "MAX_SEARCH_COST_USD",
    ])
      if (!process.env[k]) throw new Error(`Live configuration missing ${k}`);
    if (
      (role === "all" || role === "generation") &&
      !process.env.OPENAI_API_KEY
    )
      throw new Error("Live configuration missing OPENAI_API_KEY");
    if ((process.env.SESSION_SECRET?.length || 0) < 32)
      throw new Error("Live session secret must have at least 32 characters");
    if (!localOnly && !process.env.DATABASE_URL)
      throw new Error("Live configuration missing DATABASE_URL");
    if (
      (!localOnly &&
        (new URL(appUrl).protocol !== "https:" ||
          new URL(process.env.PREVIEW_ORIGIN!).protocol !== "https:")) ||
      new URL(process.env.PREVIEW_ORIGIN!).origin ===
        new URL(process.env.APP_URL!).origin
    )
      throw new Error("Live requires HTTPS and a separate preview origin");
    if (!data.includes("live"))
      throw new Error("Use a separate live data directory");
    if (
      process.env.QIE_CHAIN_ID !== "1990" ||
      process.env.QUSDC_DECIMALS !== "6" ||
      process.env.SERVICE_PRICE_BASE_UNITS !== "1000000" ||
      process.env.QUSDC_ADDRESS?.toLowerCase() !==
        "0x3f43da82ec9a4f5285f10faf1f26eca7319e5da5"
    )
      throw new Error("Unexpected settlement configuration");
  }
  return {
    mode: mode as "demo" | "live",
    role,
    generation: generation as "template" | "openai",
    fixtures,
    localOnly,
    localCheckoutOrder,
    data,
    appUrl,
    liveEnabled:
      mode === "live" &&
      process.env.LIVE_PAYMENTS_ENABLED === "true" &&
      process.env.LIVE_VERIFICATION_COMPLETE === "true" &&
      process.env.ALLOW_PAID_API_CALLS === "true",
  };
}
