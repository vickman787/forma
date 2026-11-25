import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseSiweMessage } from "viem/siwe";
import { config } from "../lib/config";
import { GET, POST } from "../app/api/[...path]/route";

test("public runtime rejects synthetic modes and content providers", () => {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, { NODE_ENV: "production", APP_MODE: "demo" });
    assert.throws(() => config(), /restricted to the automated test runner/);
    process.env.APP_MODE = "live";
    process.env.GENERATION_PROVIDER = "template";
    assert.throws(() => config(), /require OpenAI/);
    process.env.GENERATION_PROVIDER = "openai";
    process.env.LOCAL_ONLY = "true";
    process.env.APP_URL = "https://public.example";
    assert.throws(() => config(), /loopback/);
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test("wallet authentication works and removed synthetic endpoints cannot create sessions or jobs", async () => {
  Object.assign(process.env, {
    APP_MODE: "demo",
    DATA_DIRECTORY: `.forma/test-${randomUUID()}`,
    APP_URL: "http://127.0.0.1:3000",
    GENERATION_PROVIDER: "openai",
    ALLOW_PAID_API_CALLS: "false",
  });
  delete process.env.DATABASE_URL;
  async function call(route: string, body?: unknown, cookie?: string) {
    const req = new Request("http://127.0.0.1:3000/api/" + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (body === undefined ? GET : POST)(req, {
      params: Promise.resolve({ path: route.split("?")[0].split("/") }),
    });
  }
  const removed = await call("auth/demo", {});
  assert.equal(removed.status, 401);
  assert.equal(removed.headers.get("set-cookie"), null);
  assert.equal((await call("wallet/balance")).status, 401);
  const account = privateKeyToAccount(generatePrivateKey());
  const challenge = await (
    await call("auth/nonce", { wallet: account.address })
  ).json();
  const parsed = parseSiweMessage(challenge.message);
  assert.equal(parsed.domain, "127.0.0.1:3000");
  assert.equal(parsed.uri, "http://127.0.0.1:3000");
  assert.equal(parsed.chainId, 1990);
  assert.equal(parsed.nonce, challenge.nonce);
  assert.equal(parsed.address?.toLowerCase(), account.address.toLowerCase());
  assert.ok(
    parsed.expirationTime && parsed.expirationTime.getTime() > Date.now(),
  );
  const signature = await account.signMessage({ message: challenge.message });
  const signedIn = await call("auth/verify", {
    nonce: challenge.nonce,
    signature,
  });
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers.get("set-cookie")!.split(";")[0];
  const originalFetch = globalThis.fetch;
  const requests: any[] = [];
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(
      init?.body ? String(init.body) : await (_input as Request).text(),
    );
    requests.push(request);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result:
          request.method === "eth_chainId"
            ? "0x7c6"
            : `0x${1000001n.toString(16).padStart(64, "0")}`,
      }),
    );
  };
  try {
    const response = await call(
      "wallet/balance?wallet=ignored",
      undefined,
      cookie,
    );
    assert.equal(response.status, 200);
    const balance = await response.json();
    assert.equal(balance.wallet, account.address.toLowerCase());
    assert.equal(balance.formatted, "1.000001");
    assert.equal(balance.baseUnits, "1000001");
    assert.equal(balance.chainId, 1990);
    const read = requests.find((r) => r.method === "eth_call");
    assert.equal(
      read.params[0].to.toLowerCase(),
      "0x3f43da82ec9a4f5285f10faf1f26eca7319e5da5",
    );
    assert.ok(
      read.params[0].data
        .toLowerCase()
        .endsWith(account.address.slice(2).toLowerCase()),
    );
    globalThis.fetch = async () => {
      throw new Error("RPC offline");
    };
    const unavailable = await call("wallet/balance", undefined, cookie);
    assert.equal(unavailable.status, 503);
    assert.equal("baseUnits" in (await unavailable.json()), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(
    (await (await call("auth/session", undefined, cookie)).json()).wallet,
    account.address.toLowerCase(),
  );
  assert.equal(
    (await call("auth/verify", { nonce: challenge.nonce, signature })).status,
    401,
  );
  assert.equal((await call("auth/demo", {}, cookie)).status, 404);
  const list = await (await call("orders", undefined, cookie)).json();
  assert.deepEqual(list, []);
  const services = await (await call("services")).json();
  assert.equal(services.generation, "openai");
  assert.equal("demoNote" in services, false);
  assert.ok(services.services.every((s: any) => !s.enabled));
});
