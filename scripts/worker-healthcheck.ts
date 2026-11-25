import { database } from "../lib/db";
const role = process.argv[2];
if (!["generation", "operator", "chain"].includes(role)) process.exit(1);
const [row] = await (
  await database()
).query("SELECT state,updated_at FROM worker_health WHERE role=$1", [role]);
process.exit(
  row?.state === "ready" && Date.parse(row.updated_at) > Date.now() - 60000
    ? 0
    : 1,
);
