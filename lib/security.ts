import { randomBytes, createHash, randomUUID } from "node:crypto";
import { database, type DB } from "./db";
import { config } from "./config";
export const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
export const now = () => new Date().toISOString();
export const after = (ms: number) => new Date(Date.now() + ms).toISOString();
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function assert(
  ok: unknown,
  status: number,
  message: string,
): asserts ok {
  if (!ok) throw new HttpError(status, message);
}
export function checkOrigin(req: Request) {
  if (!["GET", "HEAD"].includes(req.method)) {
    const origin = req.headers.get("origin");
    assert(
      !origin || origin === new URL(config().appUrl).origin,
      403,
      "Untrusted request origin",
    );
    assert(
      !req.headers.get("sec-fetch-site") ||
        req.headers.get("sec-fetch-site") !== "cross-site",
      403,
      "Cross-site request denied",
    );
  }
}
export async function rateLimit(key: string, max = 40, ms = 60000) {
  const db = await database();
  await db.transaction(async (tx) => {
    const [r] = await tx.query("SELECT * FROM rate_limits WHERE key=$1", [key]);
    if (!r || r.expires < now()) {
      await tx.query(
        "INSERT INTO rate_limits(key,count,expires) VALUES($1,1,$2) ON CONFLICT(key) DO UPDATE SET count=1,expires=$2",
        [key, after(ms)],
      );
    } else {
      assert(r.count < max, 429, "Too many requests. Try again shortly.");
      await tx.query("UPDATE rate_limits SET count=count+1 WHERE key=$1", [
        key,
      ]);
    }
  });
}
export async function getSession(req: Request) {
  const token = req.headers
    .get("cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith("forma_session="))
    ?.slice(14);
  if (!token) return null;
  const db = await database();
  const [session] = await db.query(
    "SELECT s.*,c.wallet FROM sessions s JOIN customers c ON c.id=s.owner WHERE token_hash=$1 AND expires>$2 AND mode=$3",
    [hash(token), now(), config().mode],
  );
  return session && (session.wallet || config().fixtures) ? session : null;
}
export async function requireSession(req: Request) {
  const s = await getSession(req);
  assert(s, 401, "Sign in to your workspace first.");
  return s;
}
export async function createSession(owner: string) {
  const token = randomBytes(32).toString("hex");
  const db = await database();
  await db.query(
    "INSERT INTO sessions(token_hash,owner,expires,mode) VALUES($1,$2,$3,$4)",
    [hash(token), owner, after(7 * 86400000), config().mode],
  );
  return `forma_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${new URL(config().appUrl).protocol === "https:" ? "; Secure" : ""}`;
}
export async function event(
  db: DB,
  id: string,
  stage: string,
  message: string,
) {
  await db.query(
    "INSERT INTO events(id,order_id,stage,message,created_at) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), id, stage, message, now()],
  );
}
