import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { previewUrl, validPreview } from "../lib/preview";
import { readableInk, readableAccent, contrast } from "../lib/colors";
import { config } from "../lib/config";
test("isolated preview tokens are scoped, expiring, mode-bound and tamper evident", () => {
  process.env.APP_MODE = "demo";
  process.env.SESSION_SECRET = "local-test-preview-secret-only-32-characters";
  const id = randomUUID(),
    url = new URL(previewUrl(id)),
    expires = url.searchParams.get("expires")!,
    token = url.searchParams.get("token")!;
  assert.equal(validPreview(id, expires, token), true);
  assert.equal(validPreview(randomUUID(), expires, token), false);
  assert.equal(validPreview(id, String(Date.now() - 1), token), false);
  assert.equal(validPreview(id, expires, "0".repeat(64)), false);
});
test("brand colors keep readable template text", () => {
  for (const color of [
    "#FFFFFF",
    "#000000",
    "#888888",
    "#D75B3E",
    "#F7F5F0",
    "#684425",
  ]) {
    assert.ok(contrast(color, readableInk(color)) >= 4.5);
    assert.ok(contrast("#F7F5F0", readableAccent(color)) >= 4.5);
  }
});
test("missing live configuration fails closed", () => {
  const old = process.env.APP_MODE;
  process.env.APP_MODE = "live";
  assert.throws(() => config(), /Live configuration missing/);
  process.env.APP_MODE = old;
});
