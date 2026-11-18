import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEventLogs } from "viem";
import { deployV3Fixture, prepareBlocks } from "./fixtures.ts";

const {
  networkHelpers: { loadFixture },
} = await network.connect();

/**
 * Like Luxor's index, the price is computed at the latest block: subsidy depends only on height,
 * and every block at a height shares its parent's required difficulty, so waiting a confirmation
 * protects nothing and only reports the previous difficulty for a block after each retarget.
 */
describe("HashpriceBTC — prices the tip", () => {
  it("reports the block just accepted as the round and the priced height", async () => {
    const { contracts, accounts, config } = await loadFixture(deployV3Fixture);
    const next = config.blocks[1];
    const block = prepareBlocks(config.blocks).formatBlock(next);

    const tx = await contracts.oracle.write.submitBlock([block.header, block.coinbaseTx, block.merkleProof]);
    const receipt = await accounts.pc.waitForTransactionReceipt({ hash: tx });
    const [update] = parseEventLogs({ abi: contracts.oracle.abi, logs: receipt.logs, eventName: "HashpriceUpdated" });

    assert.ok(update, "HashpriceUpdated should be emitted");
    assert.equal(update.args.confirmedHeight, next.height, "priced height is the tip");
    const [roundId] = await contracts.oracle.read.latestRoundData();
    assert.equal(roundId, BigInt(next.height), "round is the tip");
    assert.equal(await contracts.oracle.read.confirmedHeight(), next.height);
  });
});
