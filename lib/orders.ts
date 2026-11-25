import { randomUUID } from "node:crypto";
import { database, type DB } from "./db";
import { config } from "./config";
import { briefSchema, canonical, terms, type Order } from "./domain";
import { hash, assert, now, after, event } from "./security";
import { queueOperator } from "./operator-outbox";
export function parseOrder(r: any): Order {
  return {
    ...r,
    generation: r.generation || "openai",
    brief: typeof r.brief === "string" ? JSON.parse(r.brief) : r.brief,
    manifest:
      typeof r.manifest === "string" ? JSON.parse(r.manifest) : r.manifest,
  };
}
export async function ownedOrder(id: string, owner: string, db?: DB) {
  const [r] = await (db || (await database())).query(
    "SELECT o.*,(SELECT engine FROM generation_plans WHERE quote_id=o.quote_id) AS generation FROM orders o WHERE id=$1 AND owner=$2 AND mode=$3",
    [id, owner, config().mode],
  );
  assert(r, 404, "Project not found.");
  return parseOrder(r);
}
export async function quote(owner: string, input: unknown) {
  const b = briefSchema.parse(input);
  const db = await database();
  for (const id of b.assetIds) {
    const [a] = await db.query(
      "SELECT id FROM uploads WHERE id=$1 AND owner=$2",
      [id, owner],
    );
    assert(a, 400, "Asset does not belong to this workspace.");
  }
  const q = {
    id: randomUUID(),
    brief: b,
    briefHash: hash(canonical(b)),
    termsHash: hash(canonical(terms)),
    expires: after(30 * 60000),
    amount: terms.amount,
    terms,
  };
  await db.transaction(async (tx) => {
    await tx.query(
      "INSERT INTO quotes(id,owner,brief,brief_hash,terms_hash,amount,expires,mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        q.id,
        owner,
        JSON.stringify(b),
        q.briefHash,
        q.termsHash,
        q.amount,
        q.expires,
        config().mode,
      ],
    );
    await tx.query(
      "INSERT INTO generation_plans(quote_id,engine) VALUES($1,$2)",
      [q.id, config().generation],
    );
  });
  return q;
}
export async function createOrder(owner: string, quoteId: string) {
  const db = await database();
  return db.transaction(async (tx) => {
    const [existing] = await tx.query(
      "SELECT * FROM orders WHERE quote_id=$1 AND owner=$2",
      [quoteId, owner],
    );
    if (existing) return ownedOrder(existing.id, owner, tx);
    const [q] = await tx.query(
      "SELECT * FROM quotes WHERE id=$1 AND owner=$2 AND mode=$3 FOR UPDATE",
      [quoteId, owner, config().mode],
    );
    const [raced] = await tx.query(
      "SELECT * FROM orders WHERE quote_id=$1 AND owner=$2",
      [quoteId, owner],
    );
    if (raced) return ownedOrder(raced.id, owner, tx);
    assert(
      q && q.expires > now(),
      409,
      "This quote has expired. Review your brief for a fresh quote.",
    );
    const id = randomUUID(),
      chainJob = "0x" + hash(id);
    await tx.query(
      "INSERT INTO orders(id,owner,quote_id,mode,brief,work,payment,created_at,updated_at,funding_expires,chain_job) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10)",
      [
        id,
        owner,
        q.id,
        q.mode,
        q.brief,
        "awaiting_funding",
        "unfunded",
        now(),
        q.expires,
        chainJob,
      ],
    );
    await queueOperator(tx, id, "create");
    await event(tx, id, "brief", "Brief validated and quote saved.");
    return ownedOrder(id, owner, tx);
  });
}
export async function enqueue(db: DB, id: string) {
  await db.query(
    "INSERT INTO jobs(id,order_id,status,stage) VALUES($1,$2,$3,$4) ON CONFLICT(order_id) DO NOTHING",
    [randomUUID(), id, "queued", "validate"],
  );
  await event(db, id, "queued", "Project queued for the durable worker.");
}
