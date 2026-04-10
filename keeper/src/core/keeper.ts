import type { Logger } from "pino";
import type { KeeperConfig } from "../config.ts";
import { BitcoinProvider } from "./bitcoin.ts";
import { OracleClient } from "./oracle.ts";

export interface KeeperResult {
  oracleHeight: number;
  bitcoinTipHeight: number;
  blocksSubmitted: number;
  txHashes: string[];
}

/**
 * Core keeper logic — runtime-agnostic.
 * Reads oracle chain height, fetches missing Bitcoin blocks, and submits them.
 */
export async function runKeeper(config: KeeperConfig, log: Logger): Promise<KeeperResult> {
  const btc = new BitcoinProvider(config.bitcoinRpcUrl, log);
  const oracle = new OracleClient(config, log);

  const [oracleState, btcTip] = await Promise.all([
    oracle.getState(),
    btc.getTipHeight(),
  ]);

  log.info(
    {
      oracleHeight: oracleState.chainHeight,
      bitcoinTip: btcTip,
      lag: btcTip - oracleState.chainHeight,
    },
    "chain state comparison",
  );

  const lag = btcTip - oracleState.chainHeight;
  if (lag <= 0) {
    log.info("oracle is up to date");
    return {
      oracleHeight: oracleState.chainHeight,
      bitcoinTipHeight: btcTip,
      blocksSubmitted: 0,
      txHashes: [],
    };
  }

  const count = Math.min(lag, config.maxBatchSize);
  const startHeight = oracleState.chainHeight + 1;

  log.info({ startHeight, count }, "fetching Bitcoin blocks");
  const blocks = await btc.getBlockRange(startHeight, count);

  const txHashes: string[] = [];

  if (count === 1) {
    const prepared = oracle.prepareBlock(blocks[0]);
    const txHash = await oracle.submitBlock(prepared);
    txHashes.push(txHash);
  } else {
    const prepared = blocks.map((b) => oracle.prepareBlock(b));
    const txHash = await oracle.submitBlocks(oracleState.chainHeight, prepared);
    txHashes.push(txHash);
  }

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
