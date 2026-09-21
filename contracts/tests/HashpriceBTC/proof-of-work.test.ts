import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { catchError } from "../../lib/lib.ts";
import { deployOracleFixture, prepareBlocks } from "./fixtures.ts";
import { hex, mutateHeader } from "./helpers.ts";

const {
  networkHelpers: { loadFixture },
} = await network.connect();

describe("HashpriceBTC — Layer 1: Proof-of-Work", function () {
  it("should accept a real block with valid PoW", async function () {
    const { contracts, accounts, config } = await loadFixture(deployOracleFixture);
    const { oracle } = contracts;
    const nextBlock = config.blocks[config.batchEnd];
    const fb = prepareBlocks(config.blocks).formatBlock(nextBlock);
    const hash = await oracle.write.submitBlock([fb.header, fb.coinbaseTx, fb.merkleProof]);
    const receipt = await accounts.pc.waitForTransactionReceipt({ hash });
    assert.ok(receipt.status === "success");
  });

  it("should reject a header whose hash does not meet the target (InsufficientPoW)", async function () {
    const { contracts, config } = await loadFixture(deployOracleFixture);
    const nextBlock = config.blocks[config.batchEnd];

    // Corrupt the nonce (bytes 76-80) so the hash changes and likely fails PoW
    const corruptedHeader = mutateHeader(nextBlock.rawHeader, 76, "ffffffff");

    await catchError(contracts.oracle.abi, "InsufficientPoW", async () => {
      await contracts.oracle.write.submitBlock([
        hex(corruptedHeader),
        hex(nextBlock.coinbase.rawHexStripped),
        nextBlock.merkleProof.map((h) => hex(h)) as `0x${string}`[],
      ]);
    });
  });

  it("should reject via submitBlocks when PoW is invalid", async function () {
    const { contracts, config } = await loadFixture(deployOracleFixture);
    const nextBlock = config.blocks[config.batchEnd];

    const corruptedHeader = mutateHeader(nextBlock.rawHeader, 76, "ffffffff");
    const ancestorHeight = config.blocks[config.batchEnd - 1].height;

    await catchError(contracts.oracle.abi, "InsufficientPoW", async () => {
      await contracts.oracle.write.submitBlocks([
        ancestorHeight,
        hex(corruptedHeader),
        [hex(nextBlock.coinbase.rawHexStripped)],
        [nextBlock.merkleProof.map((h) => hex(h)) as `0x${string}`[]],
      ]);
    });
  });
});
