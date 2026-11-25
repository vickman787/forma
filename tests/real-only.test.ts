import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
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
      params: Promise.resolve({ path: route.split("/") }),
    });
  }
  const removed = await call("auth/demo", {});
  assert.equal(removed.status, 401);
  assert.equal(removed.headers.get("set-cookie"), null);
  const account = privateKeyToAccount(generatePrivateKey());
  const challenge = await (
    await call("auth/nonce", { wallet: account.address })
  ).json();
  const signature = await account.signMessage({ message: challenge.message });
  const signedIn = await call("auth/verify", {
    nonce: challenge.nonce,
    signature,
  });
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers.get("set-cookie")!.split(";")[0];
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
