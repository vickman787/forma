import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureQieNetwork } from "../lib/wallet-network";

test("sign-in network setup leaves an existing QIE connection alone", async () => {
  const calls: string[] = [];
  await ensureQieNetwork({
    request: async ({ method }) => {
      calls.push(method);
      return "0x7c6";
    },
  });
  assert.deepEqual(calls, ["eth_chainId"]);
});

test("a new website's default Ethereum connection switches before signing", async () => {
  let chain = "0x1";
  const calls: string[] = [];
  await ensureQieNetwork({
    request: async ({ method, params }) => {
      calls.push(method);
      if (method === "eth_chainId") return chain;
      assert.equal(method, "wallet_switchEthereumChain");
      assert.deepEqual(params, [{ chainId: "0x7c6" }]);
      chain = "0x7c6";
    },
  });
  assert.deepEqual(calls, [
    "eth_chainId",
    "wallet_switchEthereumChain",
    "eth_chainId",
  ]);
});

test("unknown QIE network offers the exact configured chain, then verifies selection", async () => {
  let added = false,
    chain = "0x1";
  await ensureQieNetwork({
    request: async ({ method, params }) => {
      if (method === "eth_chainId") return chain;
      if (method === "wallet_switchEthereumChain") {
        if (!added) throw { code: 4902 };
        chain = "0x7c6";
        return;
      }
      assert.equal(method, "wallet_addEthereumChain");
      assert.equal(params?.[0].chainId, "0x7c6");
      assert.equal(params?.[0].chainName, "QIE Mainnet");
      assert.deepEqual(params?.[0].rpcUrls, [
        "https://rpc1mainnet.qie.digital",
      ]);
      added = true;
    },
  });
  assert.equal(chain, "0x7c6");
});

test("a rejected network switch is not retried or replaced with another request", async () => {
  const calls: string[] = [];
  const rejection = { code: 4001 };
  await assert.rejects(
    () =>
      ensureQieNetwork({
        request: async ({ method }) => {
          calls.push(method);
          if (method === "eth_chainId") return "0x1";
          throw rejection;
        },
      }),
    (error) => error === rejection,
  );
  assert.deepEqual(calls, ["eth_chainId", "wallet_switchEthereumChain"]);
});

test("a wallet that does not actually change networks cannot continue to signing", async () => {
  await assert.rejects(
    () =>
      ensureQieNetwork({
        request: async ({ method }) =>
          method === "eth_chainId" ? "0x1" : null,
      }),
    /Select QIE Mainnet/,
  );
});
