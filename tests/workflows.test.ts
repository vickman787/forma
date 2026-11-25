import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
process.env.APP_MODE = "demo";
process.env.GENERATION_PROVIDER = "template";
process.env.DATA_DIRECTORY = path.resolve(".forma/test-" + Date.now());
if (process.env.FORMA_TEST_DATABASE_URL)
  process.env.DATABASE_URL = process.env.FORMA_TEST_DATABASE_URL;
else delete process.env.DATABASE_URL;
import { database } from "../lib/db";
import {
  blankBrief,
  briefSchema,
  canonical,
  type ServiceId,
} from "../lib/domain";
import { quote, createOrder, ownedOrder } from "../lib/orders";
import { runOne, simulateFunding, simulateAccept } from "./helpers/fixtures";
import { hash, now } from "../lib/security";
import { generateContent, providerBudget } from "../lib/provider";
const sample = (service: ServiceId) => ({
  ...blankBrief(service),
  businessName: "Mira & Co. Bakery",
  description:
    "We make fresh sourdough bread and pastries for our neighbourhood. Our small team welcomes customers every morning.",
  industry: "Bakery",
  location: "Yaba, Lagos",
  audience: "Neighbourhood families and busy professionals",
  contact: "hello@mira.example",
  cta: "Visit our bakery",
  offer: "Fresh bread. Better mornings.",
  question: "How can a small bakery differentiate in Yaba, Lagos?",
  items: [
    { name: "Sourdough loaf", price: "2,500.00", currency: "NGN" },
    { name: "Croissant & butter", price: "1,200", currency: "₦" },
  ],
});
test(
  "four durable render workflows using saved fixture content, ownership and real downloads",
  { timeout: 300000 },
  async (t) => {
    const db = await database(),
      owner = randomUUID(),
      other = randomUUID();
    for (const id of [owner, other])
      await db.query("INSERT INTO customers(id,created_at) VALUES($1,$2)", [
        id,
        now(),
      ]);
    const outputs: any[] = [];
    await t.test(
      "schemas reject missing facts, oversized lists, and false consent",
      () => {
        assert.equal(
          briefSchema.safeParse({
            ...sample("business_website"),
            businessName: "",
          }).success,
          false,
        );
        assert.equal(
          briefSchema.safeParse({ ...sample("flyers_price_list"), items: [] })
            .success,
          false,
        );
        assert.equal(
          briefSchema.safeParse({ ...sample("promo_video"), consent: false })
            .success,
          false,
        );
        assert.equal(
          briefSchema.safeParse({ ...sample("market_report"), question: "" })
            .success,
          false,
        );
        assert.equal(
          briefSchema.safeParse({
            ...sample("business_website"),
            color: "red; background:url(evil)",
          }).success,
          false,
        );
      },
    );
    await t.test("paid provider calls fail closed", async () => {
      process.env.ALLOW_PAID_API_CALLS = "false";
      await assert.rejects(
        () => generateContent(sample("business_website")),
        /disabled/,
      );
      assert.throws(
        () => providerBudget(sample("business_website")),
        /cost bounds/,
      );
    });
    for (const service of [
      "business_website",
      "flyers_price_list",
      "promo_video",
      "market_report",
    ] as ServiceId[])
      await t.test(service, async () => {
        const q = await quote(owner, sample(service)),
          o = await createOrder(owner, q.id);
        assert.equal((await createOrder(owner, q.id)).id, o.id);
        await assert.rejects(() => ownedOrder(o.id, other), /not found/);
        assert.equal(await runOne(), false, "unfunded orders must not run");
        await assert.rejects(
          () => simulateAccept(o.id, owner),
          /Only a delivered/,
        );
        await simulateFunding(o.id, owner);
        await simulateFunding(o.id, owner);
        const jobs = await db.query("SELECT * FROM jobs WHERE order_id=$1", [
          o.id,
        ]);
        assert.equal(jobs.length, 1);
        await runOne();
        const complete = await ownedOrder(o.id, owner);
        assert.equal(
          complete.work,
          "delivered",
          complete.error || "render failed",
        );
        assert.equal(complete.payment, "funded");
        assert.equal(
          hash(canonical(complete.manifest)),
          complete.manifest_hash,
        );
        const artifacts = await db.query(
          "SELECT * FROM artifacts WHERE order_id=$1",
          [o.id],
        );
        for (const a of artifacts) {
          const bytes = await readFile(
            path.join(process.env.DATA_DIRECTORY!, a.storage_key),
          );
          assert.equal(hash(bytes), a.sha256);
          assert.equal(bytes.length, a.size);
          if (a.mime === "application/pdf")
            assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
        }
        if (service === "business_website") {
          const html = await readFile(
            path.join(
              process.env.DATA_DIRECTORY!,
              artifacts.find((a) => a.name === "index.html").storage_key,
            ),
            "utf8",
          );
          assert.ok(html.includes("Mira &amp; Co. Bakery"));
          assert.ok(html.includes("hello@mira.example"));
          assert.ok(!html.includes("<script"));
        }
        if (service === "market_report") {
          const html = await readFile(
            path.join(
              process.env.DATA_DIRECTORY!,
              artifacts.find((a) => a.name === "market-brief.html").storage_key,
            ),
            "utf8",
          );
          assert.ok(
            html.includes("No OpenAI request or web research was performed"),
          );
        }
        const events = await db.query(
          "SELECT * FROM events WHERE order_id=$1",
          [o.id],
        );
        assert.ok(
          ["validate", "render", "check", "deliver"].every((s) =>
            events.some((e) => e.stage === s),
          ),
        );
        await simulateAccept(o.id, owner);
        await simulateAccept(o.id, owner);
        assert.equal((await ownedOrder(o.id, owner)).payment, "released");
        assert.equal(await runOne(), false);
        outputs.push({
          service,
          order: o.id,
          artifacts: artifacts.map((a) =>
            path.join(process.env.DATA_DIRECTORY!, a.storage_key),
          ),
        });
      });
    await t.test("expired quotes cannot create orders", async () => {
      const q = await quote(owner, sample("business_website"));
      await db.query("UPDATE quotes SET expires=$1 WHERE id=$2", [
        "2000-01-01T00:00:00.000Z",
        q.id,
      ]);
      await assert.rejects(() => createOrder(owner, q.id), /expired/);
    });
    await t.test("abandoned execution leases resume saved stages", async () => {
      const q = await quote(owner, sample("business_website")),
        o = await createOrder(owner, q.id);
      await simulateFunding(o.id, owner);
      await db.query(
        "UPDATE jobs SET status='running',lease_token='dead-worker',lease_until='2000-01-01T00:00:00.000Z' WHERE order_id=$1",
        [o.id],
      );
      await runOne();
      assert.equal((await ownedOrder(o.id, owner)).work, "delivered");
    });
    await t.test(
      "renderer failure is truthful and retains payment state",
      async () => {
        const originalFfmpeg = process.env.FFMPEG_PATH;
        process.env.FFMPEG_PATH = "C:/missing/ffmpeg.exe";
        const q = await quote(owner, {
            ...sample("promo_video"),
            offer: "A valid promotional offer",
          }),
          o = await createOrder(owner, q.id);
        await simulateFunding(o.id, owner);
        await runOne();
        const failed = await ownedOrder(o.id, owner);
        if (originalFfmpeg) process.env.FFMPEG_PATH = originalFfmpeg;
        else delete process.env.FFMPEG_PATH;
        assert.equal(failed.work, "failed");
        assert.equal(failed.payment, "funded");
        assert.ok(failed.error);
      },
    );
    await mkdir(".forma", { recursive: true });
    await writeFile(
      ".forma/test-output-index.json",
      JSON.stringify(outputs, null, 2),
    );
  },
);
