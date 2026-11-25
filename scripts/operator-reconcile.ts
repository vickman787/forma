/** Reads a confirmed transaction and updates the local record. Never signs or sends. */
import { database } from "../lib/db";
import { parseOrder } from "../lib/orders";
import {
  reconcileRegistration,
  reconcilePayment,
  reconcileDelivery,
  reconcileDecision,
} from "../lib/payments";
const [orderId, action, txHash] = process.argv.slice(2);
const handlers = {
  create: reconcileRegistration,
  fund: reconcilePayment,
  deliver: reconcileDelivery,
  settle: reconcileDecision,
};
if (
  !orderId ||
  !Object.hasOwn(handlers, action || "") ||
  !/^0x[0-9a-fA-F]{64}$/.test(txHash || "")
)
  throw new Error(
    "Usage: npm run operator:reconcile -- ORDER_ID create|fund|deliver|settle TX_HASH",
  );
const db = await database();
const [row] = await db.query("SELECT * FROM orders WHERE id=$1 AND mode=$2", [
  orderId,
  "live",
]);
if (!row) throw new Error("Live order not found.");
const result = await handlers[action as keyof typeof handlers](
  parseOrder(row),
  txHash,
);
if (action === "create" || action === "deliver")
  await db.query(
    "UPDATE operator_tasks SET status='confirmed',error=NULL,updated_at=$1 WHERE order_id=$2 AND action=$3 AND tx_hash=$4",
    [new Date().toISOString(), orderId, action, txHash],
  );
console.log(
  JSON.stringify(
    {
      id: result.id,
      work: result.work,
      payment: result.payment,
      deliveryDue: result.delivery_due,
      reviewDue: result.review_due,
    },
    null,
    2,
  ),
);
process.exit(0);
