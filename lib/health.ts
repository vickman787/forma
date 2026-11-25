import { database } from "./db";
import { config } from "./config";
export async function heartbeat(
  role: string,
  state = "ready",
  detail: unknown = {},
) {
  await (
    await database()
  ).query(
    "INSERT INTO worker_health(role,state,detail,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(role) DO UPDATE SET state=$2,detail=$3,updated_at=$4",
    [role, state, JSON.stringify(detail), new Date().toISOString()],
  );
}
export async function checkoutReadiness(newOrder = false) {
  if (config().fixtures) return { enabled: true, reason: null };
  const rows = await (await database()).query("SELECT * FROM worker_health");
  for (const role of ["generation", "operator", "chain"]) {
    const row = rows.find((r) => r.role === role);
    if (
      !row ||
      row.state !== "ready" ||
      !Number.isFinite(Date.parse(row.updated_at)) ||
      Date.parse(row.updated_at) < Date.now() - 60000
    )
      return {
        enabled: false,
        reason:
          "The studio is temporarily unavailable. Your wallet has not been charged.",
      };
    if (role === "operator" && newOrder) {
      let detail;
      try {
        detail = JSON.parse(row.detail);
        if (
          !detail ||
          !Array.isArray(detail.actions) ||
          !Number.isFinite(Number(detail.expires)) ||
          !/^\d+$/.test(detail.total) ||
          !/^\d+$/.test(detail.maximumFee) ||
          BigInt(detail.maximumFee) <= 0n
        )
          throw new Error("Invalid worker capacity");
      } catch {
        return {
          enabled: false,
          reason:
            "New orders are temporarily unavailable while operator capacity is checked.",
        };
      }
      if (
        detail.orderId ||
        !detail.actions?.includes("create") ||
        !detail.actions?.includes("deliver") ||
        Number(detail.expires) < Date.now() + (24 * 60 + 30) * 60000
      )
        return {
          enabled: false,
          reason:
            "New orders are temporarily unavailable while operator capacity is renewed.",
        };
      const [budget] = await (
        await database()
      ).query("SELECT * FROM operator_policies WHERE id=$1", [detail.id]);
      if (
        BigInt(detail.total) - BigInt(budget?.reserved_wei || "0") <
        BigInt(detail.maximumFee) * 2n
      )
        return {
          enabled: false,
          reason: "New orders are temporarily full. Please try again later.",
        };
    }
  }
  return { enabled: true, reason: null };
}
