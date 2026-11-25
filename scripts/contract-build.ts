/** Offline build and unsigned deployment preparation. Never connects to a wallet or RPC. */
import { createRequire } from "node:module";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  encodeDeployData,
  isAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";

const require = createRequire(import.meta.url);
const solc = require("solc");
const sources: Record<string, { content: string }> = {
  "contracts/ServiceEscrow.sol": {
    content: readFileSync("contracts/ServiceEscrow.sol", "utf8"),
  },
};
const settings = {
  evmVersion: "shanghai",
  optimizer: { enabled: true, runs: 200 },
  outputSelection: {
    "*": {
      "*": [
        "abi",
        "metadata",
        "evm.bytecode.object",
        "evm.deployedBytecode.object",
        "evm.deployedBytecode.immutableReferences",
      ],
    },
  },
};
const compile = () =>
  JSON.parse(
    solc.compile(JSON.stringify({ language: "Solidity", sources, settings }), {
      import: (name: string) => {
        if (!name.startsWith("@openzeppelin/contracts/") || name.includes(".."))
          return { error: "Unexpected import" };
        try {
          const content = readFileSync(path.join("node_modules", name), "utf8");
          sources[name] = { content };
          return { contents: content };
        } catch {
          return { error: `Missing dependency: ${name}` };
        }
      },
    }),
  );
// Resolve the full source graph, then compile the exact input saved for verification.
compile();
const input = { language: "Solidity", sources, settings };
const output = compile();
const errors = (output.errors || []).filter((e: any) => e.severity === "error");
if (errors.length)
  throw new Error(errors.map((e: any) => e.formattedMessage).join("\n"));
const contract = output.contracts["contracts/ServiceEscrow.sol"].ServiceEscrow;
const bytecode = `0x${contract.evm.bytecode.object}` as Hex;
const inputText = JSON.stringify(input, null, 2);
const artifact = {
  contractName: "ServiceEscrow",
  fullyQualifiedName: "contracts/ServiceEscrow.sol:ServiceEscrow",
  compilerVersion: solc.version(),
  inputSha256: createHash("sha256").update(inputText).digest("hex"),
  bytecodeHash: keccak256(bytecode),
  abi: contract.abi,
  bytecode,
  deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
  immutableReferences: contract.evm.deployedBytecode.immutableReferences,
};
const directory = path.resolve(".forma/contracts");
mkdirSync(directory, { recursive: true });
writeFileSync(path.join(directory, "standard-input.json"), inputText);
writeFileSync(
  path.join(directory, "ServiceEscrow.json"),
  JSON.stringify(artifact, null, 2),
);
const treasury = process.env.TREASURY_ADDRESS;
const operator = process.env.OPERATOR_ADDRESS;
if (treasury || operator) {
  if (
    !treasury ||
    !operator ||
    !isAddress(treasury) ||
    !isAddress(operator) ||
    /^0x0{40}$/i.test(treasury) ||
    /^0x0{40}$/i.test(operator)
  )
    throw new Error(
      "Both nonzero public TREASURY_ADDRESS and OPERATOR_ADDRESS are required for an unsigned plan.",
    );
  const asset = "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5" as Address;
  const plan = {
    unsigned: true,
    requiresExplicitUserAuthorization: true,
    chainId: 1990,
    value: "0",
    asset,
    treasury,
    operator,
    compilerVersion: artifact.compilerVersion,
    inputSha256: artifact.inputSha256,
    constructorArguments: [asset, treasury, operator],
    data: encodeDeployData({
      abi: artifact.abi,
      bytecode,
      args: [asset, treasury, operator],
    }),
    reviewRequired: [
      "Recheck official token address, decimals and transfer behavior",
      "Review immutable treasury and operator",
      "Estimate gas using selected deployer",
      "Confirm QIE mainnet deployment authorization",
    ],
  };
  writeFileSync(
    path.join(directory, "unsigned-deployment.json"),
    JSON.stringify(plan, null, 2),
  );
}
console.log(
  `Offline escrow build saved to ${directory}; compiler ${artifact.compilerVersion}; ${Object.keys(sources).length} source files. No transaction sent.`,
);
