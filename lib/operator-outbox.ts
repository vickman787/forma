import { randomUUID } from "node:crypto";
import { database, type DB } from "./db";
import type { OperatorAction } from "./operator";

export async function queueOperator(
  db: DB,
  orderId: string,
  action: OperatorAction,
) {
  const [order] = await db.query("SELECT mode FROM orders WHERE id=$1", [
    orderId,
  ]);
  if (!order || order.mode !== "live") return;
  const at = new Date().toISOString();
  await db.query(
    "INSERT INTO operator_tasks(id,order_id,action,status,created_at,updated_at) VALUES($1,$2,$3,'queued',$4,$4) ON CONFLICT(order_id,action) DO UPDATE SET status='queued',updated_at=$4 WHERE operator_tasks.status='awaiting_delivery'",
    [randomUUID(), orderId, action, at],
  );
}

export function operatorPolicy() {
  if (process.env.ALLOW_OPERATOR_TRANSACTIONS !== "true")
    throw new Error(
      "Operator transactions are disabled pending explicit authorization.",
    );
  const id = process.env.OPERATOR_POLICY_ID;
  const text = process.env.OPERATOR_TOTAL_GAS_QIE || "";
  if (
    !id ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(id) ||
    !/^\d+(\.\d{1,18})?$/.test(text)
  )
    throw new Error(
      "An explicitly approved operator policy and gas allocation are required.",
    );
  const [whole, fraction = ""] = text.split(".");
  const total = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
  if (total <= 0n) throw new Error("Operator gas allocation must be positive.");
  const perTransaction = process.env.OPERATOR_MAX_TX_GAS_QIE || "";
  if (!/^\d+(\.\d{1,18})?$/.test(perTransaction))
    throw new Error(
      "An approved per-transaction operator fee cap is required.",
    );
  const [txWhole, txFraction = ""] = perTransaction.split(".");
  const maximumFee =
    BigInt(txWhole) * 10n ** 18n + BigInt(txFraction.padEnd(18, "0"));
  const expires = Date.parse(process.env.OPERATOR_POLICY_EXPIRES_AT || "");
  const actions = (process.env.OPERATOR_POLICY_ACTIONS || "").split(",");
  const orderId = process.env.OPERATOR_POLICY_ORDER_ID || "";
  if (
    maximumFee <= 0n ||
    maximumFee > total ||
    !Number.isFinite(expires) ||
    expires <= Date.now() ||
    !actions.length ||
    actions.some((a) => a !== "create" && a !== "deliver") ||
    (orderId && !/^[0-9a-f-]{36}$/i.test(orderId))
  )
    throw new Error(
      "An unexpired approval with explicit registration/delivery actions and fee limits is required.",
    );
  return { id, total, maximumFee, expires, actions, orderId };
}

export async function reserveOperatorGas(
  tx: DB,
  taskId: string,
  maximumFee: bigint,
) {
  const policy = operatorPolicy();
  if (maximumFee <= 0n || maximumFee > policy.total)
    throw new Error(
      "Transaction exceeds the approved operator gas allocation.",
    );
  await tx.query(
    "INSERT INTO operator_policies(id,total_wei,reserved_wei) VALUES($1,$2,'0') ON CONFLICT(id) DO NOTHING",
    [policy.id, policy.total.toString()],
  );
  const [row] = await tx.query(
    "SELECT * FROM operator_policies WHERE id=$1 FOR UPDATE",
    [policy.id],
  );
  if (BigInt(row.total_wei) !== policy.total)
    throw new Error(
      "Changing an operator gas allocation requires a newly approved policy ID.",
    );
  const [task] = await tx.query(
    "SELECT * FROM operator_tasks WHERE id=$1 FOR UPDATE",
    [taskId],
  );
  if (!task || task.status !== "queued" || task.gas_reserved_wei)
    throw new Error("Task is already reserved or is not queued.");
  const reserveDelivery =
    task.action === "create" && policy.actions.includes("deliver");
  const next =
    BigInt(row.reserved_wei) + maximumFee * (reserveDelivery ? 2n : 1n);
  if (next > policy.total)
    throw new Error("Approved operator gas allocation is exhausted.");
  await tx.query("UPDATE operator_policies SET reserved_wei=$1 WHERE id=$2", [
    next.toString(),
    policy.id,
  ]);
  await tx.query(
    "UPDATE operator_tasks SET policy_id=$1,gas_reserved_wei=$2 WHERE id=$3",
    [policy.id, maximumFee.toString(), taskId],
  );
  if (reserveDelivery) {
    const at = new Date().toISOString();
    await tx.query(
      "INSERT INTO operator_tasks(id,order_id,action,status,policy_id,gas_reserved_wei,created_at,updated_at) VALUES($1,$2,'deliver','awaiting_delivery',$3,$4,$5,$5)",
      [randomUUID(), task.order_id, policy.id, maximumFee.toString(), at],
    );
  }
}

export async function operatorLease(address: string) {
  const db = await database();
  const token = randomUUID(),
    at = new Date().toISOString(),
    until = new Date(Date.now() + 120000).toISOString();
  return db.transaction(async (tx) => {
    await tx.query(
      "INSERT INTO operator_locks(address,token,expires) VALUES($1,$2,$3) ON CONFLICT(address) DO NOTHING",
      [address.toLowerCase(), token, until],
    );
    const [row] = await tx.query(
      "SELECT * FROM operator_locks WHERE address=$1 FOR UPDATE",
      [address.toLowerCase()],
    );
    if (row.token !== token && row.expires > at) return null;
    await tx.query(
      "UPDATE operator_locks SET token=$1,expires=$2 WHERE address=$3",
      [token, until, address.toLowerCase()],
    );
    return {
      token,
      release: async () => {
        await db.query(
          "UPDATE operator_locks SET expires=$1 WHERE address=$2 AND token=$3",
          [new Date(0).toISOString(), address.toLowerCase(), token],
        );
      },
    };
  });
}
