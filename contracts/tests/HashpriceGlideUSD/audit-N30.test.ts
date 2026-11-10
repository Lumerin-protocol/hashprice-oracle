import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deployGlideUSDFixture, START_HEIGHT } from "./fixtures.ts";

const conn = await network.connect();
const {
  networkHelpers: { loadFixture, time },
} = conn;
const fixture = () => deployGlideUSDFixture(conn);
type Fixture = Awaited<ReturnType<typeof fixture>>;

const HALVING_2028 = 1_050_000n;
const DAY = 86_400n;
/** Blocks every 80% of the target time: a sustained 20% surge, twice what the 90% span allowed for. */
const FAST_BLOCK_TIME_PCT = 80n;

/**
 * N30: perps skips reading the glide feed until `factorFixedUntil`, so the schedule (factor, end
 * factor, epoch) must not change before then, even with blocks running fast. If it does, trades
 * settle a stale drift sum while the glide is under way.
 */
describe("N30: the schedule holds until factorFixedUntil with blocks 20% fast", function () {
  const cases: [string, (s: Fixture) => bigint][] = [
    ["from the fixture height, about 200 days before the glide", () => BigInt(START_HEIGHT)],
    ["30 days before the glide", (s) => s.glideStart(HALVING_2028) - (30n * DAY) / s.c.targetBlockTime],
    ["10 days before the glide", (s) => s.glideStart(HALVING_2028) - (10n * DAY) / s.c.targetBlockTime],
    ["at the halving, about four years before the next glide", () => HALVING_2028],
  ];

  for (const [label, startHeight] of cases) {
    it(label, async function () {
      const s = await loadFixture(fixture);
      const start = startHeight(s);
      if (start !== BigInt(START_HEIGHT)) await s.relay(start);
      const t0 = BigInt(await time.latest());
      const [, , factor, endFactor, epoch, fixedUntil] = await s.contracts.glideUSD.read.latestMarkAndSchedule();
      assert.ok(fixedUntil > t0, "the feed promises a fixed factor");

      // Fast blocks up to the last second of the promise.
      const end = fixedUntil - 1n;
      const fastBlockTime = (s.c.targetBlockTime * FAST_BLOCK_TIME_PCT) / 100n;
      const height = start + (end - t0) / fastBlockTime;
      await time.setNextBlockTimestamp(end);
      await s.relay(height);

      const [, , factorAfter, endFactorAfter, epochAfter] = await s.contracts.glideUSD.read.latestMarkAndSchedule();
      assert.deepEqual(
        [factorAfter, endFactorAfter, epochAfter],
        [factor, endFactor, epoch],
        `schedule changed at height ${height}, ${(end - t0) / DAY} days into a promise made at height ${start}`,
      );
    });
  }
});
