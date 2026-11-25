import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { database } from "../lib/db";
import { blankBrief, canonical, serviceIds } from "../lib/domain";
import { quote, createOrder, ownedOrder } from "../lib/orders";
import { validateProviderResponse } from "../lib/provider";
import { templateContent } from "./helpers/fixtures";
import { replaySavedResponse } from "./helpers/replay";
import { availability } from "../lib/capabilities";
import { hash, now } from "../lib/security";
import { runOne, simulateFunding, simulateAccept } from "./helpers/fixtures";

test(
  "AI generation with simulated payments, mocked network only",
  { timeout: 300000 },
  async (t) => {
    Object.assign(process.env, {
      APP_MODE: "demo",
      DATA_DIRECTORY: path.resolve(".forma/ai-tests-" + Date.now()),
      GENERATION_PROVIDER: "openai",
      ALLOW_PAID_API_CALLS: "true",
      OPENAI_API_KEY: "mock-not-a-key",
      OPENAI_TEXT_MODEL: "test-model",
      OPENAI_RESEARCH_MODEL: "test-research-model",
      MAX_JOB_COST_USD: ".10",
      MAX_INPUT_COST_PER_MILLION: ".75",
      MAX_OUTPUT_COST_PER_MILLION: "4.50",
      MAX_SEARCH_COST_USD: ".01",
    });
    if (process.env.FORMA_TEST_DATABASE_URL)
      process.env.DATABASE_URL = process.env.FORMA_TEST_DATABASE_URL;
    else delete process.env.DATABASE_URL;
    const originalFetch = globalThis.fetch;
    let calls = 0;
    const db = await database(),
      owner = randomUUID();
    await db.query("INSERT INTO customers(id,created_at) VALUES($1,$2)", [
      owner,
      now(),
    ]);
    const sample = (service: (typeof serviceIds)[number]) => ({
      ...blankBrief(service),
      businessName: "Nook Studio",
      description:
        "We design calm and practical interiors for homes and small businesses.",
      industry: "Interior design",
      location: "Lagos",
      audience: "Local homeowners",
      contact: "hello@nook.example",
      offer: "Thoughtful spaces for everyday life",
      question: "Which customer needs should our studio investigate?",
      items: [{ name: "Consultation", price: "15,000", currency: "NGN" }],
    });
    const contentFor = (b: ReturnType<typeof sample>) => ({
      ...templateContent(b),
      headline: "Calm spaces, thoughtfully designed",
      body: "Practical spaces for everyday life.",
      scenes: [
        "Nook Studio",
        "Designed for everyday life",
        "Calm spaces in Lagos",
        "Get in touch",
      ],
      sections: [
        {
          title: "Welcome",
          text: "Thoughtful spaces for everyday life.",
          sourceUrls: [],
          inference: true,
        },
      ],
      limitations: "Mocked test content. No real research or provider billing.",
    });
    globalThis.fetch = async (_url, options) => {
      calls++;
      const request = JSON.parse(options?.body as string),
        b = JSON.parse(request.input);
      const content = contentFor(b);
      const research = b.service === "market_report";
      if (research) {
        assert.equal(request.tools[0].type, "web_search");
        content.sources = [
          { title: "Mock evidence", url: "https://example.org/mock-evidence" },
        ];
        content.sections[0].sourceUrls = [content.sources[0].url] as never[];
        content.sections[0].inference = false;
      }
      return Response.json({
        id: "mock-" + calls,
        status: "completed",
        usage: { input_tokens: 100, output_tokens: 200 },
        output: [
          ...(research
            ? [
                {
                  type: "web_search_call",
                  action: { sources: content.sources },
                },
              ]
            : []),
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify(
                  research
                    ? {
                        ...content,
                        sources: content.sources.map((source) => ({
                          ...source,
                          id: "S1",
                        })),
                        sections: content.sections.map(
                          ({ sourceUrls, ...section }) => ({
                            ...section,
                            title: "Evidence",
                            sourceIds: ["S1"],
                          }),
                        ),
                      }
                    : content,
                ),
              },
            ],
          },
        ],
      });
    };
    try {
      for (const service of serviceIds)
        await t.test(
          service + " produces checked files from AI content",
          async () => {
            const q = await quote(owner, sample(service));
            // Changing the default after quoting must not change this order's engine.
            process.env.GENERATION_PROVIDER = "template";
            const order = await createOrder(owner, q.id);
            assert.equal(order.generation, "openai");
            assert.equal((await createOrder(owner, q.id)).generation, "openai");
            await simulateFunding(order.id, owner);
            const before = calls;
            await runOne();
            const done = await ownedOrder(order.id, owner);
            assert.equal(done.work, "delivered", done.error || "render failed");
            assert.equal(calls, before + 1);
            assert.equal(done.manifest.generation, "openai");
            assert.ok(
              done.manifest.limitations.every(
                (s: string) => !s.includes("simulated"),
              ),
            );
            const [job] = await db.query(
              "SELECT * FROM jobs WHERE order_id=$1",
              [order.id],
            );
            const [raw] = await db.query(
              "SELECT * FROM provider_responses WHERE job_id=$1",
              [job.id],
            );
            assert.ok(raw.response.includes(job.provider_request_id));
            if (service === "business_website") {
              const [file] = await db.query(
                "SELECT * FROM artifacts WHERE order_id=$1 AND name='index.html'",
                [order.id],
              );
              const html = await readFile(
                path.join(process.env.DATA_DIRECTORY!, file.storage_key),
                "utf8",
              );
              assert.ok(html.includes("Thoughtful spaces for everyday life."));
              assert.ok(!html.includes("Template demonstration"));
            }
            assert.equal(await runOne(), false);
            process.env.GENERATION_PROVIDER = "openai";
          },
        );
      await t.test(
        "restart recovers a saved raw response without another provider call",
        async () => {
          const brief = sample("business_website");
          const q = await quote(owner, brief);
          const order = await createOrder(owner, q.id);
          await simulateFunding(order.id, owner);
          const [job] = await db.query("SELECT * FROM jobs WHERE order_id=$1", [
            order.id,
          ]);
          const response = {
            id: "saved-before-crash",
            status: "completed",
            usage: { input_tokens: 100, output_tokens: 200 },
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify(contentFor(brief)),
                  },
                ],
              },
            ],
          };
          await db.query(
            "INSERT INTO provider_responses(job_id,response,created_at) VALUES($1,$2,$3)",
            [job.id, JSON.stringify(response), now()],
          );
          await db.query(
            "UPDATE jobs SET provider_started=1,status='running',lease_until=$1 WHERE id=$2",
            [new Date(0).toISOString(), job.id],
          );
          const before = calls;
          await runOne();
          assert.equal(calls, before);
          assert.equal((await ownedOrder(order.id, owner)).work, "delivered");
          const [recovered] = await db.query(
            "SELECT usage,provider_request_id FROM jobs WHERE id=$1",
            [job.id],
          );
          assert.equal(recovered.provider_request_id, response.id);
          assert.equal(
            JSON.parse(recovered.usage).recoveredFromSavedResponse,
            true,
          );
        },
      );
      await t.test(
        "rejected provider data and usage survive validation; retry cannot rebill",
        async () => {
          const q = await quote(owner, sample("business_website")),
            order = await createOrder(owner, q.id);
          await simulateFunding(order.id, owner);
          globalThis.fetch = async () => {
            calls++;
            return Response.json({
              id: "mock-rejected",
              status: "completed",
              usage: { output_tokens: 15 },
              output: [
                {
                  type: "message",
                  content: [{ type: "output_text", text: '{"headline":42}' }],
                },
              ],
            });
          };
          await runOne();
          assert.equal((await ownedOrder(order.id, owner)).work, "failed");
          const [job] = await db.query("SELECT * FROM jobs WHERE order_id=$1", [
            order.id,
          ]);
          const [raw] = await db.query(
            "SELECT * FROM provider_responses WHERE job_id=$1",
            [job.id],
          );
          assert.equal(JSON.parse(raw.response).id, "mock-rejected");
          const before = calls;
          await db.query("UPDATE jobs SET status='queued' WHERE id=$1", [
            job.id,
          ]);
          await runOne();
          assert.equal(calls, before);
          assert.match((await ownedOrder(order.id, owner)).error!, /Reconcile/);
        },
      );
      await t.test(
        "saved response replay renders with billing disabled and rejects mismatched briefs",
        async () => {
          process.env.ALLOW_PAID_API_CALLS = "false";
          assert.equal(availability("business_website").enabled, false);
          const brief = sample("business_website");
          const saved = {
            brief,
            briefHash: hash(canonical(brief)),
            content: contentFor(brief),
            requestId: "saved-test-response",
            model: "test-model",
            usage: {},
          };
          await assert.rejects(
            () =>
              replaySavedResponse(owner, {
                ...saved,
                brief: { ...brief, businessName: "Other business" },
              }),
            /original brief/,
          );
          const order = await replaySavedResponse(owner, saved),
            before = calls;
          await runOne();
          assert.equal(calls, before);
          assert.equal((await ownedOrder(order.id, owner)).work, "delivered");
          assert.equal(
            (await ownedOrder(order.id, owner)).generation,
            "saved_openai",
          );
        },
      );
      await t.test(
        "research replay requires original evidence and exact unchanged content without new billing",
        async () => {
          const brief = sample("market_report"),
            url = "https://example.org/mock-evidence";
          const wire = {
            ...contentFor(brief),
            sources: [{ id: "S1", title: "Mock source", url }],
            sections: [
              {
                title: "Evidence",
                text: "A mocked research finding.",
                sourceIds: ["S1"],
                inference: false,
              },
            ],
          };
          const raw = {
            id: "saved-research-response",
            status: "completed",
            output: [
              { type: "web_search_call", action: { sources: [{ url }] } },
              {
                type: "message",
                content: [{ type: "output_text", text: JSON.stringify(wire) }],
              },
            ],
          };
          const saved = {
            brief,
            briefHash: hash(canonical(brief)),
            content: validateProviderResponse(raw, true),
            requestId: raw.id,
            model: "test-research-model",
            usage: {},
          };
          await assert.rejects(
            () => replaySavedResponse(owner, saved),
            /original raw search evidence/,
          );
          const withEvidence = {
            ...saved,
            researchEvidence: { briefHash: saved.briefHash, response: raw },
          };
          await assert.rejects(
            () =>
              replaySavedResponse(owner, {
                ...withEvidence,
                content: { ...saved.content, body: "Changed report body" },
              }),
            /differs/,
          );
          const before = calls,
            order = await replaySavedResponse(owner, withEvidence);
          await runOne();
          assert.equal(calls, before);
          assert.equal((await ownedOrder(order.id, owner)).work, "delivered");
          const [report] = await db.query(
            "SELECT * FROM artifacts WHERE order_id=$1 AND name='market-brief.html'",
            [order.id],
          );
          assert.ok(
            (
              await readFile(
                path.join(process.env.DATA_DIRECTORY!, report.storage_key),
                "utf8",
              )
            ).includes(url),
          );
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
      process.env.ALLOW_PAID_API_CALLS = "false";
    }
  },
);
