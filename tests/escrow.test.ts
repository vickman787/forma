import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  custom,
  keccak256,
  stringToHex,
  encodeFunctionData,
  type Hex,
  type Address,
} from "viem";
const require = createRequire(import.meta.url),
  solc = require("solc"),
  ganache = require("ganache");
test(
  "ServiceEscrow local EVM transitions and authority",
  { timeout: 180000 },
  async (t) => {
    const sources = Object.fromEntries(
      ["ServiceEscrow.sol", "MockToken.sol"].map((name) => [
        name,
        { content: readFileSync(path.join("contracts", name), "utf8") },
      ]),
    );
    const compiled = JSON.parse(
      solc.compile(
        JSON.stringify({
          language: "Solidity",
          sources: {
            ...sources,
            "AdversarialToken.sol": {
              content: readFileSync(
                "tests/contracts/AdversarialToken.sol",
                "utf8",
              ),
            },
          },
          settings: {
            evmVersion: "shanghai",
            optimizer: { enabled: true, runs: 200 },
            outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
          },
        }),
        {
          import: (name: string) => {
            try {
              return {
                contents: readFileSync(path.join("node_modules", name), "utf8"),
              };
            } catch {
              return { error: "Import not found" };
            }
          },
        },
      ),
    );
    const errors =
      compiled.errors?.filter((e: any) => e.severity === "error") || [];
    assert.deepEqual(errors, []);
    const provider = ganache.provider({
      logging: { quiet: true },
      chain: { chainId: 31337, hardfork: "shanghai" },
      wallet: { totalAccounts: 5 },
    });
    const rpc = createPublicClient({
        transport: custom(provider),
        pollingInterval: 20,
      }),
      wallet = createWalletClient({
        transport: custom(provider),
        pollingInterval: 20,
      });
    const addresses = await wallet.getAddresses(),
      [operator, customer, treasury, attacker] = addresses;
    const deploy = async (file: string, name: string, args: any[] = []) => {
      const c = compiled.contracts[file][name];
      const tx = await wallet.deployContract({
        account: operator,
        chain: null,
        gas: 6000000n,
        abi: c.abi,
        bytecode: ("0x" + c.evm.bytecode.object) as Hex,
        args,
      });
      return {
        address: (await rpc.waitForTransactionReceipt({ hash: tx }))
          .contractAddress!,
        abi: c.abi,
      };
    };
    const token = await deploy("MockToken.sol", "MockToken"),
      escrow = await deploy("ServiceEscrow.sol", "ServiceEscrow", [
        token.address,
        treasury,
        operator,
      ]);
    const send = async (
      c: any,
      fn: string,
      args: any[],
      account: Address = operator,
    ) => {
      await rpc.simulateContract({
        account,
        address: c.address,
        abi: c.abi,
        functionName: fn,
        args,
      });
      const tx = await wallet.writeContract({
        account,
        chain: null,
        gas: 1000000n,
        address: c.address,
        abi: c.abi,
        functionName: fn,
        args,
      });
      const r = await rpc.waitForTransactionReceipt({ hash: tx });
      assert.equal(r.status, "success");
      return r;
    };
    const read = (c: any, fn: string, args: any[] = []) =>
      rpc.readContract({
        address: c.address,
        abi: c.abi,
        functionName: fn,
        args,
      }) as Promise<any>;
    const id = (name: string) => keccak256(stringToHex(name)),
      terms = id("forma-terms"),
      manifest = id("manifest");
    const timestamp = async () => Number((await rpc.getBlock()).timestamp);
    const create = async (name: string, delta = 1200) => {
      const job = id(name);
      await send(escrow, "createJob", [
        job,
        customer,
        1000000n,
        terms,
        (await timestamp()) + delta,
      ]);
      return job;
    };
    await send(token, "mint", [customer, 10000000n]);
    await send(token, "approve", [escrow.address, 10000000n], customer);
    await t.test(
      "operator creates once; customer alone funds exact amount",
      async () => {
        const job = await create("accept");
        await assert.rejects(async () =>
          send(escrow, "createJob", [
            job,
            customer,
            1000000n,
            terms,
            (await timestamp()) + 1000,
          ]),
        );
        await assert.rejects(() => send(escrow, "fundJob", [job], attacker));
        await send(escrow, "fundJob", [job], customer);
        assert.equal(await read(escrow, "liabilities"), 1000000n);
        await assert.rejects(() => send(escrow, "fundJob", [job], customer));
        await assert.rejects(() =>
          send(escrow, "acceptDelivery", [job], customer),
        );
      },
    );
    await t.test(
      "only operator submits; only customer accepts; treasury fixed",
      async () => {
        const job = id("accept");
        await assert.rejects(() =>
          send(escrow, "submitDelivery", [job, manifest], attacker),
        );
        await send(escrow, "submitDelivery", [job, manifest]);
        await assert.rejects(() =>
          send(escrow, "submitDelivery", [job, manifest]),
        );
        await assert.rejects(() =>
          send(escrow, "acceptDelivery", [job], attacker),
        );
        await send(escrow, "acceptDelivery", [job], customer);
        assert.equal(await read(token, "balanceOf", [treasury]), 1000000n);
        assert.equal(await read(escrow, "liabilities"), 0n);
        await assert.rejects(() =>
          send(escrow, "acceptDelivery", [job], customer),
        );
        await assert.rejects(() => send(escrow, "refundJob", [job]));
      },
    );
    await t.test(
      "operator refund returns funds only to the recorded customer",
      async () => {
        const job = await create("refund"),
          before = await read(token, "balanceOf", [customer]);
        await send(escrow, "fundJob", [job], customer);
        await assert.rejects(() => send(escrow, "refundJob", [job], attacker));
        await send(escrow, "refundJob", [job]);
        assert.equal(await read(token, "balanceOf", [customer]), before);
        await assert.rejects(() => send(escrow, "refundJob", [job]));
      },
    );
    await t.test("funding expiry rejects payment at the boundary", async () => {
      const job = await create("expired", 60);
      await provider.request({ method: "evm_increaseTime", params: [60] });
      await provider.request({ method: "evm_mine", params: [] });
      await assert.rejects(() => send(escrow, "fundJob", [job], customer));
    });
    await t.test(
      "late undelivered job refunds; cannot become a review release",
      async () => {
        const job = await create("late");
        await send(escrow, "fundJob", [job], customer);
        await assert.rejects(() =>
          send(escrow, "claimLateRefund", [job], customer),
        );
        await provider.request({ method: "evm_increaseTime", params: [86400] });
        await provider.request({ method: "evm_mine", params: [] });
        await assert.rejects(() =>
          send(escrow, "submitDelivery", [job, manifest]),
        );
        await assert.rejects(() =>
          send(escrow, "claimReviewRelease", [job], attacker),
        );
        await assert.rejects(() =>
          send(escrow, "claimLateRefund", [job], attacker),
        );
        await send(escrow, "claimLateRefund", [job], customer);
      },
    );
    await t.test(
      "review timeout releases once to treasury, never caller",
      async () => {
        const job = await create("review"),
          before = await read(token, "balanceOf", [treasury]);
        await send(escrow, "fundJob", [job], customer);
        await send(escrow, "submitDelivery", [job, manifest]);
        await assert.rejects(() =>
          send(escrow, "claimReviewRelease", [job], attacker),
        );
        await provider.request({
          method: "evm_increaseTime",
          params: [172800],
        });
        await provider.request({ method: "evm_mine", params: [] });
        await send(escrow, "claimReviewRelease", [job], attacker);
        assert.equal(
          await read(token, "balanceOf", [treasury]),
          before + 1000000n,
        );
        assert.equal(await read(token, "balanceOf", [attacker]), 0n);
        await assert.rejects(() =>
          send(escrow, "claimReviewRelease", [job], attacker),
        );
        assert.equal(await read(escrow, "liabilities"), 0n);
      },
    );
    await t.test(
      "false-return and fee-on-transfer tokens cannot fabricate funding or liabilities",
      async () => {
        const hostile = await deploy(
          "AdversarialToken.sol",
          "AdversarialToken",
        );
        const vault = await deploy("ServiceEscrow.sol", "ServiceEscrow", [
          hostile.address,
          treasury,
          operator,
        ]);
        await send(hostile, "mint", [customer, 3000000n]);
        await send(hostile, "approve", [vault.address, 3000000n], customer);
        for (const mode of [1, 2]) {
          const job = id(`hostile-${mode}`);
          await send(vault, "createJob", [
            job,
            customer,
            1000000n,
            terms,
            (await timestamp()) + 1200,
          ]);
          await send(hostile, "configure", [mode, vault.address, "0x"]);
          await assert.rejects(() => send(vault, "fundJob", [job], customer));
          assert.equal((await read(vault, "jobs", [job]))[7], 1);
          assert.equal(await read(vault, "liabilities"), 0n);
          assert.equal(await read(hostile, "balanceOf", [vault.address]), 0n);
          assert.equal(await read(hostile, "balanceOf", [customer]), 3000000n);
        }
      },
    );
    await t.test(
      "token callbacks cannot reenter funding or settlement; failed transfers roll back settlement",
      async () => {
        const hostile = await deploy(
          "AdversarialToken.sol",
          "AdversarialToken",
        );
        const vault = await deploy("ServiceEscrow.sol", "ServiceEscrow", [
          hostile.address,
          treasury,
          operator,
        ]);
        const job = id("callback");
        await send(hostile, "mint", [customer, 1000000n]);
        await send(hostile, "approve", [vault.address, 1000000n], customer);
        await send(vault, "createJob", [
          job,
          customer,
          1000000n,
          terms,
          (await timestamp()) + 1200,
        ]);
        await send(hostile, "configure", [
          3,
          vault.address,
          encodeFunctionData({
            abi: vault.abi,
            functionName: "fundJob",
            args: [job],
          }),
        ]);
        await send(vault, "fundJob", [job], customer);
        assert.equal(await read(hostile, "callbackSucceeded"), false);
        assert.equal(await read(vault, "liabilities"), 1000000n);
        await send(vault, "submitDelivery", [job, manifest]);
        await send(hostile, "configure", [4, vault.address, "0x"]);
        await assert.rejects(() =>
          send(vault, "acceptDelivery", [job], customer),
        );
        assert.equal((await read(vault, "jobs", [job]))[7], 3);
        assert.equal(await read(vault, "liabilities"), 1000000n);
        await send(hostile, "configure", [
          3,
          vault.address,
          encodeFunctionData({
            abi: vault.abi,
            functionName: "claimReviewRelease",
            args: [job],
          }),
        ]);
        await send(vault, "acceptDelivery", [job], customer);
        assert.equal(await read(hostile, "callbackSucceeded"), false);
        assert.equal(await read(vault, "liabilities"), 0n);
        assert.equal(await read(hostile, "balanceOf", [treasury]), 1000000n);
      },
    );
    await provider.disconnect();
  },
);
