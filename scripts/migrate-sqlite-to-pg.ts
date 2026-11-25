/** Offline cutover tool. Copies data in one PostgreSQL transaction; never changes the source. */
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
if (!process.argv.includes("--source-stopped"))
  throw new Error(
    "Stop source web/workers first, back up data, then pass --source-stopped",
  );
const file = process.env.SOURCE_SQLITE_PATH,
  url = process.env.DATABASE_URL;
if (!file || !url?.startsWith("postgresql://"))
  throw new Error(
    "Set SOURCE_SQLITE_PATH and target DATABASE_URL locally; never paste credentials into chat",
  );
const source = new DatabaseSync(file, { readOnly: true });
const pool = new Pool({ connectionString: url, max: 1 }),
  target = await pool.connect();
const tables = [
  "customers",
  "brand_kits",
  "drafts",
  "uploads",
  "quotes",
  "generation_plans",
  "orders",
  "jobs",
  "provider_responses",
  "events",
  "artifacts",
  "issues",
  "chain_events",
  "provider_budgets",
  "provider_budget_reservations",
  "provider_order_reservations",
  "operator_policies",
  "operator_tasks",
  "chain_scan_cursors",
];
try {
  source.exec("BEGIN");
  await target.query("BEGIN");
  const migration = await readFile("migrations/001_initial.sql", "utf8");
  for (const sql of migration
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean))
    await target.query(sql);
  for (const table of tables) {
    const count = await target.query(`SELECT COUNT(*) AS count FROM ${table}`);
    if (Number(count.rows[0].count))
      throw new Error(
        "Target is not empty. Migration refused without changing source or target data.",
      );
  }
  let copied = 0;
  for (const table of tables) {
    const exists = source
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(table);
    if (!exists) continue;
    const rows = source.prepare(`SELECT * FROM ${table}`).all();
    for (const row of rows) {
      const columns = Object.keys(row);
      if (columns.some((c) => !/^[_a-z][_a-z0-9]*$/.test(c)))
        throw new Error("Unexpected source column");
      await target.query(
        `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(",")})`,
        columns.map((c) => row[c]),
      );
      copied++;
    }
  }
  await target.query(
    "UPDATE jobs SET status='queued',lease_token=NULL,lease_until=NULL WHERE status='running'",
  );
  await target.query("COMMIT");
  source.exec("COMMIT");
  console.log(
    JSON.stringify({
      copiedRows: copied,
      providerBudgetLedgerPreserved: true,
      sourceUnchanged: true,
      sessionsAndNoncesInvalidated: true,
      files:
        "Copy the existing private uploads/artifacts separately before starting target workers.",
    }),
  );
} catch (e) {
  await target.query("ROLLBACK");
  source.exec("ROLLBACK");
  throw new Error(
    e instanceof Error
      ? e.message
      : "Migration failed; no target data committed",
  );
} finally {
  source.close();
  target.release();
  await pool.end();
}
