import { catchError } from "../../lib/lib.ts";
import { deployOracleFixture, prepareBlocks } from "./fixtures.ts";
import {
  hex,
  mineHeader,
  blockHash,
  setPrevHash,
  buildHeader,
  dsha256,
  getBlockSubsidy,
  EASY_NBITS,
  EPOCH_NBITS,
  RETARGET_EXPECTED_TIMESPAN,
} from "./helpers.ts";
import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const conn = await network.connect();
const {
  viem,
  networkHelpers: { loadFixture },
} = conn;

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

describe("HashpriceBTC — Layer 3: Difficulty retarget verification", function () {
  it("should accept blocks that maintain same nBits within an epoch", async function () {
    const { contracts, accounts, config } = await loadFixture(deployOracleFixture);
    const { oracle } = contracts;
    const { formatBlock } = prepareBlocks(config.blocks);

    const epochNBits = config.blocks[0].nBits;
    const blocksInSameEpoch = config.blocks
      .slice(config.batchEnd)
      .filter((b) => b.height % 2016 !== 0 && b.nBits === epochNBits);

    for (const block of blocksInSameEpoch.slice(0, 3)) {
      const fb = formatBlock(block);
      const hash = await oracle.write.submitBlock([fb.header, fb.coinbaseTx, fb.merkleProof]);
      const receipt = await accounts.pc.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
    }
  });

  it("should set epochStartTimestamp to the retarget block time (not H-1)", async function () {
    const pc = await viem.getPublicClient();
    const tc = await viem.getTestClient();

    const checkpointHeight = 2015;
    const latestBlock = await pc.getBlock({});
    const epochStartTs = Number(latestBlock.timestamp) + 1000;
    const checkpointTs = epochStartTs + RETARGET_EXPECTED_TIMESPAN;
    const retargetTs = checkpointTs + 600;
    const fakeCheckpointHash = "bb".repeat(32);

    await tc.setNextBlockTimestamp({ timestamp: BigInt(retargetTs + 1) });

    const oracle = await viem.deployContract("HashpriceBTC", [
      hex(fakeCheckpointHash),
      checkpointHeight,
      checkpointTs,
      EPOCH_NBITS,
      epochStartTs,
      EPOCH_NBITS,
    ]);

    const coinbaseTx = buildCoinbaseTx(getBlockSubsidy(2016));
    const retargetHeader = buildHeader({
      prevHash: fakeCheckpointHash,
      timestamp: retargetTs,
      nBits: EPOCH_NBITS,
      merkleRoot: dsha256(coinbaseTx),
    });
    const minedRetarget = mineHeader(retargetHeader, EPOCH_NBITS);

    const tx = await oracle.write.submitBlocks([
      checkpointHeight,
      hex(minedRetarget),
      [hex(coinbaseTx)],
      [[]],
    ]);
    const receipt = await pc.waitForTransactionReceipt({ hash: tx });
    assert.equal(receipt.status, "success");

    const [, , epochStartTimestamp, epochStartNBits] = await oracle.read.state();
    assert.equal(epochStartTimestamp, retargetTs);
    assert.notEqual(epochStartTimestamp, checkpointTs, "must not store H-1 timestamp");
    assert.equal(epochStartNBits, EPOCH_NBITS);
  });

  // Mirrors mainnet failure at height 959616: after the previous retarget, storing time(H-1)
  // instead of time(H) inflated actualTimespan by ~one inter-block gap and pushed the next
  // retarget outside the 0.1% tolerance → InvalidRetarget.
  it("should accept the next retarget when epoch start is H, and reject when it is H-1", async function () {
    const pc = await viem.getPublicClient();
    const tc = await viem.getTestClient();

    // Previous retarget was at 2016; next is at 4032. Deploy at 4031 with epoch state
    // as if 2016 had already been accepted.
    const checkpointHeight = 4031;
    const latestBlock = await pc.getBlock({});
    // Gap between previous epoch's H-1 (2015) and H (2016): >0.1% of EXPECTED_TIMESPAN.
    const hMinus1Gap = Math.floor(RETARGET_EXPECTED_TIMESPAN / 500); // 0.2%
    const correctEpochStartTs = Number(latestBlock.timestamp) + 1000;
    const wrongEpochStartTs = correctEpochStartTs - hMinus1Gap;
    const checkpointTs = correctEpochStartTs + RETARGET_EXPECTED_TIMESPAN;
    const retargetTs = checkpointTs + 600;
    const fakeCheckpointHash = "cc".repeat(32);

    await tc.setNextBlockTimestamp({ timestamp: BigInt(retargetTs + 1) });

    const coinbaseTx = buildCoinbaseTx(getBlockSubsidy(4032));
    const retargetHeader = buildHeader({
      prevHash: fakeCheckpointHash,
      timestamp: retargetTs,
      nBits: EPOCH_NBITS,
      merkleRoot: dsha256(coinbaseTx),
    });
    const minedRetarget = mineHeader(retargetHeader, EPOCH_NBITS);

    // Correct: epoch start = time(2016) → actualTimespan = EXPECTED → same nBits passes.
    const oracleOk = await viem.deployContract("HashpriceBTC", [
      hex(fakeCheckpointHash),
      checkpointHeight,
      checkpointTs,
      EPOCH_NBITS,
      correctEpochStartTs,
      EPOCH_NBITS,
    ]);
    const tx = await oracleOk.write.submitBlocks([
      checkpointHeight,
      hex(minedRetarget),
      [hex(coinbaseTx)],
      [[]],
    ]);
    const receipt = await pc.waitForTransactionReceipt({ hash: tx });
    assert.equal(receipt.status, "success");
    const [, , epochStartTimestamp] = await oracleOk.read.state();
    assert.equal(epochStartTimestamp, retargetTs);

    // Buggy: epoch start = time(2015) → actualTimespan too large → InvalidRetarget.
    const oracleBad = await viem.deployContract("HashpriceBTC", [
      hex(fakeCheckpointHash),
      checkpointHeight,
      checkpointTs,
      EPOCH_NBITS,
      wrongEpochStartTs,
      EPOCH_NBITS,
    ]);
    await catchError(oracleBad.abi, "InvalidRetarget", async () => {
      await oracleBad.write.submitBlocks([
        checkpointHeight,
        hex(minedRetarget),
        [hex(coinbaseTx)],
        [[]],
      ]);
    });
  });

  it("should reject a single mined block with wrong nBits (UnexpectedDifficultyChange)", async function () {
    const { contracts, config } = await loadFixture(deployOracleFixture);
    const nextBlock = config.blocks[config.batchEnd];
    const ancestorHeight = config.blocks[config.batchEnd - 1].height;

    assert.ok(nextBlock.height % 2016 !== 0, "test requires a non-retarget block");

    const mined = mineHeader(nextBlock.rawHeader);

    await catchError(contracts.oracle.abi, "UnexpectedDifficultyChange", async () => {
      await contracts.oracle.write.submitBlocks([
        ancestorHeight,
        hex(mined),
        [hex(nextBlock.coinbase.rawHexStripped)],
        [nextBlock.merkleProof.map((h) => hex(h)) as `0x${string}`[]],
      ]);
    });
  });

  it("should reject a 2-block fake chain mined at trivial difficulty", async function () {
    const { contracts, config } = await loadFixture(deployOracleFixture);
    const b1 = config.blocks[config.batchEnd];
    const b2 = config.blocks[config.batchEnd + 1];
    const ancestorHeight = config.blocks[config.batchEnd - 1].height;

    const mined1 = mineHeader(b1.rawHeader);
    const hash1 = blockHash(mined1);

    const b2WithPrev = setPrevHash(b2.rawHeader, hash1);
    const mined2 = mineHeader(b2WithPrev);

    const headers = hex(mined1 + mined2);

    await catchError(contracts.oracle.abi, "UnexpectedDifficultyChange", async () => {
      await contracts.oracle.write.submitBlocks([
        ancestorHeight,
        headers,
        [hex(b1.coinbase.rawHexStripped), hex(b2.coinbase.rawHexStripped)],
        [b1.merkleProof.map((h) => hex(h)), b2.merkleProof.map((h) => hex(h))],
      ]);
    });
  });

  it("should reject a mined block with wrong nBits at a retarget boundary (InvalidRetarget)", async function () {
    const pc = await viem.getPublicClient();
    const tc = await viem.getTestClient();

    // Deploy oracle at height 2015 — next block (2016) triggers retarget.
    // Constructor nBits = 0x1d00ffff (difficulty-1 target ≈ 2^224), small
    // enough that retarget math (oldTarget * timespan) won't overflow uint256.
    const checkpointHeight = 2015;
    const latestBlock = await pc.getBlock({});
    const checkpointTs = Number(latestBlock.timestamp) + 1000;
    const checkpointNBits = 0x1d00ffff;
    const fakeCheckpointHash = "bb".repeat(32);

    await tc.setNextBlockTimestamp({ timestamp: BigInt(checkpointTs + 1) });

    const oracle = await viem.deployContract("HashpriceBTC", [
      hex(fakeCheckpointHash),
      checkpointHeight,
      checkpointTs,
      checkpointNBits,
      checkpointTs,
      checkpointNBits,
    ]);

    // Mine block 2016 at EASY_NBITS — PoW passes (uses block's own nBits),
    // but retarget check compares against stored epoch nBits → InvalidRetarget
    const retargetHeader = buildHeader({
      prevHash: fakeCheckpointHash,
      timestamp: checkpointTs + 600,
      nBits: EASY_NBITS,
    });
    const minedRetarget = mineHeader(retargetHeader);

    // Coinbase/proof are dummy — the contract reverts on difficulty before reaching them
    await catchError(oracle.abi, "InvalidRetarget", async () => {
      await oracle.write.submitBlocks([checkpointHeight, hex(minedRetarget), ["0x00"], [[]]]);
    });
  });
});
