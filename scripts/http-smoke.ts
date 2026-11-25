import assert from "node:assert/strict";
// Read-only acceptance checks: no wallet, project, test data, paid calls or transactions are created.
const origin = "http://127.0.0.1:3000";
const health = await (await fetch(origin + "/api/health")).json();
assert.equal(health.ok, true);
assert.equal(health.mode, "live");
const services = await (await fetch(origin + "/api/services")).json();
assert.equal(services.mode, "live");
assert.equal(services.generation, "openai");
assert.equal("demoNote" in services, false);
assert.equal((await fetch(origin + "/api/orders")).status, 401);
const removed = await fetch(origin + "/api/auth/demo", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
assert.equal(removed.status, 401);
assert.equal(removed.headers.get("set-cookie"), null);
for (const route of ["/", "/new", "/projects", "/help"]) {
  const response = await fetch(origin + route);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.doesNotMatch(
    html,
    /payments simulated|demo workspace|demo mode|simulate payment|syncly/i,
  );
}
console.log(
  "PASS: real-only runtime, OpenAI configuration, protected projects, removed anonymous sign-in and clean public pages. No test data or spending.",
);
