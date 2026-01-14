import { env } from "./env";
import { createClient, createPublicClient, getContract, http, parseUnits } from "viem";
import { getChain } from "./chain";
import { hashrateOracleAbi, priceOracleAbi } from "./abi";
import pino from "pino";
import { privateKeyToAccount } from "viem/accounts";
import { BitcoinClient } from "./bitcoin";
import { RewardCalculator } from "./reward";
import { FileCache } from "./cache";
import { Coingecko } from "./coingecko";
import { getPrivateKey } from "./secrets";

export async function main() {
  const log = pino({
    level: env.LOG_LEVEL,
  });

  log.info("Starting job");

  // Retrieve private key securely from Secrets Manager (or use env var for local dev)
  const privateKey = await getPrivateKey(log);
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const transport = http(env.ETHEREUM_RPC_URL);
  const chain = getChain(env.CHAIN_ID);

  const pc = createPublicClient({ transport, chain });
  const client = createClient({ transport, chain, account });

  const oracleContract = getContract({
    address: env.HASHRATE_ORACLE_ADDRESS as `0x${string}`,
    abi: hashrateOracleAbi,
    client,
  });

  const SMA_PERIOD = 144;

  const cache = new FileCache(SMA_PERIOD, {
    parameterName: env.CACHE_PARAMETER_NAME,
    useParameterStore: env.CACHE_PARAMETER_NAME !== undefined,
    logger: log,
  });
  const bitcoinClient = new BitcoinClient(env.BITCOIN_RPC_URL);
  const rewardCalculator = new RewardCalculator(bitcoinClient, cache);

  try {
    // Wait for cache to be loaded
    await cache.ready();

    const index = await rewardCalculator.getIndex(SMA_PERIOD);
    log.info("Index: %s BTC/PH/day", index);
    const latest = await rewardCalculator.getLastIndexData(SMA_PERIOD);

    // Excplicity save cache
    await cache.save();

    log.info(
      "Latest data: latest block Number: %s, latest subsidy: %s, difficulty: %s, average TX fees: %s, hashes per block: %s, hashes per BTC: %s",
      latest.blockNumber,
      latest.subsidy,
      latest.difficulty,
      latest.averageTxFees,
      latest.hashesPerBlock,
      latest.hashesForBTC
    );
    const oldHashesForBTC = await oracleContract.read.getHashesForBTC();

    log.info("Old hashes for BTC: %s", oldHashesForBTC.value);
    log.info("New hashes for BTC: %s", latest.hashesForBTC);
    if (latest.hashesForBTC !== oldHashesForBTC.value) {
      const hash = await oracleContract.write.setHashesForBTC([latest.hashesForBTC]);
      await pc.waitForTransactionReceipt({ hash });
      log.info("Hashes for BTC updated onchain: %s", hash);
    } else {
      log.info("Hashes for BTC update skipped");
    }

    //
    // Update BTC/USD price oracle on dev
    //

    if (env.BTCUSD_ORACLE_ADDRESS !== undefined) {
      const coingecko = new Coingecko();
      const exchangeRate = await coingecko.getBTCUSDExchangeRate();
      log.info("Exchange rate: %s", exchangeRate);
      const oracle = getContract({
        address: env.BTCUSD_ORACLE_ADDRESS as `0x${string}`,
        abi: priceOracleAbi,
        client,
      });

      const oracleDecimals = await oracle.read.decimals();
      const exchangeRateBigInt = parseUnits(exchangeRate.toString(), oracleDecimals);

      const latestRoundData = await oracle.read.latestRoundData();
      log.info("Latest round data: %s", latestRoundData);

      if (latestRoundData[1] === exchangeRateBigInt) {
        log.info("Exchange rate is up to date");
        return;
      }

      const tx = await oracle.write.setPrice([exchangeRateBigInt, oracleDecimals]);
      log.info("Transaction hash: %s", tx);

      await pc.waitForTransactionReceipt({ hash: tx });
      log.info("Exchange rate updated onchain: %s", tx);

      const indexUSD = index * exchangeRate;
      log.info("Index: %s USD/PH/day", indexUSD);
    }

    log.info("Job completed");
  } catch (error) {
    log.error("Job failed: %s", error);
    throw error;
  } finally {
    log.flush();
  }
}
