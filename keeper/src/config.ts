import type { Chain } from "viem";
import { arbitrum, arbitrumSepolia, base, baseSepolia, mainnet, hardhat } from "viem/chains";

const chainMap: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [arbitrum.id]: arbitrum,
  [arbitrumSepolia.id]: arbitrumSepolia,
  [base.id]: base,
  [baseSepolia.id]: baseSepolia,
  [hardhat.id]: hardhat,
};

const alchemyEthNetwork: Record<number, string> = {
  [mainnet.id]: "eth-mainnet",
  [arbitrum.id]: "arb-mainnet",
  [arbitrumSepolia.id]: "arb-sepolia",
  [base.id]: "base-mainnet",
  [baseSepolia.id]: "base-sepolia",
};

function alchemyRpcUrl(network: string, apiKey: string) {
  return `https://${network}.g.alchemy.com/v2/${apiKey}`;
}

// The deployed keeper receives ETHEREUM_RPC_URL, not ALCHEMY_API_KEY. Dev's URL
// is Base Sepolia, and the same key can read Base mainnet Chainlink.
function alchemyKeyFromRpcUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!parsed.hostname.endsWith(".g.alchemy.com")) return undefined;
  const [version, apiKey] = parsed.pathname.split("/").filter(Boolean);
  if (version !== "v2" || !apiKey) return undefined;
  return apiKey;
}

export function getChain(chainId: number): Chain {
  const chain = chainMap[chainId];
  if (!chain) throw new Error(`Unsupported chain ID: ${chainId}`);
  return chain;
}

export function configFromEnv(env: Record<string, string | undefined>) {
  const required = (key: string): string => {
    const val = env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
  };

  const chainId = Number(required("CHAIN_ID"));
  const alchemyApiKey = env.ALCHEMY_API_KEY;
  const chainlinkAlchemyKey = alchemyApiKey ?? alchemyKeyFromRpcUrl(env.ETHEREUM_RPC_URL);
  const ethNetwork = alchemyEthNetwork[chainId];

  return {
    bitcoinRpcUrl: alchemyApiKey
      ? alchemyRpcUrl("bitcoin-mainnet", alchemyApiKey)
      : required("BITCOIN_RPC_URL"),
    ethereumRpcUrl:
      alchemyApiKey && ethNetwork
        ? alchemyRpcUrl(ethNetwork, alchemyApiKey)
        : required("ETHEREUM_RPC_URL"),
    chainId,
    hashpriceBtcAddress: required("HASHPRICE_BTC_ADDRESS") as `0x${string}`,
    privateKey: required("PRIVATE_KEY") as `0x${string}`,
    logLevel: env.LOG_LEVEL ?? "info",
    pollIntervalMs: Number(env.KEEPER_POLL_INTERVAL_MS ?? "60000"),
    maxBatchSize: Number(env.KEEPER_MAX_BATCH_SIZE ?? "10"),
    btcUsdAddress: env.BTC_USD_ADDRESS as `0x${string}` | undefined,
    updateBtcUsd: ["1", "true"].includes((env.UPDATE_BTC_USD ?? "").toLowerCase()),
    // Base mainnet Chainlink BTC/USD. Dev's keeper chain is Sepolia, so the
    // read uses a mainnet RPC built from ALCHEMY_API_KEY or the key embedded
    // in ETHEREUM_RPC_URL.
    chainlinkBtcUsdAddress: env.CHAINLINK_BTC_USD_ADDRESS as `0x${string}` | undefined,
    chainlinkRpcUrl: chainlinkAlchemyKey ? alchemyRpcUrl("base-mainnet", chainlinkAlchemyKey) : undefined,
    confirmations: Number(env.KEEPER_CONFIRMATIONS) ?? 4,
  };
}

export type Config = ReturnType<typeof configFromEnv>;
