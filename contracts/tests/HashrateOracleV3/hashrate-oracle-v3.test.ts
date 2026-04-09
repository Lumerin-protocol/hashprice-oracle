import { catchError } from "../../lib/lib.ts";
import { deployOracleFixture, deployV3Fixture, prepareBlocks } from "./fixtures.ts";
import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  viem,
  networkHelpers: { loadFixture },
} = await network.connect();

describe("HashrateOracleV3", function () {
  // ─── Chain state ──────────────────────────────────────────────────

  describe("Chain state", function () {
    it("should set chain tip to the last submitted block hash", async function () {
      const { contracts, config } = await loadFixture(deployOracleFixture);
      const lastSubmitted = config.blocks[config.batchEnd - 1];
      const chainTip = await contracts.oracle.read.chainTip();
      assert.equal(chainTip.toLowerCase(), hex(lastSubmitted.hash).toLowerCase());
    });

    it("should set chain height to the last submitted block height", async function () {
      const { contracts, config } = await loadFixture(deployOracleFixture);
      const lastSubmitted = config.blocks[config.batchEnd - 1];
      const [chainHeight] = await contracts.oracle.read.state();
      assert.equal(chainHeight, lastSubmitted.height);
    });

    it("should return confirmedHeight = chainHeight - 6", async function () {
      const { contracts, config } = await loadFixture(deployOracleFixture);
      const lastSubmitted = config.blocks[config.batchEnd - 1];
      assert.equal(await contracts.oracle.read.confirmedHeight(), lastSubmitted.height - 6);
    });

    it("should track block count", async function () {
      const { contracts, config } = await loadFixture(deployOracleFixture);
      const [, blockCount] = await contracts.oracle.read.state();
      assert.equal(blockCount, config.batchEnd - 1);
    });
  });

  // ─── submitBlock (single block) ───────────────────────────────────

  describe("submitBlock()", function () {
    it("should revert on invalid header length", async function () {
      const { contracts } = await loadFixture(deployOracleFixture);

      await catchError(contracts.oracle.abi, "InvalidHeaderLength", async () => {
        await contracts.oracle.write.submitBlock(["0xdeadbeef", "0x00", []]);
      });
    });

    it("should revert when prevHash does not match chain tip", async function () {
      const { contracts, config } = await loadFixture(deployOracleFixture);
      const header = hex(config.blocks[1].rawHeader);

      await catchError(contracts.oracle.abi, "BrokenChain", async () => {
        await contracts.oracle.write.submitBlock([
          header,
          hex(config.blocks[1].coinbase.rawHexStripped),
          config.blocks[1].merkleProof.map((h) => hex(h)) as `0x${string}`[],
        ]);
      });
    });
  });

  // ─── submitBlocks ─────────────────────────────────────────────────

  describe("submitBlocks()", function () {
    it("should revert on invalid header length", async function () {
      const { contracts, config } = await loadFixture(deployOracleFixture);

      await catchError(contracts.oracle.abi, "InvalidHeaderLength", async () => {
        await contracts.oracle.write.submitBlocks([config.blocks[0].height, "0xdeadbeef", [], []]);
      });
    });

    it("should revert when ancestor is not in buffer", async function () {
      const { contracts } = await loadFixture(deployOracleFixture);
      const fakeHeight = 1;
      const fakeHeader = ("0x" + "00".repeat(80)) as `0x${string}`;

      await catchError(contracts.oracle.abi, "AncestorTooOld", async () => {
        await contracts.oracle.write.submitBlocks([fakeHeight, fakeHeader, ["0x00"], [[]]]);
      });
    });
  });

  // ─── AggregatorV3Interface ────────────────────────────────────────

  describe("AggregatorV3Interface", function () {
    it("decimals() should return 8", async function () {
      const { contracts } = await loadFixture(deployOracleFixture);
      assert.equal(await contracts.oracle.read.decimals(), 8);
    });

    it('description() should return "The price of 100 TH/s per day in BTC"', async function () {
      const { contracts } = await loadFixture(deployOracleFixture);
      assert.equal(
        await contracts.oracle.read.description(),
        "The price of 100 TH/s per day in BTC",
      );
    });

    it("version() should return 1", async function () {
      const { contracts } = await loadFixture(deployOracleFixture);
      assert.equal(await contracts.oracle.read.version(), 1n);
    });

    it("getRoundData() should revert with NotImplemented", async function () {
      const { contracts } = await loadFixture(deployOracleFixture);
      await catchError(contracts.oracle.abi, "NotImplemented", async () => {
        await contracts.oracle.read.getRoundData([0n]);
      });
    });

    it('VERSION() should return "1.0.0"', async function () {
      const { contracts } = await loadFixture(deployOracleFixture);
      assert.equal(await contracts.oracle.read.VERSION(), "1.0.0");
    });
  });

  // ─── latestRoundData ──────────────────────────────────────────────

  describe("latestRoundData()", function () {
    it("should return a positive hashprice", async function () {
      const { contracts } = await loadFixture(deployOracleFixture);
      const [, answer] = await contracts.oracle.read.latestRoundData();
      assert.ok(answer > 0n);
    });

    it("should set roundId to confirmedHeight", async function () {
      const { contracts } = await loadFixture(deployOracleFixture);
      const confirmedHeight = await contracts.oracle.read.confirmedHeight();
      const [roundId] = await contracts.oracle.read.latestRoundData();
      assert.equal(roundId, BigInt(confirmedHeight));
    });

    it("should set answeredInRound equal to roundId", async function () {
      const { contracts } = await loadFixture(deployOracleFixture);
      const [roundId, , , , answeredInRound] = await contracts.oracle.read.latestRoundData();
      assert.equal(answeredInRound, roundId);
    });

    it("should set startedAt to the confirmed block BTC timestamp", async function () {
      const { contracts, config } = await loadFixture(deployOracleFixture);
      const confirmedHeight = Number(await contracts.oracle.read.confirmedHeight());
      const confirmedBlock = config.blocks.find((b) => b.height === confirmedHeight)!;
      const [, , startedAt] = await contracts.oracle.read.latestRoundData();
      assert.equal(startedAt, BigInt(confirmedBlock.timestamp));
    });

    it("should set updatedAt to the EVM submission timestamp", async function () {
      const { contracts } = await loadFixture(deployOracleFixture);
      const [, , , updatedAt] = await contracts.oracle.read.latestRoundData();
      const [, , , , lastSubmittedAt] = await contracts.oracle.read.state();
      assert.equal(updatedAt, BigInt(lastSubmittedAt));
      assert.ok(updatedAt > 0n);
    });

    it("should compute hashprice matching the on-chain formula", async function () {
      const { contracts, config } = await loadFixture(deployOracleFixture);
      const confirmedHeight = Number(await contracts.oracle.read.confirmedHeight());
      const confirmedBlock = config.blocks.find((b) => b.height === confirmedHeight)!;

      const subsidy = getBlockSubsidy(confirmedHeight);

      const submittedBlocks = config.blocks.slice(1, config.batchEnd);
      let totalFees = 0n;
      for (const b of submittedBlocks) {
        totalFees += BigInt(b.coinbase.totalOutputValue) - subsidy;
      }
      const avgFees = totalFees / BigInt(submittedBlocks.length);

      const HASHES_PER_100THS_PER_DAY = 8_640_000_000_000_000_000n;
      const difficulty = nBitsToDifficulty(confirmedBlock.nBits);
      const rewardPerBlock = subsidy + avgFees;
      const expectedHashprice =
        (HASHES_PER_100THS_PER_DAY * rewardPerBlock) / (difficulty * (1n << 32n));

      const [, answer] = await contracts.oracle.read.latestRoundData();
      assert.equal(answer, expectedHashprice);
    });

    it("should return hashprice in a plausible range", async function () {
      const { contracts } = await loadFixture(deployOracleFixture);
      const [, answer] = await contracts.oracle.read.latestRoundData();
      assert.ok(answer > 100n);
      assert.ok(answer < 1_000_000n);
    });
  });

  // ─── Gas benchmark ──────────────────────────────────────────────

  describe("Gas benchmark", function () {
    it("average gas per block (submit one-by-one)", async function () {
      const { contracts, accounts, config } = await loadFixture(deployV3Fixture);
      const { oracle } = contracts;
      const { pc } = accounts;
      const { blocks } = config;
      const { formatBlock } = prepareBlocks(blocks);

      const FEE_WINDOW = 144;
      let coldGas = 0n;
      let warmGas = 0n;
      let totalGas = 0n;
      const toSubmit = blocks.slice(1);

      for (let i = 0; i < toSubmit.length; i++) {
        const fb = formatBlock(toSubmit[i]);
        const hash = await oracle.write.submitBlock([fb.header, fb.coinbaseTx, fb.merkleProof]);
        const receipt = await pc.waitForTransactionReceipt({ hash });
        totalGas += receipt.gasUsed;
        if (i < FEE_WINDOW) {
          coldGas += receipt.gasUsed;
        } else {
          warmGas += receipt.gasUsed;
        }
      }

      const warmCount = toSubmit.length - FEE_WINDOW;
      console.log(`  V3 avg (all ${toSubmit.length} blocks):   ${Math.round(Number(totalGas) / toSubmit.length).toLocaleString()} gas`);
      console.log(`  V3 avg (cold, first ${FEE_WINDOW}):  ${Math.round(Number(coldGas) / FEE_WINDOW).toLocaleString()} gas`);
      if (warmCount > 0) {
        console.log(`  V3 avg (warm, last ${warmCount}):   ${Math.round(Number(warmGas) / warmCount).toLocaleString()} gas`);
      }
    });
  });
});

const hex = (s: string): `0x${string}` => `0x${s}`;

function getBlockSubsidy(height: number): bigint {
  const halvings = Math.floor(height / 210_000);
  if (halvings >= 64) return 0n;
  return 5_000_000_000n >> BigInt(halvings);
}

function nBitsToTarget(nBits: number): bigint {
  const exponent = BigInt(nBits >> 24);
  const coefficient = BigInt(nBits & 0x7fffff);
  if (exponent <= 3n) {
    return coefficient >> (8n * (3n - exponent));
  }
  return coefficient << (8n * (exponent - 3n));
}

function nBitsToDifficulty(nBits: number): bigint {
  const target = nBitsToTarget(nBits);
  const diff1Target = 0x00000000ffff0000000000000000000000000000000000000000000000000000n;
  return diff1Target / target;
}
