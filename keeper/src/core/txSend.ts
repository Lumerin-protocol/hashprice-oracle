import type { Logger } from "pino";
import type {
  Account,
  Chain,
  Hex,
  PublicClient,
  TransactionReceipt,
  Transport,
  WalletClient,
} from "viem";
import { parseEther, parseGwei } from "viem";

/**
 * Hardcoded self-heal caps — no env knobs.
 *
 * Designed so a wedged oracle nonce recovers the way we did manually
 * (bump → bump → cancel) without unbounded fee escalation.
 */
/** EIP-1559 replacement requires ≥10%; 20% gives headroom across RPCs. */
export const FEE_BUMP_PCT = 20;
/** Replacements per logical write before escalating to a cancel-tx. */
export const MAX_REPLACE_ATTEMPTS = 4;
/**
 * Cap receipt wait so a Lambda (or short-lived runner) can exit cleanly and
 * the next cycle continues bumping, instead of dying mid-wait on the same hash.
 */
export const RECEIPT_WAIT_MS = 45_000;
/** Absolute tip ceiling (gwei). */
export const MAX_PRIORITY_FEE = parseGwei("5");
/**
 * Absolute maxFeePerGas ceiling (gwei). Sized so a full submitBlocks gas
 * limit (~1.5M) at this fee stays under MAX_TX_FEE_WEI on Base.
 */
export const MAX_FEE_PER_GAS = parseGwei("20");
/** Refuse a send if gasLimit × maxFeePerGas would exceed this (~0.05 ETH). */
export const MAX_TX_FEE_WEI = parseEther("0.05");

export interface FeeCaps {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface TxSendDeps {
  pc: PublicClient;
  wc: WalletClient<Transport, Chain, Account>;
  log: Logger;
  confirmations: number;
}

/**
 * Walks viem's cause chain for replacement-underpriced / already-known signals.
 * Those mean we still own the nonce and should fee-bump, not advance.
 */
export function isReplacementUnderpricedError(err: unknown): boolean {
  const pattern =
    /replacement transaction underpriced|underpriced|already known|same as the current|fee too low|max fee per gas less than block base fee/i;
  return errorHaystack(err).some((s) => pattern.test(s));
}

/** Nonce was consumed by another tx — need a fresh nonce, not an RBF. */
export function isNonceDesyncError(err: unknown): boolean {
  const pattern =
    /nonce too low|lower than the current nonce|nonce too high|nonce has already been used|invalid nonce|oldnonce|noncetoolow|noncetoohigh/i;
  return errorHaystack(err).some((s) => pattern.test(s));
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

export function bumpFee(fee: bigint, pct = FEE_BUMP_PCT): bigint {
  return (fee * BigInt(100 + pct)) / 100n;
}

export function clampFees(fees: FeeCaps): FeeCaps {
  return {
    maxPriorityFeePerGas:
      fees.maxPriorityFeePerGas > MAX_PRIORITY_FEE ? MAX_PRIORITY_FEE : fees.maxPriorityFeePerGas,
    maxFeePerGas: fees.maxFeePerGas > MAX_FEE_PER_GAS ? MAX_FEE_PER_GAS : fees.maxFeePerGas,
  };
}

export function assertFeeBudget(gasLimit: bigint, maxFeePerGas: bigint): void {
  const worstCase = gasLimit * maxFeePerGas;
  if (worstCase > MAX_TX_FEE_WEI) {
    throw new Error(
      `tx fee budget exceeded: gasLimit=${gasLimit} maxFeePerGas=${maxFeePerGas} ` +
        `worstCaseWei=${worstCase} capWei=${MAX_TX_FEE_WEI}`,
    );
  }
}

/** Suggest initial EIP-1559 fees from the latest block, clamped to caps. */
export async function suggestFees(pc: PublicClient): Promise<FeeCaps> {
  const block = await pc.getBlock({ blockTag: "latest" });
  const base = block.baseFeePerGas ?? 0n;
  // Prefer a small tip; keep maxFee comfortably above 2×base + tip.
  let tip = parseGwei("0.05");
  if (tip < parseGwei("0.001")) tip = parseGwei("0.001");
  let maxFee = base * 2n + tip;
  if (maxFee < tip * 2n) maxFee = tip * 2n;
  return clampFees({ maxFeePerGas: maxFee, maxPriorityFeePerGas: tip });
}

/**
 * If a pending tx already owns `nonce`, start RBF from ≥110% of its fees so the
 * first replacement is accepted (avoids underpriced on the first retry).
 */
export async function feesForPendingNonce(
  pc: PublicClient,
  address: `0x${string}`,
  nonce: number,
  fallback: FeeCaps,
): Promise<FeeCaps> {
  const latest = await pc.getTransactionCount({ address, blockTag: "latest" });
  const pending = await pc.getTransactionCount({ address, blockTag: "pending" });
  if (pending <= latest || nonce !== latest) return fallback;

  // Best-effort: dig the pending tx out of the pending block. If missing (ghost
  // hash / dropped mempool), bump the fallback so a re-broadcast differs.
  try {
    const block = await pc.getBlock({ blockTag: "pending", includeTransactions: true });
    const mine = block.transactions.find((tx) => {
      if (typeof tx === "string") return false;
      return tx.from.toLowerCase() === address.toLowerCase() && Number(tx.nonce) === nonce;
    });
    if (mine && typeof mine !== "string" && mine.maxFeePerGas && mine.maxPriorityFeePerGas) {
      return clampFees({
        maxFeePerGas: bumpFee(mine.maxFeePerGas),
        maxPriorityFeePerGas: bumpFee(mine.maxPriorityFeePerGas),
      });
    }
  } catch {
    // pending block with full txs is not supported on every RPC
  }
  return clampFees({
    maxFeePerGas: bumpFee(fallback.maxFeePerGas),
    maxPriorityFeePerGas: bumpFee(fallback.maxPriorityFeePerGas),
  });
}

async function waitWithTimeout(
  pc: PublicClient,
  hash: Hex,
  confirmations: number,
  timeoutMs: number,
): Promise<TransactionReceipt | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const receipt = pc
    .waitForTransactionReceipt({ hash, confirmations, timeout: timeoutMs })
    .catch(() => null);
  return Promise.race([receipt, timeout]);
}

async function tryCancelTx(
  deps: TxSendDeps,
  nonce: number,
  fees: FeeCaps,
): Promise<void> {
  const { wc, pc, log, confirmations } = deps;
  const cancelFees = clampFees({
    maxFeePerGas: bumpFee(fees.maxFeePerGas),
    maxPriorityFeePerGas: bumpFee(fees.maxPriorityFeePerGas),
  });
  assertFeeBudget(21_000n, cancelFees.maxFeePerGas);
  try {
    const hash = await wc.sendTransaction({
      to: wc.account.address,
      value: 0n,
      nonce,
      gas: 21_000n,
      maxFeePerGas: cancelFees.maxFeePerGas,
      maxPriorityFeePerGas: cancelFees.maxPriorityFeePerGas,
    });
    log.warn(
      {
        nonce,
        txHash: hash,
        maxFeePerGas: cancelFees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: cancelFees.maxPriorityFeePerGas.toString(),
      },
      "sent cancel-tx to unstick nonce",
    );
    await waitWithTimeout(pc, hash, confirmations, RECEIPT_WAIT_MS);
  } catch (err) {
    log.error({ err, nonce }, "cancel-tx failed; next cycle will resync nonce");
  }
}

export type ContractWriteBroadcast = (params: {
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}) => Promise<Hex>;

/**
 * Broadcast a contract write with fee-bump self-heal:
 *   1. Send at nonce N; wait up to RECEIPT_WAIT_MS
 *   2. On timeout / underpriced → same-nonce replacement with bumped fees
 *   3. After MAX_REPLACE_ATTEMPTS → cancel-tx, then throw for the next cycle
 */
export async function sendWithFeeBump(
  deps: TxSendDeps,
  broadcast: ContractWriteBroadcast,
  opts: { label: string; gasLimit: bigint },
): Promise<TransactionReceipt> {
  const { pc, wc, log, confirmations } = deps;
  const address = wc.account.address;

  let nonce = await pc.getTransactionCount({ address, blockTag: "latest" });
  const pending = await pc.getTransactionCount({ address, blockTag: "pending" });
  // If something is already pending at latest, we must RBF that nonce.
  if (pending > nonce) {
    log.warn(
      { latestNonce: nonce, pendingNonce: pending },
      "pending tx detected; will replace-by-fee",
    );
  }

  let fees = await feesForPendingNonce(pc, address, nonce, await suggestFees(pc));
  assertFeeBudget(opts.gasLimit, fees.maxFeePerGas);

  for (let attempt = 0; attempt <= MAX_REPLACE_ATTEMPTS; attempt++) {
    try {
      assertFeeBudget(opts.gasLimit, fees.maxFeePerGas);
      const hash = await broadcast({
        nonce,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      log.info(
        {
          label: opts.label,
          txHash: hash,
          nonce,
          attempt,
          maxFeePerGas: fees.maxFeePerGas.toString(),
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
        },
        "tx sent",
      );

      const receipt = await waitWithTimeout(pc, hash, confirmations, RECEIPT_WAIT_MS);
      if (receipt) {
        if (receipt.status !== "success") {
          throw new Error(`${opts.label} reverted (status=${receipt.status}) tx=${hash}`);
        }
        return receipt;
      }

      fees = clampFees({
        maxFeePerGas: bumpFee(fees.maxFeePerGas),
        maxPriorityFeePerGas: bumpFee(fees.maxPriorityFeePerGas),
      });
      log.warn(
        {
          label: opts.label,
          nonce,
          attempt,
          maxFeePerGas: fees.maxFeePerGas.toString(),
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
        },
        "tx confirmation timed out; replacing by fee",
      );
    } catch (err) {
      if (isNonceDesyncError(err)) {
        const fresh = await pc.getTransactionCount({ address, blockTag: "latest" });
        log.warn(
          { label: opts.label, staleNonce: nonce, freshNonce: fresh },
          "nonce advanced on chain; resyncing",
        );
        nonce = fresh;
        fees = await suggestFees(pc);
        continue;
      }

      if (isReplacementUnderpricedError(err) && attempt < MAX_REPLACE_ATTEMPTS) {
        fees = clampFees({
          maxFeePerGas: bumpFee(fees.maxFeePerGas),
          maxPriorityFeePerGas: bumpFee(fees.maxPriorityFeePerGas),
        });
        log.warn(
          {
            label: opts.label,
            nonce,
            attempt,
            maxFeePerGas: fees.maxFeePerGas.toString(),
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
            err,
          },
          "replacement underpriced; bumping fee",
        );
        continue;
      }

      if (attempt >= MAX_REPLACE_ATTEMPTS) {
        await tryCancelTx(deps, nonce, fees);
        throw err instanceof Error ? err : new Error(String(err));
      }

      fees = clampFees({
        maxFeePerGas: bumpFee(fees.maxFeePerGas),
        maxPriorityFeePerGas: bumpFee(fees.maxPriorityFeePerGas),
      });
      log.error(
        { err, label: opts.label, nonce, attempt },
        "tx submission failed; bumping fee and retrying",
      );
    }
  }

  await tryCancelTx(deps, nonce, fees);
  throw new Error(
    `${opts.label} stuck at nonce ${nonce} after ${MAX_REPLACE_ATTEMPTS} replacements`,
  );
}
