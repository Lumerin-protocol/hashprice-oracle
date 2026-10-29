import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEventLogs } from "viem";
import { blockHash, buildHeader, EASY_NBITS, formatBatch, hex, mineChain, mineHeader, mineSyntheticBlock, type SyntheticBlock } from "./helpers.ts";

const { viem } = await network.connect();

const GENESIS_HEIGHT = 100;
const BASE_TS = 1_764_000_000;

/** Oracle at a synthetic genesis with a 3-block canonical chain (heights 101–103). */
async function deployWithCanonicalChain() {
  const pc = await viem.getPublicClient();
  const tc = await viem.getTestClient();
  const genesis = mineHeader(buildHeader({ prevHash: "00".repeat(32), timestamp: BASE_TS, nBits: EASY_NBITS }), EASY_NBITS);
  const latest = await pc.getBlock();
  const deployAt = BigInt(BASE_TS + 200_000);
  await tc.setNextBlockTimestamp({ timestamp: latest.timestamp >= deployAt ? latest.timestamp + 1n : deployAt });
  const oracle = await viem.deployContract("HashpriceBTC", [hex(blockHash(genesis)), GENESIS_HEIGHT, BASE_TS, EASY_NBITS, BASE_TS, EASY_NBITS]);

  const canonical = mineChain(blockHash(genesis), GENESIS_HEIGHT + 1, 3, BASE_TS, EASY_NBITS, 1000n);
  const batch = formatBatch(canonical);
  await oracle.write.submitBlocks([GENESIS_HEIGHT, batch.headers, batch.coinbaseTxs, batch.merkleProofs]);

  /** Submit `blocks` on top of `ancestorHeight` and return the heights it emitted BlockSubmitted for. */
  async function submittedHeights(ancestorHeight: number, blocks: SyntheticBlock[]) {
    const b = formatBatch(blocks);
    const tx = await oracle.write.submitBlocks([ancestorHeight, b.headers, b.coinbaseTxs, b.merkleProofs]);
    const receipt = await pc.waitForTransactionReceipt({ hash: tx });
    return parseEventLogs({ abi: oracle.abi, logs: receipt.logs, eventName: "BlockSubmitted" }).map((e) => e.args.height);
  }
  return { oracle, canonical, submittedHeights };
}

/**
 * A batch may repeat blocks the oracle already has before the new ones, e.g. when two keepers race
 * or one retries from an older ancestor. The repeated blocks change nothing, so they are skipped:
 * no re-verification and no duplicate BlockSubmitted / HashpriceUpdated for unchanged heights.
 */
describe("HashpriceBTC — resubmitted canonical blocks are skipped", () => {
  it("emits BlockSubmitted only for the new block after a replayed prefix", async () => {
    const { oracle, canonical, submittedHeights } = await deployWithCanonicalChain();
    const tip = canonical[canonical.length - 1];
    const next = mineSyntheticBlock(tip.hash, tip.height + 1, BASE_TS + 4 * 600, EASY_NBITS, 2000n);

    assert.deepEqual(await submittedHeights(GENESIS_HEIGHT, [...canonical, next]), [next.height]);
    assert.equal((await oracle.read.chainTipHash()).toLowerCase(), hex(next.hash).toLowerCase());
  });

  it("emits BlockSubmitted only from the first block that differs", async () => {
    const { oracle, canonical, submittedHeights } = await deployWithCanonicalChain();
    const fork = mineChain(canonical[0].hash, canonical[0].height + 1, 3, BASE_TS + 600, EASY_NBITS, 5000n);

    assert.deepEqual(await submittedHeights(GENESIS_HEIGHT, [canonical[0], ...fork]), fork.map((b) => b.height));
    assert.equal((await oracle.read.chainTipHash()).toLowerCase(), hex(fork[fork.length - 1].hash).toLowerCase());
  });
});
