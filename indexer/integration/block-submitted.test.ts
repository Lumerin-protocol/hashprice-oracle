/**
 * `handleBlockSubmitted` builds every BtcBlock row from the event alone, so a batch of any
 * depth indexes without reading the oracle's ring buffer back.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { network } from "hardhat";
import { reverseHex } from "../../contracts/tests/HashpriceBTC/helpers.ts";
import {
  blockWork,
  deployEmptyOracleFixture,
  difficultyOf,
  feesOf,
  hex,
  indexDeployment,
  indexSnapshot,
  medianTimePast,
  MTP_WINDOW,
  oracleEvents,
  read,
  submitRealBatch,
} from "./helpers.ts";

const conn = await network.getOrCreate();

describe("BtcBlock indexing", () => {
  afterEach(() => conn.matchstick.reset());

  it("records each block's header fields and coinbase value from the event", async () => {
    const { deployment: d, checkpoint, blocks } = await conn.networkHelpers.loadFixture(deployEmptyOracleFixture);
    const submitted = blocks.slice(0, MTP_WINDOW + 2);
    await indexDeployment(conn, d);
    await submitRealBatch(d, checkpoint.height, submitted);

    const events = (await oracleEvents(d)).filter((e) => e.eventName === "BlockSubmitted");
    const snap = await indexSnapshot(conn);
    const rows = snap.saved("BtcBlock");
    assert.equal(rows.length, submitted.length, "one BtcBlock row per submitted header");

    let cumulativeWork = 0n;
    for (const [i, block] of submitted.entries()) {
      const row = snap.entity("BtcBlock", String(block.height));
      assert.ok(row, `BtcBlock ${block.height} exists`);
      const event = events[i].args;
      cumulativeWork += blockWork(block.nBits);

      assert.equal(row.blockHash, hex(reverseHex(block.hash)), "hash in internal byte order");
      assert.equal(row.blockHash, event.blockHash);
      assert.equal(row.btcTimestamp, String(block.timestamp), "header timestamp");
      assert.equal(row.nBits, String(block.nBits), "header nBits");
      assert.equal(row.coinbaseValue, String(block.coinbase.totalOutputValue), "coinbase total");
      assert.equal(row.coinbaseValue, String(event.coinbaseValue));
      assert.equal(row.fees, String(feesOf(block.height, BigInt(block.coinbase.totalOutputValue))));
      assert.equal(row.difficulty, String(difficultyOf(block.nBits)));
      assert.equal(row.impliedHashrateHpS, String(blockWork(block.nBits) / 600n));
      assert.equal(row.cumulativeWork, String(cumulativeWork), "work summed from the first indexed block");
      assert.equal(row.chainBaseHeight, String(submitted[0].height));

      const expectedMedian = i >= MTP_WINDOW - 1 ? String(medianTimePast(submitted, block.height)) : null;
      assert.equal(row.medianTime, expectedMedian, `median time past at ${block.height}`);
    }
  });

  it("indexes a single batch deeper than the oracle's ring buffer without gaps", async () => {
    const { deployment: d, checkpoint, blocks } = await conn.networkHelpers.loadFixture(deployEmptyOracleFixture);
    const bufferSize = Number(await read<number>(d, d.oracle, "BLOCK_BUFFER_SIZE"));
    const submitted = blocks.slice(0, bufferSize + 36);
    await indexDeployment(conn, d);
    await submitRealBatch(d, checkpoint.height, submitted);

    const snap = await indexSnapshot(conn);
    assert.equal(snap.saved("BtcBlock").length, submitted.length, "every header in the batch has a row");

    let cumulativeWork = 0n;
    for (const block of submitted) {
      const row = snap.entity("BtcBlock", String(block.height));
      assert.ok(row, `BtcBlock ${block.height} exists`);
      cumulativeWork += blockWork(block.nBits);
      assert.equal(row.btcTimestamp, String(block.timestamp));
      assert.equal(row.chainBaseHeight, String(submitted[0].height), "one unbroken chain");
      assert.equal(row.cumulativeWork, String(cumulativeWork));
    }
  });
});
