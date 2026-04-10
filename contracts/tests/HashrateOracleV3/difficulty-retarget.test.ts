import { catchError } from "../../lib/lib.ts";
import { deployOracleFixture, prepareBlocks } from "./fixtures.ts";
import { hex, mineHeader, blockHashLE, setPrevHash, buildHeader, EASY_NBITS } from "./helpers.ts";
import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const conn = await network.connect();
const {
  viem,
  networkHelpers: { loadFixture },
} = conn;

describe("HashrateOracleV3 — Layer 3: Difficulty retarget verification", function () {
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
    const hash1 = blockHashLE(mined1);

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

    const oracle = await viem.deployContract("contracts/HashrateOracleV3.sol:HashrateOracleV3", [
      hex(fakeCheckpointHash),
      checkpointHeight,
      checkpointTs,
      checkpointNBits,
    ]);

    // Mine block 2016 at EASY_NBITS — PoW passes (uses block's own nBits),
    // but retarget check compares against stored epoch nBits → InvalidRetarget
    const retargetHeader = buildHeader({
      prevHashLE: fakeCheckpointHash,
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
