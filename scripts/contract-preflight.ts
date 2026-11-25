/** Read-only QIE deployment checks. No wallet client, private-key access or broadcast. */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  createPublicClient,
  http,
  isAddress,
  parseAbi,
  formatEther,
  keccak256,
  type Hex,
  type Address,
} from "viem";
import { qieChain } from "../lib/chain";

const plan = JSON.parse(
  readFileSync(".forma/contracts/unsigned-deployment.json", "utf8"),
);
const artifact = JSON.parse(
  readFileSync(".forma/contracts/ServiceEscrow.json", "utf8"),
);
const input = readFileSync(".forma/contracts/standard-input.json", "utf8");
const deployer = process.env.DEPLOYER_ADDRESS;
if (!deployer || !isAddress(deployer))
  throw new Error("A public DEPLOYER_ADDRESS is required.");
if (plan.chainId !== 1990 || plan.unsigned !== true || plan.value !== "0")
  throw new Error("Unexpected deployment plan.");
if (
  createHash("sha256").update(input).digest("hex") !== plan.inputSha256 ||
  artifact.inputSha256 !== plan.inputSha256 ||
  keccak256(artifact.bytecode as Hex) !== artifact.bytecodeHash ||
  !plan.data.startsWith(artifact.bytecode)
)
  throw new Error("Deployment artifacts differ. Rebuild and review.");
const rpc = createPublicClient({
  chain: qieChain,
  transport: http(process.env.QIE_RPC_URL || qieChain.rpcUrls.default.http[0], {
    timeout: 20000,
    retryCount: 0,
  }),
});
if ((await rpc.getChainId()) !== 1990)
  throw new Error("RPC is not QIE mainnet.");
const token = plan.asset as Address;
const code = await rpc.getCode({ address: token });
if (!code || code === "0x") throw new Error("Settlement token has no code.");
const abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const [balance, gasPrice, gas, decimals, symbol, block] = await Promise.all([
  rpc.getBalance({ address: deployer }),
  rpc.getGasPrice(),
  rpc.estimateGas({ account: deployer, data: plan.data as Hex, value: 0n }),
  rpc.readContract({ address: token, abi, functionName: "decimals" }),
  rpc.readContract({ address: token, abi, functionName: "symbol" }),
  rpc.getBlockNumber(),
]);
if (decimals !== 6 || symbol !== "QUSDC")
  throw new Error("Unexpected settlement token metadata.");
const gasLimit = (gas * 125n + 99n) / 100n;
const maxGasPrice = gasPrice * 2n;
const maxFee = gasLimit * maxGasPrice;
const result = {
  checkedAt: new Date().toISOString(),
  readOnly: true,
  chainId: 1990,
  block: block.toString(),
  deployer,
  treasury: plan.treasury,
  operator: plan.operator,
  asset: token,
  tokenDecimals: decimals,
  tokenSymbol: symbol,
  tokenCodeHash: keccak256(code),
  balanceQIE: formatEther(balance),
  estimatedGas: gas.toString(),
  gasLimit: gasLimit.toString(),
  gasPriceWei: gasPrice.toString(),
  estimatedFeeQIE: formatEther(gas * gasPrice),
  proposedMaxGasPriceWei: maxGasPrice.toString(),
  proposedMaxFeeQIE: formatEther(maxFee),
  enoughForProposedMaxFee: balance >= maxFee,
  inputSha256: plan.inputSha256,
  note: "Estimate only. No transaction signed or sent. Token transfer behavior and deployed escrow still need verification.",
};
writeFileSync(
  ".forma/contracts/preflight.json",
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
