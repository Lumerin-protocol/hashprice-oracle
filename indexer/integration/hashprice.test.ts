/**
 * HashpriceBtc rows mirror the oracle's HashpriceUpdated events, and HashpriceUsd is the
 * same product of the two feeds that the HashpriceUSD contract computes on-chain.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { network } from "hardhat";
import { BTC_USD_PRICE, deployOracleFixture, indexDeployment, indexSnapshot, oracleEvents, read, submitBlock } from "./helpers.ts";

const conn = await network.getOrCreate();

describe("Hashprice feeds", () => {
  afterEach(() => conn.matchstick.reset());

  it("saves one HashpriceBtc row per HashpriceUpdated event", async () => {
    const { deployment: d, remaining } = await conn.networkHelpers.loadFixture(deployOracleFixture);
    await indexDeployment(conn, d);
    for (const block of remaining.slice(0, 3)) await submitBlock(d, block);

    const events = (await oracleEvents(d)).filter((e) => e.eventName === "HashpriceUpdated");
    const snap = await indexSnapshot(conn);
    const rows = snap.saved("HashpriceBtc");
    assert.equal(rows.length, events.length, "one row per event");
    assert.ok(new Set(rows.map((r) => r.id)).size === rows.length, "rows keep distinct ids");

    for (const [i, row] of rows.entries()) {
      const { confirmedHeight, hashprice, avgFees } = events[i].args;
      assert.equal(row.confirmedHeight, String(confirmedHeight));
      assert.equal(row.price, String(hashprice));
      assert.equal(row.avgFees, String(avgFees));
    }

    const [roundId, answer] = await read<readonly bigint[]>(d, d.oracle, "latestRoundData");
    const rates = snap.entity("LatestRates", "0");
    assert.ok(rates, "LatestRates singleton exists");
    assert.equal(rates.hashpriceBtcId, String(roundId), "the Bitcoin height, which is also the round id");
    assert.equal(rates.hashpriceBtcPrice, String(answer));
  });

  it("derives HashpriceUsd the way the HashpriceUSD contract does", async () => {
    const { deployment: d, remaining } = await conn.networkHelpers.loadFixture(deployOracleFixture);
    await indexDeployment(conn, d);
    await submitBlock(d, remaining[0]);

    const snap = await indexSnapshot(conn);

    const meta = snap.entity("HashpriceMeta", "0");
    assert.ok(meta, "HashpriceMeta is initialized");
    assert.equal(meta.hashpriceBtcDecimals, String(await read<number>(d, d.oracle, "decimals")));
    assert.equal(meta.btcUsdDecimals, String(await read<number>(d, d.btcUsd, "decimals")));
    assert.equal(meta.hashpriceUsdDecimals, String(await read<number>(d, d.hashpriceUsd, "decimals")));

    const btcUsd = snap.saved("BtcUsd");
    assert.equal(btcUsd.length, 1, "the one BTC/USD answer the fixture published");
    assert.equal(btcUsd[0].price, String(BTC_USD_PRICE));

    const usd = snap.saved("HashpriceUsd");
    assert.ok(usd.length > 0, "HashpriceUsd is derived once both feeds have a value");
    const [, answer] = await read<readonly bigint[]>(d, d.hashpriceUsd, "latestRoundData");
    assert.equal(usd[usd.length - 1].price, String(answer), "matches HashpriceUSD.latestRoundData");
  });
});
