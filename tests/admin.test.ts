import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { database } from "../lib/db";
import { blankBrief } from "../lib/domain";
import { quote, createOrder } from "../lib/orders";
import { createSession } from "../lib/security";
import { POST } from "../app/api/[...path]/route";
import { supportEmail } from "../lib/support";

test("only the configured owner can resolve support; repeats do not change payment or deadlines", async () => {
  Object.assign(process.env, {
    APP_MODE: "demo",
    GENERATION_PROVIDER: "template",
    DATA_DIRECTORY: `.forma/test-admin-${randomUUID()}`,
    APP_URL: "http://127.0.0.1:3000",
    SESSION_SECRET: "isolated-test-session-secret-at-least-32-characters",
  });
  if (process.env.FORMA_TEST_DATABASE_URL)
    process.env.DATABASE_URL = process.env.FORMA_TEST_DATABASE_URL;
  else delete process.env.DATABASE_URL;
  const db = await database(),
    owner = randomUUID(),
    customer = randomUUID(),
    wallet = `0x${"11".repeat(20)}`;
  process.env.ADMIN_WALLETS = wallet;
  for (const [id, address] of [
    [owner, wallet],
    [customer, `0x${"22".repeat(20)}`],
  ])
    await db.query(
      "INSERT INTO customers(id,wallet,created_at) VALUES($1,$2,$3)",
      [id, address, new Date().toISOString()],
    );
  const q = await quote(customer, {
    ...blankBrief(),
    businessName: "Support fixture",
    description: "Approved business details for an isolated support test.",
    industry: "Services",
    location: "Lagos",
    audience: "Local customers",
    contact: "help@example.invalid",
  });
  const order = await createOrder(customer, q.id),
    issue = randomUUID();
  await db.query(
    "INSERT INTO issues(id,order_id,owner,description,created_at) VALUES($1,$2,$3,$4,$5)",
    [
      issue,
      order.id,
      customer,
      "The requested wording needs attention.",
      new Date().toISOString(),
    ],
  );
  const ownerCookie = (await createSession(owner)).split(";")[0],
    customerCookie = (await createSession(customer)).split(";")[0];
  const send = (cookie: string, id = issue) =>
    POST(
      new Request(`http://127.0.0.1:3000/api/admin/issues/${id}/resolve`, {
        method: "POST",
        headers: { cookie, origin: "http://127.0.0.1:3000" },
        body: "{}",
      }),
      { params: Promise.resolve({ path: ["admin", "issues", id, "resolve"] }) },
    );
  assert.equal((await send("")).status, 401);
  assert.equal((await send(customerCookie)).status, 403);
  assert.equal((await send(ownerCookie, randomUUID())).status, 404);
  assert.equal((await send(ownerCookie)).status, 200);
  assert.equal((await send(ownerCookie)).status, 200);
  assert.equal(
    (await db.query("SELECT status FROM issues WHERE id=$1", [issue]))[0]
      .status,
    "resolved",
  );
  const [after] = await db.query(
    "SELECT payment,review_due FROM orders WHERE id=$1",
    [order.id],
  );
  assert.equal(after.payment, order.payment);
  assert.equal(after.review_due, order.review_due);
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT COUNT(*) AS count FROM events WHERE order_id=$1 AND stage='support'",
          [order.id],
        )
      )[0].count,
    ),
    1,
  );
  process.env.SUPPORT_EMAIL = "help@example.invalid";
  assert.equal(supportEmail(), "help@example.invalid");
  process.env.SUPPORT_EMAIL = "help@example.invalid?bcc=someone";
  assert.equal(supportEmail(), null);
});
