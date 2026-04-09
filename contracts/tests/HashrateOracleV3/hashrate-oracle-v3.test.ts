import { catchError } from "../../lib/lib.ts";
import { deployOracleFixture } from "./fixtures.ts";
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
      const lastBlock = config.blocks[config.blocks.length - 1];
      const chainTip = await contracts.oracle.read.chainTip();
      assert.equal(chainTip.toLowerCase(), hex(lastBlock.hash).toLowerCase());
    });

    it("should set chain height to the last submitted block height", async function () {
      const { contracts, config } = await loadFixture(deployOracleFixture);
      const lastBlock = config.blocks[config.blocks.length - 1];
      assert.equal(await contracts.oracle.read.chainHeight(), lastBlock.height);
    });

    it("should return confirmedHeight = chainHeight - 6", async function () {
      const { contracts, config } = await loadFixture(deployOracleFixture);
      const lastBlock = config.blocks[config.blocks.length - 1];
      assert.equal(await contracts.oracle.read.confirmedHeight(), lastBlock.height - 6);
    });

    it("should track block count", async function () {
      const { contracts, config } = await loadFixture(deployOracleFixture);
      assert.equal(await contracts.oracle.read.blockCount(), config.blocks.length - 1);
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
        await contracts.oracle.write.submitBlocks([
          config.blocks[0].height,
          "0xdeadbeef",
          [],
          [],
        ]);
      });
    });

    it("should revert when ancestor is not in buffer", async function () {
      const { contracts } = await loadFixture(deployOracleFixture);
      const fakeHeight = 1;
      const fakeHeader = "0x" + "00".repeat(80) as `0x${string}`;

      await catchError(contracts.oracle.abi, "AncestorNotInBuffer", async () => {
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
      assert.equal(updatedAt, BigInt(await contracts.oracle.read.lastSubmittedAt()));
      assert.ok(updatedAt > 0n);
    });

    it("should compute hashprice matching the on-chain formula", async function () {
      const { contracts, config } = await loadFixture(deployOracleFixture);
      const confirmedHeight = Number(await contracts.oracle.read.confirmedHeight());
      const confirmedBlock = config.blocks.find((b) => b.height === confirmedHeight)!;

      const subsidy = getBlockSubsidy(confirmedHeight);

      const submittedBlocks = config.blocks.slice(1);
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

  // ─── Gas: submitBlock ─────────────────────────────────────────────

  describe("Gas: submitBlock", function () {
    it("should log gas for a single submitBlock", async function () {
      const { contracts, accounts, config } = await loadFixture(deployOracleFixture);

      const lastBlock = config.blocks[config.blocks.length - 1];
      const nextHeader = "0x" + "00".repeat(80) as `0x${string}`;

      const gasUsed = await contracts.oracle.read.blockCount();
      console.log(`  blockCount after bootstrap: ${gasUsed}`);
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
  const diff1Target = 0x00000000FFFF0000000000000000000000000000000000000000000000000000n;
  return diff1Target / target;
}
