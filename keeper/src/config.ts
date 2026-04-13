import type { Chain } from "viem";
import { arbitrum, arbitrumSepolia, base, baseSepolia, mainnet, hardhat } from "viem/chains";

export interface KeeperConfig {
  bitcoinRpcUrl: string;
  ethereumRpcUrl: string;
  chainId: number;
  hashpriceBtcAddress: `0x${string}`;
  privateKey: `0x${string}`;
  logLevel: string;
  pollIntervalMs: number;
  maxBatchSize: number;
}

const chainMap: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [arbitrum.id]: arbitrum,
  [arbitrumSepolia.id]: arbitrumSepolia,
  [base.id]: base,
  [baseSepolia.id]: baseSepolia,
  [hardhat.id]: hardhat,
};

export function getChain(chainId: number): Chain {
  const chain = chainMap[chainId];
  if (!chain) throw new Error(`Unsupported chain ID: ${chainId}`);
  return chain;
}

export function configFromEnv(env: Record<string, string | undefined>): KeeperConfig {
  const required = (key: string): string => {
    const val = env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
  };

  return {
    bitcoinRpcUrl: required("BITCOIN_RPC_URL"),
    ethereumRpcUrl: required("ETHEREUM_RPC_URL"),
    chainId: Number(required("CHAIN_ID")),
    hashpriceBtcAddress: required("HASHPRICE_BTC_ADDRESS") as `0x${string}`,
    privateKey: required("PRIVATE_KEY") as `0x${string}`,
    logLevel: env["LOG_LEVEL"] ?? "info",
    pollIntervalMs: Number(env["POLL_INTERVAL_MS"] ?? "60000"),
    maxBatchSize: Number(env["MAX_BATCH_SIZE"] ?? "10"),
  };
}
