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

/** `latestMarkAndSchedule()`: the mark and the schedule from one read, for venues paying drift. */
describe("HashpriceGlideUSD — latestMarkAndSchedule()", function () {
  async function expectMatches(s: Awaited<ReturnType<typeof fixture>>, label: string) {
    const [mark, updatedAt, factor, endFactor, epoch] = await s.contracts.glideUSD.read.latestMarkAndSchedule();
    const [, answer, , roundUpdatedAt] = await s.contracts.glideUSD.read.latestRoundData();
    const [scheduleFactor, scheduleEnd, scheduleEpoch] = await s.contracts.glideUSD.read.latestSchedule();
    assert.equal(mark, answer, `${label}: mark`);
    assert.equal(updatedAt, roundUpdatedAt, `${label}: updatedAt`);
    assert.equal(factor, scheduleFactor, `${label}: factor`);
    assert.equal(endFactor, scheduleEnd, `${label}: end factor`);
    assert.equal(epoch, scheduleEpoch, `${label}: epoch`);
  }

  it("equals latestRoundData's answer and updatedAt and latestSchedule, before, during and after the glide", async function () {
    const s = await loadFixture(fixture);
    await expectMatches(s, "before the glide");
    for (const [label, height] of [
      ["glide start", s.glideStart(HALVING_2028)],
      ["half way", s.glideStart(HALVING_2028) + s.c.glideBlocks / 2n],
      ["glide end", HALVING_2028 - s.c.glideEndBlocks],
      ["halving", HALVING_2028],
    ] as const) {
      await s.relay(height);
      await expectMatches(s, label);
    }
    const [, , , , epoch] = await s.contracts.glideUSD.read.latestMarkAndSchedule();
    assert.equal(epoch, HALVING_2028 + s.c.halvingInterval);
  });
});
