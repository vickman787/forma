import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, parseAbi } from "viem";
import { operatorPlan, validateDeliveryState } from "../lib/operator";
import { blankBrief, type Order } from "../lib/domain";
const clock = Date.parse("2026-11-24T12:00:00Z");
const settings = {
  escrow: "0x1111111111111111111111111111111111111111",
  operator: "0x2222222222222222222222222222222222222222",
};
const quote = {
  wallet: "0x3333333333333333333333333333333333333333",
  terms_hash: "ab".repeat(32),
};
const base: Order = {
  id: "test-order",
  owner: "test-owner",
  quote_id: "test-quote",
  mode: "live",
  generation: "openai",
  brief: blankBrief(),
  work: "awaiting_funding",
  payment: "unfunded",
  created_at: new Date(clock).toISOString(),
  updated_at: new Date(clock).toISOString(),
  funding_expires: new Date(clock + 1800000).toISOString(),
  delivery_due: null,
  review_due: null,
  manifest: null,
  manifest_hash: null,
  error: null,
  chain_job: `0x${"12".repeat(32)}`,
  version: 1,
  tx_hash: null,
};
test("delivery execution checks the funded chain state, customer, amount, terms and deadlines", () => {
  const order = {
    ...base,
    delivery_due: new Date(clock + 60000).toISOString(),
  };
  const job: [string, bigint, string, string, bigint, bigint, bigint, number] =
    [
      quote.wallet,
      1000000n,
      `0x${quote.terms_hash}`,
      `0x${"00".repeat(32)}`,
      BigInt(Date.parse(order.funding_expires) / 1000),
      BigInt((clock + 60000) / 1000),
      0n,
      2,
    ];
  assert.doesNotThrow(() => validateDeliveryState(order, quote, job, clock));
  const changes: [number, string | number | bigint][] = [
    [0, settings.operator],
    [1, 1n],
    [2, `0x${"ff".repeat(32)}`],
    [4, job[4] + 1n],
    [5, job[5] + 1n],
    [7, 3],
  ];
  for (const [index, value] of changes) {
    const changed = [...job] as typeof job;
    (changed as any[])[index] = value;
    assert.throws(
      () => validateDeliveryState(order, quote, changed, clock),
      /does not match/,
    );
  }
  assert.throws(
    () => validateDeliveryState(order, quote, job, clock + 60000),
    /does not match/,
  );
});
test("operator registration binds exact customer, amount, terms and quote expiry without signing", () => {
  const plan = operatorPlan(base, quote, "create", settings, clock);
  const decoded = decodeFunctionData({
    abi: parseAbi([
      "function createJob(bytes32,address,uint256,bytes32,uint64)",
    ]),
    data: plan.data,
  });
  assert.deepEqual(decoded.args, [
    base.chain_job,
    quote.wallet,
    1000000n,
    `0x${quote.terms_hash}`,
    BigInt((clock + 1800000) / 1000),
  ]);
  assert.equal(plan.unsigned, true);
  assert.equal(plan.requiresExplicitUserAuthorization, true);
  assert.equal(plan.from, settings.operator);
  assert.equal(plan.value, "0");
});
test("operator plans reject demo orders, malformed commitments and invalid or expired quotes", () => {
  for (const changes of [
    { mode: "demo" },
    { chain_job: "0x12" },
    { funding_expires: "invalid" },
    { funding_expires: new Date(clock).toISOString() },
    { funding_expires: new Date(clock + 1801000).toISOString() },
    { payment: "pending" },
    { work: "closed" },
  ] as Partial<Order>[])
    assert.throws(() =>
      operatorPlan({ ...base, ...changes }, quote, "create", settings, clock),
    );
  assert.throws(() =>
    operatorPlan(
      base,
      { ...quote, terms_hash: "bad" },
      "create",
      settings,
      clock,
    ),
  );
  assert.throws(() =>
    operatorPlan(
      base,
      quote,
      "create",
      { ...settings, operator: `0x${"0".repeat(40)}` },
      clock,
    ),
  );
});
test("delivery plan requires a checked commitment and an unexpired funded job", () => {
  const ready = {
    ...base,
    work: "checking" as const,
    payment: "funded" as const,
    manifest_hash: "cd".repeat(32),
    delivery_due: new Date(clock + 60000).toISOString(),
  };
  assert.equal(
    operatorPlan(ready, quote, "deliver", settings, clock).action,
    "deliver",
  );
  for (const changes of [
    { manifest_hash: null },
    { manifest_hash: "bad" },
    { payment: "unfunded" },
    { work: "generating" },
    { delivery_due: new Date(clock).toISOString() },
    { delivery_due: "invalid" },
  ] as Partial<Order>[])
    assert.throws(() =>
      operatorPlan({ ...ready, ...changes }, quote, "deliver", settings, clock),
    );
});
test("release respects review deadline and refund cannot target a settled job", () => {
  const delivered = {
    ...base,
    work: "delivered" as const,
    payment: "funded" as const,
    review_due: new Date(clock).toISOString(),
  };
  assert.equal(
    operatorPlan(delivered, quote, "release", settings, clock).action,
    "release",
  );
  assert.throws(() =>
    operatorPlan(
      { ...delivered, review_due: new Date(clock + 1).toISOString() },
      quote,
      "release",
      settings,
      clock,
    ),
  );
  assert.throws(() =>
    operatorPlan(
      { ...delivered, review_due: "invalid" },
      quote,
      "release",
      settings,
      clock,
    ),
  );
  assert.equal(
    operatorPlan(delivered, quote, "refund", settings, clock).action,
    "refund",
  );
  assert.throws(() =>
    operatorPlan(
      { ...delivered, payment: "released" },
      quote,
      "refund",
      settings,
      clock,
    ),
  );
});
