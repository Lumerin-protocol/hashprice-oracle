import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertClose, deployGlideUSDFixture, START_HEIGHT } from "./fixtures.ts";

const conn = await network.connect();
const {
  networkHelpers: { loadFixture },
} = conn;
const fixture = () => deployGlideUSDFixture(conn);

const HALVING_2028 = 1_050_000n;

/**
 * `latestSchedule()`: the share of the index the mark keeps under the schedule (`factor`, WAD),
 * where the current segment ends (`endFactor`) and an `epoch` that changes when the factor resets.
 * Venues pay holders the factor's changes (drift funding) without knowing what a glide is.
 */
describe("HashpriceGlideUSD — latestSchedule()", function () {
  it("outside the glide: factor 1, ending at 1 − step, epoch the next halving height", async function () {
    const { contracts, c } = await loadFixture(fixture);
    const [factor, endFactor, epoch] = await contracts.glideUSD.read.latestSchedule();
    const step = await contracts.glideUSD.read.halvingStep();
    assert.equal(factor, c.wad);
    assert.equal(endFactor, c.wad - step);
    assert.equal(epoch, HALVING_2028);
    assert.equal(epoch, await contracts.glideUSD.read.nextHalvingHeight());
    assert.ok(BigInt(START_HEIGHT) < HALVING_2028);
  });

  it("during the glide the factor is the mark / index", async function () {
    const { contracts, relay, index, glideStart, c } = await loadFixture(fixture);
    const start = glideStart(HALVING_2028);
    for (const elapsed of [1n, c.glideBlocks / 3n, c.glideBlocks / 2n, c.glideBlocks - 1n]) {
      await relay(start + elapsed);
      const [factor, endFactor] = await contracts.glideUSD.read.latestSchedule();
      const step = await contracts.glideUSD.read.halvingStep();
      assertClose(factor, c.wad - (step * elapsed) / c.glideBlocks, 1n, `factor ${elapsed} blocks in`);
      assert.equal(endFactor, c.wad - step);
      assertClose(await contracts.glideUSD.read.glidePrice(), ((await index()) * factor) / c.wad, 1n, "mark = index × factor");
    }
  });

  it("reaches its end factor when the glide does and holds it until the halving", async function () {
    const { contracts, relay, c } = await loadFixture(fixture);
    for (const height of [HALVING_2028 - c.glideEndBlocks, HALVING_2028 - 1n]) {
      await relay(height);
      const [factor, endFactor] = await contracts.glideUSD.read.latestSchedule();
      assert.equal(factor, endFactor);
    }
  });

  it("resets at the halving: a new epoch, factor 1, and the old end factor bridges the two indexes", async function () {
    const { contracts, relay, index, c } = await loadFixture(fixture);
    await relay(HALVING_2028 - 1n);
    const [, endBefore, epochBefore] = await contracts.glideUSD.read.latestSchedule();
    const indexBefore = await index();

    await relay(HALVING_2028);
    const [factor, , epoch] = await contracts.glideUSD.read.latestSchedule();
    assert.equal(factor, c.wad);
    assert.equal(epoch, epochBefore + c.halvingInterval);
    // With fees unchanged, the new index is the old one times the old end factor.
    assertClose(await index(), (indexBefore * endBefore) / c.wad, 2n, "new index = old index × end factor");
  });
});
