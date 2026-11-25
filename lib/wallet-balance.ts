import { createPublicClient, http, parseAbi, type Address } from "viem";
import { qieChain } from "./chain";
import { terms } from "./domain";

export function formatQusdcBalance(value: bigint): string {
  if (value < 0n) throw new Error("Invalid token balance");
  const whole = (value / 1_000_000n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (value % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export async function readWalletBalance(wallet: Address) {
  const client = createPublicClient({
    chain: qieChain,
    transport: http(
      process.env.QIE_RPC_URL || qieChain.rpcUrls.default.http[0],
      {
        timeout: 8_000,
        retryCount: 0,
      },
    ),
  });
  if ((await client.getChainId()) !== qieChain.id)
    throw new Error("Unexpected balance network");
  const value = await client.readContract({
    address: terms.token as Address,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [wallet],
  });
  return {
    wallet,
    chainId: qieChain.id,
    symbol: "QUSDC",
    decimals: 6,
    baseUnits: value.toString(),
    formatted: formatQusdcBalance(value),
    checkedAt: new Date().toISOString(),
  };
}
