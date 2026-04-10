import { catchError } from "../../lib/lib.ts";
import { deployOracleFixture, prepareBlocks } from "./fixtures.ts";
import { hex, writeUint32LE, mineHeader } from "./helpers.ts";
import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  networkHelpers: { loadFixture },
} = await network.connect();

describe("HashpriceBTC — Layer 5: Future timestamp cap", function () {
  it("should accept a block with a timestamp within 2 hours of EVM time", async function () {
    const { contracts, accounts, config } = await loadFixture(deployOracleFixture);
    const nextBlock = config.blocks[config.batchEnd];
    const fb = prepareBlocks(config.blocks).formatBlock(nextBlock);
    const hash = await contracts.oracle.write.submitBlock([
      fb.header,
      fb.coinbaseTx,
      fb.merkleProof,
    ]);
    const receipt = await accounts.pc.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
  });

  it("should reject submitBlock with timestamp >2h in the future (InvalidTimestamp)", async function () {
    const { contracts, accounts, config } = await loadFixture(deployOracleFixture);
    const latestBlock = await accounts.pc.getBlock({});
    const evmTime = Number(latestBlock.timestamp);

    const nextBlock = config.blocks[config.batchEnd];
    const futureTs = evmTime + 3 * 3600;
    const withFutureTs = writeUint32LE(nextBlock.rawHeader, 68, futureTs);
    const mined = mineHeader(withFutureTs);

    await catchError(contracts.oracle.abi, "InvalidTimestamp", async () => {
      await contracts.oracle.write.submitBlock([
        hex(mined),
        hex(nextBlock.coinbase.rawHexStripped),
        nextBlock.merkleProof.map((h) => hex(h)) as `0x${string}`[],
      ]);
    });
  });

  it("should reject submitBlocks with timestamp >2h in the future (InvalidTimestamp)", async function () {
    const { contracts, accounts, config } = await loadFixture(deployOracleFixture);
    const nextBlock = config.blocks[config.batchEnd];
    const ancestorHeight = config.blocks[config.batchEnd - 1].height;

    const latestBlock = await accounts.pc.getBlock({});
    const evmTime = Number(latestBlock.timestamp);
    const futureTs = evmTime + 3 * 3600;
    const withFutureTs = writeUint32LE(nextBlock.rawHeader, 68, futureTs);
    const mined = mineHeader(withFutureTs);

    await catchError(contracts.oracle.abi, "InvalidTimestamp", async () => {
      await contracts.oracle.write.submitBlocks([
        ancestorHeight,
        hex(mined),
        [hex(nextBlock.coinbase.rawHexStripped)],
        [nextBlock.merkleProof.map((h) => hex(h)) as `0x${string}`[]],
      ]);
    });
  });
});
