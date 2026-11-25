/** Executes exactly one reviewed, explicitly approved registration. No automatic retries. */
import path from "node:path";
import { operatorRecordsDirectory } from "../lib/operator-files";
import { readFile, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  createPublicClient,
  http,
  keccak256,
  formatEther,
  parseEther,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { database } from "../lib/db";
import { parseOrder } from "../lib/orders";
import { operatorPlan, validateDeliveryState } from "../lib/operator";
import { operatorLease } from "../lib/operator-outbox";
import {
  reconcileRegistration,
  reconcileDelivery,
  escrowAbi,
  tokenAbi,
} from "../lib/payments";
import { terms } from "../lib/domain";
import { qieChain } from "../lib/chain";

async function main() {
  const [file, approvedHash, cap, approval] = process.argv.slice(2);
  if (
    ![
      "--approved-single-mainnet-registration",
      "--approved-single-mainnet-delivery",
    ].includes(approval) ||
    !/^[a-f0-9]{64}$/.test(approvedHash || "") ||
    !/^\d+(\.\d{1,18})?$/.test(cap || "")
  )
    throw new Error(
      "Pass a reviewed plan file, approved SHA-256, approved QIE fee cap and single-registration approval flag.",
    );
  const text = await readFile(file, "utf8");
  if (createHash("sha256").update(text).digest("hex") !== approvedHash)
    throw new Error("Approved plan hash mismatch");
  const plan = JSON.parse(text);
  const action = plan.action;
  if (
    (action !== "create" && action !== "deliver") ||
    approval !==
      (action === "create"
        ? "--approved-single-mainnet-registration"
        : "--approved-single-mainnet-delivery")
  )
    throw new Error("Approval must match the exact transaction action");
  const db = await database();
  const [row] = await db.query(
    "SELECT * FROM orders WHERE id=$1 AND mode='live'",
    [plan.orderId],
  );
  if (!row) throw new Error("Live order not found");
  const [quote] = await db.query(
    "SELECT q.terms_hash,c.wallet FROM quotes q JOIN customers c ON c.id=q.owner WHERE q.id=$1 AND q.owner=$2",
    [row.quote_id, row.owner],
  );
  if (!quote) throw new Error("Owned quote not found");
  const expected = operatorPlan(parseOrder(row), quote, action, {
    escrow: process.env.ESCROW_ADDRESS || "",
    operator: process.env.OPERATOR_ADDRESS || "",
  });
  for (const key of Object.keys(expected) as Array<keyof typeof expected>)
    if (plan[key] !== expected[key])
      throw new Error("Reviewed plan differs from current frozen quote");
  if (
    plan.token.toLowerCase() !== terms.token.toLowerCase() ||
    plan.amount !== "1000000" ||
    plan.movesQUSDC !== false
  )
    throw new Error("Unexpected registration asset or amount");
  const recordFile = path.join(
    operatorRecordsDirectory(),
    `${action === "create" ? "registration" : "delivery"}-sent-${row.id}.json`,
  );
  let recorded = false;
  try {
    await access(recordFile);
    recorded = true;
  } catch {}
  if (recorded)
    throw new Error(
      "A transaction record exists. Reconcile its hash; never sign a replacement blindly.",
    );
  const key = process.env.FORMA_DEPLOYER_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key))
    throw new Error("Local operator key missing");
  const account = privateKeyToAccount(key as Hex);
  if (account.address.toLowerCase() !== expected.from.toLowerCase())
    throw new Error("Operator key/address mismatch");
  const lock = await operatorLease(account.address);
  if (!lock) throw new Error("Operator wallet is busy");
  try {
    const rpc = createPublicClient({
      chain: qieChain,
      transport: http(
        process.env.QIE_RPC_URL || qieChain.rpcUrls.default.http[0],
        { timeout: 20000, retryCount: 0 },
      ),
    });
    if ((await rpc.getChainId()) !== 1990)
      throw new Error("RPC network mismatch");
    const escrow = expected.to as Address;
    const [
      asset,
      treasury,
      operator,
      decimals,
      job,
      code,
      gasPrice,
      balance,
      nonce,
      confirmedNonce,
    ] = await Promise.all([
      rpc.readContract({
        address: escrow,
        abi: escrowAbi,
        functionName: "asset",
      }),
      rpc.readContract({
        address: escrow,
        abi: escrowAbi,
        functionName: "treasury",
      }),
      rpc.readContract({
        address: escrow,
        abi: escrowAbi,
        functionName: "operator",
      }),
      rpc.readContract({
        address: terms.token as Address,
        abi: tokenAbi,
        functionName: "decimals",
      }),
      rpc.readContract({
        address: escrow,
        abi: escrowAbi,
        functionName: "jobs",
        args: [row.chain_job as Hex],
      }),
      rpc.getCode({ address: escrow }),
      rpc.getGasPrice(),
      rpc.getBalance({ address: account.address }),
      rpc.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      }),
      rpc.getTransactionCount({ address: account.address, blockTag: "latest" }),
    ]);
    const deployment = JSON.parse(
      await readFile(
        process.env.ESCROW_DEPLOYMENT_RECORD ||
          ".forma/contracts/deployment.json",
        "utf8",
      ),
    );
    if (
      !code ||
      keccak256(code) !== deployment.runtimeCodeHash ||
      escrow.toLowerCase() !== deployment.contractAddress.toLowerCase()
    )
      throw new Error("Escrow bytecode differs from verified deployment");
    if (
      asset.toLowerCase() !== terms.token.toLowerCase() ||
      treasury.toLowerCase() !== process.env.TREASURY_ADDRESS?.toLowerCase() ||
      operator.toLowerCase() !== account.address.toLowerCase() ||
      decimals !== 6 ||
      (action === "create" && job[7] !== 0)
    )
      throw new Error(
        "Escrow configuration mismatch or job already registered",
      );
    if (action === "deliver")
      validateDeliveryState(parseOrder(row), quote, job);
    if (nonce !== confirmedNonce)
      throw new Error(
        "Another operator transaction is pending; reconcile first",
      );
    const estimate = await rpc.estimateGas({
      account: account.address,
      to: escrow,
      data: expected.data,
      value: 0n,
    });
    const gas = BigInt(plan.gasLimit),
      limit = parseEther(cap);
    if (
      estimate > gas ||
      gasPrice > BigInt(plan.maximumGasPrice) ||
      gas * gasPrice > limit ||
      gas * gasPrice > BigInt(plan.maximumFeeWei) ||
      balance < gas * gasPrice
    )
      throw new Error(
        "Current registration exceeds the approved fee limits or balance",
      );
    if (
      Date.parse(
        action === "create" ? row.funding_expires : row.delivery_due,
      ) <= Date.now()
    )
      throw new Error("Quote expired before signing");
    const serialized = await account.signTransaction({
      chainId: 1990,
      type: "legacy",
      nonce,
      to: escrow,
      data: expected.data,
      value: 0n,
      gas,
      gasPrice,
    });
    const hash = keccak256(serialized);
    const record = {
      status: "signed_pending_broadcast",
      orderId: row.id,
      hash,
      operator: account.address,
      escrow,
      nonce,
      chainId: 1990,
      gasLimit: gas.toString(),
      gasPriceWei: gasPrice.toString(),
      maximumFeeQIE: formatEther(gas * gasPrice),
      approvedFeeCapQIE: cap,
      planSha256: approvedHash,
      createdAt: new Date().toISOString(),
    };
    // Both the unique nonce and signed bytes survive a crash/ambiguous broadcast.
    await db.transaction(async (tx) => {
      const [activeLock] = await tx.query(
        "SELECT token,expires FROM operator_locks WHERE address=$1 FOR UPDATE",
        [account.address.toLowerCase()],
      );
      if (
        activeLock?.token !== lock.token ||
        activeLock.expires <= new Date().toISOString()
      )
        throw new Error("Operator lease expired before broadcast");
      const updated = await tx.query(
        "UPDATE operator_tasks SET status='signed',operator_address=$1,nonce=$2,tx_hash=$3,signed_tx=$4,gas_reserved_wei=$5,updated_at=$6 WHERE order_id=$7 AND action=$8 AND status='queued' AND tx_hash IS NULL RETURNING id",
        [
          account.address.toLowerCase(),
          nonce,
          hash,
          serialized,
          (gas * gasPrice).toString(),
          new Date().toISOString(),
          row.id,
          action,
        ],
      );
      if (updated.length !== 1)
        throw new Error(
          "Registration already claimed; reconcile the existing task",
        );
    });
    await writeFile(recordFile, JSON.stringify(record, null, 2), {
      flag: "wx",
    });
    const sent = await rpc.sendRawTransaction({
      serializedTransaction: serialized,
    });
    if (sent !== hash)
      throw new Error(
        "Unexpected RPC transaction hash; reconcile saved record",
      );
    record.status = "broadcast";
    await writeFile(recordFile, JSON.stringify(record, null, 2));
    await db.query(
      "UPDATE operator_tasks SET status='broadcast',updated_at=$1 WHERE order_id=$2 AND action=$4 AND tx_hash=$3",
      [new Date().toISOString(), row.id, hash, action],
    );
    console.log(
      JSON.stringify({
        status: "broadcast",
        hash,
        orderId: row.id,
        maximumFeeQIE: record.maximumFeeQIE,
      }),
    );
    const receipt = await rpc.waitForTransactionReceipt({
      hash,
      confirmations: 3,
      timeout: 120000,
      pollingInterval: 2000,
    });
    if (receipt.status !== "success")
      throw new Error(
        "Registration reverted. Saved transaction must be reconciled before further action",
      );
    await (action === "create" ? reconcileRegistration : reconcileDelivery)(
      parseOrder(row),
      hash,
    );
    await db.query(
      "UPDATE operator_tasks SET status='confirmed',updated_at=$1 WHERE order_id=$2 AND action=$4 AND tx_hash=$3",
      [new Date().toISOString(), row.id, hash, action],
    );
    record.status = "confirmed_checked";
    Object.assign(record, {
      blockNumber: receipt.blockNumber.toString(),
      actualFeeQIE: formatEther(
        receipt.gasUsed * (receipt.effectiveGasPrice ?? gasPrice),
      ),
      confirmedAt: new Date().toISOString(),
    });
    await writeFile(recordFile, JSON.stringify(record, null, 2));
    console.log(JSON.stringify(record, null, 2));
  } finally {
    await lock.release();
  }
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(
      e && typeof e === "object" && "shortMessage" in e
        ? String(e.shortMessage)
        : e instanceof Error
          ? e.message
          : "Registration stopped. Reconcile its saved transaction record before retrying.",
    );
    process.exit(1);
  });
