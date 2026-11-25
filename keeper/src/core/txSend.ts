import type { Logger } from "pino";
import type { Hex, PublicClient, TransactionReceipt } from "viem";
import { BaseError, ContractFunctionRevertedError, parseEther, parseGwei } from "viem";

/** Base blocks sampled by eth_feeHistory for the tip. */
export const FEE_HISTORY_BLOCKS = 20;
/** RPC tip suggestions went to 0.001 gwei on 2026-11-02 while only 0.01+ landed. */
export const MIN_TIP = parseGwei("0.01");
export const MAX_TIP = parseGwei("1");
/** gas × maxFeePerGas never exceeds this; at the cap the sender keeps waiting. */
export const MAX_TX_FEE_WEI = parseEther("0.002");
export const GAS_HEADROOM_PCT = 20n;
/** Unmined for this many Base blocks → rebuild to the Bitcoin tip and replace. */
export const REPLACE_AFTER_BLOCKS = 10n;
export const REPLACE_BUMP_PCT = 25n;
/** Nodes reject a same-nonce replacement unless both fees rise by at least this much. */
export const MIN_REPLACE_BUMP_PCT = 10n;
export const BLOCK_POLL_MS = 2_000;
export const UNMINED_LOG_INTERVAL_MS = 60_000;

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface FeeMarket {
  baseFee: bigint;
  medianTip: bigint;
  p75Tip: bigint;
}

const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

export function bump(value: bigint, pct: bigint): bigint {
  return (value * (100n + pct) + 99n) / 100n;
}

export function withGasHeadroom(estimate: bigint): bigint {
  return bump(estimate, GAS_HEADROOM_PCT);
}

function median(values: bigint[]): bigint {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor(sorted.length / 2)];
}

function clampTip(tip: bigint): bigint {
  return min(max(tip, MIN_TIP), MAX_TIP);
}

export async function readFeeMarket(pc: PublicClient): Promise<FeeMarket> {
  const history = await pc.getFeeHistory({
    blockCount: FEE_HISTORY_BLOCKS,
    rewardPercentiles: [50, 75],
    blockTag: "latest",
  });
  const rewards = history.reward ?? [];
  return {
    // The last entry is the next block's base fee.
    baseFee: history.baseFeePerGas.at(-1) ?? 0n,
    medianTip: median(rewards.map((r) => r[0] ?? 0n)),
    p75Tip: median(rewards.map((r) => r[1] ?? 0n)),
  };
}

export function initialFees(market: FeeMarket): Fees {
  const tip = clampTip(market.medianTip);
  return { maxPriorityFeePerGas: tip, maxFeePerGas: market.baseFee * 2n + tip };
}

export function replacementFees(prev: Fees, market: FeeMarket): Fees {
  const tip = clampTip(max(bump(prev.maxPriorityFeePerGas, REPLACE_BUMP_PCT), market.p75Tip));
  return {
    maxPriorityFeePerGas: tip,
    maxFeePerGas: max(bump(prev.maxFeePerGas, REPLACE_BUMP_PCT), market.baseFee * 2n + tip),
  };
}

export function capToBudget(fees: Fees, gas: bigint): Fees {
  const maxFeeCap = MAX_TX_FEE_WEI / gas;
  if (fees.maxFeePerGas <= maxFeeCap) return fees;
  return {
    maxFeePerGas: maxFeeCap,
    maxPriorityFeePerGas: min(fees.maxPriorityFeePerGas, maxFeeCap),
  };
}

export function isValidReplacement(prev: Fees, next: Fees): boolean {
  return (
    next.maxPriorityFeePerGas >= bump(prev.maxPriorityFeePerGas, MIN_REPLACE_BUMP_PCT) &&
    next.maxFeePerGas >= bump(prev.maxFeePerGas, MIN_REPLACE_BUMP_PCT)
  );
}

function errorHaystack(err: unknown): string[] {
  const out: string[] = [];
  let current: unknown = err;
  for (let i = 0; i < 8 && current; i++) {
    if (current instanceof Error) {
      out.push(`${current.name} ${current.message}`);
      current = (current as { cause?: unknown }).cause;
    } else if (typeof current === "object" && current !== null) {
      const o = current as { message?: unknown; shortMessage?: unknown; details?: unknown; cause?: unknown };
      for (const v of [o.message, o.shortMessage, o.details]) {
        if (typeof v === "string") out.push(v);
      }
      current = o.cause;
    } else {
      out.push(String(current));
      break;
    }
  }
  return out;
}

/** We still own the nonce and the node wants higher fees. */
export function isReplacementUnderpricedError(err: unknown): boolean {
  const pattern =
    /replacement transaction underpriced|underpriced|already known|same as the current|fee too low|max fee per gas less than block base fee/i;
  return errorHaystack(err).some((s) => pattern.test(s));
}

/** The nonce was consumed (by one of our hashes or another sender), or our count is off. */
export function isNonceDesyncError(err: unknown): boolean {
  const pattern =
    /nonce too low|lower than the current nonce|nonce too high|nonce has already been used|invalid nonce|oldnonce|noncetoolow|noncetoohigh/i;
  return errorHaystack(err).some((s) => pattern.test(s));
}

export function revertErrorName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
}

export interface TxRequest {
  label: string;
  gas: bigint;
  send(params: { nonce: number; gas: bigint } & Fees): Promise<Hex>;
}

export type SendOutcome<T extends TxRequest> =
  | { kind: "mined"; receipt: TransactionReceipt; tx: T; bumps: number; unminedMs: number }
  | { kind: "superseded"; blockNumber: bigint };

export interface TxSenderDeps {
  pc: PublicClient;
  address: `0x${string}`;
  log: Logger;
  confirmations: number;
  /** Called on each new Base block while a transaction is pending. */
  onHeartbeat?: () => void;
  blockPollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

type Broadcast = { status: "sent"; fees: Fees } | { status: "nonce-consumed" } | { status: "capped" };

/**
 * One long-lived sender for the relay key. No cancel transaction and no time limit unless the
 * caller passes a deadline (the Lambda adapter); the unmined-age alarm pages instead.
 */
export class TxSender {
  private readonly deps: TxSenderDeps;
  private readonly log: Logger;
  private nextNonce = 0;

  constructor(deps: TxSenderDeps) {
    this.deps = deps;
    this.log = deps.log.child({ component: "txSend" });
  }

  async send<T extends TxRequest>(build: () => Promise<T>, opts: { deadline?: number } = {}): Promise<SendOutcome<T>> {
    const { pc, address, confirmations } = this.deps;
    const now = this.deps.now ?? Date.now;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const pollMs = this.deps.blockPollMs ?? BLOCK_POLL_MS;

    let tx = await build();
    const latest = await pc.getTransactionCount({ address, blockTag: "latest" });
    // A load-balanced RPC can report the count from before our last receipt.
    const nonce = Math.max(latest, this.nextNonce);
    let market = await readFeeMarket(pc);
    let fees = capToBudget(initialFees(market), tx.gas);
    const sent = new Map<Hex, T>();
    let bumps = 0;
    const firstSentAt = now();

    const broadcast = async (reason: string): Promise<Broadcast> => {
      for (;;) {
        try {
          const hash = await tx.send({ nonce, gas: tx.gas, ...fees });
          sent.set(hash, tx);
          this.log.info(
            { label: tx.label, txHash: hash, nonce, gas: tx.gas.toString(), ...feeFields(fees), reason },
            "tx sent",
          );
          return { status: "sent", fees };
        } catch (err) {
          if (isNonceDesyncError(err)) return { status: "nonce-consumed" };
          if (!isReplacementUnderpricedError(err)) throw err;
          const next = capToBudget(replacementFees(fees, market), tx.gas);
          if (!isValidReplacement(fees, next)) return { status: "capped" };
          fees = next;
          bumps++;
          this.log.warn(
            { event: "fee_bump", reason: "underpriced", label: tx.label, nonce, ...feeFields(fees) },
            "replacement underpriced; bumping fee",
          );
          reason = "underpriced";
        }
      }
    };

    const first = await broadcast("new");
    if (first.status === "capped") {
      this.log.warn({ event: "fee_cap", nonce, ...feeFields(fees) }, "fee cap reached; waiting");
    }

    let sentAtBlock = await pc.getBlockNumber();
    let lastBlock = sentAtBlock;
    let lastUnminedLog = firstSentAt;
    let cappedWarned = first.status === "capped";
    let checkNonce = first.status === "nonce-consumed";

    for (;;) {
      if (!checkNonce) {
        if (opts.deadline !== undefined && now() > opts.deadline) {
          throw new Error(`${tx.label} unmined at nonce ${nonce} at the deadline; next run continues`);
        }
        await sleep(pollMs);
        const head = await pc.getBlockNumber();
        if (head === lastBlock) continue;
        lastBlock = head;
        this.deps.onHeartbeat?.();
      }
      checkNonce = false;

      const found = await this.findReceipt(sent);
      if (found) {
        const head = lastBlock > found.receipt.blockNumber ? lastBlock : found.receipt.blockNumber;
        if (head - found.receipt.blockNumber + 1n < BigInt(confirmations)) continue;
        this.nextNonce = nonce + 1;
        return { kind: "mined", receipt: found.receipt, tx: found.tx, bumps, unminedMs: now() - firstSentAt };
      }

      const onChain = await pc.getTransactionCount({ address, blockTag: "latest" });
      if (onChain > nonce) {
        this.nextNonce = onChain;
        this.log.warn({ nonce, onChainNonce: onChain }, "nonce consumed by a transaction we did not track");
        return { kind: "superseded", blockNumber: lastBlock };
      }

      if (now() - lastUnminedLog >= UNMINED_LOG_INTERVAL_MS) {
        lastUnminedLog = now();
        this.log.warn(
          {
            event: "tx_unmined",
            label: tx.label,
            nonce,
            unminedSec: Math.round((now() - firstSentAt) / 1000),
            hashes: sent.size,
            bumps,
            ...feeFields(fees),
          },
          "relay tx still unmined",
        );
      }

      if (lastBlock - sentAtBlock < REPLACE_AFTER_BLOCKS) continue;
      sentAtBlock = lastBlock;

      try {
        tx = await build();
      } catch (err) {
        this.log.warn({ err: shortError(err), nonce }, "rebuild failed; replacing the current batch");
      }
      market = await readFeeMarket(pc);
      const next = capToBudget(replacementFees(fees, market), tx.gas);
      if (!isValidReplacement(fees, next)) {
        if (!cappedWarned) {
          cappedWarned = true;
          this.log.warn({ event: "fee_cap", nonce, ...feeFields(fees) }, "fee cap reached; waiting");
        }
        continue;
      }
      fees = next;
      bumps++;
      this.log.warn(
        { event: "fee_bump", reason: "unmined", label: tx.label, nonce, ...feeFields(fees) },
        `unmined for ${REPLACE_AFTER_BLOCKS} blocks; replacing`,
      );
      try {
        const result = await broadcast("unmined");
        if (result.status === "nonce-consumed") checkNonce = true;
        if (result.status === "capped" && !cappedWarned) {
          cappedWarned = true;
          this.log.warn({ event: "fee_cap", nonce, ...feeFields(fees) }, "fee cap reached; waiting");
        }
      } catch (err) {
        if (sent.size === 0) throw err;
        this.log.warn({ err: shortError(err), nonce }, "replacement failed; waiting on sent hashes");
      }
    }
  }

  private async findReceipt<T extends TxRequest>(
    sent: Map<Hex, T>,
  ): Promise<{ receipt: TransactionReceipt; tx: T } | undefined> {
    for (const [hash, tx] of sent) {
      const receipt = await this.deps.pc.getTransactionReceipt({ hash }).catch(() => undefined);
      if (receipt) return { receipt, tx };
    }
    return undefined;
  }
}

function feeFields(fees: Fees) {
  return {
    maxFeePerGas: fees.maxFeePerGas.toString(),
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
  };
}

/** viem's short message only: the full message can repeat calldata and the RPC URL. */
export function shortError(err: unknown): { name?: string; message: string } {
  if (err instanceof BaseError) return { name: err.name, message: err.shortMessage };
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { message: String(err) };
}
