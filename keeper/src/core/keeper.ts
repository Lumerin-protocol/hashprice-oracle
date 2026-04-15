import type { Logger } from "pino";
import type { KeeperConfig } from "../config.ts";
import { BitcoinProvider } from "./bitcoin.ts";
import { updateBTCUSDMock } from "./btc-usd-mock.ts";
import { OracleClient } from "./oracle.ts";

export interface KeeperResult {
  oracleHeight: number;
  bitcoinTipHeight: number;
  blocksSubmitted: number;
  txHashes: string[];
}

/**
 * Ring buffer size in the contract. We can look back at most this many
 * blocks via getBlockFromTip() before slots wrap around and become stale.
 */
const ORACLE_BLOCK_BUFFER = 32;

/**
 * Convert an oracle-stored hash (bytes32, internal Bitcoin byte order)
 * to the display order returned by the Bitcoin RPC `getblockhash`.
 */
function toDisplayHash(bytes32: `0x${string}`): string {
  return Buffer.from(bytes32.slice(2), "hex").reverse().toString("hex");
}

/**
 * Walk back through the oracle's ring buffer comparing each stored block hash
 * with the canonical Bitcoin chain until a common ancestor is found.
 *
 * Returns the height of the common ancestor and whether a reorg was detected.
 * Throws if no common ancestor exists within ORACLE_BLOCK_BUFFER blocks.
 */
async function resolveAncestor(
  oracle: OracleClient,
  btc: BitcoinProvider,
  chainHeight: number,
  log: Logger,
): Promise<{ ancestorHeight: number; isReorg: boolean }> {
  const maxLookback = Math.min(chainHeight, ORACLE_BLOCK_BUFFER - 1);

  for (let i = 0; i <= maxLookback; i++) {
    const height = chainHeight - i;
    const [oracleEntry, btcHash] = await Promise.all([
      oracle.getBlockFromTip(i),
      btc.getBlockHash(height),
    ]);

    if (toDisplayHash(oracleEntry.blockHash) === btcHash) {
      if (i > 0) {
        log.warn({ reorgDepth: i, ancestorHeight: height }, "reorg detected, found common ancestor");
      }
      return { ancestorHeight: height, isReorg: i > 0 };
    }

    log.debug(
      { index: i, height, oracleHash: oracleEntry.blockHash, btcHash },
      "block mismatch during reorg scan",
    );
  }

  throw new Error(
    `Cannot find common ancestor within ${ORACLE_BLOCK_BUFFER} blocks — reorg too deep to handle`,
  );
}

/**
 * Core keeper logic — runtime-agnostic.
 * Reads oracle chain height, detects reorgs by comparing tip hashes, finds the
 * common ancestor if needed, then submits the canonical chain from that point.
 */
export async function runKeeper(config: KeeperConfig, log: Logger): Promise<KeeperResult> {
  const btc = new BitcoinProvider(config.bitcoinRpcUrl, log);
  const oracle = new OracleClient(config, log);

  if (config.btcUsdAddress) {
    await updateBTCUSDMock(config, log);
  }

  const [oracleState, btcTip] = await Promise.all([oracle.getState(), btc.getTipHeight()]);

  const { ancestorHeight, isReorg } = await resolveAncestor(
    oracle,
    btc,
    oracleState.chainHeight,
    log,
  );

  const lag = btcTip - ancestorHeight;

  log.info(
    {
      oracleHeight: oracleState.chainHeight,
      ancestorHeight,
      isReorg,
      bitcoinTip: btcTip,
      lag,
    },
    "chain state comparison",
  );

  if (!isReorg && lag <= 0) {
    log.info("oracle is up to date");
    return {
      oracleHeight: oracleState.chainHeight,
      bitcoinTipHeight: btcTip,
      blocksSubmitted: 0,
      txHashes: [],
    };
  }

  const count = Math.min(lag, config.maxBatchSize);
  const startHeight = ancestorHeight + 1;

  log.info({ startHeight, count, isReorg }, "fetching Bitcoin blocks");
  const blocks = await btc.getBlockRange(startHeight, count);

  const prepared = blocks.map((b) => oracle.prepareBlock(b));
  const txHash = await oracle.submitBlocks(ancestorHeight, prepared);
  const txHashes = [txHash];

  const newState = await oracle.getState();
  log.info(
    {
      newHeight: newState.chainHeight,
      blocksSubmitted: count,
      remaining: btcTip - newState.chainHeight,
    },
    "submission complete",
  );

  return {
    oracleHeight: newState.chainHeight,
    bitcoinTipHeight: btcTip,
    blocksSubmitted: count,
    txHashes,
  };
}
