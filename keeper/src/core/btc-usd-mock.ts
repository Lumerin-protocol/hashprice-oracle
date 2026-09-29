import type { Logger } from "pino";
import {
  type Account,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { BTCUSDMockAbi } from "../abi/BTCUSDMock.ts";
import type { Config } from "../config.ts";
import { getChain } from "../config.ts";

const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";

const chainlinkAbi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

function scaleDecimals(value: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return value;
  if (fromDecimals < toDecimals) return value * 10n ** BigInt(toDecimals - fromDecimals);
  return value / 10n ** BigInt(fromDecimals - toDecimals);
}

async function fetchCoinGeckoPrice(): Promise<number> {
  const response = await fetch(COINGECKO_URL, {
    headers: { "User-Agent": "hashprice-oracle-keeper", Accept: "application/json" },
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Failed to parse CoinGecko response (status ${response.status}): ${text.substring(0, 500)}`,
    );
  }

  const price = (data as { bitcoin?: { usd?: number } })?.bitcoin?.usd;
  if (!price) {
    throw new Error(`Unexpected CoinGecko response format: ${text.substring(0, 500)}`);
  }

  return price;
}

async function fetchChainlinkPrice(config: Config, mockDecimals: number): Promise<bigint> {
  const address = config.chainlinkBtcUsdAddress;
  if (!address) throw new Error("CHAINLINK_BTC_USD_ADDRESS is not set");

  const rpcUrl = config.chainId === base.id ? config.ethereumRpcUrl : config.chainlinkRpcUrl;
  if (!rpcUrl) {
    throw new Error("No Base mainnet RPC for the Chainlink BTC/USD read");
  }

  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const [feedDecimals, round] = await Promise.all([
    client.readContract({ address, abi: chainlinkAbi, functionName: "decimals" }),
    client.readContract({ address, abi: chainlinkAbi, functionName: "latestRoundData" }),
  ]);

  const answer = round[1];
  const updatedAt = round[3];
  if (answer <= 0n || updatedAt === 0n) {
    throw new Error(`Chainlink BTC/USD round is unusable (answer=${answer}, updatedAt=${updatedAt})`);
  }

  return scaleDecimals(answer, feedDecimals, mockDecimals);
}

export async function updateBTCUSDMock(config: Config, log: Logger): Promise<void> {
  if (!config.btcUsdAddress) {
    throw new Error("UPDATE_BTC_USD is enabled but BTC_USD_ADDRESS is not set");
  }

  const child = log.child({ component: "btc-usd-mock" });

  const chain = getChain(config.chainId);
  const transport = http(config.ethereumRpcUrl);
  const account = privateKeyToAccount(config.privateKey);

  const pc: PublicClient<Transport, Chain> = createPublicClient({ chain, transport });
  const wc: WalletClient<Transport, Chain, Account> = createWalletClient({
    chain,
    transport,
    account,
  });

  const address = config.btcUsdAddress;

  const decimals = await pc.readContract({
    address,
    abi: BTCUSDMockAbi,
    functionName: "decimals",
  });

  let priceBigInt: bigint;
  if (config.chainlinkBtcUsdAddress) {
    priceBigInt = await fetchChainlinkPrice(config, decimals);
    child.debug({ price: priceBigInt.toString() }, "fetched BTC/USD from Chainlink");
  } else {
    const exchangeRate = await fetchCoinGeckoPrice();
    child.debug({ exchangeRate }, "fetched BTC/USD exchange rate from CoinGecko");
    priceBigInt = parseUnits(exchangeRate.toString(), decimals);
  }

  const latestRoundData = await pc.readContract({
    address,
    abi: BTCUSDMockAbi,
    functionName: "latestRoundData",
  });

  if (latestRoundData[1] === priceBigInt) {
    child.info({ price: priceBigInt.toString() }, "BTC/USD price is up to date");
    return;
  }

  const { request } = await pc.simulateContract({
    address,
    abi: BTCUSDMockAbi,
    functionName: "setPrice",
    args: [priceBigInt],
    account,
  });

  const txHash = await wc.writeContract(request);

  const receipt = await pc.waitForTransactionReceipt({
    hash: txHash,
    confirmations: config.confirmations,
  });
  child.info(
    { txHash, gasUsed: receipt.gasUsed.toString(), status: receipt.status, price: priceBigInt.toString() },
    "BTC/USD mock price updated",
  );
}
