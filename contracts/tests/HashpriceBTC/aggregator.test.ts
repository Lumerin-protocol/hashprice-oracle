import { catchError } from "../../lib/lib.ts";
import { deployOracleFixture } from "./fixtures.ts";
import { getBlockSubsidy, nBitsToDifficulty } from "./helpers.ts";
import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  networkHelpers: { loadFixture },
} = await network.connect();

describe("HashpriceBTC — AggregatorV3Interface", function () {
  it("decimals() should return 16", async function () {
    const { contracts } = await loadFixture(deployOracleFixture);
    assert.equal(await contracts.oracle.read.decimals(), 16);
  });

  it('description() should return "The price of 100 TH/s per day in BTC"', async function () {
    const { contracts } = await loadFixture(deployOracleFixture);
    assert.equal(await contracts.oracle.read.description(), "The price of 100 TH/s per day in BTC");
  });

  it("version() should return 1", async function () {
    const { contracts } = await loadFixture(deployOracleFixture);
    assert.equal(await contracts.oracle.read.version(), 1n);
  });

  it("getRoundData() should revert with NotImplemented", async function () {
    const { contracts } = await loadFixture(deployOracleFixture);
    await catchError(contracts.oracle.abi, "NotImplemented", async () => {
      await contracts.oracle.read.getRoundData([0n]);
    });
  });
});

describe("HashpriceBTC — latestRoundData()", function () {
  it("should return a positive hashprice", async function () {
    const { contracts } = await loadFixture(deployOracleFixture);
    const [, answer] = await contracts.oracle.read.latestRoundData();
    assert.ok(answer > 0n);
  });

  it("should set roundId to confirmedHeight", async function () {
    const { contracts } = await loadFixture(deployOracleFixture);
    const confirmedHeight = await contracts.oracle.read.confirmedHeight();
    const [roundId] = await contracts.oracle.read.latestRoundData();
    assert.equal(roundId, BigInt(confirmedHeight));
  });

  it("should set answeredInRound equal to roundId", async function () {
    const { contracts } = await loadFixture(deployOracleFixture);
    const [roundId, , , , answeredInRound] = await contracts.oracle.read.latestRoundData();
    assert.equal(answeredInRound, roundId);
  });

  it("should set startedAt to the confirmed block BTC timestamp", async function () {
    const { contracts, config } = await loadFixture(deployOracleFixture);
    const confirmedHeight = Number(await contracts.oracle.read.confirmedHeight());
    const confirmedBlock = config.blocks.find((b) => b.height === confirmedHeight);
    assert.ok(confirmedBlock);
    const [, , startedAt] = await contracts.oracle.read.latestRoundData();
    assert.equal(startedAt, BigInt(confirmedBlock.timestamp));
  });

  it("should set updatedAt to the EVM submission timestamp", async function () {
    const { contracts } = await loadFixture(deployOracleFixture);
    const [, , , updatedAt] = await contracts.oracle.read.latestRoundData();
    const [, , , , lastSubmittedAt] = await contracts.oracle.read.state();
    assert.equal(updatedAt, BigInt(lastSubmittedAt));
    assert.ok(updatedAt > 0n);
  });

  it("should compute hashprice matching the on-chain formula", async function () {
    const { contracts, config } = await loadFixture(deployOracleFixture);
    const confirmedHeight = Number(await contracts.oracle.read.confirmedHeight());
    const confirmedBlock = config.blocks.find((b) => b.height === confirmedHeight);
    assert.ok(confirmedBlock);

    const subsidy = getBlockSubsidy(confirmedHeight);

    const submittedBlocks = config.blocks.slice(1, config.batchEnd);
    let totalFees = 0n;
    for (const b of submittedBlocks) {
      totalFees += BigInt(b.coinbase.totalOutputValue) - subsidy;
    }
    const avgFees = totalFees / BigInt(submittedBlocks.length);

    const HASHES_PER_100THS_PER_DAY = 8_640_000_000_000_000_000n;
    const decimals = await contracts.oracle.read.decimals();
    const difficulty = nBitsToDifficulty(confirmedBlock.nBits);
    const rewardPerBlock = subsidy + avgFees;
    const expectedHashprice =
      (HASHES_PER_100THS_PER_DAY * rewardPerBlock * 10n ** BigInt(decimals - 8)) /
      (difficulty * (1n << 32n));

    const [, answer] = await contracts.oracle.read.latestRoundData();
    assert.equal(answer, expectedHashprice);
  });

  it("should return hashprice in a plausible range", async function () {
    const { contracts } = await loadFixture(deployOracleFixture);
    const [, answer] = await contracts.oracle.read.latestRoundData();
    // answer has 16 decimals: 1e16 = 1 BTC/100TH/day, plausible range ~1e12–1e15
    assert.ok(answer > 10_000_000_000n);
    assert.ok(answer < 1_000_000_000_000_000n);
  });
});
