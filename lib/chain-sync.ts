/** Read-only chain recovery. Never loads a wallet key or sends transactions. */
import { readFile } from "node:fs/promises";
import { type Hex } from "viem";
import { database } from "./db";
import { ownedOrder, parseOrder } from "./orders";
import {
  escrowAbi,
  verifiedConfig,
  reconcilePayment,
  reconcileDelivery,
  reconcileDecision,
} from "./payments";
import type { Order } from "./domain";
import { releaseExpiredProviderReservation } from "./provider-budget";

export async function syncOrderFromChain(order: Order) {
  if (order.mode !== "live" || ["released", "refunded"].includes(order.payment))
    return order;
  const db = await database();
  const [registration] = await db.query(
    "SELECT block_number FROM chain_events WHERE order_id=$1 AND action='registered' ORDER BY block_number LIMIT 1",
    [order.id],
  );
  if (!registration && order.payment === "unfunded") return order;
  const { rpc, escrow } = await verifiedConfig();
  const job = await rpc.readContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "jobs",
    args: [order.chain_job as Hex],
  });
  const state = job[7];
  if (state === 1 && Number(job[4]) * 1000 <= Date.now()) {
    const latestBlock = await rpc.getBlock();
    if (latestBlock.timestamp >= job[4])
      await releaseExpiredProviderReservation(order.id);
  }
  const phase =
    state === 4
      ? "JobReleased"
      : state === 5
        ? "JobRefunded"
        : state === 3 && order.work !== "delivered"
          ? "DeliverySubmitted"
          : state === 2 &&
              ["unfunded", "pending", "unknown"].includes(order.payment)
            ? "JobFunded"
            : null;
  if (!phase) return order;
  const latest = await rpc.getBlockNumber();
  if (latest < 2n) return order;
  const toBlock = latest - 2n;
  let start: bigint;
  if (registration) start = BigInt(registration.block_number);
  else {
    const deployment = JSON.parse(
      await readFile(
        process.env.ESCROW_DEPLOYMENT_RECORD ||
          ".forma/contracts/deployment.json",
        "utf8",
      ),
    );
    start = BigInt(deployment.blockNumber);
  }
  const [cursor] = await db.query(
    "SELECT next_block FROM chain_scan_cursors WHERE order_id=$1 AND event_name=$2",
    [order.id, phase],
  );
  if (cursor) start = BigInt(cursor.next_block);
  // Bound each cycle; persisted cursors allow recovery after a long outage.
  for (let batch = 0; batch < 8 && start <= toBlock; batch++) {
    const end = start + 1999n < toBlock ? start + 1999n : toBlock;
    const logs = await rpc.getContractEvents({
      address: escrow,
      abi: escrowAbi,
      eventName: phase,
      args: { jobId: order.chain_job as Hex },
      fromBlock: start,
      toBlock: end,
      strict: true,
    });
    for (const log of logs) {
      if (!log.transactionHash) continue;
      const fresh = await ownedOrder(order.id, order.owner);
      if (phase === "JobFunded")
        await reconcilePayment(fresh, log.transactionHash);
      else if (phase === "DeliverySubmitted")
        await reconcileDelivery(fresh, log.transactionHash);
      else await reconcileDecision(fresh, log.transactionHash);
      return ownedOrder(order.id, order.owner);
    }
    // Only scan blocks with the required confirmation depth.
    await db.query(
      "INSERT INTO chain_scan_cursors(order_id,event_name,next_block) VALUES($1,$2,$3) ON CONFLICT(order_id,event_name) DO UPDATE SET next_block=$3",
      [order.id, phase, (end + 1n).toString()],
    );
    start = end + 1n;
  }
  return order;
}

export async function syncActiveOrders() {
  const db = await database();
  const rows = await db.query(
    "SELECT * FROM orders WHERE mode='live' AND payment NOT IN ('released','refunded') ORDER BY updated_at LIMIT 100",
  );
  let failed = 0;
  for (const row of rows) {
    try {
      await syncOrderFromChain(parseOrder(row));
    } catch {
      failed++;
      /* An RPC outage never fabricates success or triggers signing. The next cycle retries reads. */
    }
  }
  return { checked: rows.length, failed };
}
