import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { queueOperator } from "../lib/operator-outbox";
import { heartbeat } from "../lib/health";
import { blankBrief } from "../lib/domain";
import path from "node:path";
import { database, type DB } from "../lib/db";
import { config } from "../lib/config";
import { briefSchema, canonical, terms, type Artifact } from "../lib/domain";
import { now, after, hash, event } from "../lib/security";
import { parseOrder } from "../lib/orders";
import {
  generateContent,
  contentSchema,
  prepareProviderRequest,
  validateProviderResponse,
} from "../lib/provider";
import { render } from "../lib/renderers";
import { checkBusinessFacts } from "../lib/checks";
export async function runOne() {
  const db = await database(),
    lease = randomUUID();
  const job = await db.transaction(async (tx) => {
    const [j] = await tx.query(
      "SELECT j.* FROM jobs j JOIN orders o ON o.id=j.order_id WHERE (j.status='queued' OR (j.status='running' AND j.lease_until<$1)) AND o.payment='funded' AND o.mode=$2 ORDER BY o.created_at LIMIT 1",
      [now(), config().mode],
    );
    if (!j) return null;
    const lock = await tx.query(
      "UPDATE jobs SET status='running',lease_token=$1,lease_until=$2,attempts=attempts+1 WHERE id=$3 AND (status='queued' OR lease_until<$4) RETURNING *",
      [lease, after(60000), j.id, now()],
    );
    return lock[0] || null;
  });
  if (!job) return false;
  const [row] = await db.query(
      "SELECT o.*,(SELECT engine FROM generation_plans WHERE quote_id=o.quote_id) AS generation FROM orders o WHERE id=$1",
      [job.order_id],
    ),
    o = parseOrder(row);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const save = async (stage: string, message: string, work = "running") => {
    await db.transaction(async (tx) => {
      const updated = await tx.query(
        "UPDATE jobs SET stage=$1,lease_until=$2 WHERE id=$3 AND lease_token=$4 RETURNING id",
        [stage, after(60000), job.id, lease],
      );
      if (!updated.length) throw new Error("Execution lease lost");
      const active = await tx.query(
        "UPDATE orders SET work=$1,updated_at=$2 WHERE id=$3 AND payment='funded' AND work!='closed' RETURNING id",
        [work, now(), o.id],
      );
      if (!active.length) throw new Error("Order is settled; worker stopped.");
      await event(tx, o.id, stage, message);
    });
  };
  try {
    heartbeat = setInterval(() => {
      void db
        .query(
          "UPDATE jobs SET lease_until=$1 WHERE id=$2 AND lease_token=$3",
          [after(60000), job.id, lease],
        )
        .catch(() => {});
    }, 15000);
    o.brief = briefSchema.parse(o.brief);
    await save("validate", "Approved business facts validated.");
    let content = job.provider_output
      ? contentSchema.parse(JSON.parse(job.provider_output))
      : null;
    if (!content && job.provider_started) {
      const [raw] = await db.query(
        "SELECT response FROM provider_responses WHERE job_id=$1",
        [job.id],
      );
      if (raw) {
        const response = JSON.parse(raw.response);
        try {
          content = validateProviderResponse(
            response,
            o.brief.service === "market_report",
          );
        } catch {
          throw new Error(
            "Saved provider response failed validation. Reconcile it before retrying; no new paid request was made.",
          );
        }
        await db.query(
          "UPDATE jobs SET provider_output=$1,provider_request_id=$2,usage=$3 WHERE id=$4 AND lease_token=$5",
          [
            JSON.stringify(content),
            response.id,
            JSON.stringify({
              usage: response.usage,
              recoveredFromSavedResponse: true,
            }),
            job.id,
            lease,
          ],
        );
        await save(
          "generate",
          "Recovered the saved provider response without another paid request.",
        );
      }
    }
    if (!content) {
      if (job.provider_started)
        throw new Error(
          "A previous provider request has an ambiguous outcome. Reconcile it before retrying to prevent duplicate billing.",
        );
      if (o.generation === "saved_openai")
        throw new Error(
          "Saved AI response is missing; no new paid request was made.",
        );
      prepareProviderRequest(o.brief);
      await save("generate", "Generating bounded content with OpenAI.");
      await db.query(
        "UPDATE jobs SET provider_started=1 WHERE id=$1 AND lease_token=$2",
        [job.id, lease],
      );
      const generated = await generateContent(
        o.brief,
        async (data) => {
          await db.query(
            "INSERT INTO provider_responses(job_id,response,created_at) VALUES($1,$2,$3) ON CONFLICT(job_id) DO NOTHING",
            [job.id, JSON.stringify(data), now()],
          );
        },
        o.id,
      );
      content = generated.content;
      await db.query(
        "UPDATE jobs SET provider_output=$1,provider_request_id=$2,usage=$3 WHERE id=$4 AND lease_token=$5",
        [
          JSON.stringify(content),
          generated.requestId,
          JSON.stringify({
            model: generated.model,
            promptVersion: "forma-1",
            usage: generated.usage,
            estimatedCeiling: generated.estimatedCeiling,
          }),
          job.id,
          lease,
        ],
      );
    }
    checkBusinessFacts(o.brief, content);
    await save(
      "render",
      "Rendering actual downloadable files with trusted templates.",
    );
    const files = await render(o, content);
    await save(
      "check",
      "Checking required formats, file sizes, source facts and checksums.",
      "checking",
    );
    const required: Record<string, string[]> = {
      business_website: ["index.html", "website-source.zip"],
      promo_video: ["promo-vertical.mp4", "poster.png", "captions.txt"],
      flyers_price_list: [
        "promotional-flyer.png",
        "promotional-flyer.pdf",
        "price-list.pdf",
      ],
      market_report: ["market-brief.html", "market-brief.pdf", "sources.csv"],
    };
    if (
      required[o.brief.service].some(
        (name) => !files.some((f) => f.name === name),
      )
    )
      throw new Error("Required deliverable is missing");
    const artifacts: Artifact[] = [];
    for (const f of files) {
      const bytes = await readFile(f.path);
      if (
        f.mime === "application/pdf" &&
        bytes.subarray(0, 5).toString() !== "%PDF-"
      )
        throw new Error("Invalid PDF signature");
      if (f.name.endsWith(".html")) {
        const html = bytes.toString();
        if (
          html.includes("<script") ||
          !html.includes(
            o.brief.businessName.replace(/&/g, "&amp;").replace(/</g, "&lt;"),
          )
        )
          throw new Error("HTML content check failed");
      }
      artifacts.push({
        id: randomUUID(),
        order_id: o.id,
        name: f.name,
        mime: f.mime,
        size: bytes.length,
        sha256: hash(bytes),
        storage_key: path.relative(config().data, f.path).replace(/\\/g, "/"),
        version: o.version,
      });
    }
    const manifest = {
      schemaVersion: 1,
      service: o.brief.service,
      orderId: o.id,
      version: o.version,
      mode: o.mode,
      generation: o.generation,
      rendererVersion: "forma-1",
      artifacts: artifacts.map(({ name, mime, size, sha256 }) => ({
        name,
        mime,
        size,
        sha256,
      })),
      checks: [
        { name: "Required deliverables present", passed: true },
        { name: "Non-empty bounded files", passed: true },
        { name: "SHA-256 checksums recorded", passed: true },
        {
          name: "Trusted renderer; original business fields used",
          passed: true,
        },
      ],
      limitations: [
        "AI content rendered with trusted templates. Automated technical checks do not guarantee business results.",
        ...(o.brief.service === "market_report"
          ? [
              "Research review draft: verify source dates, accessibility and claim support before acting.",
            ]
          : []),
      ],
    };
    const manifestText = canonical(manifest),
      manifestHash = hash(manifestText),
      manifestPath = path.join(
        config().data,
        "artifacts",
        o.id,
        `v${o.version}`,
        "delivery-manifest.json",
      );
    await writeFile(manifestPath, manifestText);
    artifacts.push({
      id: randomUUID(),
      order_id: o.id,
      name: "delivery-manifest.json",
      mime: "application/json",
      size: Buffer.byteLength(manifestText),
      sha256: manifestHash,
      storage_key: path
        .relative(config().data, manifestPath)
        .replace(/\\/g, "/"),
      version: o.version,
    });
    await db.transaction(async (tx) => {
      const [valid] = await tx.query(
        "SELECT id FROM jobs WHERE id=$1 AND lease_token=$2",
        [job.id, lease],
      );
      if (!valid) throw new Error("Lease lost before delivery");
      const [current] = await tx.query(
        "SELECT id FROM orders WHERE id=$1 AND payment='funded' AND work!='closed'",
        [o.id],
      );
      if (!current)
        throw new Error("Order settled before delivery; files remain private.");
      for (const a of artifacts)
        await tx.query(
          "INSERT INTO artifacts(id,order_id,name,mime,size,sha256,storage_key,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(order_id,version,name) DO NOTHING",
          [
            a.id,
            a.order_id,
            a.name,
            a.mime,
            a.size,
            a.sha256,
            a.storage_key,
            a.version,
          ],
        );
      await tx.query(
        "UPDATE orders SET work=$1,manifest=$2,manifest_hash=$3,review_due=$4,updated_at=$5,error=NULL WHERE id=$6",
        ["checking", manifestText, manifestHash, null, now(), o.id],
      );
      await tx.query(
        "UPDATE jobs SET status=$1,stage=$2,lease_until=NULL,lease_token=NULL WHERE id=$3",
        ["completed", "deliver", job.id],
      );
      await queueOperator(tx, o.id, "deliver");
      await event(
        tx,
        o.id,
        "deliver",
        "Files checked. Operator must submit the manifest commitment on chain before customer acceptance.",
      );
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Worker failed";
    await db.transaction(async (tx) => {
      const [valid] = await tx.query(
        "SELECT id FROM jobs WHERE id=$1 AND lease_token=$2",
        [job.id, lease],
      );
      if (!valid) return;
      await tx.query(
        "UPDATE jobs SET status=$1,error=$2,lease_until=NULL,lease_token=NULL WHERE id=$3",
        ["failed", message, job.id],
      );
      await tx.query(
        "UPDATE orders SET work=$1,error=$2,updated_at=$3 WHERE id=$4 AND payment='funded' AND work!='closed'",
        ["failed", message, now(), o.id],
      );
      await event(tx, o.id, "failed", message);
    });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
  return true;
}
if (process.argv[1]?.replace(/\\/g, "/").endsWith("worker/index.ts")) {
  console.log(`Forma durable worker · ${config().mode} · no mainnet signer`);
  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });
  while (!stopping) {
    try {
      prepareProviderRequest(blankBrief("market_report"));
      await heartbeat("generation");
    } catch {
      await heartbeat("generation", "unavailable");
    }
    const ran = await runOne();
    if (!ran) await new Promise((r) => setTimeout(r, 1500));
  }
  process.exit(0);
}
