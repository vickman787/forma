import { z } from "zod";
import { database } from "../../lib/db";
import { config } from "../../lib/config";
import { briefSchema, canonical } from "../../lib/domain";
import { contentSchema, validateProviderResponse } from "../../lib/provider";
import { checkBusinessFacts } from "../../lib/checks";
import { quote, createOrder, enqueue, ownedOrder } from "../../lib/orders";
import { hash, now, after, event } from "../../lib/security";

// Server/CLI only: reuse a saved response for its exact original brief.
// No API endpoint accepts provider output or changes a project's engine.
const savedSchema = z.object({
  brief: briefSchema,
  briefHash: z.string(),
  content: contentSchema,
  requestId: z.string().min(1),
  model: z.string().min(1),
  usage: z.unknown(),
  researchEvidence: z
    .object({
      briefHash: z.string(),
      response: z.record(z.string(), z.unknown()),
    })
    .optional(),
});
export async function replaySavedResponse(owner: string, input: unknown) {
  if (config().mode !== "demo")
    throw new Error("Saved response replay is demo-only.");
  const saved = savedSchema.parse(input);
  if (saved.briefHash !== hash(canonical(saved.brief)))
    throw new Error("Saved response does not match its original brief.");
  if (saved.brief.service === "market_report") {
    const evidence = saved.researchEvidence;
    if (
      !evidence ||
      evidence.briefHash !== saved.briefHash ||
      evidence.response.id !== saved.requestId
    )
      throw new Error(
        "Research replay requires matching original raw search evidence.",
      );
    const checked = validateProviderResponse(evidence.response, true);
    if (canonical(checked) !== canonical(saved.content))
      throw new Error(
        "Saved report content differs from the verified provider response.",
      );
  }
  checkBusinessFacts(saved.brief, saved.content);
  const db = await database();
  const [customer] = await db.query("SELECT id FROM customers WHERE id=$1", [
    owner,
  ]);
  if (!customer) throw new Error("Choose an existing demo workspace.");
  const q = await quote(owner, saved.brief);
  await db.query(
    "UPDATE generation_plans SET engine='saved_openai' WHERE quote_id=$1",
    [q.id],
  );
  const order = await createOrder(owner, q.id);
  await db.transaction(async (tx) => {
    await enqueue(tx, order.id);
    await tx.query(
      "UPDATE jobs SET provider_output=$1,provider_request_id=$2,usage=$3 WHERE order_id=$4",
      [
        JSON.stringify(saved.content),
        saved.requestId,
        JSON.stringify({
          model: saved.model,
          usage: saved.usage,
          replay: true,
        }),
        order.id,
      ],
    );
    await tx.query(
      "UPDATE orders SET payment='funded',work='queued',delivery_due=$1,updated_at=$2 WHERE id=$3",
      [after(86400000), now(), order.id],
    );
    await event(
      tx,
      order.id,
      "generate",
      "Reusing a saved OpenAI response for its original brief. No new API call; payment simulated.",
    );
  });
  return ownedOrder(order.id, owner);
}
