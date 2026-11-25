import type { Logger } from "pino";
import type { Config } from "../config.ts";
import { type BlockData, BitcoinProvider } from "./bitcoin.ts";
import { updateBTCUSDMock } from "./btc-usd-mock.ts";
import { OracleClient } from "./oracle.ts";
import { type SendOutcome, type TxRequest, TxSender, revertErrorName } from "./txSend.ts";

export interface KeeperResult {
  oracleHeight: number;
  bitcoinTipHeight: number;
  blocksSubmitted: number;
  txHashes: string[];
}

interface Plan {
  oracleHeight: number;
  btcTip: number;
  ancestorHeight: number;
  isReorg: boolean;
  /** Empty when the oracle is up to date. */
  blocks: BlockData[];
}

type PlannedTx = TxRequest & { plan: Plan };

/** The dev BTC/USD mock keeps the 5-minute cadence the old Lambda schedule had. */
const BTC_USD_UPDATE_INTERVAL_MS = 300_000;

/**
 * Convert an oracle-stored hash (bytes32, internal Bitcoin byte order)
 * to the display order returned by the Bitcoin RPC `getblockhash`.
 */
function toDisplayHash(bytes32: `0x${string}`): string {
  return Buffer.from(bytes32.slice(2), "hex").reverse().toString("hex");
}

/** Header timestamp: bytes 68..71, little-endian. */
export function headerTime(rawHeader: string): number {
  return Buffer.from(rawHeader.replace(/^0x/, ""), "hex").readUInt32LE(68);
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

export interface RelayOptions {
  /** Called whenever the relay makes progress (each Base block while a tx is pending). */
  onHeartbeat?: () => void;
}

/**
 * Core keeper logic — runtime-agnostic. One instance per process: it owns the clients and the
 * only sender for the relay key, so fee state for a pending nonce survives across ticks.
 */
export class Relay {
  private readonly config: Config;
  private readonly log: Logger;
  private readonly btc: BitcoinProvider;
  private readonly oracle: OracleClient;
  private readonly sender: TxSender;
  /** After an equal-work NotHeaviestChain, skip submitting until Bitcoin passes this height. */
  private waitForBtcAbove?: number;
  /** When the relay first saw each pending Bitcoin height; header times are miner-set. */
  private readonly seenAt = new Map<number, number>();
  private lastBtcUsdUpdateAt = 0;

  constructor(config: Config, log: Logger, opts: RelayOptions = {}) {
    this.config = config;
    this.log = log;
    this.btc = new BitcoinProvider(config.bitcoinRpcUrl);
    this.oracle = new OracleClient(config, log);
    this.sender = new TxSender({
      pc: this.oracle.pc,
      address: this.oracle.wc.account.address,
      log,
      confirmations: config.confirmations,
      onHeartbeat: opts.onHeartbeat,
    });
  }

  /**
   * Reads oracle chain height, detects reorgs by comparing tip hashes, finds the
   * common ancestor if needed, then submits the canonical chain from that point.
   */
  async tick(): Promise<KeeperResult> {
    const { config, log } = this;

    if (config.updateBtcUsd && Date.now() - this.lastBtcUsdUpdateAt >= BTC_USD_UPDATE_INTERVAL_MS) {
      this.lastBtcUsdUpdateAt = Date.now();
      try {
        await updateBTCUSDMock(config, log);
      } catch (err) {
        log.error({ err }, "BTC/USD mock update failed; continuing with block submission");
      }
    }

    // Tracks the L2 block of our most recent write. Threaded into subsequent
    // reads so a load-balanced RPC can't serve us pre-tx state from a stale
    // backend node and trick us into re-submitting blocks already on-chain
    // (which would revert with NotHeaviestChain).
    let minReadBlock: bigint | undefined;
    let blocksSubmitted = 0;
    const txHashes: string[] = [];

    for (;;) {
      const plan = await this.plan(minReadBlock);
      const result = {
        oracleHeight: plan.oracleHeight,
        bitcoinTipHeight: plan.btcTip,
        blocksSubmitted,
        txHashes,
      };
      if (plan.blocks.length === 0) return result;
      if (this.waitForBtcAbove !== undefined && plan.btcTip <= this.waitForBtcAbove) {
        log.debug({ btcTip: plan.btcTip }, "waiting for the next Bitcoin block after NotHeaviestChain");
        return result;
      }
      this.waitForBtcAbove = undefined;

      log.info(
        {
          oracleHeight: plan.oracleHeight,
          ancestorHeight: plan.ancestorHeight,
          isReorg: plan.isReorg,
          bitcoinTip: plan.btcTip,
          lag: plan.btcTip - plan.ancestorHeight,
        },
        "oracle is behind the Bitcoin chain",
      );

      let first = true;
      const build = async (): Promise<PlannedTx> => {
        const p = first ? plan : await this.plan(minReadBlock);
        first = false;
        if (p.blocks.length === 0) throw new Error("oracle is up to date; nothing to rebuild");
        return { ...(await this.buildTx(p)), plan: p };
      };

      let outcome: SendOutcome<PlannedTx>;
      try {
        outcome = await this.sender.send(build);
      } catch (err) {
        if (revertErrorName(err) === "NotHeaviestChain" && this.isEqualHeightReplacement(plan)) {
          this.waitForBtcAbove = plan.btcTip;
          log.warn(
            { oracleHeight: plan.oracleHeight, ancestorHeight: plan.ancestorHeight, btcTip: plan.btcTip },
            "NotHeaviestChain at the oracle's height (equal-work orphan holds the tip); retrying after the next Bitcoin block",
          );
          return result;
        }
        throw err;
      }

      if (outcome.kind === "superseded") {
        minReadBlock = outcome.blockNumber;
        continue;
      }

      const { receipt, bumps, unminedMs } = outcome;
      const sentPlan = outcome.tx.plan;
      minReadBlock = receipt.blockNumber;
      txHashes.push(receipt.transactionHash);

      if (receipt.status !== "success") {
        log.warn(
          { txHash: receipt.transactionHash, blockNumber: receipt.blockNumber.toString() },
          "relay tx reverted; re-reading oracle state",
        );
        continue;
      }

      blocksSubmitted += sentPlan.blocks.length;
      const newest = sentPlan.blocks[sentPlan.blocks.length - 1];
      const inclusion = await this.oracle.pc.getBlock({ blockNumber: receipt.blockNumber });
      const includedAt = Number(inclusion.timestamp);
      const seenAt = this.seenAt.get(newest.height) ?? Date.now();
      for (const h of this.seenAt.keys()) if (h <= newest.height) this.seenAt.delete(h);
      log.info(
        {
          event: "relayed",
          height: newest.height,
          blocks: sentPlan.blocks.length,
          latencySec: includedAt - headerTime(newest.rawHeader),
          relaySec: Math.max(0, Math.round(includedAt - seenAt / 1000)),
          unminedSec: Math.round(unminedMs / 1000),
          bumps,
          txHash: receipt.transactionHash,
          gasUsed: receipt.gasUsed.toString(),
          remaining: sentPlan.btcTip - newest.height,
        },
        "block submission complete",
      );
    }
  }

  private async plan(minReadBlock?: bigint): Promise<Plan> {
    const bufferSize = await this.oracle.getBlockBufferSize();
    const [oracleState, btcTip] = await Promise.all([
      this.oracle.getState(minReadBlock),
      this.btc.getTipHeight(),
    ]);
    const { ancestorHeight, isReorg } = await resolveAncestor(
      this.oracle,
      this.btc,
      oracleState.chainHeight,
      bufferSize,
      this.log,
      minReadBlock,
    );

    const lag = btcTip - ancestorHeight;
    const count = Math.min(lag, this.config.maxBatchSize);
    const base = { oracleHeight: oracleState.chainHeight, btcTip, ancestorHeight, isReorg };
    if (count <= 0 || (!isReorg && lag <= 0)) return { ...base, blocks: [] };

    const now = Date.now();
    for (let h = ancestorHeight + 1; h <= btcTip; h++) if (!this.seenAt.has(h)) this.seenAt.set(h, now);

    this.log.debug({ startHeight: ancestorHeight + 1, count, isReorg }, "fetching Bitcoin blocks");
    return { ...base, blocks: await this.btc.getBlockRange(ancestorHeight + 1, count) };
  }

  private buildTx(plan: Plan): Promise<TxRequest> {
    const prepared = plan.blocks.map((b) => this.oracle.prepareBlock(b));
    // submitBlock appends to the tip and takes no ancestor, so it only covers a plain
    // single-block extension — which is the steady state, one block per ~10 minutes.
    // It costs about 4,400 gas less than submitBlocks for that case, mostly the
    // array-of-arrays calldata encoding and the ancestor buffer read it avoids.
    return !plan.isReorg && prepared.length === 1
      ? this.oracle.buildSubmitBlock(prepared[0])
      : this.oracle.buildSubmitBlocks(plan.ancestorHeight, prepared);
  }

  /** The batch only reaches the oracle's own height, so equal work cannot replace its tip. */
  private isEqualHeightReplacement(plan: Plan): boolean {
    return plan.isReorg && plan.ancestorHeight + plan.blocks.length <= plan.oracleHeight;
  }
}
