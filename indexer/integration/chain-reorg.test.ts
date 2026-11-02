/**
 * A heavier fork replaces canonical blocks: `handleChainReorg` records it, and the fork's
 * BlockSubmitted events that follow overwrite the replaced BtcBlock rows in place.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { network } from "hardhat";
import { blockWork, deployReorgFixture, hex, indexDeployment, indexSnapshot, oracleEvents, submitSyntheticBatch } from "./helpers.ts";

const conn = await network.getOrCreate();

describe("Chain reorg indexing", () => {
  afterEach(() => conn.matchstick.reset());

  it("records the reorg and rewrites every replaced block from the fork", async () => {
    const { deployment: d, genesisHeight, canonical, fork } = await conn.networkHelpers.loadFixture(deployReorgFixture);
    await indexDeployment(conn, d);
    const receipt = await submitSyntheticBatch(d, genesisHeight, fork);

    const reorg = (await oracleEvents(d, receipt.blockNumber)).find((e) => e.eventName === "ChainReorg");
    assert.ok(reorg, "the fork triggers ChainReorg on-chain");

    const snap = await indexSnapshot(conn);
    const reorgs = snap.saved("ChainReorgEvent");
    assert.equal(reorgs.length, 1, "one row per reorg");
    const row = reorgs[0];
    assert.equal(row.newTip, reorg.args.newTip);
    assert.equal(row.newTip, hex(fork[fork.length - 1].hash));
    assert.equal(row.newHeight, String(fork[fork.length - 1].height));
    assert.equal(row.ancestorHeight, String(genesisHeight));
    assert.equal(row.oldTip, hex(canonical[canonical.length - 1].hash));
    assert.equal(row.oldHeight, String(canonical[canonical.length - 1].height));
    assert.equal(row.depth, String(canonical.length));

    assert.equal(snap.saved("BtcBlock").length, fork.length, "replaced heights are rewritten, not duplicated");
    let cumulativeWork = 0n;
    for (const block of fork) {
      const entry = snap.entity("BtcBlock", String(block.height));
      assert.ok(entry, `BtcBlock ${block.height} exists`);
      cumulativeWork += blockWork(block.nBits);
      assert.equal(entry.blockHash, hex(block.hash), `height ${block.height} holds the fork's block`);
      assert.equal(entry.coinbaseValue, String(block.coinbaseValue));
      assert.equal(entry.btcTimestamp, String(block.timestamp));
      assert.equal(entry.cumulativeWork, String(cumulativeWork), "work rebuilt from the fork's parents");
    }
  });
});
