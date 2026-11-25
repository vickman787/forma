/** Produces unsigned calldata only. Never signs, deploys, or sends a transaction. */
import { database } from "../lib/db";
import { parseOrder } from "../lib/orders";
import {
  operatorActions,
  operatorPlan,
  type OperatorAction,
} from "../lib/operator";
const [orderId, action] = process.argv.slice(2);
if (!orderId || !operatorActions.includes(action as OperatorAction))
  throw new Error(
    "Usage: npm run operator:plan -- ORDER_ID create|deliver|refund|release",
  );
const db = await database();
const [row] = await db.query("SELECT * FROM orders WHERE id=$1", [orderId]);
if (!row) throw new Error("Order not found.");
const [quote] = await db.query(
  "SELECT q.*,c.wallet FROM quotes q JOIN customers c ON c.id=q.owner WHERE q.id=$1 AND q.owner=$2",
  [row.quote_id, row.owner],
);
if (!quote) throw new Error("Owned quote not found.");
console.log(
  JSON.stringify(
    operatorPlan(parseOrder(row), quote, action as OperatorAction, {
      escrow: process.env.ESCROW_ADDRESS || "",
      operator: process.env.OPERATOR_ADDRESS || "",
    }),
    null,
    2,
  ),
);
process.exit(0);
