import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, type Hex } from "viem";
import { validateSavedOperatorTransaction } from "../lib/operator-recovery";
test("crash recovery accepts only the exact signed transaction and existing gas approval", async () => {
  const account = privateKeyToAccount(`0x${"01".repeat(32)}`);
  const to = `0x${"22".repeat(20)}` as Hex,
    data = "0x12345678" as Hex;
  const signed = await account.signTransaction({
    chainId: 1990,
    type: "legacy",
    nonce: 7,
    to,
    data,
    gas: 100000n,
    gasPrice: 1000000000n,
    value: 0n,
  });
  const task = {
    signed_tx: signed,
    tx_hash: keccak256(signed),
    operator_address: account.address,
    nonce: 7,
    gas_reserved_wei: "350000000000000",
    policy_id: "approved",
  };
  const expected = { from: account.address, to, data },
    policy = { id: "approved", maximumFee: 350000000000000n };
  assert.equal(
    await validateSavedOperatorTransaction(task, expected, policy),
    signed,
  );
  for (const change of [
    { nonce: 8 },
    { tx_hash: `0x${"00".repeat(32)}` },
    { policy_id: "different" },
    { operator_address: to },
    { gas_reserved_wei: "1" },
  ])
    await assert.rejects(() =>
      validateSavedOperatorTransaction(
        { ...task, ...change },
        expected,
        policy,
      ),
    );
  await assert.rejects(() =>
    validateSavedOperatorTransaction(
      task,
      { ...expected, data: "0x5678" },
      policy,
    ),
  );
  await assert.rejects(() =>
    validateSavedOperatorTransaction(task, expected, {
      ...policy,
      maximumFee: 1n,
    }),
  );
  for (const change of [
    { chainId: 1 },
    { value: 1n },
    { to: account.address },
  ]) {
    const serialized = await account.signTransaction({
      chainId: 1990,
      type: "legacy",
      nonce: 7,
      to,
      data,
      gas: 100000n,
      gasPrice: 1000000000n,
      value: 0n,
      ...change,
    });
    await assert.rejects(() =>
      validateSavedOperatorTransaction(
        { ...task, signed_tx: serialized, tx_hash: keccak256(serialized) },
        expected,
        policy,
      ),
    );
  }
});
