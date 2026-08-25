/**
 * Integration tests for the NetworkHashrate feed.
 *
 * These drive the real mapping with real `HashpriceUpdated` logs from a real
 * HashpriceBTC deployment, so they check the thing that actually matters: that
 * inverting the oracle's hashprice back into a hashrate reproduces the
 * difficulty the contract used, for every block the oracle confirms.
 *
 * Two harness limits shape the assertions:
 *
 *   - Graph Node assigns `id` to `timeseries` rows itself; matchstick keys the
 *     store on whatever the mapping set (always 0 here), so replaying N events
 *     leaves one row — the newest. Per-block coverage therefore comes from
 *     snapshotting after each submitted block rather than from reading N rows.
 *   - The runner routes event handlers only, so the `initFeeds` block handler
 *     never runs and `HashpriceMeta` is absent. `handleHashpriceUpdated` bails
 *     out at the end because of that, which is downstream of every write these
 *     tests look at, but it does mean HashpriceUsd is out of scope here.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { read } from "matchstick-ts";
import {
  assertRelativelyClose,
  avgFees,
  deployOracleFixture,
  difficulty,
  difficultyImpliedHashrate,
  latestConfirmedHeight,
  submitBlock,
} from "./helpers.ts";

const conn = await network.getOrCreate();

describe("NetworkHashrate derivation", () => {
  after(() => conn.matchstick.reset());

  it("reproduces the difficulty-implied hashrate the oracle priced against", async () => {
    const { contracts, accounts, config } =
      await conn.networkHelpers.loadFixture(deployOracleFixture);
    const { oracle } = contracts;
    const { owner, pc } = accounts;

    conn.matchstick.bind("HashpriceBTC", oracle.address, oracle.abi);
    await conn.matchstick.captureViewMocks();
    await conn.matchstick.anchor();

    await submitBlock(owner, pc, oracle, config.remaining[0]);

    const snap = await conn.matchstick.indexSnapshot([read("LatestRates", "0")]);
    const rows = snap.saved("NetworkHashrate");
    assert.equal(rows.length, 1, "one submitted block produces one NetworkHashrate row");

    const onChainDifficulty = await difficulty(pc, oracle);
    const expected = (onChainDifficulty * 2n ** 32n) / 600n;
    assertRelativelyClose(
      BigInt(String(rows[0].hashrate)),
      expected,
      "derived hashrate vs difficulty * 2^32 / 600",
    );

    // Sanity-check the fixture itself: the nBits in the headers must expand to
    // the difficulty the contract computed, or the test above proves nothing.
    assert.equal(
      onChainDifficulty,
      (difficultyImpliedHashrate(config.nBits) * 600n) / 2n ** 32n,
      "fixture nBits and on-chain difficulty disagree",
    );

    assert.equal(
      BigInt(String(rows[0].confirmedHeight)),
      await latestConfirmedHeight(pc, oracle),
      "row is tagged with the Bitcoin height the oracle confirmed",
    );
  });

  it("holds the hashrate steady across a difficulty epoch while the hashprice moves", async () => {
    const { contracts, accounts, config } =
      await conn.networkHelpers.loadFixture(deployOracleFixture);
    const { oracle } = contracts;
    const { owner, pc } = accounts;

    conn.matchstick.bind("HashpriceBTC", oracle.address, oracle.abi);
    await conn.matchstick.captureViewMocks();
    await conn.matchstick.anchor();

    const hashrates: bigint[] = [];
    const prices: bigint[] = [];
    const heights: bigint[] = [];

    for (const block of config.remaining.slice(0, 4)) {
      await submitBlock(owner, pc, oracle, block);
      const snap = await conn.matchstick.indexSnapshot([read("LatestRates", "0")]);
      const hashrate = snap.saved("NetworkHashrate")[0];
      const price = snap.saved("HashpriceBtc")[0];
      assert.ok(hashrate, "every submitted block yields a NetworkHashrate row");
      assert.ok(price, "every submitted block yields a HashpriceBtc row");
      hashrates.push(BigInt(String(hashrate.hashrate)));
      heights.push(BigInt(String(hashrate.confirmedHeight)));
      prices.push(BigInt(String(price.price)));
    }

    assert.equal(new Set(heights.map(String)).size, heights.length, "each block is a fresh height");
    for (let i = 1; i < heights.length; i++) {
      assert.equal(heights[i], heights[i - 1] + 1n, "confirmed height advances one block at a time");
    }

    // The fee SMA — and with it the hashprice — moves on every block, but all of
    // these headers share one nBits. The derived hashrate must ignore the fee
    // component entirely and track difficulty alone.
    assert.ok(
      new Set(prices.map(String)).size > 1,
      `hashprice must vary across blocks for this test to mean anything, got ${prices.join(", ")}`,
    );
    assert.equal(
      new Set(hashrates.map(String)).size,
      1,
      `hashrate must be constant within a difficulty epoch, got ${hashrates.join(", ")}`,
    );
  });

  it("mirrors the newest hashrate and hashprice onto LatestRates", async () => {
    const { contracts, accounts, config } =
      await conn.networkHelpers.loadFixture(deployOracleFixture);
    const { oracle } = contracts;
    const { owner, pc } = accounts;

    conn.matchstick.bind("HashpriceBTC", oracle.address, oracle.abi);
    await conn.matchstick.captureViewMocks();
    await conn.matchstick.anchor();

    await submitBlock(owner, pc, oracle, config.remaining[0]);
    await submitBlock(owner, pc, oracle, config.remaining[1]);

    const snap = await conn.matchstick.indexSnapshot([read("LatestRates", "0")]);
    const rates = snap.entity("LatestRates", "0");
    assert.ok(rates, "LatestRates singleton exists");

    const confirmedHeight = await latestConfirmedHeight(pc, oracle);
    const hashrate = snap.saved("NetworkHashrate")[0];

    assert.equal(
      String(rates.networkHashrate),
      String(hashrate.hashrate),
      "LatestRates.networkHashrate matches the newest NetworkHashrate row",
    );
    // Both id columns carry the Bitcoin height, which is also the oracle's
    // Chainlink roundId. They used to be read back off the timeseries `id`,
    // which Graph Node overwrites, so they silently held the wrong value.
    assert.equal(String(rates.networkHashrateId), String(confirmedHeight));
    assert.equal(String(rates.hashpriceBtcId), String(confirmedHeight));
  });

  it("records confirmedHeight and avgFees on the hashprice row itself", async () => {
    const { contracts, accounts, config } =
      await conn.networkHelpers.loadFixture(deployOracleFixture);
    const { oracle } = contracts;
    const { owner, pc } = accounts;

    conn.matchstick.bind("HashpriceBTC", oracle.address, oracle.abi);
    await conn.matchstick.captureViewMocks();
    await conn.matchstick.anchor();

    await submitBlock(owner, pc, oracle, config.remaining[0]);

    const snap = await conn.matchstick.indexSnapshot([read("LatestRates", "0")]);
    const row = snap.saved("HashpriceBtc")[0];
    assert.ok(row, "HashpriceBtc row exists");

    // These two fields make the row self-describing: subsidy is a pure function
    // of height, so the hashrate is recomputable from the row alone.
    assert.equal(BigInt(String(row.confirmedHeight)), await latestConfirmedHeight(pc, oracle));
    assert.equal(BigInt(String(row.avgFees)), await avgFees(pc, oracle));
  });
});
