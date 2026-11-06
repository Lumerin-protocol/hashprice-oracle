import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertClose, BTC_USD, deployGlideUSDFixture, FEES, START_HEIGHT } from "./fixtures.ts";

const conn = await network.connect();
const {
  networkHelpers: { loadFixture, time },
} = conn;
const fixture = () => deployGlideUSDFixture(conn);

const HALVING_2028 = 1_050_000n;

describe("HashpriceGlideUSD — constructor", function () {
  it("reads HashpriceBTC from HashpriceUSD", async function () {
    const { contracts } = await loadFixture(fixture);
    assert.equal(
      (await contracts.glideUSD.read.hashpriceBtc()).toLowerCase(),
      (await contracts.hashpriceUSD.read.hashpriceOracle()).toLowerCase(),
    );
    assert.equal(
      (await contracts.glideUSD.read.hashpriceUsd()).toLowerCase(),
      contracts.hashpriceUSD.address.toLowerCase(),
    );
  });

  it("quotes in HashpriceUSD's decimals", async function () {
    const { contracts } = await loadFixture(fixture);
    assert.equal(await contracts.glideUSD.read.decimals(), await contracts.hashpriceUSD.read.decimals());
  });
});

describe("HashpriceGlideUSD — next halving", function () {
  it("is the next multiple of the halving interval: 1,050,000 from the fixture height", async function () {
    const { contracts } = await loadFixture(fixture);
    assert.equal(await contracts.glideUSD.read.nextHalvingHeight(), HALVING_2028);
  });

  it("stays until the halving block is relayed, then moves one interval on", async function () {
    const { contracts, relay, c } = await loadFixture(fixture);
    await relay(HALVING_2028 - 1n);
    assert.equal(await contracts.glideUSD.read.nextHalvingHeight(), HALVING_2028);
    await relay(HALVING_2028);
    assert.equal(await contracts.glideUSD.read.nextHalvingHeight(), HALVING_2028 + c.halvingInterval);
  });

  it("estimates its date at the target block time from now", async function () {
    const { contracts, relay, c } = await loadFixture(fixture);
    const now = await time.latest();
    assert.equal(
      await contracts.glideUSD.read.halvingEta(),
      BigInt(now) + (HALVING_2028 - BigInt(START_HEIGHT)) * c.targetBlockTime,
    );

    await relay(HALVING_2028);
    const later = await time.latest();
    assert.equal(
      await contracts.glideUSD.read.halvingEta(),
      BigInt(later) + c.halvingInterval * c.targetBlockTime,
    );
  });
});

describe("HashpriceGlideUSD — halving step and post-halving price", function () {
  it("step is 1 − (subsidy / 2 + fees) / (subsidy + fees), about 49.5% at the fixture fees", async function () {
    const { contracts, subsidyAt, c } = await loadFixture(fixture);
    const sub = subsidyAt(BigInt(START_HEIGHT));
    const step = await contracts.glideUSD.read.halvingStep();
    assertClose(step, c.wad - (c.wad * (sub / 2n + FEES)) / (sub + FEES), 1n, "halving step");
    assert.ok(step > (c.wad * 49n) / 100n && step < (c.wad * 50n) / 100n, `step ${step} not about 49.5%`);
  });

  it("step is exactly one half with no fees", async function () {
    const { contracts, relay, c } = await loadFixture(fixture);
    await relay(START_HEIGHT, 0n);
    assert.equal(await contracts.glideUSD.read.halvingStep(), c.wad / 2n);
  });

  it("post-halving price is the index × (next subsidy + fees) / (subsidy + fees)", async function () {
    const { contracts, index, postHalving } = await loadFixture(fixture);
    const idx = await index();
    assertClose(await contracts.glideUSD.read.postHalvingPrice(), postHalving(idx, BigInt(START_HEIGHT)));
    assert.ok((await contracts.glideUSD.read.postHalvingPrice()) < idx);
  });

  it("post-halving price moves with BTC/USD by the same percentage", async function () {
    const { contracts } = await loadFixture(fixture);
    const before = await contracts.glideUSD.read.postHalvingPrice();
    await contracts.btcUsd.write.setPrice([BTC_USD * 2n]);
    assertClose(await contracts.glideUSD.read.postHalvingPrice(), before * 2n, 2n);
  });

  it("post-halving price follows the fee average live", async function () {
    const { contracts, relay, index, postHalving } = await loadFixture(fixture);
    await relay(START_HEIGHT + 1, FEES * 3n);
    assertClose(
      await contracts.glideUSD.read.postHalvingPrice(),
      postHalving(await index(), BigInt(START_HEIGHT + 1), FEES * 3n),
    );
  });
});

describe("HashpriceGlideUSD — perps glide", function () {
  it("is the index, with no progress, until the glide starts", async function () {
    const { contracts, relay, index, glideStart } = await loadFixture(fixture);
    assert.equal(await contracts.glideUSD.read.glidePrice(), await index());

    await relay(glideStart(HALVING_2028) - 1n);
    assert.equal(await contracts.glideUSD.read.glideProgress(), 0n);
    assert.equal(await contracts.glideUSD.read.glidePrice(), await index());

    await relay(glideStart(HALVING_2028));
    assert.equal(await contracts.glideUSD.read.glideProgress(), 0n);
    assert.equal(await contracts.glideUSD.read.glidePrice(), await index());
  });

  it("moves linearly by block from the index to the post-halving price", async function () {
    const { contracts, relay, index, postHalving, glideStart, c } = await loadFixture(fixture);
    const start = glideStart(HALVING_2028);
    for (const elapsed of [1n, c.glideBlocks / 4n, c.glideBlocks / 2n, c.glideBlocks - 1n]) {
      const height = start + elapsed;
      await relay(height);
      const idx = await index();
      const post = postHalving(idx, height);
      assert.equal(await contracts.glideUSD.read.glideProgress(), (elapsed * c.wad) / c.glideBlocks);
      assertClose(
        await contracts.glideUSD.read.glidePrice(),
        idx - ((idx - post) * elapsed) / c.glideBlocks,
        1n,
        `glide ${elapsed} blocks in`,
      );
    }
  });

  it("is halfway, about 0.75 × the index, half way through", async function () {
    const { contracts, relay, index, glideStart, c } = await loadFixture(fixture);
    await relay(glideStart(HALVING_2028) + c.glideBlocks / 2n);
    assert.equal(await contracts.glideUSD.read.glideProgress(), c.wad / 2n);
    const ratio = ((await contracts.glideUSD.read.glidePrice()) * 1000n) / (await index());
    assert.ok(ratio >= 745n && ratio <= 755n, `glide/index ${ratio}‰`);
  });

  it("sits at the post-halving price for the last end blocks before the halving", async function () {
    const { contracts, relay, index, postHalving, c } = await loadFixture(fixture);
    for (const height of [HALVING_2028 - c.glideEndBlocks, HALVING_2028 - 1n]) {
      await relay(height);
      assert.equal(await contracts.glideUSD.read.glideProgress(), c.wad);
      assertClose(await contracts.glideUSD.read.glidePrice(), postHalving(await index(), height));
    }
  });

  it("returns to the index, now the post-halving one, once the halving block is relayed", async function () {
    const { contracts, relay, index } = await loadFixture(fixture);
    await relay(HALVING_2028);
    assert.equal(await contracts.glideUSD.read.glideProgress(), 0n);
    assert.equal(await contracts.glideUSD.read.glidePrice(), await index());
  });

  it("counts blocks, not time: no progress while no block is relayed", async function () {
    const { contracts, relay, glideStart, c } = await loadFixture(fixture);
    await relay(glideStart(HALVING_2028) + c.glideBlocks / 2n);
    const progress = await contracts.glideUSD.read.glideProgress();
    const glide = await contracts.glideUSD.read.glidePrice();
    await time.increase(30 * 24 * 3600);
    assert.equal(await contracts.glideUSD.read.glideProgress(), progress);
    assert.equal(await contracts.glideUSD.read.glidePrice(), glide);
  });

  it("moves with BTC/USD by the same percentage in the same block", async function () {
    const { contracts, relay, glideStart, c } = await loadFixture(fixture);
    await relay(glideStart(HALVING_2028) + c.glideBlocks / 3n);
    const before = await contracts.glideUSD.read.glidePrice();
    await contracts.btcUsd.write.setPrice([BTC_USD / 2n]);
    assertClose(await contracts.glideUSD.read.glidePrice(), before / 2n, 2n);
  });
});

describe("HashpriceGlideUSD — futures price ranges", function () {
  async function windowAndEta(s: Awaited<ReturnType<typeof fixture>>) {
    const eta = await s.contracts.glideUSD.read.halvingEta();
    const w = await s.contracts.glideUSD.read.halvingWindow();
    return { eta, w };
  }

  it("window is 10% of the time to the estimate when that exceeds the floor", async function () {
    const s = await loadFixture(fixture);
    const now = BigInt(await time.latest());
    const { eta, w } = await windowAndEta(s);
    const tenPercent = ((eta - now) * s.c.windowBps) / s.c.bps;
    assert.ok(tenPercent > s.c.minWindow);
    assert.equal(w, tenPercent);
  });

  it("window is the floor close to the halving", async function () {
    const s = await loadFixture(fixture);
    await s.relay(HALVING_2028 - 100n);
    assert.equal(await s.contracts.glideUSD.read.halvingWindow(), s.c.minWindow);
  });

  it("prices dates before the window at the index, after it post-halving, and inside it at both", async function () {
    const s = await loadFixture(fixture);
    const idx = await s.index();
    const post = s.postHalving(idx, BigInt(START_HEIGHT));
    const at = await s.updatedAt();
    const { eta, w } = await windowAndEta(s);

    const cases: [string, bigint, bigint, bigint][] = [
      ["well before", eta - 4n * w, idx, idx],
      ["just before the window", eta - w - 1n, idx, idx],
      ["window start", eta - w, post, idx],
      ["the estimate", eta, post, idx],
      ["window end", eta + w, post, idx],
      ["just after the window", eta + w + 1n, post, post],
      ["well after", eta + 4n * w, post, post],
    ];
    for (const [label, t, low, high] of cases) {
      const [gotLow, gotHigh, gotAt] = await s.contracts.glideUSD.read.priceRangeAt([t]);
      assertClose(gotLow, low, 1n, `${label} low`);
      assertClose(gotHigh, high, 1n, `${label} high`);
      assert.equal(gotAt, at, `${label} updatedAt`);
    }
  });

  it("prices a matured date at the index", async function () {
    const s = await loadFixture(fixture);
    const now = BigInt(await time.latest());
    const [low, high] = await s.contracts.glideUSD.read.priceRangeAt([now - 86_400n]);
    assert.equal(low, await s.index());
    assert.equal(high, await s.index());
  });

  it("batched ranges equal the single ones", async function () {
    const s = await loadFixture(fixture);
    const { eta, w } = await windowAndEta(s);
    const dates = [eta - 2n * w, eta - w / 2n, eta, eta + w / 2n, eta + 2n * w];
    const [lows, highs, at] = await s.contracts.glideUSD.read.priceRangesAt([dates]);
    assert.equal(lows.length, dates.length);
    assert.equal(highs.length, dates.length);
    assert.equal(at, await s.updatedAt());
    for (let i = 0; i < dates.length; i++) {
      const [low, high] = await s.contracts.glideUSD.read.priceRangeAt([dates[i]]);
      assert.equal(lows[i], low, `date ${i} low`);
      assert.equal(highs[i], high, `date ${i} high`);
    }
    assert.ok(lows[2] < highs[2], "the estimate's date is priced at both sides");
    assert.ok(lows[4] < (await s.index()), "the last date is priced post-halving");
  });

  it("prices every listed date at the index again once the halving is relayed", async function () {
    const s = await loadFixture(fixture);
    const { eta, w } = await windowAndEta(s);
    await s.relay(HALVING_2028);
    const idx = await s.index();
    for (const t of [eta - w, eta, eta + w, eta + 90n * 86_400n]) {
      const [low, high] = await s.contracts.glideUSD.read.priceRangeAt([t]);
      assert.equal(low, idx);
      assert.equal(high, idx);
    }
  });

  for (const [label, blockTime] of [
    ["on schedule", 600n],
    ["5% fast", 570n],
    ["5% slow", 630n],
  ] as const) {
    it(`a date priced at one value never moves into the window while it shrinks (blocks ${label})`, async function () {
      const s = await loadFixture(fixture);
      const { eta, w } = await windowAndEta(s);
      const before = eta - w - 3_600n;
      const after = eta + w + 3_600n;
      const stepBlocks = 720n;
      let height = BigInt(START_HEIGHT);
      let steps = 0;
      while (true) {
        height += stepBlocks;
        await time.increase(stepBlocks * blockTime);
        await s.relay(height);
        if ((await s.contracts.glideUSD.read.halvingWindow()) <= s.c.minWindow) break;
        steps++;
        const idx = await s.index();
        const post = s.postHalving(idx, height);
        const [bLow, bHigh] = await s.contracts.glideUSD.read.priceRangeAt([before]);
        const [aLow, aHigh] = await s.contracts.glideUSD.read.priceRangeAt([after]);
        assert.equal(bLow, idx, `pre-halving date entered the window at ${height}`);
        assert.equal(bHigh, idx);
        assertClose(aLow, post, 1n, `post-halving date entered the window at ${height}`);
        assertClose(aHigh, post, 1n);
      }
      assert.ok(steps > 20, `only ${steps} steps before the window reached its floor`);
    });
  }
});
