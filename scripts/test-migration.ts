/** Disposable loopback-only cutover verification. Never opens the owner's SQLite file. */
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { randomUUID, createHash } from "node:crypto";
import { readFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
const root = process.env.FORMA_PG_TEST_ROOT_URL,
  app = process.env.FORMA_PG_TEST_APP_URL;
if (
  !root ||
  !app ||
  [root, app].some(
    (v) => !["127.0.0.1", "localhost"].includes(new URL(v).hostname),
  )
)
  throw new Error("Disposable loopback PostgreSQL URLs required");
const schema = `forma_test_${randomUUID().replaceAll("-", "")}`;
const user = new URL(app).username;
if (!/^[a-z_]+$/.test(user)) throw new Error("Unexpected test user");
const directory = path.resolve(".forma", `test-migration-${randomUUID()}`);
if (path.dirname(directory) !== path.resolve(".forma"))
  throw new Error("Unsafe test directory");
await mkdir(directory);
const file = path.join(directory, "source.sqlite");
const source = new DatabaseSync(file);
source.exec(await readFile("migrations/001_initial.sql", "utf8"));
source.exec(`
 INSERT INTO customers VALUES('customer','0xfixture','2026-11-25');
 INSERT INTO sessions VALUES('old-session','customer','2099-01-01','live');
 INSERT INTO quotes VALUES('quote','customer','{}','brief','terms','1000000','2099-01-01','live');
 INSERT INTO generation_plans VALUES('quote','openai');
 INSERT INTO orders(id,owner,quote_id,mode,brief,work,payment,created_at,updated_at,funding_expires,chain_job) VALUES('order','customer','quote','live','{}','running','funded','2026-11-25','2026-11-25','2099-01-01','chain-job');
 INSERT INTO jobs(id,order_id,status,stage,provider_started,lease_token,lease_until) VALUES('job','order','running','generate',1,'old-lease','2099-01-01');
 INSERT INTO provider_responses VALUES('job','{"id":"saved-response"}','2026-11-25');
 INSERT INTO artifacts VALUES('artifact','order','index.html','text/html',123,'saved-sha256','artifacts/order/v1/index.html',1);
 INSERT INTO provider_budgets VALUES('approved-budget',1000000,100000);
 INSERT INTO provider_budget_reservations VALUES('reserved','approved-budget',100000,'2026-11-25');
 INSERT INTO provider_order_reservations VALUES('order','reserved');
 INSERT INTO operator_policies VALUES('approved-policy','10000000000000000','700000000000000');
 INSERT INTO operator_tasks(id,order_id,action,status,policy_id,gas_reserved_wei,nonce,operator_address,tx_hash,signed_tx,created_at,updated_at) VALUES('task','order','create','broadcast','approved-policy','350000000000000',1,'operator','hash','fixture-signed-bytes','2026-11-25','2026-11-25');
`);
source.close();
const digest = async () =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
const before = await digest();
const pool = new Pool({ connectionString: root, max: 1 });
let target: Pool | undefined;
try {
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`GRANT USAGE,CREATE ON SCHEMA ${schema} TO ${user}`);
  const url = new URL(app);
  url.searchParams.set("options", `-csearch_path=${schema}`);
  const env = {
    ...process.env,
    DATABASE_URL: url.toString(),
    SOURCE_SQLITE_PATH: file,
    OPENAI_API_KEY: "",
    FORMA_DEPLOYER_PRIVATE_KEY: "",
  };
  const migrate = () =>
    promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/migrate-sqlite-to-pg.ts",
        "--source-stopped",
      ],
      { env, windowsHide: true, timeout: 60000 },
    );
  await migrate();
  target = new Pool({ connectionString: url.toString(), max: 1 });
  const rows = async (sql: string) => (await target!.query(sql)).rows;
  assert.equal(
    (await rows("SELECT COUNT(*) AS count FROM orders"))[0].count,
    "1",
  );
  assert.deepEqual(
    (
      await rows(
        "SELECT status,provider_started,lease_token,lease_until FROM jobs",
      )
    )[0],
    {
      status: "queued",
      provider_started: 1,
      lease_token: null,
      lease_until: null,
    },
  );
  assert.equal(
    JSON.parse(
      (await rows("SELECT response FROM provider_responses"))[0].response,
    ).id,
    "saved-response",
  );
  assert.equal(
    (await rows("SELECT reserved_microusd FROM provider_budgets"))[0]
      .reserved_microusd,
    100000,
  );
  assert.equal(
    (await rows("SELECT reserved_wei FROM operator_policies"))[0].reserved_wei,
    "700000000000000",
  );
  assert.equal(
    (await rows("SELECT signed_tx FROM operator_tasks"))[0].signed_tx,
    "fixture-signed-bytes",
  );
  assert.equal(
    (await rows("SELECT sha256 FROM artifacts"))[0].sha256,
    "saved-sha256",
  );
  assert.equal(
    (await rows("SELECT COUNT(*) AS count FROM sessions"))[0].count,
    "0",
  );
  await assert.rejects(migrate, /Target is not empty/);
  assert.equal(
    (await rows("SELECT COUNT(*) AS count FROM orders"))[0].count,
    "1",
  );
  assert.equal(await digest(), before);
  console.log(
    "PASS: SQLite-to-PostgreSQL cutover preserves projects, saved responses, transaction identity and both spending ledgers; source unchanged; repeat migration refused.",
  );
} finally {
  await target?.end();
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
  await rm(directory, { recursive: true, force: true });
}
