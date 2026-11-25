/** Runs the workflow suites against isolated PostgreSQL schemas, then removes only those schemas. */
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
const root = process.env.FORMA_PG_TEST_ROOT_URL,
  app = process.env.FORMA_PG_TEST_APP_URL;
if (!root || !app)
  throw new Error(
    "Configure private FORMA_PG_TEST_ROOT_URL and FORMA_PG_TEST_APP_URL for a disposable local test database",
  );
for (const text of [root, app])
  if (!["127.0.0.1", "localhost"].includes(new URL(text).hostname))
    throw new Error("PostgreSQL workflow tests may target loopback only");
const pool = new Pool({ connectionString: root, max: 1 });
const user = new URL(app).username;
if (!/^[a-z_]+$/.test(user)) throw new Error("Unexpected test database user");
let failed = false;
try {
  for (const file of [
    "workflows",
    "ai-workflows",
    "provider-budget",
    "operator-worker",
    "payments",
  ]) {
    const schema = `forma_test_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${user}`);
    try {
      const url = new URL(app);
      url.searchParams.set("options", `-csearch_path=${schema}`);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        FORMA_TEST_DATABASE_URL: url.toString(),
      };
      for (const key of Object.keys(env))
        if (
          /^(OPENAI_|PROVIDER_|MAX_|APP_|DATABASE_URL$|LOCAL_|LIVE_|ALLOW_|OPERATOR_|PROCESS_ROLE$)/.test(
            key,
          )
        )
          delete env[key];
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "--import",
            "./tests/setup.mjs",
            "--test",
            `tests/${file}.test.ts`,
          ],
          { cwd: process.cwd(), env, stdio: "inherit", windowsHide: true },
        );
        child.on("error", reject);
        child.on("exit", resolve);
      });
      if (code !== 0) failed = true;
    } finally {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    }
  }
} finally {
  await pool.end();
}
if (failed) process.exit(1);
console.log(
  "PASS: PostgreSQL workflow suites completed with isolated schemas; no owner data was used.",
);
