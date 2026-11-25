import { test } from "node:test";
import assert from "node:assert/strict";
import { reserveProviderCall } from "../lib/provider-budget";
import { database } from "../lib/db";
import { generateContent } from "../lib/provider";
import { blankBrief } from "../lib/domain";
import { randomUUID } from "node:crypto";
import { quote, createOrder } from "../lib/orders";
import { releaseExpiredProviderReservation } from "../lib/provider-budget";
test("aggregate provider budget is durable, atomic and conservative on ambiguous requests", async () => {
  process.env.APP_MODE = "demo";
  process.env.DATA_DIRECTORY = `.forma/test-${Date.now()}`;
  if (process.env.FORMA_TEST_DATABASE_URL)
    process.env.DATABASE_URL = process.env.FORMA_TEST_DATABASE_URL;
  else delete process.env.DATABASE_URL;
  process.env.PROVIDER_BUDGET_ID = "isolated-test-only";
  process.env.PROVIDER_TOTAL_BUDGET_USD = "0.3";
  process.env.MAX_JOB_COST_USD = "0.1";
  const attempts = await Promise.allSettled(
    Array.from({ length: 5 }, () => reserveProviderCall()),
  );
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal(attempts.filter((r) => r.status === "rejected").length, 2);
  const db = await database();
  const [row] = await db.query("SELECT * FROM provider_budgets WHERE id=$1", [
    process.env.PROVIDER_BUDGET_ID,
  ]);
  assert.equal(Number(row.reserved_microusd), 300000);
  assert.equal(
    (await db.query("SELECT * FROM provider_budget_reservations")).length,
    3,
  );
  // Reservations remain even if a request fails or its billing outcome is unknown.
  await assert.rejects(() => reserveProviderCall(), /exhausted/);
  Object.assign(process.env, {
    ALLOW_PAID_API_CALLS: "true",
    OPENAI_API_KEY: "test-only-never-sent",
    OPENAI_TEXT_MODEL: "mock-model",
    MAX_INPUT_COST_PER_MILLION: "0.75",
    MAX_OUTPUT_COST_PER_MILLION: "4.5",
    MAX_SEARCH_COST_USD: "0.01",
    MAX_OUTPUT_TOKENS: "2500",
  });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("Network must not be called");
  };
  try {
    await assert.rejects(() => generateContent(blankBrief()), /exhausted/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
  process.env.PROVIDER_TOTAL_BUDGET_USD = "1";
  await assert.rejects(() => reserveProviderCall(), /newly approved budget ID/);
  process.env.PROVIDER_BUDGET_ID = "invalid/id";
  await assert.rejects(() => reserveProviderCall(), /configuration/);
});
test("checkout capacity is reserved once, reused by generation, and released only for expired unfunded orders", async () => {
  process.env.PROVIDER_BUDGET_ID = "order-capacity-test";
  process.env.PROVIDER_TOTAL_BUDGET_USD = "0.1";
  process.env.MAX_JOB_COST_USD = "0.1";
  const db = await database(),
    owner = randomUUID();
  await db.query("INSERT INTO customers(id,created_at) VALUES($1,$2)", [
    owner,
    new Date().toISOString(),
  ]);
  const brief = {
    ...blankBrief(),
    businessName: "Capacity test",
    industry: "Services",
    description: "A valid approved description for isolated capacity testing.",
    location: "Lagos",
    audience: "Local customers",
    contact: "test@example.invalid",
  };
  const q = await quote(owner, brief),
    o = await createOrder(owner, q.id);
  const results = await Promise.all(
    Array.from({ length: 5 }, () => reserveProviderCall(o.id)),
  );
  assert.equal(new Set(results.map((r) => r?.id)).size, 1);
  await releaseExpiredProviderReservation(o.id);
  assert.equal(
    (
      await db.query(
        "SELECT * FROM provider_order_reservations WHERE order_id=$1",
        [o.id],
      )
    ).length,
    1,
    "unexpired checkout retains its capacity",
  );
  await assert.rejects(() => reserveProviderCall(), /exhausted/);
  await db.query("UPDATE orders SET funding_expires=$1 WHERE id=$2", [
    new Date(Date.now() - 1000).toISOString(),
    o.id,
  ]);
  await releaseExpiredProviderReservation(o.id);
  assert.equal(
    (
      await db.query(
        "SELECT * FROM provider_order_reservations WHERE order_id=$1",
        [o.id],
      )
    ).length,
    0,
  );
  const [budget] = await db.query(
    "SELECT reserved_microusd FROM provider_budgets WHERE id=$1",
    [process.env.PROVIDER_BUDGET_ID],
  );
  assert.equal(Number(budget.reserved_microusd), 0);
  await reserveProviderCall(o.id);
  await db.query("UPDATE orders SET payment='funded' WHERE id=$1", [o.id]);
  await releaseExpiredProviderReservation(o.id);
  assert.equal(
    (
      await db.query(
        "SELECT * FROM provider_order_reservations WHERE order_id=$1",
        [o.id],
      )
    ).length,
    1,
    "funded work cannot lose its reserved provider capacity",
  );
});
