import { catchError } from "../../lib/lib.ts";
import { deployOracleFixture, prepareBlocks } from "./fixtures.ts";
import { hex } from "./helpers.ts";
import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { zeroHash } from "viem";

const {
  networkHelpers: { loadFixture },
} = await network.connect();

describe("HashpriceBTC — Layer 4: Coinbase Merkle proof", function () {
  it("should accept a valid coinbase + merkle proof", async function () {
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

  it("should reject a corrupted coinbase transaction (InvalidMerkleProof)", async function () {
    const { contracts, config } = await loadFixture(deployOracleFixture);
    const nextBlock = config.blocks[config.batchEnd];

    // Flip a byte in the coinbase tx
    const rawCoinbase = nextBlock.coinbase.rawHexStripped;
    const corruptedCoinbase = `${rawCoinbase.slice(0, 20)}ff${rawCoinbase.slice(22)}`;

    await catchError(contracts.oracle.abi, "InvalidMerkleProof", async () => {
      await contracts.oracle.write.submitBlock([
        hex(nextBlock.rawHeader),
        hex(corruptedCoinbase),
        nextBlock.merkleProof.map((h) => hex(h)),
      ]);
    });
  });

  it("should reject a corrupted merkle proof sibling (InvalidMerkleProof)", async function () {
    const { contracts, config } = await loadFixture(deployOracleFixture);
    const nextBlock = config.blocks[config.batchEnd];

    const corruptedProof = nextBlock.merkleProof.map((h) => hex(h));
    if (corruptedProof.length > 0) {
      // Replace first sibling with zeros
      corruptedProof[0] = zeroHash;
    }

    await catchError(contracts.oracle.abi, "InvalidMerkleProof", async () => {
      await contracts.oracle.write.submitBlock([
        hex(nextBlock.rawHeader),
        hex(nextBlock.coinbase.rawHexStripped),
        corruptedProof,
      ]);
    });
  });

  it("should reject when merkle proof has wrong length (too short)", async function () {
    const { contracts, config } = await loadFixture(deployOracleFixture);
    const nextBlock = config.blocks[config.batchEnd];

    // Remove last sibling from proof
    const shortProof = nextBlock.merkleProof.slice(0, -1).map((h) => hex(h));

    await catchError(contracts.oracle.abi, "InvalidMerkleProof", async () => {
      await contracts.oracle.write.submitBlock([
        hex(nextBlock.rawHeader),
        hex(nextBlock.coinbase.rawHexStripped),
        shortProof,
      ]);
    });
  });

  it("should reject an empty merkle proof (block has >1 tx)", async function () {
    const { contracts, config } = await loadFixture(deployOracleFixture);
    const nextBlock = config.blocks[config.batchEnd];

    // Real blocks have many transactions, so empty proof won't produce the right root
    await catchError(contracts.oracle.abi, "InvalidMerkleProof", async () => {
      await contracts.oracle.write.submitBlock([
        hex(nextBlock.rawHeader),
        hex(nextBlock.coinbase.rawHexStripped),
        [],
      ]);
    });
  });

  it("should reject a coinbase from a different block (InvalidMerkleProof)", async function () {
    const { contracts, config } = await loadFixture(deployOracleFixture);
    const nextBlock = config.blocks[config.batchEnd];
    // Use coinbase from a different block
    const wrongBlock = config.blocks[1];

    await catchError(contracts.oracle.abi, "InvalidMerkleProof", async () => {
      await contracts.oracle.write.submitBlock([
        hex(nextBlock.rawHeader),
        hex(wrongBlock.coinbase.rawHexStripped),
        nextBlock.merkleProof.map((h) => hex(h)),
      ]);
    });
  });
});
