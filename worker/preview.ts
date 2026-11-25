import { createServer } from "node:http";
import { database } from "../lib/db";
import { config } from "../lib/config";
import { validPreview, previewBytes } from "../lib/preview";
const origin = process.env.PREVIEW_ORIGIN || "http://127.0.0.1:4317";
createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", origin),
      match = url.pathname.match(/^\/preview\/([0-9a-f-]{36})$/);
    if (
      req.method !== "GET" ||
      !match ||
      !validPreview(
        match[1],
        url.searchParams.get("expires") || "",
        url.searchParams.get("token") || "",
      )
    ) {
      res.writeHead(404);
      res.end(
        "Preview unavailable or expired. Refresh your project for a new link.",
      );
      return;
    }
    const [a] = await (
      await database()
    ).query(
      "SELECT a.* FROM artifacts a JOIN orders o ON o.id=a.order_id WHERE a.id=$1 AND o.mode=$2",
      [match[1], config().mode],
    );
    if (!a || !a.mime.startsWith("text/html")) {
      res.writeHead(404);
      res.end("Preview not found");
      return;
    }
    const bytes = await previewBytes(a);
    res.writeHead(200, {
      "Content-Type": a.mime,
      "Content-Length": bytes.length,
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": `sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors ${new URL(config().appUrl).origin}`,
    });
    res.end(bytes);
  } catch {
    res.writeHead(500);
    res.end("Preview unavailable. Refresh your project.");
  }
}).listen(
  Number(process.env.PREVIEW_PORT || 4317),
  process.env.LISTEN_HOST || "127.0.0.1",
  () => console.log(`Forma isolated previews: ${origin}`),
);
