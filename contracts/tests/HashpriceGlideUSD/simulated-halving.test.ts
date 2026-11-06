import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deployGlideUSDFixture, FEES } from "./fixtures.ts";

const conn = await network.connect();
const {
  networkHelpers: { loadFixture, time },
} = conn;
const fixture = () => deployGlideUSDFixture(conn);

const HALVING_2028 = 1_050_000n;

/** |a / b − 1| in parts per billion. */
function relativeDiffPpb(a: bigint, b: bigint) {
  const diff = a > b ? a - b : b - a;
  return (diff * 1_000_000_000n) / b;
}

describe("HashpriceGlideUSD — simulated halving", function () {
  it("the glide meets the new index at the halving block", async function () {
    const { contracts, relay, index } = await loadFixture(fixture);
    await relay(HALVING_2028 - 1n);
    const glideBefore = await contracts.glideUSD.read.glidePrice();
    const indexBefore = await index();

    await relay(HALVING_2028);
    const indexAfter = await index();
    const glideAfter = await contracts.glideUSD.read.glidePrice();

    assert.ok(indexAfter * 100n < indexBefore * 55n, "the index itself steps down about half");
    assert.equal(glideAfter, indexAfter);
    assert.ok(relativeDiffPpb(glideAfter, glideBefore) <= 10n, `glide moved ${relativeDiffPpb(glideAfter, glideBefore)} ppb`);
  });

  it("the glide moves at the halving by no more than one block's change in the fee average", async function () {
    const { contracts, relay, subsidyAt } = await loadFixture(fixture);
    await relay(HALVING_2028 - 1n);
    const glideBefore = await contracts.glideUSD.read.glidePrice();

    // The halving block pays twice the average in fees: the 144-block average rises by 1/144.
    const feeChange = FEES / 144n;
    await relay(HALVING_2028, FEES + feeChange);
    const glideAfter = await contracts.glideUSD.read.glidePrice();

    const bound = (feeChange * 1_000_000_000n) / (subsidyAt(HALVING_2028) + FEES) + 10n;
    assert.ok(relativeDiffPpb(glideAfter, glideBefore) <= bound, `glide moved ${relativeDiffPpb(glideAfter, glideBefore)} ppb, bound ${bound}`);
  });

  it("the glide falls by at most the step / glide length per block, and never rises, at a steady index", async function () {
    const { contracts, relay, index, postHalving, glideStart, c } = await loadFixture(fixture);
    const start = glideStart(HALVING_2028);
    await relay(start);
    const idx = await index();
    const maxDrop = (idx - postHalving(idx, start)) / c.glideBlocks + 1n;

    let previous = await contracts.glideUSD.read.glidePrice();
    for (const elapsed of [1n, 2n, 3n, 1_000n, 1_001n, 6_480n, 6_481n, c.glideBlocks - 1n, c.glideBlocks]) {
      await relay(start + elapsed);
      const glide = await contracts.glideUSD.read.glidePrice();
      assert.ok(glide <= previous, `glide rose at ${elapsed}`);
      previous = glide;
    }
    await relay(start + 1_000n);
    const a = await contracts.glideUSD.read.glidePrice();
    await relay(start + 1_001n);
    const b = await contracts.glideUSD.read.glidePrice();
    assert.ok(a - b <= maxDrop && a - b > 0n, `one block moved the glide by ${a - b}, max ${maxDrop}`);
  });

  it("futures ranges switch to the index at the halving block", async function () {
    const { contracts, relay, index } = await loadFixture(fixture);
    await relay(HALVING_2028 - 1n);
    const now = BigInt(await time.latest());
    const dates = [now + 86_400n, now + 30n * 86_400n, now + 60n * 86_400n];
    const indexBefore = await index();
    const [lowsBefore] = await contracts.glideUSD.read.priceRangesAt([dates]);
    assert.ok(
      lowsBefore.every((low) => low < indexBefore),
      "dates about the halving and after it are priced below the index",
    );

    await relay(HALVING_2028);
    const idx = await index();
    const [lows, highs] = await contracts.glideUSD.read.priceRangesAt([dates]);
    for (let i = 0; i < dates.length; i++) {
      assert.equal(lows[i], idx);
      assert.equal(highs[i], idx);
    }
  });
});
