/** Read-only registration preparation. Never reads a signing key or broadcasts. */
import path from "node:path";
import { operatorRecordsDirectory } from "../lib/operator-files";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  createPublicClient,
  http,
  parseAbi,
  formatEther,
  type Address,
  type Hex,
} from "viem";
import { database } from "../lib/db";
import { parseOrder } from "../lib/orders";
import { operatorPlan, validateDeliveryState } from "../lib/operator";
import { escrowAbi, tokenAbi } from "../lib/payments";
import { terms } from "../lib/domain";
import { qieChain } from "../lib/chain";

const db = await database();
const orderId = process.argv[2];
const action = process.argv[3] || "create";
const policySuffix = process.argv[4] || "";
if (policySuffix && !/^[a-zA-Z0-9_-]{1,160}$/.test(policySuffix))
  throw new Error("Invalid policy preparation identifier");
if (action !== "create" && action !== "deliver")
  throw new Error("Only registration or delivery can be prepared here");
if (!orderId)
  throw new Error(
    "Pass an order ID or latest to prepare one unsigned registration.",
  );
const [row] =
  orderId === "latest"
    ? await db.query(
        "SELECT * FROM orders WHERE mode='live' ORDER BY created_at DESC LIMIT 1",
      )
    : await db.query("SELECT * FROM orders WHERE id=$1 AND mode='live'", [
        orderId,
      ]);
if (!row) throw new Error("Live order not found");
const [quote] = await db.query(
  "SELECT q.terms_hash,c.wallet FROM quotes q JOIN customers c ON c.id=q.owner WHERE q.id=$1 AND q.owner=$2",
  [row.quote_id, row.owner],
);
if (!quote) throw new Error("Owned quote not found");
const plan = operatorPlan(parseOrder(row), quote, action, {
  escrow: process.env.ESCROW_ADDRESS || "",
  operator: process.env.OPERATOR_ADDRESS || "",
});
const rpc = createPublicClient({
  chain: qieChain,
  transport: http(process.env.QIE_RPC_URL || qieChain.rpcUrls.default.http[0], {
    retryCount: 0,
    timeout: 20000,
  }),
});
if ((await rpc.getChainId()) !== 1990) throw new Error("RPC network mismatch");
const escrow = plan.to as Address;
const [asset, treasury, operator, decimals, job, gasPrice, balance] =
  await Promise.all([
    rpc.readContract({
      address: escrow,
      abi: escrowAbi,
      functionName: "asset",
    }),
    rpc.readContract({
      address: escrow,
      abi: escrowAbi,
      functionName: "treasury",
    }),
    rpc.readContract({
      address: escrow,
      abi: escrowAbi,
      functionName: "operator",
    }),
    rpc.readContract({
      address: terms.token as Address,
      abi: tokenAbi,
      functionName: "decimals",
    }),
    rpc.readContract({
      address: escrow,
      abi: escrowAbi,
      functionName: "jobs",
      args: [row.chain_job as Hex],
    }),
    rpc.getGasPrice(),
    rpc.getBalance({ address: plan.from as Address }),
  ]);
if (
  asset.toLowerCase() !== terms.token.toLowerCase() ||
  treasury.toLowerCase() !== process.env.TREASURY_ADDRESS?.toLowerCase() ||
  operator.toLowerCase() !== plan.from.toLowerCase() ||
  decimals !== 6 ||
  (action === "create" && job[7] !== 0)
)
  throw new Error("Escrow configuration mismatch or job already registered");
if (action === "deliver") validateDeliveryState(parseOrder(row), quote, job);
const gasEstimate = await rpc.estimateGas({
  account: plan.from as Address,
  to: escrow,
  data: plan.data,
  value: 0n,
});
const gasLimit = (gasEstimate * 120n + 99n) / 100n;
const maximumGasPrice = gasPrice * 2n;
const maximumFee = gasLimit * maximumGasPrice;
if (balance < maximumFee)
  throw new Error("Operator balance below proposed maximum fee");
const payload = {
  ...plan,
  createdAt: new Date().toISOString(),
  customer: quote.wallet,
  fundingExpires: row.funding_expires,
  token: terms.token,
  amount: "1000000",
  gasEstimate: gasEstimate.toString(),
  gasLimit: gasLimit.toString(),
  maximumGasPrice: maximumGasPrice.toString(),
  maximumFeeWei: maximumFee.toString(),
  maximumFeeQIE: formatEther(maximumFee),
  estimatedFeeQIE: formatEther(gasEstimate * gasPrice),
  movesQUSDC: false,
};
const json = JSON.stringify(payload, null, 2);
await mkdir(operatorRecordsDirectory(), { recursive: true });
const file = path.join(
  operatorRecordsDirectory(),
  `${policySuffix ? `policy-${policySuffix}-` : ""}${action === "create" ? "registration" : "delivery"}-${row.id}.json`,
);
await writeFile(file, json, { flag: "w" });
console.log(
  JSON.stringify(
    {
      unsigned: true,
      orderId: row.id,
      action: action === "create" ? "createJob" : "submitDelivery",
      escrow,
      customer: quote.wallet,
      fundingExpires: row.funding_expires,
      estimatedFeeQIE: payload.estimatedFeeQIE,
      maximumFeeQIE: payload.maximumFeeQIE,
      planSha256: createHash("sha256").update(json).digest("hex"),
      file,
      transactionsSent: 0,
    },
    null,
    2,
  ),
);
process.exit(0);
