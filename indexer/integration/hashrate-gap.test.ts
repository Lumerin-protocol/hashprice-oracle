/**
 * Network hashrate across Bitcoin heights the subgraph never indexed. On dev the keeper fed the
 * new HashpriceBTC 975,339–975,350 before the subgraph was grafted onto it, so 975,351 started
 * a new chain run and the hashrate windows stopped. The work across a gap follows from the
 * neighbouring blocks' nBits; only the median time past of the 10 blocks after it is built from
 * fewer timestamps, and the windows ending or starting on those blocks are flagged as not exact.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { network } from "hardhat";
import {
  deployGapFixture,
  deployOracleSwitchGapFixture,
  indexDeployment,
  indexSnapshot,
  MTP_WINDOW,
  WINDOW_1D,
  WINDOW_7D,
  windowHashrate,
} from "./helpers.ts";

const conn = await network.getOrCreate();

// An approximate median time past may move a window's elapsed time; the deviation accepted.
const MAX_DEVIATION_PERCENT = 10n;

/** Whether the median time past at `height` is built from fewer than 11 timestamps. */
function approximate(gapEnd: number, height: number): boolean {
  return height > gapEnd && height - (MTP_WINDOW - 1) <= gapEnd;
}

describe("NetworkHashrate across a gap in Bitcoin heights", () => {
  afterEach(() => conn.matchstick.reset());

  it("bridges a gap that opens while indexing", async () => {
    const { deployment: d, chain, gapStart, gapEnd, gapBlock } = await conn.networkHelpers.loadFixture(deployGapFixture);
    await indexDeployment(conn, d, { toBlock: gapBlock - 1n });
    await conn.matchstick.ingest({ fromBlock: gapBlock + 1n });

    const snap = await indexSnapshot(conn);
    const baseHeight = chain[0].height;
    const tip = chain[chain.length - 1].height;

    const rates = snap.entity("LatestRates", "0");
    assert.ok(rates, "LatestRates singleton exists");
    assert.equal(rates.networkHashrate1dId, String(tip), "1-day hashrate measured at the tip");
    assert.equal(rates.networkHashrate1dHpS, String(windowHashrate(chain, tip, WINDOW_1D)));
    assert.equal(rates.networkHashrate1dExact, true);
    assert.equal(rates.networkHashrate7dId, String(tip), "7-day hashrate measured at the tip");
    assert.equal(rates.networkHashrate7dHpS, String(windowHashrate(chain, tip, WINDOW_7D)));
    assert.equal(rates.networkHashrate7dExact, true);

    for (const [entity, window] of [
      ["NetworkHashrate1d", WINDOW_1D],
      ["NetworkHashrate7d", WINDOW_7D],
    ] as const) {
      const rows = snap.saved(entity);
      const firstHeight = baseHeight + MTP_WINDOW - 1 + window;
      const expectedHeights: number[] = [];
      for (let height = firstHeight; height <= tip; height++) {
        if (height < gapStart || height > gapEnd) expectedHeights.push(height);
      }
      assert.deepEqual(
        rows.map((row) => Number(row.confirmedHeight)),
        expectedHeights,
        `${entity}: one row per indexed measurable height`,
      );

      for (const row of rows) {
        const height = Number(row.confirmedHeight);
        const expected = windowHashrate(chain, height, window);
        const exact = !approximate(gapEnd, height) && !approximate(gapEnd, height - window);
        assert.equal(row.exact, exact, `${entity} at ${height}: exact`);
        if (exact) {
          assert.equal(row.hashrateHpS, String(expected), `${entity} at ${height}`);
        } else {
          const deviation = BigInt(row.hashrateHpS) - expected;
          const magnitude = deviation < 0n ? -deviation : deviation;
          assert.ok(
            magnitude * 100n <= expected * MAX_DEVIATION_PERCENT,
            `${entity} at ${height}: ${row.hashrateHpS} within ${MAX_DEVIATION_PERCENT} % of ${expected}`,
          );
        }
      }
    }
  });

  it("joins a run indexed after a gap to the chain below it (dev after the oracle switch)", async () => {
    const { previous, next, chain, gapEnd, tipBlock } = await conn.networkHelpers.loadFixture(
      deployOracleSwitchGapFixture,
    );
    // Replayed in EVM order: the run above the gap with nothing below it, as 3.6.0 left it on
    // dev; the run below the gap, as the graft copied it; then the next block.
    await indexDeployment(conn, next, { toBlock: previous.startBlock - 1n });
    await indexDeployment(conn, previous, { toBlock: tipBlock - 1n });
    await indexDeployment(conn, next, { fromBlock: tipBlock });

    const snap = await indexSnapshot(conn);
    const baseHeight = chain[0].height;
    const tip = chain[chain.length - 1].height;

    const rates = snap.entity("LatestRates", "0");
    assert.ok(rates, "LatestRates singleton exists");
    assert.equal(rates.networkHashrate1dId, String(tip), "1-day hashrate measured at the tip");
    assert.equal(rates.networkHashrate1dHpS, String(windowHashrate(chain, tip, WINDOW_1D)));
    assert.equal(rates.networkHashrate1dExact, true);
    assert.equal(rates.networkHashrate7dId, String(tip), "7-day hashrate measured at the tip");
    assert.equal(rates.networkHashrate7dHpS, String(windowHashrate(chain, tip, WINDOW_7D)));
    assert.equal(rates.networkHashrate7dExact, true);

    for (let height = gapEnd + 1; height <= tip; height++) {
      const block = snap.entity("BtcBlock", String(height));
      assert.ok(block, `BtcBlock ${height} exists`);
      assert.equal(block.chainBaseHeight, String(baseHeight), `BtcBlock ${height}: joined to the run below the gap`);
      assert.equal(block.medianTimeApproximate, approximate(gapEnd, height), `BtcBlock ${height}: medianTimeApproximate`);
    }
  });
});
