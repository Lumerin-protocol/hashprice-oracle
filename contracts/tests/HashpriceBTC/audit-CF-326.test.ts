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
  const genesisHash = blockHash(genesis);

  const latest = await pc.getBlock();
  await tc.setNextBlockTimestamp({ timestamp: latest.timestamp + 1n > BigInt(BASE_TS + 200_000) ? latest.timestamp + 1n : BigInt(BASE_TS + 200_000) });
  const oracle = await viem.deployContract("HashpriceBTC", [hex(genesisHash), GENESIS_HEIGHT, BASE_TS, EASY_NBITS, BASE_TS, EASY_NBITS]);

  const canonical = mineChain(genesisHash, GENESIS_HEIGHT + 1, 3, BASE_TS, EASY_NBITS, 1000n);
  const batch = formatBatch(canonical);
  await oracle.write.submitBlocks([GENESIS_HEIGHT, batch.headers, batch.coinbaseTxs, batch.merkleProofs]);

  /** Submit `blocks` on top of `ancestorHeight` and return the ChainReorg events it emitted. */
  async function submit(ancestorHeight: number, blocks: SyntheticBlock[]) {
    const b = formatBatch(blocks);
    const tx = await oracle.write.submitBlocks([ancestorHeight, b.headers, b.coinbaseTxs, b.merkleProofs]);
    const receipt = await pc.waitForTransactionReceipt({ hash: tx });
    return parseEventLogs({ abi: oracle.abi, logs: receipt.logs, eventName: "ChainReorg" });
  }
  return { oracle, canonical, submit };
}

/**
 * CF-326 (Low): `submitBlocks` announces a reorg whenever `ancestorHeight` is below the tip, even
 * when the headers it replays are the canonical ones. Anyone can resubmit canonical blocks plus
 * one new block from an older ancestor and make consumers orphan blocks that never changed.
 */
describe("CF-326 — replayed canonical headers are not a reorg", () => {
  it("emits no ChainReorg when every replaced block is resubmitted unchanged", async () => {
    const { oracle, canonical, submit } = await deployWithCanonicalChain();
    const tip = canonical[canonical.length - 1];
    const next = mineSyntheticBlock(tip.hash, tip.height + 1, BASE_TS + 4 * 600, EASY_NBITS, 2000n);

    const events = await submit(GENESIS_HEIGHT, [...canonical, next]);

    assert.equal(events.length, 0, "replaying the canonical chain must not announce a reorg");
    assert.equal((await oracle.read.chainTipHash()).toLowerCase(), hex(next.hash).toLowerCase());
  });

  it("reports the last unchanged block as the ancestor when only later blocks differ", async () => {
    const { canonical, submit } = await deployWithCanonicalChain();
    const fork = mineChain(canonical[0].hash, canonical[0].height + 1, 3, BASE_TS + 600, EASY_NBITS, 5000n);

    const [reorg] = await submit(GENESIS_HEIGHT, [canonical[0], ...fork]);

    assert.ok(reorg, "ChainReorg should be emitted");
    assert.equal(reorg.args.ancestorHeight, canonical[0].height, "fork point is the last unchanged block");
    assert.equal(reorg.args.oldHeight, canonical[canonical.length - 1].height);
    assert.equal(reorg.args.newHeight, fork[fork.length - 1].height);
  });
});
