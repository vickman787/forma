/** Writes private deployment configuration locally. Never deploys or contacts a provider. */
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const i = a.indexOf("=");
    return [a.slice(0, i), a.slice(i + 1)];
  }),
);
const app = args["--app-url"],
  preview = args["--preview-url"];
if (!app || !preview)
  throw new Error(
    "Provide --app-url=https://your-domain and --preview-url=https://your-preview-domain",
  );
for (const value of [app, preview]) {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.origin !== value || u.username || u.password)
    throw new Error(
      "Deployment URLs must be distinct HTTPS origins without credentials or paths",
    );
}
if (app === preview) throw new Error("Preview requires a separate origin");
const dir = path.resolve(".forma/deploy");
try {
  await access(path.join(dir, "shared.env"));
  throw new Error(
    "Deployment configuration already exists; preserve and review it instead of overwriting credentials",
  );
} catch (e) {
  if (!(e && typeof e === "object" && "code" in e && e.code === "ENOENT"))
    throw e;
}
const required = [
  "OPENAI_API_KEY",
  "OPENAI_TEXT_MODEL",
  "OPENAI_RESEARCH_MODEL",
  "ESCROW_ADDRESS",
  "TREASURY_ADDRESS",
  "OPERATOR_ADDRESS",
  "SESSION_SECRET",
  "ADMIN_WALLETS",
  "SUPPORT_EMAIL",
  "MAX_JOB_COST_USD",
  "MAX_INPUT_COST_PER_MILLION",
  "MAX_OUTPUT_COST_PER_MILLION",
  "MAX_SEARCH_COST_USD",
];
for (const name of required)
  if (!process.env[name])
    throw new Error(`Deployment setting missing: ${name}`);
const password = randomBytes(32).toString("base64url"),
  adminPassword = randomBytes(32).toString("base64url");
const shared: Record<string, string> = {
  APP_MODE: "live",
  LOCAL_ONLY: "false",
  GENERATION_PROVIDER: "openai",
  APP_URL: app,
  PREVIEW_ORIGIN: preview,
  DATABASE_URL: `postgresql://forma:${password}@db:5432/forma`,
  DATA_DIRECTORY: "/data/live",
  SESSION_SECRET: randomBytes(48).toString("hex"),
  QIE_CHAIN_ID: "1990",
  QUSDC_DECIMALS: "6",
  SERVICE_PRICE_BASE_UNITS: "1000000",
  QUSDC_ADDRESS: "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5",
  LIVE_PAYMENTS_ENABLED: "false",
  LIVE_VERIFICATION_COMPLETE: "false",
  ALLOW_PAID_API_CALLS: process.env.ALLOW_PAID_API_CALLS || "false",
};
for (const key of [
  "OPENAI_TEXT_MODEL",
  "OPENAI_RESEARCH_MODEL",
  "MAX_OUTPUT_TOKENS",
  "MAX_JOB_COST_USD",
  "MAX_INPUT_COST_PER_MILLION",
  "MAX_OUTPUT_COST_PER_MILLION",
  "MAX_SEARCH_COST_USD",
  "PROVIDER_BUDGET_ID",
  "PROVIDER_TOTAL_BUDGET_USD",
  "ESCROW_ADDRESS",
  "TREASURY_ADDRESS",
  "OPERATOR_ADDRESS",
  "ADMIN_WALLETS",
  "SUPPORT_EMAIL",
  "QIE_RPC_URL",
])
  if (process.env[key]) shared[key] = process.env[key]!;
const operator: Record<string, string> = {
  ALLOW_OPERATOR_TRANSACTIONS: "false",
};
for (const name of [
  "OPERATOR_POLICY_ID",
  "OPERATOR_TOTAL_GAS_QIE",
  "OPERATOR_MAX_TX_GAS_QIE",
  "OPERATOR_POLICY_EXPIRES_AT",
  "OPERATOR_POLICY_ACTIONS",
  "OPERATOR_POLICY_ORDER_ID",
]) {
  if (process.env[name]) operator[name] = process.env[name]!;
}
if (process.env.FORMA_DEPLOYER_PRIVATE_KEY)
  operator.FORMA_DEPLOYER_PRIVATE_KEY = process.env.FORMA_DEPLOYER_PRIVATE_KEY;
const encode = (record: Record<string, string>) =>
  Object.entries(record)
    .map(([k, v]) => {
      if (/[\r\n]/.test(v))
        throw new Error("Environment values must be single-line");
      return `${k}=${JSON.stringify(v)}`;
    })
    .join("\n") + "\n";
await mkdir(dir, { recursive: true });
await writeFile(path.join(dir, "shared.env"), encode(shared), {
  flag: "wx",
  mode: 0o600,
});
await writeFile(
  path.join(dir, "generation.env"),
  encode({ OPENAI_API_KEY: process.env.OPENAI_API_KEY! }),
  { flag: "wx", mode: 0o600 },
);
await writeFile(path.join(dir, "operator.env"), encode(operator), {
  flag: "wx",
  mode: 0o600,
});
await writeFile(path.join(dir, "db-password"), password, {
  flag: "wx",
  mode: 0o600,
});
await writeFile(path.join(dir, "db-admin-password"), adminPassword, {
  flag: "wx",
  mode: 0o600,
});
console.log(
  "Wrote private deployment files. Operator key is isolated from web/generation/preview; public checkout and signing remain disabled. Migrate the existing data and budget ledger before activation.",
);
