import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
  type TransactionSerializedLegacy,
} from "viem";

/** Checks an existing signature only. Never receives a private key or signs a replacement. */
export async function validateSavedOperatorTransaction(
  task: {
    signed_tx: string;
    tx_hash: string;
    operator_address: string;
    nonce: number;
    gas_reserved_wei: string;
    policy_id: string;
  },
  expected: { from: string; to: string; data: string },
  policy: { id: string; maximumFee: bigint },
) {
  const serialized = task.signed_tx as Hex;
  if (
    !serialized ||
    task.policy_id !== policy.id ||
    keccak256(serialized) !== task.tx_hash
  )
    throw new Error("Saved transaction identity or approval mismatch");
  const tx = parseTransaction(serialized);
  if (tx.type !== "legacy")
    throw new Error(
      "Only the saved legacy operator transaction may be recovered",
    );
  const sender = await recoverTransactionAddress({
    serializedTransaction: serialized as TransactionSerializedLegacy,
  });
  const fee = (tx.gas || 0n) * (tx.gasPrice || 0n);
  if (
    tx.type !== "legacy" ||
    tx.chainId !== 1990 ||
    tx.nonce !== task.nonce ||
    tx.to?.toLowerCase() !== expected.to.toLowerCase() ||
    tx.data !== expected.data ||
    (tx.value || 0n) !== 0n ||
    sender.toLowerCase() !== expected.from.toLowerCase() ||
    sender.toLowerCase() !== task.operator_address.toLowerCase() ||
    fee <= 0n ||
    fee > policy.maximumFee ||
    fee > BigInt(task.gas_reserved_wei || "0")
  )
    throw new Error(
      "Saved transaction differs from the approved registration/delivery",
    );
  return serialized;
}
