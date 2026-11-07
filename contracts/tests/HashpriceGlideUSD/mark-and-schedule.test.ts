import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deployGlideUSDFixture, START_HEIGHT } from "./fixtures.ts";

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

describe("HashpriceGlideUSD — latestMarkAndSchedule() factorFixedUntil", function () {
  async function fixedUntil(s: Awaited<ReturnType<typeof fixture>>) {
    const result = await s.contracts.glideUSD.read.latestMarkAndSchedule();
    return (result as readonly bigint[])[5];
  }

  it("before the glide: now + 90% of the estimated time to the glide's start", async function () {
    const s = await loadFixture(fixture);
    const now = BigInt(await s.networkHelpers.time.latest());
    const blocksToGlide = s.glideStart(HALVING_2028) - BigInt(START_HEIGHT);
    const fixedSpan = (blocksToGlide * s.c.targetBlockTime * 9n) / 10n;
    assert.equal(await fixedUntil(s), now + fixedSpan);
  });

  it("is 0 from the glide's start to the halving, and again after it until the next glide", async function () {
    const s = await loadFixture(fixture);
    for (const height of [s.glideStart(HALVING_2028), s.glideStart(HALVING_2028) + s.c.glideBlocks / 2n, HALVING_2028 - 1n]) {
      await s.relay(height);
      assert.equal(await fixedUntil(s), 0n, `at ${height}`);
    }
    await s.relay(HALVING_2028);
    const now = BigInt(await s.networkHelpers.time.latest());
    const next = HALVING_2028 + s.c.halvingInterval;
    const blocksToGlide = next - s.c.glideBlocks - s.c.glideEndBlocks - HALVING_2028;
    assert.equal(await fixedUntil(s), now + (blocksToGlide * s.c.targetBlockTime * 9n) / 10n);
  });
});

describe("HashpriceGlideUSD — factorFixedUntil stops FACTOR_FIXED_MIN_LEAD before the glide", function () {
  async function fixedUntil(s: Awaited<ReturnType<typeof fixture>>) {
    const result = await s.contracts.glideUSD.read.latestMarkAndSchedule();
    return (result as readonly bigint[])[5];
  }

  it("ends the fixed span the lead before the glide's estimated start, and is 0 within the lead", async function () {
    const s = await loadFixture(fixture);
    const lead = await s.contracts.glideUSD.read.FACTOR_FIXED_MIN_LEAD();
    const blocksInLead = lead / s.c.targetBlockTime;

    // Twice the lead before the glide: 90% of the time would reach into the lead, so it stops there.
    await s.relay(s.glideStart(HALVING_2028) - 2n * blocksInLead);
    const now = BigInt(await s.networkHelpers.time.latest());
    assert.equal(await fixedUntil(s), now + 2n * blocksInLead * s.c.targetBlockTime - lead);

    // Within the lead: every read.
    await s.relay(s.glideStart(HALVING_2028) - blocksInLead / 2n);
    assert.equal(await fixedUntil(s), 0n);
  });
});
