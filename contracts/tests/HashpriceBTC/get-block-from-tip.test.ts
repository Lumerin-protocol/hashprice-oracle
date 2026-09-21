import { catchError } from "../../lib/lib.ts";
import {
  hex,
  dsha256,
  blockHash,
  buildHeader,
  mineHeader,
  getBlockSubsidy,
  EASY_NBITS,
} from "./helpers.ts";
import { deployOracleFixture } from "./fixtures.ts";
import { network } from "hardhat";
import type { NetworkConnection } from "hardhat/types";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  networkHelpers: { loadFixture },
} = await network.connect();

// ─── Minimal low-height fixture ───────────────────────────────────
//
// Uses synthetic blocks at height 10–13 so that the uint8 index
// can exceed chainHeight (needed to exercise the InsufficientData guard).

function buildCoinbaseTx(outputValue: bigint): string {
  const valueBuf = Buffer.alloc(8);
  valueBuf.writeBigUInt64LE(outputValue);
  return [
    "01000000",
    "01",
    "00".repeat(32),
    "ffffffff",
    "04",
    "deadbeef",
    "ffffffff",
    "01",
    valueBuf.toString("hex"),
    "01",
    "51",
    "00000000",
  ].join("");
}

function mineSyntheticBlock(prevHash: string, height: number, timestamp: number, nBits: number) {
  const coinbaseTx = buildCoinbaseTx(getBlockSubsidy(height) + 1000n);
  const rawHeader = buildHeader({ prevHash, timestamp, nBits, merkleRoot: dsha256(coinbaseTx) });
  const minedHeader = mineHeader(rawHeader, nBits);
  return { rawHeader: minedHeader, coinbaseTx, hash: blockHash(minedHeader), height };
}

async function deployLowHeightFixture(conn: NetworkConnection) {
  const { viem } = conn;
  const pc = await viem.getPublicClient();
  const tc = await viem.getTestClient();

  const genesisHeight = 10;
  const baseTs = 2_000_000_000; // well past any timestamp set by other fixtures
  const nBits = EASY_NBITS;

  const genesisHeader = buildHeader({ prevHash: "00".repeat(32), timestamp: baseTs, nBits });
  const minedGenesis = mineHeader(genesisHeader, nBits);
  const genesisHash = blockHash(minedGenesis);

  await tc.setNextBlockTimestamp({ timestamp: BigInt(baseTs + 100_000) });

  const oracle = await viem.deployContract("HashpriceBTC", [
    hex(genesisHash),
    genesisHeight,
    baseTs,
    nBits,
    baseTs,
    nBits,
  ]);

  // Submit 3 blocks: heights 11, 12, 13
  const blocks = [];
  let prevHash = genesisHash;
  for (let i = 0; i < 3; i++) {
    const b = mineSyntheticBlock(prevHash, genesisHeight + 1 + i, baseTs + (i + 1) * 600, nBits);
    blocks.push(b);
    prevHash = b.hash;
  }

  for (const b of blocks) {
    await oracle.write.submitBlock([hex(b.rawHeader), hex(b.coinbaseTx), []]);
  }

  return { oracle, pc, genesisHeight, genesisHash, genesisHeader: minedGenesis, blocks, nBits };
}

// ─── Tests ────────────────────────────────────────────────────────

describe("HashpriceBTC — getBlockFromTip()", function () {
  it("index=0 returns the tip block with correct height", async function () {
    const { contracts, config } = await loadFixture(deployOracleFixture);
    const [chainHeight] = await contracts.oracle.read.state();
    const entry = await contracts.oracle.read.getBlockFromTip([0]);
    assert.equal(entry.height, chainHeight);
  });

  it("index=0 returns the tip block with correct blockHash", async function () {
    const { contracts, config } = await loadFixture(deployOracleFixture);
    const tip = config.blocks[config.batchEnd - 1];
    const entry = await contracts.oracle.read.getBlockFromTip([0]);
    assert.equal(entry.blockHash.toLowerCase(), hex(dsha256(tip.rawHeader)).toLowerCase());
  });

  it("index=0 returns the tip block with correct timestamp", async function () {
    const { contracts, config } = await loadFixture(deployOracleFixture);
    const tip = config.blocks[config.batchEnd - 1];
    const entry = await contracts.oracle.read.getBlockFromTip([0]);
    assert.equal(entry.timestamp, tip.timestamp);
  });

  it("index=0 returns the tip block with correct nBits", async function () {
    const { contracts, config } = await loadFixture(deployOracleFixture);
    const tip = config.blocks[config.batchEnd - 1];
    const entry = await contracts.oracle.read.getBlockFromTip([0]);
    assert.equal(entry.nBits, tip.nBits);
  });

  it("index=1 returns the block one behind the tip", async function () {
    const { contracts, config } = await loadFixture(deployOracleFixture);
    const [chainHeight] = await contracts.oracle.read.state();
    const entry = await contracts.oracle.read.getBlockFromTip([1]);
    assert.equal(entry.height, chainHeight - 1);
  });

  it("index=1 returns the correct blockHash for tip-1", async function () {
    const { contracts, config } = await loadFixture(deployOracleFixture);
    const penultimate = config.blocks[config.batchEnd - 2];
    const entry = await contracts.oracle.read.getBlockFromTip([1]);
    assert.equal(entry.blockHash.toLowerCase(), hex(dsha256(penultimate.rawHeader)).toLowerCase());
  });

  it("each successive index steps one block further from the tip", async function () {
    const { oracle, blocks } = await loadFixture(deployLowHeightFixture);
    const [chainHeight] = await oracle.read.state();

    for (let i = 0; i <= 2; i++) {
      const entry = await oracle.read.getBlockFromTip([i]);
      assert.equal(entry.height, chainHeight - i);
    }
  });

  it("blockHash matches dsha256 of raw header at each offset", async function () {
    const { oracle, blocks, genesisHash } = await loadFixture(deployLowHeightFixture);

    // blocks[2] = tip (index 0), blocks[1] = index 1, blocks[0] = index 2
    const expected = [...blocks].reverse();
    for (let i = 0; i < expected.length; i++) {
      const entry = await oracle.read.getBlockFromTip([i]);
      assert.equal(
        entry.blockHash.toLowerCase(),
        hex(dsha256(expected[i].rawHeader)).toLowerCase(),
      );
    }
  });

  it("reverts InsufficientData when index == chainHeight", async function () {
    const { oracle } = await loadFixture(deployLowHeightFixture);
    const [chainHeight] = await oracle.read.state();
    // chainHeight = 13; uint8(13) >= 13 → should revert
    await catchError(oracle.abi, "InsufficientData", async () => {
      await oracle.read.getBlockFromTip([Number(chainHeight)]);
    });
  });

  it("reverts InsufficientData when index > chainHeight", async function () {
    const { oracle } = await loadFixture(deployLowHeightFixture);
    const [chainHeight] = await oracle.read.state();
    await catchError(oracle.abi, "InsufficientData", async () => {
      await oracle.read.getBlockFromTip([Number(chainHeight) + 5]);
    });
  });
});
