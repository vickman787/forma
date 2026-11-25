import { NextResponse } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { verifyMessage, isAddress, getAddress } from "viem";
import { z } from "zod";
import { config } from "@/lib/config";
import {
  operatorPlan,
  operatorActions,
  type OperatorAction,
} from "@/lib/operator";
import { availability } from "@/lib/capabilities";
import { checkoutReadiness } from "@/lib/health";
import { previewUrl } from "@/lib/preview";
import { database } from "@/lib/db";
import { services, terms, brandKitSchema } from "@/lib/domain";
import {
  hash,
  assert,
  after,
  now,
  checkOrigin,
  rateLimit,
  requireSession,
  getSession,
  createSession,
  HttpError,
  event,
} from "@/lib/security";
import { quote, createOrder, ownedOrder, parseOrder } from "@/lib/orders";
import {
  reconcilePayment,
  reconcileDecision,
  reconcileDelivery,
  paymentInfo,
  recordPendingPayment,
} from "@/lib/payments";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function jsonBody(req: Request) {
  const reader = req.body?.getReader();
  assert(reader, 400, "A JSON body is required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 32768) {
        await reader.cancel();
        throw new HttpError(413, "Request body is too large");
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}
async function handler(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
) {
  try {
    checkOrigin(req);
    const parts = (await ctx.params).path,
      route = parts.join("/"),
      method = req.method,
      c = config();
    const json = (data: unknown, status = 200, headers?: HeadersInit) =>
      NextResponse.json(data, {
        status,
        headers: { "Cache-Control": "no-store", ...headers },
      });
    if (route === "health") {
      await (await database()).query("SELECT 1 AS ready");
      return json({ ok: true, mode: c.mode });
    }
    if (route === "services") {
      const listed = services.map((s) => ({ ...s, ...availability(s.id) }));
      const readiness = listed.some((s) => s.enabled)
        ? await checkoutReadiness(true)
        : { enabled: true, reason: null };
      return json({
        services: listed.map((s) =>
          s.enabled && !readiness.enabled ? { ...s, ...readiness } : s,
        ),
        mode: c.mode,
        liveEnabled: c.liveEnabled,
        generation: c.generation,
        provider: "Forma",
      });
    }
    if (route === "auth/session") {
      const s = await getSession(req);
      return json({
        authenticated: !!s,
        mode: c.mode,
        generation: c.generation,
        liveEnabled: c.liveEnabled,
        generationAuthorized: process.env.ALLOW_PAID_API_CALLS === "true",
        wallet: s?.wallet,
        workspaceId: s?.owner,
        admin: !!s?.wallet && adminWallet(s.wallet),
      });
    }
    if (route === "auth/logout" && method === "POST") {
      const s = await getSession(req);
      if (s)
        await (
          await database()
        ).query("DELETE FROM sessions WHERE token_hash=$1", [s.token_hash]);
      return json({ ok: true }, 200, {
        "Set-Cookie":
          "forma_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      });
    }
    if (route === "auth/nonce" && method === "POST") {
      await rateLimit("wallet-auth", 60);
      const { wallet } = await jsonBody(req);
      assert(isAddress(wallet), 400, "Invalid wallet address");
      const id = randomBytes(16).toString("hex"),
        expires = after(5 * 60000),
        address = getAddress(wallet),
        domain = new URL(c.appUrl).host;
      const message = `${domain} wants you to sign in to Forma with your Ethereum account:\n${address}\n\nSign in to your private business studio. No transaction is requested.\n\nURI: ${c.appUrl}\nVersion: 1\nChain ID: 1990\nNonce: ${id}\nIssued At: ${now()}\nExpiration Time: ${expires}`;
      await (
        await database()
      ).query(
        "INSERT INTO nonces(id,wallet,message,expires) VALUES($1,$2,$3,$4)",
        [id, address.toLowerCase(), message, expires],
      );
      return json({ nonce: id, message });
    }
    if (route === "auth/verify" && method === "POST") {
      await rateLimit("wallet-verify", 60);
      const { nonce, signature } = await jsonBody(req),
        db = await database();
      const [n] = await db.query(
        "SELECT * FROM nonces WHERE id=$1 AND consumed=0 AND expires>$2",
        [nonce, now()],
      );
      assert(n, 401, "Sign-in request expired or was already used.");
      assert(
        await verifyMessage({
          address: n.wallet,
          message: n.message,
          signature,
        }),
        401,
        "Signature verification failed",
      );
      const owner = await db.transaction(async (tx) => {
        const consumed = await tx.query(
          "UPDATE nonces SET consumed=1 WHERE id=$1 AND consumed=0 RETURNING id",
          [nonce],
        );
        assert(consumed.length, 401, "Nonce already used");
        const [customer] = await tx.query(
          "SELECT id FROM customers WHERE wallet=$1",
          [n.wallet],
        );
        if (customer) return customer.id;
        const id = randomUUID();
        await tx.query(
          "INSERT INTO customers(id,wallet,created_at) VALUES($1,$2,$3)",
          [id, n.wallet, now()],
        );
        return id;
      });
      return json({ ok: true }, 200, {
        "Set-Cookie": await createSession(owner),
      });
    }
    const session = await requireSession(req),
      owner = session.owner,
      db = await database();
    if (method !== "GET") await rateLimit(`${owner}:${parts[0]}`, 40);
    if (route === "brand-kit") {
      if (method === "GET") {
        const [r] = await db.query("SELECT * FROM brand_kits WHERE owner=$1", [
          owner,
        ]);
        return json(r ? { ...r, data: JSON.parse(r.data) } : null);
      }
      if (method === "PUT") {
        const data = brandKitSchema.parse(await jsonBody(req));
        for (const id of data.assetIds) {
          const [asset] = await db.query(
            "SELECT id FROM uploads WHERE id=$1 AND owner=$2",
            [id, owner],
          );
          assert(asset, 400, "Brand kit asset does not belong to this account");
        }
        assert(
          JSON.stringify(data).length < 15000,
          400,
          "Brand kit is too large",
        );
        await db.query(
          "INSERT INTO brand_kits(owner,data) VALUES($1,$2) ON CONFLICT(owner) DO UPDATE SET data=$2,version=brand_kits.version+1",
          [owner, JSON.stringify(data)],
        );
        return json({ ok: true });
      }
    }
    if (parts[0] === "drafts") {
      const service = z
        .enum([
          "business_website",
          "promo_video",
          "flyers_price_list",
          "market_report",
        ])
        .parse(parts[1]);
      if (method === "GET") {
        const [r] = await db.query(
          "SELECT data FROM drafts WHERE owner=$1 AND service=$2",
          [owner, service],
        );
        return json(r ? JSON.parse(r.data) : null);
      }
      if (method === "PUT") {
        const data = JSON.stringify(await jsonBody(req));
        assert(data.length < 20000, 413, "Draft too large");
        JSON.parse(data);
        await db.query(
          "INSERT INTO drafts(owner,service,data,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(owner,service) DO UPDATE SET data=$3,updated_at=$4",
          [owner, service, data, now()],
        );
        return json({ ok: true });
      }
    }
    if (route === "uploads" && method === "POST") {
      const form = await req.formData(),
        file = form.get("file");
      assert(file instanceof File, 400, "Choose a PNG or JPG file");
      assert(file.size <= 5 * 1024 * 1024, 413, "Maximum upload size is 5 MB");
      assert(
        ["image/png", "image/jpeg"].includes(file.type),
        400,
        "Only PNG and JPEG are supported",
      );
      const input = Buffer.from(await file.arrayBuffer());
      assert(
        input.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" ||
          input.subarray(0, 3).toString("hex") === "ffd8ff",
        400,
        "Invalid image content",
      );
      let normalized: Buffer;
      try {
        const meta = await sharp(input, {
          limitInputPixels: 24000000,
        }).metadata();
        assert(
          ["png", "jpeg"].includes(meta.format || ""),
          400,
          "Invalid image content",
        );
        normalized = await sharp(input, { limitInputPixels: 24000000 })
          .rotate()
          .resize(1920, 1920, { fit: "inside", withoutEnlargement: true })
          .png()
          .toBuffer();
      } catch {
        throw new HttpError(
          400,
          "Image could not be decoded safely. Choose a valid PNG or JPEG.",
        );
      }
      const id = randomUUID(),
        key = `uploads/${id}.png`,
        dir = path.join(c.data, "uploads");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(c.data, key), normalized);
      await db.query(
        "INSERT INTO uploads(id,owner,storage_key,mime,name) VALUES($1,$2,$3,$4,$5)",
        [id, owner, key, "image/png", file.name.slice(0, 120)],
      );
      return json({ id, name: file.name });
    }
    if (route === "quotes" && method === "POST")
      return json(await quote(owner, await jsonBody(req)), 201);
    if (route === "orders" && method === "POST") {
      const { quoteId } = await jsonBody(req);
      return json(
        await createOrder(owner, z.string().uuid().parse(quoteId)),
        201,
      );
    }
    if (route === "orders" && method === "GET")
      return json(
        (
          await db.query(
            "SELECT o.*,(SELECT engine FROM generation_plans WHERE quote_id=o.quote_id) AS generation FROM orders o WHERE owner=$1 AND mode=$2 ORDER BY created_at DESC",
            [owner, c.mode],
          )
        ).map(parseOrder),
      );
    if (parts[0] === "orders" && parts[1]) {
      const id = z.string().uuid().parse(parts[1]),
        o = await ownedOrder(id, owner);
      if (parts.length === 2 && method === "GET") return json(o);
      if (parts[2] === "events" && method === "GET")
        return json(
          await db.query(
            "SELECT id,stage,message,created_at FROM events WHERE order_id=$1 ORDER BY created_at,id",
            [id],
          ),
        );
      if (parts[2] === "artifacts" && method === "GET")
        return json(
          (
            await db.query(
              "SELECT id,name,mime,size,sha256,version FROM artifacts WHERE order_id=$1 ORDER BY name",
              [id],
            )
          ).map((a) => ({
            ...a,
            previewUrl: a.mime.startsWith("text/html")
              ? previewUrl(a.id)
              : undefined,
          })),
        );
      if (parts[2] === "payment-info" && method === "GET")
        return json(await paymentInfo(o));
      if (parts[2] === "payment-record" && method === "POST")
        return json(
          await recordPendingPayment(o, (await jsonBody(req)).txHash),
        );
      if (parts[2] === "payment-sync" && method === "POST") {
        assert(
          c.mode === "live",
          409,
          "Real settlement configuration is required.",
        );
        return json(await reconcilePayment(o, (await jsonBody(req)).txHash));
      }
      if (parts[2] === "delivery-sync" && method === "POST") {
        assert(
          c.mode === "live",
          409,
          "Real settlement configuration is required.",
        );
        return json(await reconcileDelivery(o, (await jsonBody(req)).txHash));
      }
      if (parts[2] === "decision-sync" && method === "POST") {
        assert(
          c.mode === "live",
          409,
          "Real settlement configuration is required.",
        );
        return json(await reconcileDecision(o, (await jsonBody(req)).txHash));
      }
      if (parts[2] === "issues" && method === "POST") {
        const { description } = z
          .object({ description: z.string().trim().min(10).max(3000) })
          .parse(await jsonBody(req));
        await db.query(
          "INSERT INTO issues(id,order_id,owner,description,created_at) VALUES($1,$2,$3,$4,$5)",
          [randomUUID(), id, owner, description, now()],
        );
        await event(
          db,
          id,
          "issue",
          "Customer reported a problem. Review deadline remains unchanged.",
        );
        return json({ ok: true }, 201);
      }
    }
    if (parts[0] === "files" && parts[1] && method === "GET") {
      const [a] = await db.query(
        "SELECT a.* FROM artifacts a JOIN orders o ON a.order_id=o.id WHERE a.id=$1 AND o.owner=$2 AND o.mode=$3",
        [parts[1], owner, c.mode],
      );
      assert(a, 404, "File not found");
      const bytes = await readFile(path.join(c.data, a.storage_key));
      assert(hash(bytes) === a.sha256, 500, "Artifact checksum mismatch");
      const preview = new URL(req.url).searchParams.get("preview") === "1";
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": a.mime,
          "Content-Length": String(bytes.length),
          "Cache-Control": "private, no-store",
          "Content-Disposition": `${preview ? "inline" : "attachment"}; filename="${a.name}"`,
          "Content-Security-Policy":
            "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (
      parts[0] === "admin" &&
      parts[1] === "operator" &&
      parts[2] &&
      parts[3] === "plan" &&
      method === "GET"
    ) {
      assert(
        session.wallet && adminWallet(session.wallet),
        403,
        "Owner access required",
      );
      const action = new URL(req.url).searchParams.get(
        "action",
      ) as OperatorAction;
      assert(operatorActions.includes(action), 400, "Unknown operator action");
      const [row] = await db.query(
        "SELECT * FROM orders WHERE id=$1 AND mode=$2",
        [parts[2], c.mode],
      );
      assert(row, 404, "Order not found");
      const [q] = await db.query(
        "SELECT q.terms_hash,c.wallet FROM quotes q JOIN customers c ON c.id=q.owner WHERE q.id=$1 AND q.owner=$2",
        [row.quote_id, row.owner],
      );
      assert(q, 404, "Owned quote not found");
      try {
        return json(
          operatorPlan(parseOrder(row), q, action, {
            escrow: process.env.ESCROW_ADDRESS || "",
            operator: process.env.OPERATOR_ADDRESS || "",
          }),
        );
      } catch (e) {
        throw new HttpError(
          409,
          e instanceof Error ? e.message : "Operator plan unavailable",
        );
      }
    }
    if (
      parts[0] === "admin" &&
      parts[1] === "issues" &&
      parts[3] === "resolve" &&
      parts.length === 4 &&
      method === "POST"
    ) {
      assert(
        session.wallet && adminWallet(session.wallet),
        403,
        "Owner access required",
      );
      const issueId = z.uuid().parse(parts[2]);
      await db.transaction(async (tx) => {
        const [issue] = await tx.query(
          "SELECT i.id,i.order_id,i.status FROM issues i JOIN orders o ON o.id=i.order_id WHERE i.id=$1 AND o.mode=$2",
          [issueId, c.mode],
        );
        assert(issue, 404, "Issue not found");
        if (issue.status === "resolved") return;
        await tx.query("UPDATE issues SET status='resolved' WHERE id=$1", [
          issueId,
        ]);
        await event(
          tx,
          issue.order_id,
          "support",
          "The studio marked the problem report resolved. Payment and review deadlines are unchanged.",
        );
      });
      return json({ resolved: true });
    }
    if (route === "admin/jobs" && method === "GET") {
      assert(
        session.wallet && adminWallet(session.wallet),
        403,
        "Owner access required",
      );
      const [jobs, liabilities, issues, operations, workers, operatorTasks] =
        await Promise.all([
          db.query(
            "SELECT j.*,o.mode,o.work,o.payment,o.created_at FROM jobs j JOIN orders o ON j.order_id=o.id WHERE o.mode=$1 ORDER BY o.created_at DESC LIMIT 100",
            [c.mode],
          ),
          db.query(
            "SELECT payment,COUNT(*) AS count FROM orders WHERE mode=$1 GROUP BY payment",
            [c.mode],
          ),
          db.query(
            "SELECT i.id,i.order_id,i.description,i.created_at,i.status FROM issues i JOIN orders o ON o.id=i.order_id WHERE i.status='open' AND o.mode=$1",
            [c.mode],
          ),
          db.query(
            "SELECT id,mode,work,payment,funding_expires,delivery_due,review_due,manifest_hash FROM orders WHERE mode=$1 AND payment NOT IN ('released','refunded') ORDER BY created_at DESC LIMIT 100",
            [c.mode],
          ),
          db.query("SELECT role,state,detail,updated_at FROM worker_health"),
          db.query(
            "SELECT t.id,t.order_id,t.action,t.status,t.error,t.tx_hash,t.policy_id FROM operator_tasks t JOIN orders o ON o.id=t.order_id WHERE o.mode=$1 ORDER BY t.created_at DESC LIMIT 100",
            [c.mode],
          ),
        ]);
      return json({
        jobs,
        liabilities,
        issues,
        operations,
        workers,
        operatorTasks,
      });
    }
    throw new HttpError(404, "Endpoint not found");
  } catch (e) {
    if (e instanceof SyntaxError)
      return NextResponse.json(
        { error: "Invalid JSON request body" },
        { status: 400 },
      );
    if (e instanceof z.ZodError)
      return NextResponse.json(
        { error: "Please check your brief.", fields: e.flatten().fieldErrors },
        { status: 400 },
      );
    if (e instanceof HttpError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    console.error(
      "Forma request failed:",
      e instanceof Error ? e.message : "unknown",
    );
    return NextResponse.json(
      { error: "The request could not be completed. Your saved work is safe." },
      { status: 500 },
    );
  }
}
function adminWallet(wallet: string) {
  return (process.env.ADMIN_WALLETS || "")
    .toLowerCase()
    .split(",")
    .map((x) => x.trim())
    .includes(wallet.toLowerCase());
}
export const GET = handler;
export const POST = handler;
export const PUT = handler;
