import { catchError } from "../../lib/lib.ts";
import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deployGlideUSDFixture } from "./fixtures.ts";

const conn = await network.connect();
const {
  networkHelpers: { loadFixture },
} = conn;
const fixture = () => deployGlideUSDFixture(conn);

const HALVING_2028 = 1_050_000n;

describe("HashpriceGlideUSD — AggregatorV3Interface", function () {
  it("has HashpriceUSD's decimals", async function () {
    const { contracts } = await loadFixture(fixture);
    assert.equal(await contracts.glideUSD.read.decimals(), await contracts.hashpriceUSD.read.decimals());
  });

  it("description() is set", async function () {
    const { contracts } = await loadFixture(fixture);
    assert.ok((await contracts.glideUSD.read.description()).length > 0);
  });

  it("getRoundData() reverts with NotImplemented", async function () {
    const { contracts } = await loadFixture(fixture);
    await catchError(contracts.glideUSD.abi, "NotImplemented", async () => {
      await contracts.glideUSD.read.getRoundData([1n]);
    });
  });
});

describe("HashpriceGlideUSD — latestRoundData()", function () {
  it("equals HashpriceUSD's round before the glide, so repointing a venue changes nothing", async function () {
    const { contracts, relay, glideStart } = await loadFixture(fixture);
    assert.deepEqual(
      await contracts.glideUSD.read.latestRoundData(),
      await contracts.hashpriceUSD.read.latestRoundData(),
    );
    await relay(glideStart(HALVING_2028));
    assert.deepEqual(
      await contracts.glideUSD.read.latestRoundData(),
      await contracts.hashpriceUSD.read.latestRoundData(),
    );
  });

  it("answers the glide price during the glide, with HashpriceUSD's round id and timestamps", async function () {
    const { contracts, relay, glideStart, c } = await loadFixture(fixture);
    await relay(glideStart(HALVING_2028) + c.glideBlocks / 2n);
    const [roundId, answer, startedAt, updatedAt, answeredInRound] =
      await contracts.glideUSD.read.latestRoundData();
    const [usdRoundId, usdAnswer, usdStartedAt, usdUpdatedAt, usdAnsweredInRound] =
      await contracts.hashpriceUSD.read.latestRoundData();
    assert.equal(answer, await contracts.glideUSD.read.glidePrice());
    assert.ok(answer < usdAnswer, "the glide is below the index half way through");
    assert.equal(roundId, usdRoundId);
    assert.equal(startedAt, usdStartedAt);
    assert.equal(updatedAt, usdUpdatedAt);
    assert.equal(answeredInRound, usdAnsweredInRound);
  });

  it("answers 0 when the index is 0, so venues reject it as they would the index", async function () {
    const { contracts } = await loadFixture(fixture);
    await contracts.btcUsd.write.setPrice([0n]);
    const [, answer] = await contracts.glideUSD.read.latestRoundData();
    assert.equal(answer, 0n);
  });
});
