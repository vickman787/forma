/** Reconcile the saved deployment using public RPC reads only. Never signs or sends. */
import { readFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient,
  http,
  formatEther,
  keccak256,
  parseAbi,
  type Hex,
} from "viem";
import { qieChain } from "../lib/chain";

const file = ".forma/contracts/deployment.json";
const record = JSON.parse(readFileSync(file, "utf8"));
const artifact = JSON.parse(
  readFileSync(".forma/contracts/ServiceEscrow.json", "utf8"),
);
const plan = JSON.parse(
  readFileSync(".forma/contracts/unsigned-deployment.json", "utf8"),
);
const rpc = createPublicClient({
  chain: qieChain,
  transport: http(qieChain.rpcUrls.default.http[0], {
    retryCount: 0,
    timeout: 20000,
  }),
});
if ((await rpc.getChainId()) !== 1990) throw new Error("Wrong chain.");
const receipt = await rpc.getTransactionReceipt({ hash: record.hash });
const transaction = await rpc.getTransaction({ hash: record.hash });
if (
  receipt.status !== "success" ||
  receipt.contractAddress?.toLowerCase() !==
    record.predictedAddress.toLowerCase() ||
  transaction.from.toLowerCase() !== record.deployer.toLowerCase() ||
  transaction.input !== plan.data ||
  transaction.value !== 0n
)
  throw new Error("Deployment receipt or transaction mismatch.");
const [block, height, code] = await Promise.all([
  rpc.getBlock({ blockNumber: receipt.blockNumber }),
  rpc.getBlockNumber(),
  rpc.getCode({ address: receipt.contractAddress! }),
]);
if (block.hash !== receipt.blockHash || height < receipt.blockNumber + 2n)
  throw new Error("Await three canonical confirmations.");
if (!code || code === "0x") throw new Error("No deployed code.");
const normalize = (hex: string) => {
  const bytes = Buffer.from(hex.slice(2), "hex");
  for (const refs of Object.values(artifact.immutableReferences) as Array<
    Array<{ start: number; length: number }>
  >)
    for (const ref of refs) bytes.fill(0, ref.start, ref.start + ref.length);
  return bytes.toString("hex");
};
if (normalize(code) !== normalize(artifact.deployedBytecode))
  throw new Error("Runtime bytecode mismatch.");
const abi = parseAbi([
  "function asset() view returns (address)",
  "function treasury() view returns (address)",
  "function operator() view returns (address)",
  "function liabilities() view returns (uint256)",
]);
const values = await Promise.all(
  (["asset", "treasury", "operator", "liabilities"] as const).map(
    (functionName) =>
      rpc.readContract({
        address: receipt.contractAddress!,
        abi,
        functionName,
      }),
  ),
);
if (
  String(values[0]).toLowerCase() !== record.asset.toLowerCase() ||
  String(values[1]).toLowerCase() !== record.treasury.toLowerCase() ||
  String(values[2]).toLowerCase() !== record.operator.toLowerCase() ||
  values[3] !== 0n
)
  throw new Error("Escrow configuration mismatch.");
// QIE may omit effectiveGasPrice; this deployment is legacy, whose gasPrice is fixed in the signed transaction.
const price = receipt.effectiveGasPrice ?? transaction.gasPrice;
if (
  price == null ||
  transaction.type !== "legacy" ||
  price !== BigInt(record.gasPriceWei)
)
  throw new Error("Unable to establish deployment fee.");
Object.assign(record, {
  status: "confirmed_checked",
  contractAddress: receipt.contractAddress,
  blockNumber: receipt.blockNumber.toString(),
  blockHash: receipt.blockHash,
  gasUsed: receipt.gasUsed.toString(),
  actualFeeQIE: formatEther(receipt.gasUsed * price),
  runtimeCodeHash: keccak256(code as Hex),
  confirmedAt: new Date().toISOString(),
  explorerSourceVerified: record.explorerSourceVerified || false,
});
writeFileSync(file, JSON.stringify(record, null, 2));
let env = readFileSync(".env", "utf8");
env = /^ESCROW_ADDRESS=.*$/m.test(env)
  ? env.replace(
      /^ESCROW_ADDRESS=.*$/m,
      `ESCROW_ADDRESS=${record.contractAddress}`,
    )
  : env.trimEnd() + `\nESCROW_ADDRESS=${record.contractAddress}\n`;
writeFileSync(".env", env);
console.log(JSON.stringify(record, null, 2));
