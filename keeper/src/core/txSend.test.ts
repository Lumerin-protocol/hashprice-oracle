import { describe, it } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import type { Hex, PublicClient, TransactionReceipt } from "viem";
import { parseGwei } from "viem";
import {
  MAX_TIP,
  MAX_TX_FEE_WEI,
  MIN_TIP,
  REPLACE_AFTER_BLOCKS,
  type Fees,
  type TxRequest,
  TxSender,
  capToBudget,
  initialFees,
  isValidReplacement,
  replacementFees,
} from "./txSend.ts";

const log = pino({ level: "silent" });
const BASE_FEE = parseGwei("0.005");
const MEDIAN_TIP = parseGwei("0.02");
const P75_TIP = parseGwei("0.05");
const market = { baseFee: BASE_FEE, medianTip: MEDIAN_TIP, p75Tip: P75_TIP };

interface Sent extends Fees {
  nonce: number;
  gas: bigint;
  hash: Hex;
  label: string;
}

/** Each sender sleep advances the fake Base chain by one block and runs `onBlock`. */
function harness(opts: { confirmations?: number; now?: () => number; sleep?: () => void } = {}) {
  let head = 100n;
  let onChainNonce = 7;
  const receipts = new Map<Hex, TransactionReceipt>();
  const sent: Sent[] = [];
  const attempts: Fees[] = [];
  const sendErrors: Error[] = [];
  let onBlock: (head: bigint) => void = () => {};
  let builds = 0;

  const pc = {
    getTransactionCount: async () => onChainNonce,
    getBlockNumber: async () => head,
    getFeeHistory: async () => ({
      baseFeePerGas: Array(21).fill(BASE_FEE),
      reward: Array(20).fill([MEDIAN_TIP, P75_TIP]),
    }),
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const r = receipts.get(hash);
      if (!r) throw new Error("receipt not found");
      return r;
    },
  } as unknown as PublicClient;

  const build = async (): Promise<TxRequest> => {
    builds++;
    const label = `batch-${builds}`;
    return {
      label,
      gas: 200_000n,
      send: async (p) => {
        attempts.push({ maxFeePerGas: p.maxFeePerGas, maxPriorityFeePerGas: p.maxPriorityFeePerGas });
        const err = sendErrors.shift();
        if (err) throw err;
        const hash = `0x${(sent.length + 1).toString(16).padStart(64, "0")}` as Hex;
        sent.push({ ...p, hash, label });
        return hash;
      },
    };
  };

  const sender = new TxSender({
    pc,
    address: "0x0000000000000000000000000000000000000abc",
    log,
    confirmations: opts.confirmations ?? 2,
    now: opts.now,
    sleep: async () => {
      opts.sleep?.();
      head++;
      onBlock(head);
    },
  });

  return {
    sender,
    build,
    sent,
    attempts,
    sendErrors,
    get builds() {
      return builds;
    },
    setOnBlock(fn: (head: bigint) => void) {
      onBlock = fn;
    },
    mine(hash: Hex, status: "success" | "reverted" = "success") {
      receipts.set(hash, { transactionHash: hash, blockNumber: head, status, gasUsed: 1n } as TransactionReceipt);
      onChainNonce++;
    },
    consumeNonce() {
      onChainNonce++;
    },
    setNonce(n: number) {
      onChainNonce = n;
    },
  };
}

describe("fee decisions", () => {
  it("tips the fee-history median, floored at 0.01 gwei and capped at 1 gwei, with max fee 2x base + tip", () => {
    assert.deepEqual(initialFees(market), {
      maxPriorityFeePerGas: MEDIAN_TIP,
      maxFeePerGas: BASE_FEE * 2n + MEDIAN_TIP,
    });
    assert.equal(initialFees({ ...market, medianTip: parseGwei("0.001") }).maxPriorityFeePerGas, MIN_TIP);
    assert.equal(initialFees({ ...market, medianTip: parseGwei("3") }).maxPriorityFeePerGas, MAX_TIP);
  });

  it("replaces at the higher of +25% and the 75th-percentile tip", () => {
    const prev = initialFees(market);
    assert.deepEqual(replacementFees(prev, market), {
      maxPriorityFeePerGas: P75_TIP,
      maxFeePerGas: BASE_FEE * 2n + P75_TIP,
    });
    const high = { maxPriorityFeePerGas: parseGwei("0.2"), maxFeePerGas: parseGwei("0.3") };
    assert.deepEqual(replacementFees(high, market), {
      maxPriorityFeePerGas: parseGwei("0.25"),
      maxFeePerGas: parseGwei("0.375"),
    });
  });

  it("caps gas x max fee at 0.002 ETH", () => {
    const gas = 2_000_000n;
    const capped = capToBudget({ maxPriorityFeePerGas: parseGwei("1"), maxFeePerGas: parseGwei("5") }, gas);
    assert.equal(capped.maxFeePerGas, MAX_TX_FEE_WEI / gas);
    assert.equal(capped.maxPriorityFeePerGas, MAX_TX_FEE_WEI / gas);
  });

  it("does not count a replacement below +10% on either fee as valid", () => {
    const atCap = { maxPriorityFeePerGas: MAX_TIP, maxFeePerGas: parseGwei("2") };
    assert.equal(isValidReplacement(atCap, replacementFees(atCap, market)), false);
  });
});

describe("TxSender", () => {
  it("sends at the market fees and returns once the receipt has its confirmations", async () => {
    const h = harness({ confirmations: 2 });
    h.setOnBlock((head) => {
      if (head === 102n) h.mine(h.sent[0].hash);
    });
    const out = await h.sender.send(h.build);
    assert.equal(out.kind, "mined");
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].nonce, 7);
    assert.equal(h.sent[0].maxPriorityFeePerGas, MEDIAN_TIP);
    assert.equal(h.sent[0].maxFeePerGas, BASE_FEE * 2n + MEDIAN_TIP);
    assert.equal(h.sent[0].gas, 200_000n);
  });

  it("bumps at once on 'replacement transaction underpriced' and resends the same nonce", async () => {
    const h = harness();
    h.sendErrors.push(new Error("replacement transaction underpriced"));
    h.setOnBlock((head) => {
      if (head === 101n) h.mine(h.sent[0].hash);
    });
    const out = await h.sender.send(h.build);
    assert.equal(out.kind, "mined");
    assert.equal(out.kind === "mined" && out.bumps, 1);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].nonce, 7);
    assert.equal(h.sent[0].maxPriorityFeePerGas, P75_TIP);
  });

  it(`rebuilds and replaces after ${REPLACE_AFTER_BLOCKS} unmined blocks, and still accepts an earlier hash`, async () => {
    const h = harness();
    h.setOnBlock((head) => {
      if (head === 100n + REPLACE_AFTER_BLOCKS + 2n) h.mine(h.sent[0].hash);
    });
    const out = await h.sender.send(h.build);
    assert.equal(h.builds, 2);
    assert.equal(h.sent.length, 2);
    assert.equal(h.sent[1].nonce, h.sent[0].nonce);
    assert.equal(h.sent[1].label, "batch-2");
    assert.equal(h.sent[1].maxPriorityFeePerGas, P75_TIP);
    assert.ok(out.kind === "mined");
    assert.equal(out.receipt.transactionHash, h.sent[0].hash);
    assert.equal(out.tx.label, "batch-1");
  });

  it("stops raising fees at the 1 gwei tip cap and keeps waiting", async () => {
    const h = harness();
    // An earlier process's tx holds the nonce at a higher fee than we can reach.
    for (let i = 0; i < 100; i++) h.sendErrors.push(new Error("replacement transaction underpriced"));
    let attemptsAtFirstBlock = 0;
    h.setOnBlock((head) => {
      if (head === 101n) attemptsAtFirstBlock = h.attempts.length;
      if (head === 100n + 5n * REPLACE_AFTER_BLOCKS) h.consumeNonce();
    });
    const out = await h.sender.send(h.build);
    const last = h.attempts.at(-1) as Fees;
    assert.ok(last.maxPriorityFeePerGas <= MAX_TIP);
    assert.equal(isValidReplacement(last, replacementFees(last, market)), false);
    assert.equal(h.attempts.length, attemptsAtFirstBlock);
    assert.equal(out.kind, "superseded");
  });

  it("re-reads when another transaction consumed the nonce", async () => {
    const h = harness();
    h.setOnBlock((head) => {
      if (head === 103n) h.consumeNonce();
    });
    const out = await h.sender.send(h.build);
    assert.deepEqual(out, { kind: "superseded", blockNumber: 103n });
  });

  it("returns a reverted receipt without bumping", async () => {
    const h = harness({ confirmations: 1 });
    h.setOnBlock(() => {
      if (h.sent.length === 1) h.mine(h.sent[0].hash, "reverted");
    });
    const out = await h.sender.send(h.build);
    assert.ok(out.kind === "mined");
    assert.equal(out.receipt.status, "reverted");
    assert.equal(out.bumps, 0);
    assert.equal(h.sent.length, 1);
  });

  it("uses the next nonce after a mined tx even if the RPC still reports the old count", async () => {
    const h = harness({ confirmations: 1 });
    h.setOnBlock(() => {
      const last = h.sent.at(-1);
      if (last) h.mine(last.hash);
    });
    await h.sender.send(h.build);
    h.setNonce(7);
    await h.sender.send(h.build);
    assert.deepEqual(
      h.sent.map((s) => s.nonce),
      [7, 8],
    );
  });
});
