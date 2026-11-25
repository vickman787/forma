import { config } from "../lib/config";
import { syncActiveOrders } from "../lib/chain-sync";
import { heartbeat } from "../lib/health";
import { verifiedConfig } from "../lib/payments";
if (config().mode !== "live")
  throw new Error("Chain recovery requires real-mode configuration");
console.log(
  "Forma read-only chain recovery worker: no signing or transactions",
);
await verifiedConfig();
let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});
while (!stopping) {
  const result = await syncActiveOrders();
  await heartbeat("chain", result.failed ? "unavailable" : "ready", result);
  if (!stopping) await new Promise((r) => setTimeout(r, 10000));
}
