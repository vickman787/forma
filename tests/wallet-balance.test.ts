import { test } from "node:test";
import assert from "node:assert/strict";
import { formatQusdcBalance, readWalletBalance } from "../lib/wallet-balance";

test("QUSDC display preserves six-decimal precision without rounding funds up", () => {
  assert.equal(formatQusdcBalance(0n), "0");
  assert.equal(formatQusdcBalance(1n), "0.000001");
  assert.equal(formatQusdcBalance(999999n), "0.999999");
  assert.equal(formatQusdcBalance(1200000n), "1.2");
  assert.equal(
    formatQusdcBalance(123456789012345678901n),
    "123,456,789,012,345.678901",
  );
});

test("balance reader rejects an RPC connected to the wrong chain", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }));
  try {
    await assert.rejects(
      () => readWalletBalance("0x0000000000000000000000000000000000000001"),
      /Unexpected balance network/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
