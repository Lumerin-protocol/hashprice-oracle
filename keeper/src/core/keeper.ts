import type { Logger } from "pino";
import type { Config } from "../config.ts";
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
 * Throws if no common ancestor exists within the contract's ring buffer.
 *
 * `bufferSize` is the contract's BLOCK_BUFFER_SIZE. Beyond that the slots have wrapped
 * and getBlockFromTip reverts, so a deeper reorg is genuinely unrecoverable here.
 */
async function resolveAncestor(
  oracle: OracleClient,
  btc: BitcoinProvider,
  chainHeight: number,
  bufferSize: number,
  log: Logger,
  minBlock?: bigint,
): Promise<{ ancestorHeight: number; isReorg: boolean }> {
  const maxLookback = Math.min(chainHeight, bufferSize - 1);

  for (let i = 0; i <= maxLookback; i++) {
    const height = chainHeight - i;
    const [oracleEntry, btcHash] = await Promise.all([
      oracle.getBlockFromTip(i, minBlock),
      btc.getBlockHash(height),
    ]);

    if (toDisplayHash(oracleEntry.blockHash) === btcHash) {
      if (i > 0) {
        log.warn(
          { reorgDepth: i, ancestorHeight: height },
          "reorg detected, found common ancestor",
        );
      }
      return { ancestorHeight: height, isReorg: i > 0 };
    }

    log.debug(
      { index: i, height, oracleHash: oracleEntry.blockHash, btcHash },
      "block mismatch during reorg scan",
    );
  }

  throw new Error(
    `Cannot find common ancestor within ${bufferSize} blocks — reorg too deep to handle`,
  );
}

/**
 * Core keeper logic — runtime-agnostic.
 * Reads oracle chain height, detects reorgs by comparing tip hashes, finds the
 * common ancestor if needed, then submits the canonical chain from that point.
 */
export async function runKeeper(config: Config, log: Logger): Promise<KeeperResult> {
  const btc = new BitcoinProvider(config.bitcoinRpcUrl, log);
  const oracle = new OracleClient(config, log);

  if (config.btcUsdAddress) {
    await updateBTCUSDMock(config, log);
  }

  // Tracks the L2 block of our most recent write. Threaded into subsequent
  // reads so a load-balanced RPC can't serve us pre-tx state from a stale
  // backend node and trick us into re-submitting blocks already on-chain
  // (which would revert with NotHeaviestChain).
  let minReadBlock: bigint | undefined;

  const bufferSize = await oracle.getBlockBufferSize();
  log.debug({ bufferSize }, "read ring buffer size from contract");

  for (;;) {
    const [oracleState, btcTip] = await Promise.all([
      oracle.getState(minReadBlock),
      btc.getTipHeight(),
    ]);
    const { ancestorHeight, isReorg } = await resolveAncestor(
      oracle,
      btc,
      oracleState.chainHeight,
      bufferSize,
      log,
      minReadBlock,
    );

    const lag = btcTip - ancestorHeight;

    if (!isReorg && lag <= 0) {
      return {
        oracleHeight: oracleState.chainHeight,
        bitcoinTipHeight: btcTip,
        blocksSubmitted: 0,
        txHashes: [],
      };
    }
    log.info(
      {
        oracleHeight: oracleState.chainHeight,
        ancestorHeight,
        isReorg,
        bitcoinTip: btcTip,
        lag,
      },
      "oracle is behind the Bitcoin chain",
    );

    const count = Math.min(lag, config.maxBatchSize);
    const startHeight = ancestorHeight + 1;

    log.debug({ startHeight, count, isReorg }, "fetching Bitcoin blocks");
    const blocks = await btc.getBlockRange(startHeight, count);

    const prepared = blocks.map((b) => oracle.prepareBlock(b));

    // submitBlock appends to the tip and takes no ancestor, so it only covers a plain
    // single-block extension — which is the steady state, one block per ~10 minutes.
    // It costs about 4,400 gas less than submitBlocks for that case, mostly the
    // array-of-arrays calldata encoding and the ancestor buffer read it avoids.
    const receipt =
      !isReorg && prepared.length === 1
        ? await oracle.submitBlock(prepared[0])
        : await oracle.submitBlocks(ancestorHeight, prepared);
    minReadBlock = receipt.blockNumber;

    log.info(
      {
        txHash: receipt.transactionHash,
        gasUsed: receipt.gasUsed.toString(),
        blocksSubmitted: count,
        remaining: btcTip - oracleState.chainHeight - count,
      },
      "block submission complete",
    );
  }
}
