import { deployOracleFixture } from "./fixtures.ts";
import { hex, dsha256 } from "./helpers.ts";
import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  networkHelpers: { loadFixture },
} = await network.connect();

describe("HashpriceBTC — Chain state", function () {
  it("should set chain tip to the last submitted block hash", async function () {
    const { contracts, config } = await loadFixture(deployOracleFixture);
    const lastSubmitted = config.blocks[config.batchEnd - 1];
    const chainTip = await contracts.oracle.read.chainTip();
    assert.equal(chainTip.toLowerCase(), hex(dsha256(lastSubmitted.rawHeader)).toLowerCase());
  });

  it("should set chain height to the last submitted block height", async function () {
    const { contracts, config } = await loadFixture(deployOracleFixture);
    const lastSubmitted = config.blocks[config.batchEnd - 1];
    const [chainHeight] = await contracts.oracle.read.state();
    assert.equal(chainHeight, lastSubmitted.height);
  });

  it("should return confirmedHeight = chainHeight - 6", async function () {
    const { contracts, config } = await loadFixture(deployOracleFixture);
    const lastSubmitted = config.blocks[config.batchEnd - 1];
    assert.equal(await contracts.oracle.read.confirmedHeight(), lastSubmitted.height - 6);
  });

  it("should track block count", async function () {
    const { contracts, config } = await loadFixture(deployOracleFixture);
    const [, blockCount] = await contracts.oracle.read.state();
    assert.equal(blockCount, config.batchEnd - 1);
  });

  it("should update lastSubmittedAt to nonzero EVM timestamp", async function () {
    const { contracts } = await loadFixture(deployOracleFixture);
    const [, , , , lastSubmittedAt] = await contracts.oracle.read.state();
    assert.ok(lastSubmittedAt > 0);
  });
});
