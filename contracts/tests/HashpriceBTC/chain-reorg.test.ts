import { catchError } from "../../lib/lib.ts";
import { parseEventLogs } from "viem";
import {
  hex,
  buildHeader,
  buildCoinbaseTx,
  mineHeader,
  blockHash,
  getBlockSubsidy,
  mineSyntheticBlock,
  mineChain,
  formatBatch,
  EASY_NBITS,
} from "./helpers.ts";
import type { NetworkConnection } from "hardhat/types";
import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  networkHelpers: { loadFixture },
} = await network.connect();

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
 * After chain A: state.epochStartNBits = EPOCH_NBITS, epochStartTimestamp = chainA_block2016_ts
 * (first block of the new epoch, matching Bitcoin).
 *
 * Chain B (4 blocks 2015–2018) forks from the same ancestor (2014):
 *   - Block 2015: EPOCH_NBITS, timestamp = baseTs + EXPECTED_TIMESPAN (Bitcoin-correct
 *     timespan against the restored previous epoch start).
 *   - Blocks 2016–2018: HARDER_EPOCH_NBITS (0x20555555) → each block carries work=3 vs work=2.
 * Same height (2018), more cumulative work → should trigger ChainReorg.
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

  // After chain A's retarget: state.epochStartTimestamp = chainA_block2016_ts = checkpointTs + 1200.
  const chainA_block2016_ts = checkpointTs + 1200;

  return {
    oracle,
    pc,
    checkpointHeight,
    fakeCheckpointHash,
    checkpointTs,
    baseTs,
    chainA,
    chainA_block2016_ts,
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

/**
 * A canonical chain long enough to fill the fee window, using a harness that emits a
 * HashpriceUpdated whenever the production computation is invoked. Synthetic easy-difficulty
 * headers normally make difficulty truncate to zero, hiding the emission path under test.
 */
async function deployReorgEmissionFixture(conn: NetworkConnection) {
  const { viem } = conn;
  const pc = await viem.getPublicClient();
  const tc = await viem.getTestClient();

  const genesisHeight = 100;
  const baseTs = 1_764_000_000;
  const nBits = EASY_NBITS;
  const minedGenesis = mineHeader(
    buildHeader({ prevHash: "00".repeat(32), timestamp: baseTs, nBits }),
    nBits,
  );
  const genesisHash = blockHash(minedGenesis);

  const latestBlock = await pc.getBlock();
  const fixtureTimestamp =
    latestBlock.timestamp > BigInt(baseTs + 200_000)
      ? latestBlock.timestamp + 1n
      : BigInt(baseTs + 200_000);
  await tc.setNextBlockTimestamp({ timestamp: fixtureTimestamp });

  const oracle = await viem.deployContract("HashpriceBTCTestHarness", [
    hex(genesisHash),
    genesisHeight,
    baseTs,
    nBits,
    baseTs,
    nBits,
  ]);

  // 146 blocks lets the test fork from height 244 with a full 144-block window, replace
  // heights 245–246, and extend to 247.
  const chainA = mineChain(genesisHash, genesisHeight + 1, 146, baseTs, nBits, 1000n);
  const batchA = formatBatch(chainA);
  const txA = await oracle.write.submitBlocks([
    genesisHeight,
    batchA.headers,
    batchA.coinbaseTxs,
    batchA.merkleProofs,
  ]);
  await pc.waitForTransactionReceipt({ hash: txA });

  return { oracle, pc, genesisHeight, baseTs, nBits, chainA };
}

// ─── Fixture: canonical chain made heavier per block than a longer fork can be ─

/**
 * Same shape as deployRetargetBoundaryFixture, but chain A takes the *harder* branch of
 * the retarget so it carries more work per block than any fork built at EPOCH_NBITS.
 *
 * Both branches are legitimate: the two coefficients differ by one part in 5.6M, far
 * inside _verifyRetarget's 0.1% tolerance, so the same timespan admits either target.
 * That is what makes "longer but lighter" constructible at all — within one epoch nBits
 * is fixed, so length and work only diverge across a retarget boundary.
 *
 * Chain A: 2015 at EPOCH (work 2), 2016–2018 at HARDER (work 3 each) → height 2018, work 11.
 */
async function deployHarderCanonicalFixture(conn: NetworkConnection) {
  const { viem } = conn;
  const pc = await viem.getPublicClient();
  const tc = await viem.getTestClient();

  const checkpointHeight = 2014;
  const baseTs = 1_764_000_000;
  const checkpointTs = baseTs + RETARGET_EXPECTED_TIMESPAN;
  const fakeCheckpointHash = "cc".repeat(32);

  await tc.setNextBlockTimestamp({
    timestamp: BigInt(checkpointTs + 2 * RETARGET_EXPECTED_TIMESPAN + 30 * 24 * 3600),
  });

  const oracle = await viem.deployContract("HashpriceBTC", [
    hex(fakeCheckpointHash),
    checkpointHeight,
    checkpointTs,
    EPOCH_NBITS,
    baseTs,
    EPOCH_NBITS,
  ]);

  // Block 2015 is pre-retarget so it must keep the tip's nBits. Its timestamp sets the
  // epoch timespan to exactly EXPECTED, making the retarget target EPOCH's own.
  const forkTs = baseTs + RETARGET_EXPECTED_TIMESPAN;
  const a2015 = mineSyntheticBlock(fakeCheckpointHash, 2015, forkTs, EPOCH_NBITS, 500n);
  const chainA = [a2015, ...mineChain(a2015.hash, 2016, 3, forkTs, HARDER_EPOCH_NBITS, 5000n)];

  const batchA = formatBatch(chainA);
  const txA = await oracle.write.submitBlocks([
    checkpointHeight,
    batchA.headers,
    batchA.coinbaseTxs,
    batchA.merkleProofs,
  ]);
  await pc.waitForTransactionReceipt({ hash: txA });

  return { oracle, pc, checkpointHeight, fakeCheckpointHash, baseTs, forkTs, chainA };
}

/**
 * `count` structurally invalid headers carrying a well-formed nBits field.
 *
 * _authorizeFork reads nBits straight out of calldata, so these weigh correctly, but the
 * all-zero prevBlockHash cannot link to any real tip — whichever of the two checks runs
 * first is the one that reports the error.
 */
function junkBatch(count: number, nBits: number, timestamp: number) {
  const header = buildHeader({
    prevHash: "00".repeat(32),
    merkleRoot: "00".repeat(32),
    timestamp,
    nBits,
  });
  return {
    headers: hex(header.repeat(count)),
    coinbaseTxs: Array.from({ length: count }, () => hex(buildCoinbaseTx(5_000_000_000n))),
    merkleProofs: Array.from({ length: count }, () => [] as `0x${string}`[]),
  };
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

  // H-1 work-snapshot regression: the old heavier-chain check read the ring buffer AFTER
  // _processHeader overwrote it, so oldWork == newWork always. Fix: snapshot before the loop.
  // Timestamps use the original epoch start (baseTs); submitBlocks restores that clock when
  // the fork rewinds past the last retarget (see the epoch-restore test below).
  it("should accept a same-height fork with strictly greater cumulative work (ChainReorg)", async function () {
    const { oracle, pc, checkpointHeight, fakeCheckpointHash, baseTs } =
      await loadFixture(deployRetargetBoundaryFixture);

    // Chain B forks from height 2014 and ends at 2018 with more work per post-retarget block.
    // Block 2015 timestamp yields actualTimespan = EXPECTED against the restored epoch start.
    const chainB_block2015_ts = baseTs + RETARGET_EXPECTED_TIMESPAN;
    const chainB_b2015 = mineSyntheticBlock(
      fakeCheckpointHash,
      2015,
      chainB_block2015_ts,
      EPOCH_NBITS,
      500n,
    );

    // Blocks 2016–2018 at HARDER_EPOCH_NBITS: each carries more work per block.
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

  // Regression: after chain A retargets, state.epochStart* points at block 2016. A reorg that
  // forks below 2016 must restore the *previous* epoch start (baseTs) before re-verifying
  // the retarget. Without that restore, timespan is measured from chain A's 2016 timestamp
  // and a correctly timed fork reverts (underflow / InvalidRetarget).
  it("should restore previous epoch start when a reorg re-crosses a retarget boundary", async function () {
    const { oracle, pc, checkpointHeight, fakeCheckpointHash, baseTs } =
      await loadFixture(deployRetargetBoundaryFixture);

    // Bitcoin-correct timespan for retarget at 2016: time(2015) - time(epochStart).
    // epochStart is still baseTs until the reorg's own block 2016 is accepted.
    const chainB_block2015_ts = baseTs + RETARGET_EXPECTED_TIMESPAN;
    const chainB_b2015 = mineSyntheticBlock(
      fakeCheckpointHash,
      2015,
      chainB_block2015_ts,
      EPOCH_NBITS,
      500n,
    );
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

    const [
      ,
      ,
      epochStartTimestamp,
      epochStartNBits,
      ,
      epochStartHeight,
      prevEpochStartTimestamp,
      prevEpochStartNBits,
    ] = await oracle.read.state();
    // Chain B's retarget block 2016 timestamp = chainB_block2015_ts + 600.
    assert.equal(epochStartTimestamp, chainB_block2015_ts + 600);
    assert.equal(epochStartNBits, HARDER_EPOCH_NBITS);
    assert.equal(epochStartHeight, 2016);
    assert.equal(prevEpochStartTimestamp, baseTs);
    assert.equal(prevEpochStartNBits, EPOCH_NBITS);
  });

  it("should leave epoch state intact when a boundary-crossing reorg is rejected", async function () {
    const { oracle, checkpointHeight, fakeCheckpointHash, baseTs } =
      await loadFixture(deployRetargetBoundaryFixture);

    const stateBefore = await oracle.read.state();
    const tipBefore = await oracle.read.chainTipHash();

    // Same-height fork with equal work (all EPOCH_NBITS) → NotHeaviestChain after restore path runs.
    const chainB_block2015_ts = baseTs + RETARGET_EXPECTED_TIMESPAN;
    const chainB_b2015 = mineSyntheticBlock(
      fakeCheckpointHash,
      2015,
      chainB_block2015_ts,
      EPOCH_NBITS,
      500n,
    );
    const chainB_rest = mineChain(
      chainB_b2015.hash,
      2016,
      3,
      chainB_block2015_ts,
      EPOCH_NBITS,
      5000n,
    );
    const batchB = formatBatch([chainB_b2015, ...chainB_rest]);

    await catchError(oracle.abi, "NotHeaviestChain", async () => {
      await oracle.write.submitBlocks([
        checkpointHeight,
        batchB.headers,
        batchB.coinbaseTxs,
        batchB.merkleProofs,
      ]);
    });

    assert.equal(await oracle.read.chainTipHash(), tipBefore);
    const stateAfter = await oracle.read.state();
    assert.deepEqual(stateAfter, stateBefore);
  });

  it("should not restore epoch start when ancestorHeight equals epochStartHeight", async function () {
    const { oracle, pc, chainA, chainA_block2016_ts } =
      await loadFixture(deployRetargetBoundaryFixture);

    const [, , epochStartTimestampBefore, , , epochStartHeight] = await oracle.read.state();
    assert.equal(epochStartHeight, 2016);
    assert.equal(epochStartTimestampBefore, chainA_block2016_ts);

    // Fork from the retarget block itself (ancestor == epoch start) — restore must not fire.
    // chainA[1] is height 2016; extend 2017–2019 so the fork is longer than tip 2018.
    const block2016 = chainA[1];
    const extension = mineChain(
      block2016.hash,
      2017,
      3,
      chainA_block2016_ts,
      EPOCH_NBITS,
      2000n,
    );
    const batch = formatBatch(extension);
    const tx = await oracle.write.submitBlocks([
      2016,
      batch.headers,
      batch.coinbaseTxs,
      batch.merkleProofs,
    ]);
    await pc.waitForTransactionReceipt({ hash: tx });

    const [, , epochStartTimestampAfter, , , epochStartHeightAfter] = await oracle.read.state();
    assert.equal(epochStartHeightAfter, 2016);
    assert.equal(epochStartTimestampAfter, epochStartTimestampBefore);
  });

  it("should report the ancestor and the displaced tip in ChainReorg", async function () {
    // The indexer needs all four to snapshot orphans: which rows to mark orphaned
    // (everything above ancestorHeight), and which chain they belonged to (oldTip/oldHeight).
    const { oracle, pc, genesisHeight, genesisHash, baseTs, nBits, chainA } =
      await loadFixture(deployReorgFixture);

    const oldTip = chainA[chainA.length - 1];
    const chainB = mineChain(genesisHash, genesisHeight + 1, 4, baseTs, nBits, 5000n);
    const batch = formatBatch(chainB);

    const txHash = await oracle.write.submitBlocks([
      genesisHeight,
      batch.headers,
      batch.coinbaseTxs,
      batch.merkleProofs,
    ]);
    const receipt = await pc.waitForTransactionReceipt({ hash: txHash });

    const [reorg] = parseEventLogs({
      abi: oracle.abi,
      logs: receipt.logs,
      eventName: "ChainReorg",
    });

    assert.ok(reorg, "ChainReorg should be emitted");
    assert.equal(reorg.args.newTip?.toLowerCase(), hex(chainB[3].hash).toLowerCase());
    assert.equal(reorg.args.newHeight, genesisHeight + 4);
    assert.equal(reorg.args.ancestorHeight, genesisHeight);
    assert.equal(reorg.args.oldTip?.toLowerCase(), hex(oldTip.hash).toLowerCase());
    assert.equal(reorg.args.oldHeight, oldTip.height);
  });

  it("should emit ChainReorg before any BlockSubmitted of the incoming fork", async function () {
    // Ordering is what lets a consumer process the log stream in one pass: orphan the old
    // rows on ChainReorg, then apply the replacements as they arrive.
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

    // No HashpriceUpdated here: this fixture mines at a difficulty that truncates to zero.
    const names = parseEventLogs({ abi: oracle.abi, logs: receipt.logs }).map((l) => l.eventName);
    assert.deepEqual(names, [
      "ChainReorg",
      "BlockSubmitted",
      "BlockSubmitted",
      "BlockSubmitted",
      "BlockSubmitted",
    ]);
  });

  it("should emit canonical fee averages for every replacement block", async function () {
    const { oracle, pc, nBits, chainA } =
      await loadFixture(deployReorgEmissionFixture);

    // Fork from height 244, replacing 245–246 and extending to 247. The old implementation's
    // first correction retained fee 246 from chain A. The ancestor snapshot plus each displaced
    // block's evictedFee instead produce the exact canonical 144-block average at every step.
    const ancestorIndex = 143;
    const ancestor = chainA[ancestorIndex];
    const chainB = mineChain(
      ancestor.hash,
      ancestor.height + 1,
      3,
      ancestor.timestamp,
      nBits,
      5000n,
    );
    const batchB = formatBatch(chainB);
    const tx = await oracle.write.submitBlocks([
      ancestor.height,
      batchB.headers,
      batchB.coinbaseTxs,
      batchB.merkleProofs,
    ]);
    const receipt = await pc.waitForTransactionReceipt({ hash: tx });

    const updates = parseEventLogs({
      abi: oracle.abi,
      logs: receipt.logs,
      eventName: "HashpriceUpdated",
    });

    const canonicalPrefix = chainA.slice(0, ancestorIndex + 1);
    const expected = chainB.map((block, index) => {
      const canonical = [...canonicalPrefix, ...chainB.slice(0, index + 1)];
      const window = canonical.slice(-144);
      const sum = window.reduce(
        (total, entry) => total + (entry.coinbaseValue - getBlockSubsidy(entry.height)),
        0n,
      );
      return {
        confirmedHeight: block.height - 1,
        avgFees: sum / BigInt(window.length),
      };
    });

    assert.deepEqual(
      updates.map((event) => ({
        confirmedHeight: event.args.confirmedHeight,
        avgFees: event.args.avgFees,
      })),
      expected,
    );
  });

  it("should reject a losing fork before validating any header", async function () {
    // Both submissions use headers that cannot possibly validate. The three-header batch
    // ties on work and so is turned away by the work check; the five-header batch wins on
    // work and gets far enough to fail linkage. The differing revert reasons are the proof
    // that the work check runs first — a losing fork never pays for PoW or merkle verification.
    const { oracle, genesisHeight, baseTs, nBits } = await loadFixture(deployReorgFixture);

    const tying = junkBatch(3, nBits, baseTs + 600);
    await catchError(oracle.abi, "NotHeaviestChain", async () => {
      await oracle.write.submitBlocks([
        genesisHeight,
        tying.headers,
        tying.coinbaseTxs,
        tying.merkleProofs,
      ]);
    });

    const winning = junkBatch(5, nBits, baseTs + 600);
    await catchError(oracle.abi, "BrokenChain", async () => {
      await oracle.write.submitBlocks([
        genesisHeight,
        winning.headers,
        winning.coinbaseTxs,
        winning.merkleProofs,
      ]);
    });
  });

  it("should reject a longer fork that carries less cumulative work", async function () {
    // Bitcoin's rule is heaviest chain, not longest. Chain A is 4 blocks totalling 11 work;
    // this fork is 5 blocks totalling 10. A length-based check would accept it.
    const { oracle, checkpointHeight, fakeCheckpointHash, forkTs } =
      await loadFixture(deployHarderCanonicalFixture);

    const b2015 = mineSyntheticBlock(fakeCheckpointHash, 2015, forkTs, EPOCH_NBITS, 900n);
    const chainB = [b2015, ...mineChain(b2015.hash, 2016, 4, forkTs, EPOCH_NBITS, 7000n)];
    const batchB = formatBatch(chainB);

    assert.equal(chainB.length, 5, "fork is longer than chain A's 4 blocks");

    await catchError(oracle.abi, "NotHeaviestChain", async () => {
      await oracle.write.submitBlocks([
        checkpointHeight,
        batchB.headers,
        batchB.coinbaseTxs,
        batchB.merkleProofs,
      ]);
    });
  });

  it("should accept that same fork once it also carries more work", async function () {
    // Positive control for the test above: identical shape and length, only the
    // post-retarget difficulty differs, so the rejection there was about work and
    // not some unrelated defect in how the fork was built.
    const { oracle, pc, checkpointHeight, fakeCheckpointHash, forkTs } =
      await loadFixture(deployHarderCanonicalFixture);

    const b2015 = mineSyntheticBlock(fakeCheckpointHash, 2015, forkTs, EPOCH_NBITS, 900n);
    const chainB = [b2015, ...mineChain(b2015.hash, 2016, 4, forkTs, HARDER_EPOCH_NBITS, 7000n)];
    const batchB = formatBatch(chainB);

    const tx = await oracle.write.submitBlocks([
      checkpointHeight,
      batchB.headers,
      batchB.coinbaseTxs,
      batchB.merkleProofs,
    ]);
    const receipt = await pc.waitForTransactionReceipt({ hash: tx });
    assert.equal(receipt.status, "success");

    const [chainHeight] = await oracle.read.state();
    assert.equal(chainHeight, 2019);
    assert.equal(
      (await oracle.read.chainTipHash()).toLowerCase(),
      hex(chainB[chainB.length - 1].hash).toLowerCase(),
    );
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
