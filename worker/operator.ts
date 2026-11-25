/** Separate signer process. Disabled without an explicitly approved, bounded policy. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatEther, keccak256, type Hex } from "viem";
import { readFile } from "node:fs/promises";
import { database } from "../lib/db";
import { config } from "../lib/config";
import { parseOrder } from "../lib/orders";
import {
  operatorPolicy,
  reserveOperatorGas,
  operatorLease,
} from "../lib/operator-outbox";
import {
  reconcileRegistration,
  reconcileDelivery,
  verifiedConfig,
} from "../lib/payments";
import { operatorPlan } from "../lib/operator";
import { validateSavedOperatorTransaction } from "../lib/operator-recovery";
import { heartbeat } from "../lib/health";
import { privateKeyToAccount } from "viem/accounts";
const exec = promisify(execFile);

export async function runOperatorOne(execute: typeof exec = exec) {
  const policy = operatorPolicy(); // Checked before loading any signing key or starting a child process.
  const c = config();
  if (c.mode !== "live")
    throw new Error("Operator execution requires real-mode configuration");
  const db = await database();
  const [pending] = await db.query(
    "SELECT t.*,o.owner FROM operator_tasks t JOIN orders o ON o.id=t.order_id WHERE o.mode='live' AND t.status IN ('signed','broadcast') ORDER BY t.created_at LIMIT 1",
  );
  if (pending) {
    // Never blindly recreate or resign an ambiguous transaction, even across a policy change.
    const [row] = await db.query("SELECT * FROM orders WHERE id=$1", [
      pending.order_id,
    ]);
    try {
      if (pending.action === "create")
        await reconcileRegistration(parseOrder(row), pending.tx_hash);
      else if (pending.action === "deliver")
        await reconcileDelivery(parseOrder(row), pending.tx_hash);
      else throw new Error("Unsupported queued operator action");
      await db.query(
        "UPDATE operator_tasks SET status='confirmed',error=NULL,updated_at=$1 WHERE id=$2",
        [new Date().toISOString(), pending.id],
      );
    } catch {
      // A crash between durable signing and broadcast must not leave a job stuck forever.
      // Only the exact saved signature may be rebroadcast, within its original active policy.
      try {
        if (
          !pending.signed_tx ||
          pending.policy_id !== policy.id ||
          !policy.actions.includes(pending.action) ||
          (policy.orderId && policy.orderId !== pending.order_id)
        )
          throw new Error("Saved transaction needs separate review");
        const [quote] = await db.query(
          "SELECT q.terms_hash,c.wallet FROM quotes q JOIN customers c ON c.id=q.owner WHERE q.id=$1 AND q.owner=$2",
          [row.quote_id, row.owner],
        );
        const expected = operatorPlan(parseOrder(row), quote, pending.action, {
          escrow: process.env.ESCROW_ADDRESS || "",
          operator: process.env.OPERATOR_ADDRESS || "",
        });
        const serialized = await validateSavedOperatorTransaction(
          pending,
          expected,
          policy,
        );
        const { rpc, escrow } = await verifiedConfig();
        let missing = false;
        try {
          await rpc.getTransaction({ hash: pending.tx_hash });
        } catch (e) {
          if (e instanceof Error && e.name === "TransactionNotFoundError")
            missing = true;
          else throw e;
        }
        if (missing) {
          const lock = await operatorLease(expected.from);
          if (!lock) throw new Error("Operator wallet busy");
          try {
            const deployment = JSON.parse(
              await readFile(
                process.env.ESCROW_DEPLOYMENT_RECORD ||
                  ".forma/contracts/deployment.json",
                "utf8",
              ),
            );
            const [code, latest, poolNonce] = await Promise.all([
              rpc.getCode({ address: escrow }),
              rpc.getTransactionCount({
                address: expected.from as Hex,
                blockTag: "latest",
              }),
              rpc.getTransactionCount({
                address: expected.from as Hex,
                blockTag: "pending",
              }),
            ]);
            if (
              !code ||
              keccak256(code) !== deployment.runtimeCodeHash ||
              escrow.toLowerCase() !==
                deployment.contractAddress.toLowerCase() ||
              latest !== pending.nonce ||
              poolNonce !== pending.nonce
            )
              throw new Error(
                "Existing signature cannot be safely rebroadcast",
              );
            operatorPolicy();
            // eth_call checks current contract state and deadline without moving funds.
            await rpc.call({
              account: expected.from as Hex,
              to: escrow,
              data: expected.data,
              value: 0n,
            });
            const sent = await rpc.sendRawTransaction({
              serializedTransaction: serialized,
            });
            if (sent !== pending.tx_hash)
              throw new Error("Unexpected saved transaction hash");
            await db.query(
              "UPDATE operator_tasks SET status='broadcast',updated_at=$1 WHERE id=$2 AND tx_hash=$3",
              [new Date().toISOString(), pending.id, sent],
            );
          } finally {
            await lock.release();
          }
        }
      } catch {
        /* Keep the original signature for read-only reconciliation or owner review. */
      }
      await db.query("UPDATE operator_tasks SET error=$1 WHERE id=$2", [
        "Waiting for canonical confirmation. Existing transaction retained; no replacement was signed.",
        pending.id,
      ]);
    }
    return true;
  }
  const tasks = await db.query(
    "SELECT t.*,o.funding_expires,o.delivery_due FROM operator_tasks t JOIN orders o ON o.id=t.order_id WHERE o.mode='live' AND t.status='queued' ORDER BY t.created_at LIMIT 100",
  );
  const task = tasks.find(
    (t) =>
      policy.actions.includes(t.action) &&
      (!policy.orderId || policy.orderId === t.order_id) &&
      (t.action !== "create" ||
        c.liveEnabled ||
        c.localCheckoutOrder === t.order_id),
  );
  if (!task) return false;
  const deadline =
    task.action === "create" ? task.funding_expires : task.delivery_due;
  if (!deadline || Date.parse(deadline) <= Date.now()) {
    await db.query(
      "UPDATE operator_tasks SET status='expired',error=$1,updated_at=$2 WHERE id=$3",
      [
        "The original on-chain action deadline expired. No transaction was sent.",
        new Date().toISOString(),
        task.id,
      ],
    );
    return true;
  }
  if (task.policy_id && task.policy_id !== policy.id)
    throw new Error(
      "Reserved task belongs to a different approval policy; review it first.",
    );
  try {
    const prepared = await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator-preflight.ts",
        task.order_id,
        task.action,
        `${policy.id}-${task.id}`,
      ],
      {
        cwd: process.cwd(),
        windowsHide: true,
        timeout: 90000,
        maxBuffer: 32768,
      },
    );
    const plan = JSON.parse(prepared.stdout);
    if (
      !plan.unsigned ||
      plan.orderId !== task.order_id ||
      plan.transactionsSent !== 0
    )
      throw new Error("Unexpected preflight result");
    const parts = String(plan.maximumFeeQIE).split(".");
    const fee =
      BigInt(parts[0]) * 10n ** 18n + BigInt((parts[1] || "").padEnd(18, "0"));
    if (fee > policy.maximumFee)
      throw new Error("Current fee exceeds the approved transaction cap");
    if (!task.gas_reserved_wei)
      await db.transaction((tx) =>
        reserveOperatorGas(tx, task.id, policy.maximumFee),
      );
    else if (fee > BigInt(task.gas_reserved_wei))
      throw new Error("Current fee exceeds the existing task reservation");
    // Recheck expiry/approval immediately before invoking the narrowly scoped executor.
    operatorPolicy();
    const result = await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator-execute.ts",
        plan.file,
        plan.planSha256,
        formatEther(fee),
        task.action === "create"
          ? "--approved-single-mainnet-registration"
          : "--approved-single-mainnet-delivery",
      ],
      {
        cwd: process.cwd(),
        windowsHide: true,
        timeout: 180000,
        maxBuffer: 32768,
      },
    );
    // Child stdout contains only public transaction records; signed bytes stay in private storage.
    if (result.stdout) console.log(result.stdout.trim());
  } catch {
    const [current] = await db.query(
      "SELECT status FROM operator_tasks WHERE id=$1",
      [task.id],
    );
    if (current?.status === "queued")
      await db.query(
        "UPDATE operator_tasks SET status='blocked',error=$1,updated_at=$2 WHERE id=$3",
        [
          "Operator preparation or execution needs review. No automatic retry or replacement signing.",
          new Date().toISOString(),
          task.id,
        ],
      );
  }
  return true;
}
if (process.argv[1]?.replace(/\\/g, "/").endsWith("worker/operator.ts")) {
  operatorPolicy();
  const key = process.env.FORMA_DEPLOYER_PRIVATE_KEY;
  if (
    !key ||
    !/^0x[0-9a-f]{64}$/i.test(key) ||
    privateKeyToAccount(key as `0x${string}`).address.toLowerCase() !==
      process.env.OPERATOR_ADDRESS?.toLowerCase()
  )
    throw new Error("The configured operator signer is unavailable");
  console.log(
    "Forma operator worker: bounded registration/delivery policy only",
  );
  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });
  while (!stopping) {
    try {
      const policy = operatorPolicy();
      await heartbeat("operator", "ready", {
        ...policy,
        total: policy.total.toString(),
        maximumFee: policy.maximumFee.toString(),
      });
      await runOperatorOne();
    } catch {
      await heartbeat("operator", "unavailable");
      console.error(
        "Operator approval/configuration requires review. No automatic signing.",
      );
    }
    if (!stopping) await new Promise((r) => setTimeout(r, 10000));
  }
}
