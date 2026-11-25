import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { database } from "../lib/db";
import { blankBrief } from "../lib/domain";
import { quote, createOrder } from "../lib/orders";
import { operatorPolicy } from "../lib/operator-outbox";
import { runOperatorOne } from "../worker/operator";
import { heartbeat, checkoutReadiness } from "../lib/health";

test("automatic operator respects expiry, exact scope and aggregate gas limits before any signing command", async () => {
  process.env.APP_MODE = "demo";
  process.env.DATA_DIRECTORY = `.forma/test-${randomUUID()}/live`;
  if (process.env.FORMA_TEST_DATABASE_URL)
    process.env.DATABASE_URL = process.env.FORMA_TEST_DATABASE_URL;
  else delete process.env.DATABASE_URL;
  const db = await database();
  Object.assign(process.env, {
    APP_MODE: "live",
    LOCAL_ONLY: "true",
    APP_URL: "http://127.0.0.1:3000",
    PREVIEW_ORIGIN: "http://127.0.0.1:4317",
    SESSION_SECRET: "test-only-secret-at-least-thirty-two-characters",
    OPENAI_API_KEY: "never-used",
    OPENAI_TEXT_MODEL: "test",
    OPENAI_RESEARCH_MODEL: "test",
    GENERATION_PROVIDER: "openai",
    ALLOW_PAID_API_CALLS: "true",
    ESCROW_ADDRESS: `0x${"11".repeat(20)}`,
    TREASURY_ADDRESS: `0x${"22".repeat(20)}`,
    OPERATOR_ADDRESS: `0x${"22".repeat(20)}`,
    QIE_CHAIN_ID: "1990",
    QUSDC_DECIMALS: "6",
    SERVICE_PRICE_BASE_UNITS: "1000000",
    QUSDC_ADDRESS: "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5",
    MAX_JOB_COST_USD: "0.1",
    MAX_INPUT_COST_PER_MILLION: "0.75",
    MAX_OUTPUT_COST_PER_MILLION: "4.5",
    MAX_SEARCH_COST_USD: "0.01",
    LIVE_PAYMENTS_ENABLED: "true",
    LIVE_VERIFICATION_COMPLETE: "true",
    ALLOW_OPERATOR_TRANSACTIONS: "true",
    OPERATOR_POLICY_ID: "isolated-operator-test",
    OPERATOR_TOTAL_GAS_QIE: "0.0008",
    OPERATOR_MAX_TX_GAS_QIE: "0.0002",
    OPERATOR_POLICY_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
    OPERATOR_POLICY_ACTIONS: "create,deliver",
  });
  const owner = randomUUID();
  await db.query(
    "INSERT INTO customers(id,wallet,created_at) VALUES($1,$2,$3)",
    [owner, `0x${"33".repeat(20)}`, new Date().toISOString()],
  );
  const brief = {
    ...blankBrief(),
    businessName: "Operator test",
    industry: "Services",
    description: "Approved business description for isolated operator tests.",
    location: "Lagos",
    audience: "Local customers",
    contact: "test@example.invalid",
  };
  const orders = [];
  for (let i = 0; i < 3; i++) {
    const q = await quote(owner, brief);
    orders.push(await createOrder(owner, q.id));
  }
  let signed = 0,
    prepared = 0;
  const command = async (_file: string, args: string[]) => {
    if (args.includes("scripts/operator-preflight.ts")) {
      prepared++;
      if (prepared === 1) throw new Error("Temporary read-only RPC outage");
      const id = args[3];
      return {
        stdout: JSON.stringify({
          unsigned: true,
          orderId: id,
          transactionsSent: 0,
          maximumFeeQIE: "0.0001",
          file: id,
          planSha256: "ab".repeat(32),
        }),
        stderr: "",
      };
    }
    signed++;
    assert.equal(
      args[args.length - 1],
      "--approved-single-mainnet-registration",
    );
    await db.query(
      "UPDATE operator_tasks SET status='confirmed' WHERE order_id=$1 AND action='create'",
      [args[3]],
    );
    return { stdout: "", stderr: "" };
  };
  process.env.ALLOW_OPERATOR_TRANSACTIONS = "false";
  await assert.rejects(() => runOperatorOne(command as any), /disabled/);
  assert.equal(prepared, 0);
  process.env.ALLOW_OPERATOR_TRANSACTIONS = "true";
  process.env.OPERATOR_POLICY_ORDER_ID = randomUUID();
  assert.equal(await runOperatorOne(command as any), false);
  assert.equal(signed, 0);
  delete process.env.OPERATOR_POLICY_ORDER_ID;
  assert.equal(await runOperatorOne(command as any), true);
  assert.equal(prepared, 2, "unsigned preparation retries before any signing");
  assert.equal(
    signed,
    1,
    "signing is executed only once after preparation recovers",
  );
  assert.equal(await runOperatorOne(command as any), true);
  await runOperatorOne(command as any);
  assert.equal(
    signed,
    2,
    "exhausted allocation must prevent the third signing command",
  );
  const [budget] = await db.query(
    "SELECT reserved_wei FROM operator_policies WHERE id=$1",
    [process.env.OPERATOR_POLICY_ID],
  );
  assert.equal(BigInt(budget.reserved_wei), 800000000000000n);
  const [blocked] = await db.query(
    "SELECT status FROM operator_tasks WHERE order_id=$1",
    [orders[2].id],
  );
  assert.equal(blocked.status, "blocked");
  await heartbeat("generation");
  await heartbeat("chain");
  const policy = operatorPolicy();
  await heartbeat("operator", "ready", {
    ...policy,
    expires: Date.now() + 48 * 3600000,
    total: policy.total.toString(),
    maximumFee: policy.maximumFee.toString(),
  });
  process.env.FORMA_TEST_FIXTURES = "false";
  try {
    assert.equal(
      (await checkoutReadiness(true)).enabled,
      false,
      "exhausted gas capacity must prevent new checkout",
    );
    await heartbeat("operator", "ready", {
      ...policy,
      id: "unused-policy",
      expires: Date.now() + 48 * 3600000,
      total: policy.total.toString(),
      maximumFee: policy.maximumFee.toString(),
    });
    assert.equal((await checkoutReadiness(true)).enabled, true);
    await db.query(
      "UPDATE worker_health SET updated_at=$1 WHERE role='generation'",
      [new Date(Date.now() - 61000).toISOString()],
    );
    assert.equal(
      (await checkoutReadiness()).enabled,
      false,
      "stale worker must prevent charging",
    );
    await heartbeat("generation");
    await db.query(
      "UPDATE worker_health SET updated_at='invalid' WHERE role='chain'",
    );
    assert.equal((await checkoutReadiness()).enabled, false);
    await heartbeat("chain");
    await heartbeat("operator", "ready", { invalid: true });
    assert.equal(
      (await checkoutReadiness(true)).enabled,
      false,
      "malformed capacity must fail closed",
    );
  } finally {
    process.env.FORMA_TEST_FIXTURES = "true";
  }
  const failedQuote = await quote(owner, brief);
  const failedOrder = await createOrder(owner, failedQuote.id);
  let attempts = 0;
  await runOperatorOne((async (_file: string, args: string[]) => {
    assert.ok(
      args.includes("scripts/operator-preflight.ts"),
      "failed preparation must never invoke signing",
    );
    attempts++;
    throw new Error("RPC unavailable");
  }) as any);
  assert.equal(attempts, 3, "read-only retries are bounded");
  const [failedTask] = await db.query(
    "SELECT status,error,tx_hash,signed_tx FROM operator_tasks WHERE order_id=$1 AND action='create'",
    [failedOrder.id],
  );
  assert.equal(failedTask.status, "blocked");
  assert.match(failedTask.error, /No signing command was started/);
  assert.equal(failedTask.tx_hash, null);
  assert.equal(failedTask.signed_tx, null);
  process.env.OPERATOR_POLICY_EXPIRES_AT = new Date(
    Date.now() - 1,
  ).toISOString();
  assert.throws(() => operatorPolicy(), /unexpired/);
  process.env.OPERATOR_POLICY_EXPIRES_AT = new Date(
    Date.now() + 10000,
  ).toISOString();
  process.env.OPERATOR_POLICY_ACTIONS = "refund";
  assert.throws(() => operatorPolicy(), /explicit registration/);
});
