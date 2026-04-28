import { catchError } from "../../lib/lib.ts";
import { deployOracleFixture, deployV3Fixture, prepareBlocks } from "./fixtures.ts";
import { hex } from "./helpers.ts";
import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  networkHelpers: { loadFixture },
} = await network.connect();

describe("HashpriceBTC — Layer 2: Chain continuity", function () {
  it("should reject submitBlock when prevHash does not match chain tip (BrokenChain)", async function () {
    const { contracts, config } = await loadFixture(deployOracleFixture);
    // Submit block[1] which has prevHash pointing to block[0], not current tip
    const block = config.blocks[1];
    await catchError(contracts.oracle.abi, "BrokenChain", async () => {
      await contracts.oracle.write.submitBlock([
        hex(block.rawHeader),
        hex(block.coinbase.rawHexStripped),
        block.merkleProof.map((h) => hex(h)) as `0x${string}`[],
      ]);
    });
  });

  it("should reject submitBlock with a completely fabricated prevHash", async function () {
    const { contracts, config } = await loadFixture(deployOracleFixture);
    const nextBlock = config.blocks[config.batchEnd];

    // Overwrite prevHash field (bytes 4-36) with zeros
    const zeroPrevHash = "00".repeat(32);
    const corrupted =
      nextBlock.rawHeader.slice(0, 8) + zeroPrevHash + nextBlock.rawHeader.slice(8 + 64);

    await catchError(contracts.oracle.abi, "BrokenChain", async () => {
      await contracts.oracle.write.submitBlock([
        hex(corrupted),
        hex(nextBlock.coinbase.rawHexStripped),
        nextBlock.merkleProof.map((h) => hex(h)),
      ]);
    });
  });

  it("should reject submitBlocks when headers are not chained together", async function () {
    const { contracts, config } = await loadFixture(deployOracleFixture);
    // Submit two non-consecutive blocks as if they were sequential
    const b1 = config.blocks[config.batchEnd];
    const b2 = config.blocks[config.batchEnd]; // duplicate — prevHash won't chain
    const ancestorHeight = config.blocks[config.batchEnd - 1].height;

    const headers = hex(b1.rawHeader + b2.rawHeader);

    await catchError(contracts.oracle.abi, "BrokenChain", async () => {
      await contracts.oracle.write.submitBlocks([
        ancestorHeight,
        headers,
        [hex(b1.coinbase.rawHexStripped), hex(b2.coinbase.rawHexStripped)],
        [b1.merkleProof.map((h) => hex(h)), b2.merkleProof.map((h) => hex(h))],
      ]);
    });
  });

  it("should reject submitBlocks when ancestor is not in the ring buffer (AncestorNotInBuffer)", async function () {
    const { contracts } = await loadFixture(deployOracleFixture);
    const fakeHeight = 1;
    const fakeHeader: `0x${string}` = `0x${"00".repeat(80)}`;

    await catchError(contracts.oracle.abi, "AncestorNotInBuffer", async () => {
      await contracts.oracle.write.submitBlocks([fakeHeight, fakeHeader, ["0x00"], [[]]]);
    });
  });

  it("should accept sequential blocks via submitBlock", async function () {
    const { contracts, accounts, config } = await loadFixture(deployOracleFixture);
    const { oracle } = contracts;
    const { formatBlock } = prepareBlocks(config.blocks);

    // Submit 3 blocks one by one
    for (let i = config.batchEnd; i < config.batchEnd + 3 && i < config.blocks.length; i++) {
      const fb = formatBlock(config.blocks[i]);
      const hash = await oracle.write.submitBlock([fb.header, fb.coinbaseTx, fb.merkleProof]);
      const receipt = await accounts.pc.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
    }

    const [chainHeight] = await oracle.read.state();
    assert.equal(chainHeight, config.blocks[config.batchEnd + 2].height);
  });
});
