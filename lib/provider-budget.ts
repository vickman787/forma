import { randomUUID } from "node:crypto";
import { database } from "./db";

/** Conservatively reserves the full per-job estimate before any provider request. */
export async function reserveProviderCall(orderId?: string) {
  const id = process.env.PROVIDER_BUDGET_ID;
  const limitText = process.env.PROVIDER_TOTAL_BUDGET_USD;
  if (!id && !limitText) return;
  const limit = Math.round(Number(limitText) * 1e6);
  const amount = Math.ceil(Number(process.env.MAX_JOB_COST_USD) * 1e6);
  if (
    !id ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(id) ||
    !Number.isSafeInteger(limit) ||
    !Number.isSafeInteger(amount) ||
    limit <= 0 ||
    amount <= 0 ||
    amount > limit
  )
    throw new Error("Invalid approved provider budget configuration.");
  const db = await database();
  return db.transaction(async (tx) => {
    if (orderId) {
      const [order] = await tx.query(
        "SELECT id FROM orders WHERE id=$1 FOR UPDATE",
        [orderId],
      );
      if (!order)
        throw new Error("Provider reservation requires an existing order");
      const [existing] = await tx.query(
        "SELECT r.* FROM provider_order_reservations o JOIN provider_budget_reservations r ON r.id=o.reservation_id WHERE o.order_id=$1",
        [orderId],
      );
      if (existing)
        return {
          id: existing.id,
          budgetId: existing.budget_id,
          reservedUSD: Number(existing.amount_microusd) / 1e6,
        };
    }
    await tx.query(
      "INSERT INTO provider_budgets(id,limit_microusd,reserved_microusd) VALUES($1,$2,0) ON CONFLICT(id) DO NOTHING",
      [id, limit],
    );
    const [account] = await tx.query(
      "SELECT * FROM provider_budgets WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (Number(account.limit_microusd) !== limit)
      throw new Error(
        "Changing a saved provider budget requires a newly approved budget ID.",
      );
    const updated = await tx.query(
      "UPDATE provider_budgets SET reserved_microusd=reserved_microusd+$1 WHERE id=$2 AND reserved_microusd+$1<=limit_microusd RETURNING id",
      [amount, id],
    );
    if (!updated.length)
      throw new Error(
        "Approved AI testing budget is exhausted. No provider request was sent.",
      );
    const reservation = randomUUID();
    await tx.query(
      "INSERT INTO provider_budget_reservations(id,budget_id,amount_microusd,created_at) VALUES($1,$2,$3,$4)",
      [reservation, id, amount, new Date().toISOString()],
    );
    if (orderId)
      await tx.query(
        "INSERT INTO provider_order_reservations(order_id,reservation_id) VALUES($1,$2)",
        [orderId, reservation],
      );
    return { id: reservation, budgetId: id, reservedUSD: amount / 1e6 };
  });
}

/** Caller must first verify on-chain that the unfunded quote has expired. */
export async function releaseExpiredProviderReservation(orderId: string) {
  const db = await database();
  await db.transaction(async (tx) => {
    const [o] = await tx.query(
      "SELECT payment,funding_expires FROM orders WHERE id=$1 FOR UPDATE",
      [orderId],
    );
    if (
      !o ||
      !["unfunded", "pending", "unknown"].includes(o.payment) ||
      Date.parse(o.funding_expires) > Date.now()
    )
      return;
    const jobs = await tx.query("SELECT id FROM jobs WHERE order_id=$1", [
      orderId,
    ]);
    if (jobs.length) return;
    const [r] = await tx.query(
      "SELECT r.* FROM provider_order_reservations o JOIN provider_budget_reservations r ON r.id=o.reservation_id WHERE o.order_id=$1",
      [orderId],
    );
    if (!r) return;
    await tx.query(
      "UPDATE provider_budgets SET reserved_microusd=reserved_microusd-$1 WHERE id=$2 AND reserved_microusd>=$1",
      [r.amount_microusd, r.budget_id],
    );
    await tx.query(
      "DELETE FROM provider_order_reservations WHERE order_id=$1",
      [orderId],
    );
    await tx.query("DELETE FROM provider_budget_reservations WHERE id=$1", [
      r.id,
    ]);
  });
}
