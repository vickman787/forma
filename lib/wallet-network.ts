import { qieChain } from "./chain";

export type BrowserWallet = {
  request: (args: { method: string; params?: any[] }) => Promise<any>;
};

/** Match the SIWE chain before asking the wallet to review a signature. */
export async function ensureQieNetwork(wallet: BrowserWallet) {
  const chainId = `0x${qieChain.id.toString(16)}`;
  if ((await wallet.request({ method: "eth_chainId" })) === chainId) return;
  try {
    await wallet.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId }],
    });
  } catch (error) {
    const code =
      (error as any)?.code ?? (error as any)?.data?.originalError?.code;
    if (Number(code) !== 4902) throw error;
    await wallet.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: qieChain.name,
          nativeCurrency: qieChain.nativeCurrency,
          rpcUrls: [...qieChain.rpcUrls.default.http],
          blockExplorerUrls: [qieChain.blockExplorers.default.url],
        },
      ],
    });
    await wallet.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId }],
    });
  }
  if ((await wallet.request({ method: "eth_chainId" })) !== chainId)
    throw new Error(
      "Select QIE Mainnet in your wallet, then try signing in again.",
    );
}
