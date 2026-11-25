import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { blankBrief, briefSchema, canonical, serviceIds } from "../lib/domain";
import { hash } from "../lib/security";
import { generateContent, providerBudget } from "../lib/provider";
import { checkBusinessFacts } from "../lib/checks";

// Offline preflight by default. A paid run requires both an explicit flag and
// the existing process-level paid-call gate; this never enables app payments.
const selectedService =
  process.argv.find((arg) => arg.startsWith("--service="))?.split("=")[1] ||
  "business_website";
if (!serviceIds.includes(selectedService as (typeof serviceIds)[number]))
  throw new Error("Unknown service.");
const brief = briefSchema.parse({
  ...blankBrief(selectedService as (typeof serviceIds)[number]),
  businessName: "Nook Studio",
  description:
    "We create calm, practical interiors for small homes and independent businesses.",
  industry: "Interior design",
  location: "Lagos, Nigeria",
  audience: "Local homeowners and independent business owners",
  contact: "hello@nook.example",
  offer:
    selectedService === "promo_video"
      ? "Calm, practical interiors for everyday life"
      : "",
  items:
    selectedService === "flyers_price_list"
      ? [{ name: "Design consultation", currency: "NGN", price: "15,000" }]
      : [],
  question:
    selectedService === "market_report"
      ? "What customer needs should a small interior design studio in Lagos investigate before choosing its services?"
      : "",
});
if (!process.env.OPENAI_API_KEY?.trim())
  throw new Error("OpenAI key is missing.");
if (!process.env.OPENAI_TEXT_MODEL || !process.env.OPENAI_RESEARCH_MODEL)
  throw new Error("Select the text and research models first.");
const budget = providerBudget(brief);
console.log(
  JSON.stringify(
    {
      keyPresent: true,
      model: process.env.OPENAI_TEXT_MODEL,
      service: brief.service,
      estimatedReserveUSD: budget.reserve,
      maxOutputTokens: budget.tokens,
      appMode: process.env.APP_MODE || "demo",
      paidRunRequested: process.argv.includes("--paid"),
    },
    null,
    2,
  ),
);
if (process.argv.includes("--paid")) {
  // generateContent enforces ALLOW_PAID_API_CALLS=true before any network I/O.
  // No automatic retry: a failed request may still have incurred provider cost.
  const dir = path.resolve(".forma", "ai-check");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}.json`);
  let result: Record<string, unknown> = {
    brief,
    briefHash: hash(canonical(brief)),
  };
  try {
    const generated = await generateContent(brief, async (response) => {
      await writeFile(
        file + ".raw.json",
        JSON.stringify(
          { brief, briefHash: hash(canonical(brief)), response },
          null,
          2,
        ),
      );
    });
    result = { ...generated, brief, briefHash: hash(canonical(brief)) };
    await writeFile(file, JSON.stringify(result, null, 2));
    checkBusinessFacts(brief, generated.content);
    console.log(
      `Structured content and business-fact checks passed. Result: ${file}`,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Validation failed";
    await writeFile(
      file,
      JSON.stringify(
        {
          ...result,
          validation: { passed: false, error: message },
          rawResponseFile: file + ".raw.json",
        },
        null,
        2,
      ),
    );
    console.error(
      `Test failed: ${message} Saved diagnostics: ${file}. Raw response, if received: ${file}.raw.json. No retry made.`,
    );
    process.exitCode = 1;
  }
} else {
  console.log("Offline preflight passed. No API request made.");
}
