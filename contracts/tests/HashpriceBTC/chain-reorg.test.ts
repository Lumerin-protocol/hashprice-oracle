import { catchError } from "../../lib/lib.ts";
import { parseEventLogs } from "viem";
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

// ─── Fixture: deploy at retarget boundary for same-height reorg test ─

// Choose nBits that straddle the integer boundary where floor(2^24 / coeff) jumps from 2 to 3.
//   coeff = 5_592_406 (0x555556): floor(2^24 / 5592406) = 2  → work = 2, ~2 expected hashes
//   coeff = 5_592_405 (0x555555): floor(2^24 / 5592405) = 3  → work = 3, ~3 expected hashes
// Adjacent coefficients → |Δtarget| = 2^232, tolerance = target/1000 ≈ 5592 × 2^232 → retarget passes.
const EPOCH_NBITS = 0x20555556; // work = 2 per block, mines in ~2 hashes
const HARDER_EPOCH_NBITS = 0x20555555; // work = 3 per block, mines in ~3 hashes
const RETARGET_EXPECTED_TIMESPAN = 2016 * 10 * 60;

/**
 * Deploy at height 2014 (two blocks before the retarget at 2016).
 *
 * Chain A (4 blocks 2015–2018, all EPOCH_NBITS) becomes the canonical tip at 2018.
 * Chain A's retarget at block 2016 keeps EPOCH_NBITS (actualTimespan ≈ EXPECTED_TIMESPAN).
 * After chain A: state.epochStartNBits = EPOCH_NBITS, epochStartTimestamp = chainA_block2015_ts.
 *
 * Chain B (4 blocks 2015–2018) forks from the same ancestor (2014):
 *   - Block 2015: EPOCH_NBITS, timestamp = chainA_block2015_ts + EXPECTED_TIMESPAN.
 *     This overwrites _blockAt(2015) so chain B's retarget at block 2016 sees
 *     actualTimespan = EXPECTED_TIMESPAN → expectedTarget = nBitsToTarget(EPOCH_NBITS).
 *   - Blocks 2016–2018: HARDER_EPOCH_NBITS (0x20555555) → each block carries work=3 vs work=2.
 * Same height (2018), more cumulative work → should trigger ChainReorg.
 * With H-1 bug: always NotHeaviestChain. With fix: ChainReorg accepted.
 */
async function deployRetargetBoundaryFixture(conn: NetworkConnection) {
  const { viem } = conn;
  const pc = await viem.getPublicClient();
  const tc = await viem.getTestClient();

  const checkpointHeight = 2014;
  const baseTs = 1_764_000_000;
  // checkpointTs is epoch-start + EXPECTED_TIMESPAN so chain A's retarget actualTimespan
  // = chainA_block2015_ts - baseTs ≈ EXPECTED_TIMESPAN → expectedTarget ≈ EPOCH_NBITS target.
  const checkpointTs = baseTs + RETARGET_EXPECTED_TIMESPAN;
  const fakeCheckpointHash = "bb".repeat(32);

  // EVM time must be ahead of the furthest block timestamp chain B will submit.
  // Chain B's latest timestamp ≈ checkpointTs + 2*EXPECTED_TIMESPAN + 2400.
  await tc.setNextBlockTimestamp({
    timestamp: BigInt(checkpointTs + 2 * RETARGET_EXPECTED_TIMESPAN + 30 * 24 * 3600),
  });

  const oracle = await viem.deployContract("HashpriceBTC", [
    hex(fakeCheckpointHash),
    checkpointHeight,
    checkpointTs,
    EPOCH_NBITS,
    baseTs, // epochStartTimestamp = first block of this epoch
    EPOCH_NBITS,
  ]);

  // Chain A: 4 blocks (2015–2018) at EPOCH_NBITS. Block 2016 is the retarget block.
  // mineChain timestamps: block i → checkpointTs + (i+1)*600, so block2015_ts = checkpointTs+600.
  const chainA = mineChain(
    fakeCheckpointHash,
    checkpointHeight + 1,
    4,
    checkpointTs,
    EPOCH_NBITS,
    1000n,
  );
  const batchA = formatBatch(chainA);
  const txA = await oracle.write.submitBlocks([
    checkpointHeight,
    batchA.headers,
    batchA.coinbaseTxs,
    batchA.merkleProofs,
  ]);
  await pc.waitForTransactionReceipt({ hash: txA });

  // After chain A's retarget: state.epochStartTimestamp = chainA_block2015_ts = checkpointTs + 600.
  const chainA_block2015_ts = checkpointTs + 600;

  return {
    oracle,
    pc,
    checkpointHeight,
    fakeCheckpointHash,
    checkpointTs,
    chainA,
    chainA_block2015_ts,
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

  it("should emit ChainReorg when a longer fork replaces canonical blocks", async function () {
    // The fixture leaves chain A (3 blocks, heights 101–103) as the canonical tip.
    // Chain B forks from genesisHeight (100), which is below the current tip (103),
    // and adds 4 blocks (101–104) — this is a genuine reorg, not a plain extension.
    const { oracle, pc, genesisHeight, genesisHash, baseTs, nBits } =
      await loadFixture(deployReorgFixture);

    const chainB = mineChain(genesisHash, genesisHeight + 1, 4, baseTs, nBits, 5000n);
    const batch = formatBatch(chainB);

    const txHash = await oracle.write.submitBlocks([
      genesisHeight,
      batch.headers,
      batch.coinbaseTxs,
      batch.merkleProofs,
    ]);
    const receipt = await pc.waitForTransactionReceipt({ hash: txHash });

    const [reorgEvent] = parseEventLogs({
      abi: oracle.abi,
      logs: receipt.logs,
      eventName: "ChainReorg",
    });

    assert.ok(reorgEvent, "ChainReorg event should be emitted");
    assert.equal(reorgEvent.args.newTip?.toLowerCase(), hex(chainB[3].hash).toLowerCase());
    assert.equal(reorgEvent.args.newHeight, genesisHeight + 4);
  });

  it("should not emit ChainReorg when extending the chain tip (no reorg)", async function () {
    // Submit one more block on top of chain A's tip — ancestorHeight == chainHeight,
    // so this is a plain extension and must not emit ChainReorg.
    const { oracle, pc, genesisHeight, baseTs, nBits, chainA } =
      await loadFixture(deployReorgFixture);

    const tip = chainA[chainA.length - 1];
    const extension = mineChain(tip.hash, tip.height + 1, 1, baseTs + 3 * 600, nBits, 2000n);
    const batch = formatBatch(extension);

    const txHash = await oracle.write.submitBlocks([
      tip.height, // ancestorHeight == current chainHeight → plain extension
      batch.headers,
      batch.coinbaseTxs,
      batch.merkleProofs,
    ]);
    const receipt = await pc.waitForTransactionReceipt({ hash: txHash });

    const reorgEvents = parseEventLogs({
      abi: oracle.abi,
      logs: receipt.logs,
      eventName: "ChainReorg",
    });

    assert.equal(reorgEvents.length, 0, "ChainReorg must not be emitted for a plain extension");
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

  // H-1 regression: the old _isHeavierChain read the ring buffer AFTER _processHeader
  // already overwrote it with the new fork's data, so oldNBits == newNBits and the
  // heavier-chain check always returned false. Fix: snapshot work before the loop.
  it("should accept a same-height fork with strictly greater cumulative work (ChainReorg)", async function () {
    const { oracle, pc, checkpointHeight, fakeCheckpointHash, chainA_block2015_ts } =
      await loadFixture(deployRetargetBoundaryFixture);

    // Chain B forks from the same ancestor (height 2014) and ends at the same height (2018).
    //
    // Block 2015 uses EPOCH_NBITS (must match ancestor's nBits; 2015%2016≠0 so no retarget).
    // Its timestamp is chainA_block2015_ts + EXPECTED_TIMESPAN so that when block 2016's
    // _verifyRetarget runs it sees actualTimespan = EXPECTED_TIMESPAN → expectedTarget =
    // nBitsToTarget(EPOCH_NBITS), and HARDER_EPOCH_NBITS is within the 0.1% tolerance.
    //
    // Without this careful timestamp, chain A's retarget would have set
    // state.epochStartTimestamp = chainA_block2015_ts, and _blockAt(2015) (still chain A's
    // data) would give actualTimespan = 0 → InvalidRetarget for chain B.
    // Chain B's block 2015 *overwrites* _blockAt(2015) before its own block 2016 retarget.
    const chainB_block2015_ts = chainA_block2015_ts + RETARGET_EXPECTED_TIMESPAN;
    const chainB_b2015 = mineSyntheticBlock(
      fakeCheckpointHash,
      2015,
      chainB_block2015_ts,
      EPOCH_NBITS,
      500n,
    );

    // Blocks 2016–2018 at HARDER_EPOCH_NBITS: each carries more work per block.
    // Block 2016 is the retarget block; it passes _verifyRetarget as shown above.
    const chainB_rest = mineChain(
      chainB_b2015.hash,
      2016,
      3,
      chainB_block2015_ts,
      HARDER_EPOCH_NBITS,
      5000n,
    );
    const chainB = [chainB_b2015, ...chainB_rest];
    const batchB = formatBatch(chainB);

    // Expected (after H-1 fix): snapshotted work shows chain B is heavier → ChainReorg.
    // Before fix: ring buffer overwritten before comparison → oldWork==newWork → NotHeaviestChain.
    const tx = await oracle.write.submitBlocks([
      checkpointHeight,
      batchB.headers,
      batchB.coinbaseTxs,
      batchB.merkleProofs,
    ]);
    const receipt = await pc.waitForTransactionReceipt({ hash: tx });
    assert.equal(receipt.status, "success");

    const newTip = await oracle.read.chainTipHash();
    assert.equal(newTip.toLowerCase(), hex(chainB[chainB.length - 1].hash).toLowerCase());
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
