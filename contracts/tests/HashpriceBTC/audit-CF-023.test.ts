import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blockHash, buildHeader, EASY_NBITS, formatBatch, getBlockSubsidy, hex, mineHeader, mineSyntheticBlock, type SyntheticBlock } from "./helpers.ts";

const { viem } = await network.connect();

const GENESIS_HEIGHT = 944_000;
const BASE_TS = 1_776_000_000;
const HONEST_FEE = 1_660_000n; // 0.0166 BTC, the mean fee of the mainnet fixture blocks
const FAKE_FEE = 100_000_000_000n; // 1,000 BTC the block pays itself on top of the subsidy

/**
 * CF-023 (High): the oracle checks a block's proof of work, not that its coinbase pays only the
 * subsidy plus the block's real fees. A miner mines a template whose coinbase pays itself an extra
 * 1,000 BTC; Bitcoin rejects the block, but the oracle accepts it at the tip and its fee enters the
 * average at once. A full node, and so Luxor's index, would never see that block.
 *
 * The asserted outcome is the price impact: the fee average may not move by 1% of the block reward.
 */
describe("CF-023 — a consensus-invalid coinbase cannot move the fee average", () => {
  it("keeps one fake 1,000 BTC coinbase from moving the fee average by 1% of the reward", async () => {
    const pc = await viem.getPublicClient();
    const tc = await viem.getTestClient();
    const genesis = mineHeader(buildHeader({ prevHash: "00".repeat(32), timestamp: BASE_TS, nBits: EASY_NBITS }), EASY_NBITS);
    const latest = await pc.getBlock();
    const deployAt = BigInt(BASE_TS + 200_000);
    await tc.setNextBlockTimestamp({ timestamp: latest.timestamp >= deployAt ? latest.timestamp + 1n : deployAt });
    const oracle = await viem.deployContract("HashpriceBTC", [hex(blockHash(genesis)), GENESIS_HEIGHT, BASE_TS, EASY_NBITS, BASE_TS, EASY_NBITS]);

    const honest: SyntheticBlock[] = [];
    let prev = blockHash(genesis);
    for (let i = 1; i <= 30; i++) {
      const b = mineSyntheticBlock(prev, GENESIS_HEIGHT + i, BASE_TS + i * 600, EASY_NBITS, HONEST_FEE);
      honest.push(b);
      prev = b.hash;
    }
    const batch = formatBatch(honest);
    await pc.waitForTransactionReceipt({
      hash: await oracle.write.submitBlocks([GENESIS_HEIGHT, batch.headers, batch.coinbaseTxs, batch.merkleProofs]),
    });
    const before = await oracle.read.avgFees();
    assert.equal(before, HONEST_FEE, "honest baseline");

    const fakeHeight = GENESIS_HEIGHT + 31;
    const fake = mineSyntheticBlock(prev, fakeHeight, BASE_TS + 31 * 600, EASY_NBITS, FAKE_FEE);
    try {
      await oracle.write.submitBlock([hex(fake.rawHeader), hex(fake.coinbaseTx), []]);
    } catch {
      // a venue that rejects the block outright is also fixed
    }

    const reward = getBlockSubsidy(fakeHeight) + before;
    const moved = (await oracle.read.avgFees()) - before;
    assert.ok(moved * 100n < reward, `fee average moved ${moved} sats, at least 1% of the ${reward} sat block reward`);
  });
});
