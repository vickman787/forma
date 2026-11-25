/** Single, explicitly authorized deployment. Never retries a broadcast. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  createPublicClient,
  encodeDeployData,
  formatEther,
  getContractAddress,
  http,
  keccak256,
  parseAbi,
  parseEther,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { qieChain } from "../lib/chain";

async function main() {
  if (!process.argv.includes("--approved-mainnet-deployment"))
    throw new Error("Explicit mainnet deployment authorization required.");
  const recordPath = ".forma/contracts/deployment.json";
  if (existsSync(recordPath))
    throw new Error(
      "A deployment record already exists. Reconcile it; do not deploy again.",
    );
  const plan = JSON.parse(
    readFileSync(".forma/contracts/unsigned-deployment.json", "utf8"),
  );
  const artifact = JSON.parse(
    readFileSync(".forma/contracts/ServiceEscrow.json", "utf8"),
  );
  const input = readFileSync(".forma/contracts/standard-input.json", "utf8");
  const approvedInputHash =
    "acb800af3c382860e065e2b84eaa22ac3138e819a6d9dc5b87b4aa3bd2ae4694";
  const approvedAddress = "0xC137afa61B212D1492ad70B34b614aD7Aab9A873";
  const asset = "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5";
  if (
    createHash("sha256").update(input).digest("hex") !== approvedInputHash ||
    plan.inputSha256 !== approvedInputHash ||
    artifact.inputSha256 !== approvedInputHash ||
    keccak256(artifact.bytecode as Hex) !== artifact.bytecodeHash
  )
    throw new Error("Approved build hash mismatch.");
  const data = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [asset, approvedAddress, approvedAddress],
  });
  if (
    data !== plan.data ||
    plan.chainId !== 1990 ||
    plan.value !== "0" ||
    plan.asset !== asset ||
    plan.treasury !== approvedAddress ||
    plan.operator !== approvedAddress
  )
    throw new Error("Approved deployment parameters mismatch.");
  const key = process.env.FORMA_DEPLOYER_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key))
    throw new Error("Local deployer key missing.");
  const account = privateKeyToAccount(key as Hex);
  if (account.address !== approvedAddress)
    throw new Error("Deployer does not match approved wallet.");
  const rpc = createPublicClient({
    chain: qieChain,
    transport: http(qieChain.rpcUrls.default.http[0], {
      timeout: 20000,
      retryCount: 0,
    }),
  });
  if ((await rpc.getChainId()) !== 1990) throw new Error("Wrong RPC chain.");
  const [gas, gasPrice, balance, nonce] = await Promise.all([
    rpc.estimateGas({ account: account.address, data, value: 0n }),
    rpc.getGasPrice(),
    rpc.getBalance({ address: account.address }),
    rpc.getTransactionCount({ address: account.address, blockTag: "pending" }),
  ]);
  const gasLimit = 1334297n;
  const maxGasPrice = 2250000000n;
  if (
    gas > gasLimit ||
    gasPrice > maxGasPrice ||
    gasLimit * gasPrice > parseEther("0.0031") ||
    balance < gasLimit * gasPrice
  )
    throw new Error(
      "Deployment exceeds the approved fee cap or available balance.",
    );
  const serialized = await account.signTransaction({
    chainId: 1990,
    type: "legacy",
    nonce,
    gas: gasLimit,
    gasPrice,
    value: 0n,
    data,
  });
  const hash = keccak256(serialized);
  const predictedAddress = getContractAddress({
    from: account.address,
    nonce: BigInt(nonce),
  });
  const record: Record<string, unknown> = {
    status: "signed_pending_broadcast",
    chainId: 1990,
    hash,
    predictedAddress,
    deployer: account.address,
    asset,
    treasury: approvedAddress,
    operator: approvedAddress,
    nonce,
    gasLimit: gasLimit.toString(),
    gasPriceWei: gasPrice.toString(),
    maxFeeQIE: formatEther(gasLimit * gasPrice),
    inputSha256: approvedInputHash,
    createdAt: new Date().toISOString(),
  };
  // Persist identity before broadcasting, so ambiguous network results cannot cause a duplicate deployment.
  writeFileSync(recordPath, JSON.stringify(record, null, 2), { flag: "wx" });
  const sent = await rpc.sendRawTransaction({
    serializedTransaction: serialized,
  });
  if (sent !== hash)
    throw new Error(
      "RPC returned an unexpected transaction hash. Reconcile saved deployment record.",
    );
  record.status = "broadcast";
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
  console.log(
    JSON.stringify({
      status: "broadcast",
      hash,
      predictedAddress,
      maxFeeQIE: record.maxFeeQIE,
    }),
  );
  const receipt = await rpc.waitForTransactionReceipt({
    hash,
    confirmations: 3,
    timeout: 120000,
    pollingInterval: 2000,
  });
  if (
    receipt.status !== "success" ||
    receipt.contractAddress?.toLowerCase() !== predictedAddress.toLowerCase()
  )
    throw new Error("Deployment receipt failed or address mismatch.");
  const code = await rpc.getCode({ address: predictedAddress });
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
    throw new Error("Deployed runtime bytecode mismatch.");
  const abi = parseAbi([
    "function asset() view returns (address)",
    "function treasury() view returns (address)",
    "function operator() view returns (address)",
    "function liabilities() view returns (uint256)",
  ]);
  const values = await Promise.all(
    (["asset", "treasury", "operator", "liabilities"] as const).map(
      (functionName) =>
        rpc.readContract({ address: predictedAddress, abi, functionName }),
    ),
  );
  if (
    String(values[0]).toLowerCase() !== asset.toLowerCase() ||
    String(values[1]).toLowerCase() !== approvedAddress.toLowerCase() ||
    String(values[2]).toLowerCase() !== approvedAddress.toLowerCase() ||
    values[3] !== 0n
  )
    throw new Error("Deployed immutable settings or liabilities mismatch.");
  Object.assign(record, {
    status: "confirmed_checked",
    contractAddress: predictedAddress,
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
    gasUsed: receipt.gasUsed.toString(),
    actualFeeQIE: formatEther(
      receipt.gasUsed * (receipt.effectiveGasPrice ?? gasPrice),
    ),
    runtimeCodeHash: keccak256(code),
    confirmedAt: new Date().toISOString(),
    explorerSourceVerified: false,
  });
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
  let env = readFileSync(".env", "utf8");
  env = /^ESCROW_ADDRESS=.*$/m.test(env)
    ? env.replace(/^ESCROW_ADDRESS=.*$/m, `ESCROW_ADDRESS=${predictedAddress}`)
    : env.trimEnd() + `\nESCROW_ADDRESS=${predictedAddress}\n`;
  writeFileSync(".env", env);
  console.log(JSON.stringify(record, null, 2));
}
main().catch(() => {
  console.error(
    "Deployment stopped. Inspect the saved public deployment record and reconcile its transaction hash before any further action. No automatic retry.",
  );
  process.exitCode = 1;
});
