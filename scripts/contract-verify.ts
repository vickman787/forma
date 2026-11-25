/** Publishes only the reviewed Solidity source bundle to the QIE explorer. No key or chain transaction. */
import { readFileSync, writeFileSync } from "node:fs";
const file = ".forma/contracts/deployment.json";
const record = JSON.parse(readFileSync(file, "utf8"));
if (record.status !== "confirmed_checked")
  throw new Error("Confirm and check deployment first.");
const artifact = JSON.parse(
  readFileSync(".forma/contracts/ServiceEscrow.json", "utf8"),
);
const base = "https://mainnet.qie.digital/api/v2/smart-contracts";
const existing = await fetch(`${base}/${record.contractAddress}`, {
  signal: AbortSignal.timeout(20000),
});
if (existing.ok) {
  const body = await existing.json();
  if (body.is_verified === true && body.name === "ServiceEscrow") {
    record.explorerSourceVerified = true;
    writeFileSync(file, JSON.stringify(record, null, 2));
    console.log("Explorer source verification confirmed.");
    process.exit(0);
  }
}
const form = new FormData();
form.set(
  "compiler_version",
  `v${artifact.compilerVersion.split(".Emscripten")[0]}`,
);
form.set("license_type", "mit");
form.set("autodetect_constructor_args", "true");
form.set("contract_name", artifact.fullyQualifiedName);
form.set(
  "files[0]",
  new Blob([readFileSync(".forma/contracts/standard-input.json", "utf8")], {
    type: "application/json",
  }),
  "standard-input.json",
);
const response = await fetch(
  `${base}/${record.contractAddress}/verification/via/standard-input`,
  { method: "POST", body: form, signal: AbortSignal.timeout(60000) },
);
const text = await response.text();
writeFileSync(
  ".forma/contracts/explorer-verification-response.json",
  JSON.stringify({ status: response.status, body: text }, null, 2),
);
console.log(
  JSON.stringify({ status: response.status, response: text.slice(0, 2000) }),
);
if (!response.ok) process.exitCode = 1;
