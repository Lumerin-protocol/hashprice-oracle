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
import { BTCUSDMockAbi } from "../abi/BTCUSDMock.ts";
import type { KeeperConfig } from "../config.ts";
import { getChain } from "../config.ts";

const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";

async function fetchBTCUSDPrice(): Promise<number> {
  const response = await fetch(COINGECKO_URL);
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

export async function updateBTCUSDMock(config: KeeperConfig, log: Logger): Promise<void> {
  if (!config.btcUsdAddress) return;

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

  const [exchangeRate, decimals] = await Promise.all([
    fetchBTCUSDPrice(),
    pc.readContract({ address, abi: BTCUSDMockAbi, functionName: "decimals" }),
  ]);

  child.info({ exchangeRate }, "fetched BTC/USD exchange rate from CoinGecko");

  const priceBigInt = parseUnits(exchangeRate.toString(), decimals);

  const latestRoundData = await pc.readContract({
    address,
    abi: BTCUSDMockAbi,
    functionName: "latestRoundData",
  });

  if (latestRoundData[1] === priceBigInt) {
    child.info("BTC/USD price is already up to date");
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
  child.info({ txHash }, "setPrice tx sent");

  const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
  child.info(
    { txHash, gasUsed: receipt.gasUsed.toString(), status: receipt.status },
    "BTC/USD mock price updated",
  );
}
