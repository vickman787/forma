import { database } from "../../lib/db";
import { config } from "../../lib/config";
import { ownedOrder, enqueue } from "../../lib/orders";
import { assert, now, after, event } from "../../lib/security";
import type { Brief } from "../../lib/domain";
import type { Content } from "../../lib/provider";
import { runOne as workerRunOne } from "../../worker/index";
export function templateContent(b: Brief): Content {
  return {
    headline: b.offer || b.businessName,
    body: b.description,
    scenes: [
      b.businessName,
      b.offer || b.description.slice(0, 140),
      b.location,
      b.cta,
    ],
    sections: [
      {
        title: "Your research question",
        text: b.question || b.description,
        sourceUrls: [],
        inference: true,
      },
      {
        title: "A practical next step",
        text: `Speak with customers in ${b.location} about their priorities. Compare the answers before changing your offer. This is a planning suggestion, not a researched market finding.`,
        sourceUrls: [],
        inference: true,
      },
    ],
    sources: [],
    limitations:
      "DEMO TEMPLATE: No OpenAI request or web research was performed. No market statistics or competitor claims have been verified. This file demonstrates the report layout and is not a purchased research report.",
  };
}

export async function simulateFunding(id: string, owner: string) {
  assert(config().fixtures, 403, "Test fixtures are unavailable.");
  const db = await database();
  return db.transaction(async (tx) => {
    const o = await ownedOrder(id, owner, tx);
    if (o.payment === "funded") return o;
    assert(
      o.payment === "unfunded" && o.work === "awaiting_funding",
      409,
      "This order cannot be funded.",
    );
    assert(
      o.funding_expires > now(),
      409,
      "Quote expired. Create a new quote.",
    );
    await tx.query(
      "UPDATE orders SET payment=$1,work=$2,delivery_due=$3,updated_at=$4 WHERE id=$5",
      ["funded", "queued", after(86400000), now(), id],
    );
    await enqueue(tx, id);
    if (o.generation === "template")
      await tx.query("UPDATE jobs SET provider_output=$1 WHERE order_id=$2", [
        JSON.stringify(templateContent(o.brief)),
        id,
      ]);
    await event(
      tx,
      id,
      "payment",
      "Simulated payment confirmed — no funds moved.",
    );
    return ownedOrder(id, owner, tx);
  });
}

export async function simulateAccept(id: string, owner: string) {
  assert(config().fixtures, 403, "Test fixtures are unavailable.");
  const db = await database();
  return db.transaction(async (tx) => {
    const o = await ownedOrder(id, owner, tx);
    if (o.payment === "released") return o;
    assert(
      o.work === "delivered" && o.payment === "funded",
      409,
      "Only a delivered, funded project can be accepted.",
    );
    await tx.query(
      "UPDATE orders SET work=$1,payment=$2,updated_at=$3 WHERE id=$4",
      ["closed", "released", now(), id],
    );
    await event(
      tx,
      id,
      "accepted",
      "Delivery accepted in demo mode. No funds moved.",
    );
    return ownedOrder(id, owner, tx);
  });
}

// A separate test fixture represents an already confirmed delivery receipt.
export async function runOne() {
  assert(config().fixtures, 403, "Test fixtures are unavailable");
  const result = await workerRunOne();
  const db = await database();
  await db.query(
    "UPDATE orders SET work='delivered',review_due=$1 WHERE mode='demo' AND work='checking'",
    [after(48 * 3600000)],
  );
  return result;
}
