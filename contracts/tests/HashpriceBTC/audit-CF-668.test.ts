import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blockHash, buildHeader, EASY_NBITS, formatBatch, getBlockSubsidy, hex, mineHeader, mineSyntheticBlock, type SyntheticBlock } from "./helpers.ts";

const { viem } = await network.connect();

const GENESIS_HEIGHT = 944_000;
const BASE_TS = 1_776_000_000;
const HONEST_FEE = 1_660_000n; // 0.0166 BTC, the mean fee of the mainnet fixture blocks
const SELF_PAID_FEE = 5_000_000_000n; // 50 BTC the miner pays to itself in each of its blocks
const WINDOW_BLOCKS = 150; // a full 144-block fee window and a few more

/**
 * CF-668 (High): the fee term is a plain mean of consensus-valid coinbases. A miner with 10% of the
 * hashrate puts a 50 BTC transaction paying itself into every block it finds. The fee comes back to
 * it, so the cost is near zero, yet each such block lifts the average by fee / 144 for a day.
 *
 * The asserted outcome is the price impact over a full window: the fee average may not move by 1%
 * of the block reward.
 */
describe("CF-668 — recycled self-paid fees cannot lift the fee average", () => {
  it("keeps a 10% miner's 50 BTC self-paid fees from moving the fee average by 1% of the reward", async () => {
    const pc = await viem.getPublicClient();
    const tc = await viem.getTestClient();
    const genesis = mineHeader(buildHeader({ prevHash: "00".repeat(32), timestamp: BASE_TS, nBits: EASY_NBITS }), EASY_NBITS);
    const latest = await pc.getBlock();
    const deployAt = BigInt(BASE_TS + 200_000);
    await tc.setNextBlockTimestamp({ timestamp: latest.timestamp >= deployAt ? latest.timestamp + 1n : deployAt });
    const oracle = await viem.deployContract("HashpriceBTC", [hex(blockHash(genesis)), GENESIS_HEIGHT, BASE_TS, EASY_NBITS, BASE_TS, EASY_NBITS]);

    const chain: SyntheticBlock[] = [];
    let prev = blockHash(genesis);
    for (let i = 1; i <= WINDOW_BLOCKS; i++) {
      const fee = i % 10 === 0 ? SELF_PAID_FEE : HONEST_FEE;
      const b = mineSyntheticBlock(prev, GENESIS_HEIGHT + i, BASE_TS + i * 600, EASY_NBITS, fee);
      chain.push(b);
      prev = b.hash;
    }
    for (let i = 0; i < chain.length; i += 50) {
      const batch = formatBatch(chain.slice(i, i + 50));
      try {
        await pc.waitForTransactionReceipt({
          hash: await oracle.write.submitBlocks([GENESIS_HEIGHT + i, batch.headers, batch.coinbaseTxs, batch.merkleProofs]),
        });
      } catch {
        // a venue that rejects the blocks outright is also fixed
      }
    }

    const reward = getBlockSubsidy(GENESIS_HEIGHT + WINDOW_BLOCKS) + HONEST_FEE;
    const moved = (await oracle.read.avgFees()) - HONEST_FEE;
    assert.ok(moved * 100n < reward, `fee average moved ${moved} sats, at least 1% of the ${reward} sat block reward`);
  });
});
