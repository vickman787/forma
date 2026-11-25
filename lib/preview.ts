import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { database } from "./db";
import { hash } from "./security";
function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const dir = config().data;
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "preview-secret");
  try {
    return readFileSync(file, "utf8");
  } catch {
    try {
      writeFileSync(file, randomBytes(32).toString("hex"), {
        flag: "wx",
        mode: 0o600,
      });
    } catch {}
    return readFileSync(file, "utf8");
  }
}
function sign(id: string, expires: string) {
  return createHmac("sha256", secret())
    .update(`${config().mode}:${id}:${expires}`)
    .digest("hex");
}
export function previewUrl(id: string) {
  const expires = String(Date.now() + 5 * 60000);
  return `${process.env.PREVIEW_ORIGIN || "http://127.0.0.1:4317"}/preview/${id}?expires=${expires}&token=${sign(id, expires)}`;
}
export function validPreview(id: string, expires: string, token: string) {
  if (
    !/^\d{13}$/.test(expires) ||
    Number(expires) < Date.now() ||
    Number(expires) > Date.now() + 5 * 60000 ||
    !/^[0-9a-f]{64}$/.test(token)
  )
    return false;
  return timingSafeEqual(
    Buffer.from(sign(id, expires), "hex"),
    Buffer.from(token, "hex"),
  );
}
export async function previewBytes(a: any) {
  let bytes = await readFile(path.join(config().data, a.storage_key));
  if (hash(bytes) !== a.sha256) throw new Error("Artifact checksum mismatch");
  if (a.mime.startsWith("text/html")) {
    let html = bytes.toString();
    const photos = await (
      await database()
    ).query(
      "SELECT name,storage_key FROM artifacts WHERE order_id=$1 AND version=$2 AND mime='image/png'",
      [a.order_id, a.version],
    );
    for (const photo of photos) {
      if (!/^photo-\d+\.png$/.test(photo.name)) continue;
      const data = await readFile(path.join(config().data, photo.storage_key));
      html = html.replaceAll(
        `src="${photo.name}"`,
        `src="data:image/png;base64,${data.toString("base64")}"`,
      );
    }
    bytes = Buffer.from(html);
  }
  return bytes;
}
