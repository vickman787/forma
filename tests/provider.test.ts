import { templateContent } from "./helpers/fixtures";
import { test } from "node:test";
import assert from "node:assert/strict";
import { blankBrief } from "../lib/domain";
import {
  generateContent,
  providerBudget,
  validateProviderResponse,
} from "../lib/provider";
import { checkBusinessFacts } from "../lib/checks";
const brief = {
  ...blankBrief(),
  businessName: "Nook Studio",
  description: "We make thoughtful interiors for small independent businesses.",
  industry: "Design",
  location: "Lagos",
  audience: "Business owners",
  contact: "hello@nook.example",
};
test("provider validation and failure boundaries with mocked HTTP only", async (t) => {
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    ALLOW_PAID_API_CALLS: "true",
    OPENAI_API_KEY: "mock-not-a-key",
    OPENAI_TEXT_MODEL: "configured-test-model",
    OPENAI_RESEARCH_MODEL: "configured-test-model",
    MAX_JOB_COST_USD: "1",
    MAX_INPUT_COST_PER_MILLION: "1",
    MAX_OUTPUT_COST_PER_MILLION: "1",
    MAX_SEARCH_COST_USD: ".01",
  });
  const content = templateContent(brief);
  try {
    await t.test(
      "successful structured response records request, model and usage",
      async () => {
        globalThis.fetch = async (_url, opts) => {
          const body = JSON.parse(opts?.body as string);
          assert.equal(body.model, "configured-test-model");
          assert.equal(body.store, false);
          assert.equal(body.text.format.strict, true);
          return Response.json({
            id: "mock-response",
            status: "completed",
            usage: { input_tokens: 100, output_tokens: 200 },
            output: [
              {
                type: "message",
                content: [
                  { type: "output_text", text: JSON.stringify(content) },
                ],
              },
            ],
          });
        };
        const result = await generateContent(brief);
        assert.equal(result.requestId, "mock-response");
        assert.equal(result.model, "configured-test-model");
      },
    );
    await t.test("schema failure cannot deliver", async () => {
      globalThis.fetch = async () =>
        Response.json({
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: '{"headline":42}' }],
            },
          ],
        });
      await assert.rejects(() => generateContent(brief));
    });
    await t.test(
      "provider error and ambiguous timeout do not silently succeed",
      async () => {
        globalThis.fetch = async () => new Response("no", { status: 429 });
        await assert.rejects(() => generateContent(brief), /429/);
        globalThis.fetch = async () => {
          throw new Error("timeout");
        };
        await assert.rejects(() => generateContent(brief), /timeout/);
      },
    );
    await t.test("cost ceiling blocks before fetch", () => {
      process.env.MAX_JOB_COST_USD = ".000001";
      assert.throws(() => providerBudget(brief), /exceeds/);
      process.env.MAX_JOB_COST_USD = "1";
    });
    await t.test(
      "fabricated report URLs fail source provenance checks",
      async () => {
        const report = {
          ...brief,
          service: "market_report" as const,
          question: "What matters to customers?",
        };
        globalThis.fetch = async () =>
          Response.json({
            id: "mock-report",
            status: "completed",
            output: [
              {
                type: "web_search_call",
                action: {
                  sources: [{ url: "https://verified.example/source" }],
                },
              },
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      ...content,
                      sources: [
                        {
                          title: "Invented",
                          url: "https://fabricated.example",
                        },
                      ],
                    }),
                  },
                ],
              },
            ],
          });
        await assert.rejects(() => generateContent(report), /not supported/);
      },
    );
    await t.test(
      "report citations must appear in the declared source list even when search found them",
      async () => {
        const first = "https://verified.example/first",
          second = "https://verified.example/second";
        globalThis.fetch = async () =>
          Response.json({
            id: "mock-unmatched-citation",
            status: "completed",
            usage: { output_tokens: 100 },
            output: [
              {
                type: "web_search_call",
                action: { sources: [{ url: first }, { url: second }] },
              },
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      ...content,
                      sources: [{ title: "Declared source", url: first }],
                      sections: [
                        {
                          title: "Evidence",
                          text: "A sourced observation.",
                          sourceUrls: [second],
                          inference: false,
                        },
                      ],
                    }),
                  },
                ],
              },
            ],
          });
        let saved: any;
        await assert.rejects(
          () =>
            generateContent(
              { ...brief, service: "market_report" },
              async (raw) => {
                saved = raw;
              },
            ),
          /Unmatched claim citation/,
        );
        assert.equal(saved.id, "mock-unmatched-citation");
        assert.equal(saved.usage.output_tokens, 100);
      },
    );
    await t.test(
      "report source IDs resolve exact verified URLs and fail closed for unknown or duplicate IDs",
      () => {
        const verified = "https://verified.example/research?edition=original";
        const wire = {
          ...content,
          sources: [{ id: "S1", title: "Evidence", url: verified }],
          sections: [
            {
              title: "Evidence",
              text: "A sourced finding.",
              sourceIds: ["S1"],
              inference: false,
            },
          ],
        };
        const response = (body: unknown) => ({
          status: "completed",
          output: [
            {
              type: "web_search_call",
              action: { sources: [{ url: verified }] },
            },
            {
              type: "message",
              content: [{ type: "output_text", text: JSON.stringify(body) }],
            },
          ],
        });
        const parsed = validateProviderResponse(response(wire), true);
        assert.deepEqual(parsed.sections[0].sourceUrls, [verified]);
        assert.throws(
          () =>
            validateProviderResponse(
              response({
                ...wire,
                sections: [{ ...wire.sections[0], sourceIds: ["S2"] }],
              }),
              true,
            ),
          /undeclared source identifier/,
        );
        assert.throws(
          () =>
            validateProviderResponse(
              response({
                ...wire,
                sources: [wire.sources[0], wire.sources[0]],
              }),
              true,
            ),
          /Duplicate/,
        );
        assert.throws(
          () =>
            validateProviderResponse(
              response({
                ...wire,
                sources: [
                  {
                    ...wire.sources[0],
                    url: "https://invented.example/research",
                  },
                ],
              }),
              true,
            ),
          /not supported/,
        );
        assert.throws(
          () =>
            validateProviderResponse(
              response({
                ...wire,
                sections: [
                  { ...wire.sections[0], sourceIds: [], inference: false },
                ],
              }),
              true,
            ),
          /unsourced/,
        );
      },
    );
    await t.test("new contact details and changed numbers are rejected", () => {
      assert.throws(
        () =>
          checkBusinessFacts(brief, {
            ...content,
            body: "Email attacker@example.com",
          }),
        /contact/,
      );
      assert.throws(
        () =>
          checkBusinessFacts(brief, {
            ...content,
            headline: "Get 40% off today",
          }),
        /number or price/,
      );
      checkBusinessFacts(brief, content);
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.env.ALLOW_PAID_API_CALLS = "false";
  }
});
