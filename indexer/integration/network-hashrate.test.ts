/**
 * The actual network hashrate: expected work over the trailing 144 (1-day) and 1,008
 * (7-day) blocks divided by the median-time-past elapsed over them. Uses a synthetic chain
 * with irregular block gaps, because the real-header fixture is shorter than one window.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { network } from "hardhat";
import {
  deployLongSyntheticFixture,
  indexDeployment,
  indexSnapshot,
  MTP_WINDOW,
  read,
  WINDOW_1D,
  WINDOW_7D,
  windowHashrate,
} from "./helpers.ts";

const conn = await network.getOrCreate();

describe("NetworkHashrate derivation", () => {
  afterEach(() => conn.matchstick.reset());

  it("measures 1-day and 7-day hashrate from work and median time past", async () => {
    const { deployment: d, chain } = await conn.networkHelpers.loadFixture(deployLongSyntheticFixture);
    await indexDeployment(conn, d);

    const snap = await indexSnapshot(conn);
    const baseHeight = chain[0].height;
    const tip = chain[chain.length - 1].height;
    const confirmedTip = tip - Number(await read<number>(d, d.oracle, "CONFIRMATION_DEPTH"));

    for (const [entity, window] of [
      ["NetworkHashrate1d", WINDOW_1D],
      ["NetworkHashrate7d", WINDOW_7D],
    ] as const) {
      const rows = snap.saved(entity);
      // The window start needs its own median time past, so 10 ancestors below it.
      const firstHeight = baseHeight + MTP_WINDOW - 1 + window;
      assert.equal(rows.length, confirmedTip - firstHeight + 1, `${entity}: one row per measurable height`);
      assert.equal(rows[0].confirmedHeight, String(firstHeight), `${entity}: first measurable height`);

      for (const row of rows) {
        const height = Number(row.confirmedHeight);
        assert.equal(row.hashrateHpS, String(windowHashrate(chain, height, window)), `${entity} at ${height}`);
      }
    }

    const rates = snap.entity("LatestRates", "0");
    assert.ok(rates, "LatestRates singleton exists");
    assert.equal(rates.networkHashrate1dId, String(confirmedTip));
    assert.equal(rates.networkHashrate1dHpS, String(windowHashrate(chain, confirmedTip, WINDOW_1D)));
    assert.equal(rates.networkHashrate7dId, String(confirmedTip));
    assert.equal(rates.networkHashrate7dHpS, String(windowHashrate(chain, confirmedTip, WINDOW_7D)));
  });
});
