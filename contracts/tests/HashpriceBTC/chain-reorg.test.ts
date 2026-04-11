import { catchError } from "../../lib/lib.ts";
import {
  hex,
  buildHeader,
  mineHeader,
  dsha256,
  blockHash,
  getBlockSubsidy,
  EASY_NBITS,
} from "./helpers.ts";
import type { NetworkConnection } from "hardhat/types";
import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  networkHelpers: { loadFixture },
} = await network.connect();

// ─── Synthetic block helpers ──────────────────────────────────────

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

interface SyntheticBlock {
  rawHeader: string;
  coinbaseTx: string;
  hash: string;
  height: number;
}

function mineSyntheticBlock(
  prevHash: string,
  height: number,
  timestamp: number,
  nBits: number,
  fees: bigint,
): SyntheticBlock {
  const coinbaseTx = buildCoinbaseTx(getBlockSubsidy(height) + fees);
  const rawHeader = buildHeader({
    prevHash,
    timestamp,
    nBits,
    merkleRoot: dsha256(coinbaseTx),
  });
  const minedHeader = mineHeader(rawHeader, nBits);
  return {
    rawHeader: minedHeader,
    coinbaseTx,
    hash: blockHash(minedHeader),
    height,
  };
}

/** Mine a chain of synthetic blocks. Different `baseFee` values produce distinct chains. */
function mineChain(
  tipHash: string,
  startHeight: number,
  count: number,
  baseTimestamp: number,
  nBits: number,
  baseFee: bigint,
): SyntheticBlock[] {
  const chain: SyntheticBlock[] = [];
  let prev = tipHash;
  for (let i = 0; i < count; i++) {
    const b = mineSyntheticBlock(
      prev,
      startHeight + i,
      baseTimestamp + (i + 1) * 600,
      nBits,
      baseFee + BigInt(i) * 100n,
    );
    chain.push(b);
    prev = b.hash;
  }
  return chain;
}

function formatBatch(blocks: SyntheticBlock[]) {
  return {
    headers: hex(blocks.map((b) => b.rawHeader).join("")),
    coinbaseTxs: blocks.map((b) => hex(b.coinbaseTx)),
    merkleProofs: blocks.map(() => [] as `0x${string}`[]),
  };
}

// ─── Fixture: deploy oracle + submit a 3-block main chain ─────────

async function deployReorgFixture(conn: NetworkConnection) {
  const { viem } = conn;
  const pc = await viem.getPublicClient();
  const tc = await viem.getTestClient();

  const genesisHeight = 100;
  const baseTs = 1_764_000_000;
  const nBits = EASY_NBITS;

  const genesisHeader = buildHeader({
    prevHash: "00".repeat(32),
    timestamp: baseTs,
    nBits,
  });
  const minedGenesis = mineHeader(genesisHeader, nBits);
  const genesisHash = blockHash(minedGenesis);

  await tc.setNextBlockTimestamp({ timestamp: BigInt(baseTs + 200_000) });

  const oracle = await viem.deployContract("HashpriceBTC", [
    hex(genesisHash),
    genesisHeight,
    baseTs,
    nBits,
    baseTs,
    nBits,
  ]);

  // Main chain (A): 3 blocks, heights 101–103
  const chainA = mineChain(genesisHash, genesisHeight + 1, 3, baseTs, nBits, 1000n);
  const batchA = formatBatch(chainA);

  const txA = await oracle.write.submitBlocks([
    genesisHeight,
    batchA.headers,
    batchA.coinbaseTxs,
    batchA.merkleProofs,
  ]);
  await pc.waitForTransactionReceipt({ hash: txA });

  return { oracle, pc, genesisHeight, genesisHash, baseTs, nBits, chainA };
}

// ─── Tests ────────────────────────────────────────────────────────

describe("HashpriceBTC — Chain reorg", function () {
  it("should accept a longer fork and update chain tip + height", async function () {
    const { oracle, pc, genesisHeight, genesisHash, baseTs, nBits } =
      await loadFixture(deployReorgFixture);

    // Chain B: 4 blocks from same genesis (longer than chain A's 3)
    const chainB = mineChain(genesisHash, genesisHeight + 1, 4, baseTs, nBits, 5000n);
    const batch = formatBatch(chainB);

    const txHash = await oracle.write.submitBlocks([
      genesisHeight,
      batch.headers,
      batch.coinbaseTxs,
      batch.merkleProofs,
    ]);
    const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
    assert.equal(receipt.status, "success");

    const tip = await oracle.read.chainTipHash();
    assert.equal(tip.toLowerCase(), hex(chainB[3].hash).toLowerCase());

    const [chainHeight] = await oracle.read.state();
    assert.equal(chainHeight, genesisHeight + 4);
  });

  it("should reject a same-length fork with equal work (NotHeaviestChain)", async function () {
    const { oracle, genesisHeight, genesisHash, baseTs, nBits } =
      await loadFixture(deployReorgFixture);

    // Chain B: 3 blocks, same nBits → same cumulative work → not heavier
    const chainB = mineChain(genesisHash, genesisHeight + 1, 3, baseTs, nBits, 5000n);
    const batch = formatBatch(chainB);

    await catchError(oracle.abi, "NotHeaviestChain", async () => {
      await oracle.write.submitBlocks([
        genesisHeight,
        batch.headers,
        batch.coinbaseTxs,
        batch.merkleProofs,
      ]);
    });
  });

  it("should reject a shorter fork (NotHeaviestChain)", async function () {
    const { oracle, genesisHeight, genesisHash, baseTs, nBits } =
      await loadFixture(deployReorgFixture);

    // Chain B: 2 blocks (shorter than chain A's 3)
    const chainB = mineChain(genesisHash, genesisHeight + 1, 2, baseTs, nBits, 5000n);
    const batch = formatBatch(chainB);

    await catchError(oracle.abi, "NotHeaviestChain", async () => {
      await oracle.write.submitBlocks([
        genesisHeight,
        batch.headers,
        batch.coinbaseTxs,
        batch.merkleProofs,
      ]);
    });
  });

  it("should preserve chain state when a reorg attempt is rejected", async function () {
    const { oracle, genesisHeight, genesisHash, baseTs, nBits } =
      await loadFixture(deployReorgFixture);

    const tipBefore = await oracle.read.chainTipHash();
    const [heightBefore] = await oracle.read.state();

    const chainB = mineChain(genesisHash, genesisHeight + 1, 2, baseTs, nBits, 5000n);
    const batch = formatBatch(chainB);

    await catchError(oracle.abi, "NotHeaviestChain", async () => {
      await oracle.write.submitBlocks([
        genesisHeight,
        batch.headers,
        batch.coinbaseTxs,
        batch.merkleProofs,
      ]);
    });

    assert.equal(await oracle.read.chainTipHash(), tipBefore);
    const [heightAfter] = await oracle.read.state();
    assert.equal(heightAfter, heightBefore);
  });

  it("should allow extending the chain with submitBlock after a reorg", async function () {
    const { oracle, pc, genesisHeight, genesisHash, baseTs, nBits } =
      await loadFixture(deployReorgFixture);

    // Reorg to longer chain B
    const chainB = mineChain(genesisHash, genesisHeight + 1, 4, baseTs, nBits, 5000n);
    const batchB = formatBatch(chainB);

    const txReorg = await oracle.write.submitBlocks([
      genesisHeight,
      batchB.headers,
      batchB.coinbaseTxs,
      batchB.merkleProofs,
    ]);
    await pc.waitForTransactionReceipt({ hash: txReorg });

    // Extend chain B with one more block via submitBlock
    const lastB = chainB[chainB.length - 1];
    const nextBlock = mineSyntheticBlock(
      lastB.hash,
      lastB.height + 1,
      baseTs + 5 * 600,
      nBits,
      2000n,
    );

    const txHash = await oracle.write.submitBlock([
      hex(nextBlock.rawHeader),
      hex(nextBlock.coinbaseTx),
      [],
    ]);
    const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
    assert.equal(receipt.status, "success");

    const [chainHeight] = await oracle.read.state();
    assert.equal(chainHeight, lastB.height + 1);
  });
});
