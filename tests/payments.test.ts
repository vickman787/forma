import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  stringToHex,
  type Hex,
} from "viem";
import { database } from "../lib/db";
import { syncOrderFromChain } from "../lib/chain-sync";
import { blankBrief, terms, type Order } from "../lib/domain";
import { parseOrder } from "../lib/orders";
import {
  escrowAbi,
  tokenAbi,
  reconcileRegistration,
  reconcilePayment,
  reconcileDecision,
  paymentInfo,
  recordPendingPayment,
} from "../lib/payments";

test("live receipt reconciliation with isolated database and mocked RPC only", async (t) => {
  const previous = { ...process.env },
    originalFetch = globalThis.fetch;
  process.env.APP_MODE = "demo";
  process.env.DATA_DIRECTORY = `.forma/test-${Date.now()}/live`;
  if (process.env.FORMA_TEST_DATABASE_URL)
    process.env.DATABASE_URL = process.env.FORMA_TEST_DATABASE_URL;
  else delete process.env.DATABASE_URL;
  const db = await database(); // SQLite exercises the repository interface; no PostgreSQL service is contacted.
  Object.assign(process.env, {
    APP_MODE: "live",
    DATABASE_URL: "postgresql://unused-test-only",
    GENERATION_PROVIDER: "openai",
    SESSION_SECRET: "test-only-session-secret-at-least-32-characters",
    APP_URL: "https://forma.example",
    PREVIEW_ORIGIN: "https://preview.forma.example",
    QIE_RPC_URL: "https://rpc.test.invalid",
    OPENAI_API_KEY: "test-key-never-sent",
    OPENAI_TEXT_MODEL: "mock-model",
    OPENAI_RESEARCH_MODEL: "mock-model",
    MAX_JOB_COST_USD: "0.1",
    MAX_INPUT_COST_PER_MILLION: "0.75",
    MAX_OUTPUT_COST_PER_MILLION: "4.5",
    MAX_SEARCH_COST_USD: "0.01",
    MAX_OUTPUT_TOKENS: "2500",
    ESCROW_ADDRESS: "0x1111111111111111111111111111111111111111",
    TREASURY_ADDRESS: "0x2222222222222222222222222222222222222222",
    OPERATOR_ADDRESS: "0x2222222222222222222222222222222222222222",
    QIE_CHAIN_ID: "1990",
    QUSDC_DECIMALS: "6",
    SERVICE_PRICE_BASE_UNITS: "1000000",
    QUSDC_ADDRESS: terms.token,
    LIVE_PAYMENTS_ENABLED: "true",
    LIVE_VERIFICATION_COMPLETE: "true",
    ALLOW_PAID_API_CALLS: "true",
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env))
      if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  const customer = "0x3333333333333333333333333333333333333333",
    owner = randomUUID();
  await db.query(
    "INSERT INTO customers(id,wallet,created_at) VALUES($1,$2,$3)",
    [owner, customer, new Date().toISOString()],
  );
  let order: Order,
    kind: "JobCreated" | "JobFunded" | "JobReleased" = "JobCreated";
  let state = 1,
    amount = 1000000n,
    height = 102n,
    canonical = true,
    eventToken = terms.token;
  const blockHash = `0x${"ab".repeat(32)}` as Hex,
    termsHash = "cd".repeat(32),
    manifest = "ef".repeat(32);
  const txHash = () => keccak256(stringToHex(order.id + kind));
  async function fresh() {
    const id = randomUUID(),
      qid = randomUUID(),
      at = new Date().toISOString(),
      expires = new Date(Date.now() + 1200000).toISOString();
    await db.query(
      "INSERT INTO quotes(id,owner,brief,brief_hash,terms_hash,amount,expires,mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        qid,
        owner,
        JSON.stringify(blankBrief()),
        "test-brief",
        termsHash,
        "1000000",
        expires,
        "live",
      ],
    );
    await db.query(
      "INSERT INTO orders(id,owner,quote_id,mode,brief,work,payment,created_at,updated_at,funding_expires,chain_job) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10)",
      [
        id,
        owner,
        qid,
        "live",
        JSON.stringify(blankBrief()),
        "awaiting_funding",
        "unfunded",
        at,
        expires,
        keccak256(stringToHex(id)),
      ],
    );
    order = parseOrder(
      (await db.query("SELECT * FROM orders WHERE id=$1", [id]))[0],
    );
    kind = "JobCreated";
    state = 1;
    amount = 1000000n;
    height = 102n;
    canonical = true;
    eventToken = terms.token;
  }
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(String(url)).origin, "https://rpc.test.invalid"); // Any provider or unexpected network request fails the test.
    const req = JSON.parse(String(init?.body));
    let result: unknown;
    if (req.method === "eth_getLogs") {
      const nested = await globalThis.fetch(url, {
        ...init,
        body: JSON.stringify({ ...req, method: "eth_getTransactionReceipt" }),
      });
      result = (await nested.json()).result.logs;
    } else if (req.method === "eth_chainId") result = "0x7c6";
    else if (req.method === "eth_blockNumber")
      result = `0x${height.toString(16)}`;
    else if (req.method === "eth_getBlockByNumber")
      result = {
        hash: canonical ? blockHash : `0x${"aa".repeat(32)}`,
        number: "0x64",
        timestamp: "0x1",
        transactions: [],
      };
    else if (req.method === "eth_call") {
      const call = req.params[0],
        isToken = call.to.toLowerCase() === terms.token.toLowerCase();
      const { functionName } = decodeFunctionData({
        abi: isToken ? tokenAbi : escrowAbi,
        data: call.data,
      });
      if (functionName === "decimals")
        result = encodeAbiParameters([{ type: "uint8" }], [6]);
      else if (functionName === "jobs")
        result = encodeAbiParameters(
          [
            { type: "address" },
            { type: "uint256" },
            { type: "bytes32" },
            { type: "bytes32" },
            { type: "uint64" },
            { type: "uint64" },
            { type: "uint64" },
            { type: "uint8" },
          ],
          [
            customer,
            1000000n,
            `0x${termsHash}`,
            `0x${manifest}`,
            BigInt(Math.floor(Date.parse(order.funding_expires) / 1000)),
            BigInt(Math.floor(Date.now() / 1000) + 86400),
            BigInt(Math.floor(Date.now() / 1000) + 172800),
            state,
          ],
        );
      else
        result = encodeAbiParameters(
          [{ type: "address" }],
          [
            functionName === "asset"
              ? (terms.token as Hex)
              : (process.env.TREASURY_ADDRESS as Hex),
          ],
        );
    } else if (req.method === "eth_getTransactionReceipt") {
      const data =
        kind === "JobCreated"
          ? encodeAbiParameters(
              [{ type: "uint256" }, { type: "bytes32" }, { type: "uint64" }],
              [
                amount,
                `0x${termsHash}`,
                BigInt(Math.floor(Date.parse(order.funding_expires) / 1000)),
              ],
            )
          : encodeAbiParameters([{ type: "uint256" }], [amount]);
      const args =
        kind === "JobCreated"
          ? { jobId: order.chain_job as Hex, customer }
          : kind === "JobFunded"
            ? {
                jobId: order.chain_job as Hex,
                customer,
                token: eventToken as Hex,
              }
            : {
                jobId: order.chain_job as Hex,
                treasury: process.env.TREASURY_ADDRESS as Hex,
              };
      result = {
        transactionHash: txHash(),
        blockHash,
        blockNumber: "0x64",
        status: "0x1",
        transactionIndex: "0x0",
        from: customer,
        to: process.env.ESCROW_ADDRESS,
        gasUsed: "0x5208",
        cumulativeGasUsed: "0x5208",
        effectiveGasPrice: null,
        logsBloom: `0x${"00".repeat(256)}`,
        type: "0x0",
        logs: [
          {
            address: process.env.ESCROW_ADDRESS,
            topics: encodeEventTopics({
              abi: escrowAbi,
              eventName: kind,
              args: args as any,
            }),
            data,
            logIndex: "0x0",
            transactionIndex: "0x0",
            transactionHash: txHash(),
            blockHash,
            blockNumber: "0x64",
            removed: false,
          },
        ],
      };
    } else throw new Error(`Unexpected RPC method: ${req.method}`);
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: req.id, result }),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  await t.test(
    "registration records once and never queues unfunded work",
    async () => {
      await fresh();
      await reconcileRegistration(order, txHash());
      await reconcileRegistration(order, txHash());
      assert.equal(
        (
          await db.query("SELECT * FROM chain_events WHERE order_id=$1", [
            order.id,
          ])
        ).length,
        1,
      );
      assert.equal(
        (await db.query("SELECT * FROM jobs WHERE order_id=$1", [order.id]))
          .length,
        0,
      );
    },
  );
  await t.test(
    "wrong registration amount, insufficient confirmations and reorg fail closed",
    async () => {
      await fresh();
      amount = 999999n;
      await assert.rejects(
        () => reconcileRegistration(order, txHash()),
        /frozen quote/,
      );
      amount = 1000000n;
      height = 101n;
      await assert.rejects(
        () => reconcileRegistration(order, txHash()),
        /three block confirmations/,
      );
      height = 102n;
      canonical = false;
      await assert.rejects(
        () => reconcileRegistration(order, txHash()),
        /canonical/,
      );
      assert.equal(
        (
          await db.query("SELECT * FROM chain_events WHERE order_id=$1", [
            order.id,
          ])
        ).length,
        0,
      );
    },
  );
  await t.test(
    "wrong funding token is rejected and valid funding queues exactly once",
    async () => {
      await fresh();
      kind = "JobFunded";
      state = 2;
      eventToken = "0x4444444444444444444444444444444444444444";
      await assert.rejects(
        () => reconcilePayment(order, txHash()),
        /does not match/,
      );
      eventToken = terms.token;
      const funded = await reconcilePayment(order, txHash());
      await reconcilePayment(funded, txHash());
      assert.equal(funded.payment, "funded");
      assert.equal(funded.work, "queued");
      assert.equal(
        (await db.query("SELECT * FROM jobs WHERE order_id=$1", [order.id]))
          .length,
        1,
      );
    },
  );
  await t.test(
    "funding recovery discovers the real receipt without browser storage and queues exactly once",
    async () => {
      await fresh();
      await reconcileRegistration(order, txHash());
      kind = "JobFunded";
      state = 2;
      assert.equal(order.tx_hash, null);
      const recovered = await syncOrderFromChain(order);
      assert.equal(recovered.payment, "funded");
      assert.equal(recovered.work, "queued");
      await syncOrderFromChain(recovered);
      assert.equal(
        (await db.query("SELECT id FROM jobs WHERE order_id=$1", [order.id]))
          .length,
        1,
      );
    },
  );
  await t.test(
    "settlement replay does not duplicate settlement events",
    async () => {
      await fresh();
      kind = "JobReleased";
      state = 4;
      await db.query(
        "UPDATE orders SET payment='funded',work='delivered',manifest_hash=$1 WHERE id=$2",
        [manifest, order.id],
      );
      order = parseOrder(
        (await db.query("SELECT * FROM orders WHERE id=$1", [order.id]))[0],
      );
      const settled = await reconcileDecision(order, txHash());
      await reconcileDecision(settled, txHash());
      assert.equal(settled.payment, "released");
      assert.equal(
        (
          await db.query(
            "SELECT * FROM events WHERE order_id=$1 AND stage='settled'",
            [order.id],
          )
        ).length,
        1,
      );
    },
  );
  await t.test(
    "local checkout permits only its exact registered order and keeps provider guards",
    async () => {
      await fresh();
      process.env.LIVE_PAYMENTS_ENABLED = "false";
      process.env.LIVE_VERIFICATION_COMPLETE = "false";
      process.env.LOCAL_ONLY = "true";
      process.env.APP_URL = "http://127.0.0.1:3000";
      process.env.PREVIEW_ORIGIN = "http://127.0.0.1:4317";
      process.env.LOCAL_CHECKOUT_ORDER_ID = order.id;
      assert.equal((await paymentInfo(order)).enabled, true);
      process.env.LOCAL_CHECKOUT_ORDER_ID = randomUUID();
      assert.equal((await paymentInfo(order)).enabled, false);
      process.env.LOCAL_CHECKOUT_ORDER_ID = order.id;
      process.env.ALLOW_PAID_API_CALLS = "false";
      assert.equal((await paymentInfo(order)).enabled, false);
      process.env.ALLOW_PAID_API_CALLS = "true";
      state = 0;
      assert.equal((await paymentInfo(order)).enabled, false);
      state = 1;
      const first = txHash();
      await recordPendingPayment(order, first);
      await recordPendingPayment(order, first);
      await assert.rejects(
        () => recordPendingPayment(order, `0x${"12".repeat(32)}`),
        /saved transaction/,
      );
      assert.equal(
        (
          await db.query("SELECT tx_hash FROM orders WHERE id=$1", [order.id])
        )[0].tx_hash,
        first,
      );
      assert.equal(
        (await db.query("SELECT * FROM jobs WHERE order_id=$1", [order.id]))
          .length,
        0,
      );
      process.env.LOCAL_ONLY = "false";
      await assert.rejects(() => paymentInfo(order), /loopback-only/);
    },
  );
});
