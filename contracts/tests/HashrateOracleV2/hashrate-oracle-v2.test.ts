import { catchError } from "../../lib/lib.ts";
import { deployFullFixture, deployRelayFixture, deployV2Fixture } from "./fixtures.ts";
import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { zeroHash } from "viem";

const {
  viem,
  networkHelpers: { loadFixture },
} = await network.connect();

describe("HashrateOracleV2", function () {
  // ─── BTCRelay ──────────────────────────────────────────────────────

  describe("BTCRelay", function () {
    it("should set chain tip to the last submitted block hash", async function () {
      const { contracts, config } = await loadFixture(deployRelayFixture);
      const lastSubmitted = config.blocks[config.batchEnd - 1];
      const chainTip = await contracts.btcRelay.read.chainTip();
      assert.equal(chainTip.toLowerCase(), hex(lastSubmitted.hash).toLowerCase());
    });

    it("should set chain height to the last submitted block height", async function () {
      const { contracts, config } = await loadFixture(deployRelayFixture);
      const lastSubmitted = config.blocks[config.batchEnd - 1];
      assert.equal(await contracts.btcRelay.read.chainHeight(), lastSubmitted.height);
    });

    it("should return confirmedHeight = chainHeight - 6", async function () {
      const { contracts, config } = await loadFixture(deployRelayFixture);
      const lastSubmitted = config.blocks[config.batchEnd - 1];
      assert.equal(await contracts.btcRelay.read.confirmedHeight(), lastSubmitted.height - 6);
    });

    it("should store correct timestamps for all blocks", async function () {
      const { contracts, config } = await loadFixture(deployRelayFixture);
      for (const block of config.blocks.slice(0, config.batchEnd)) {
        const ts = await contracts.btcRelay.read.getTimestamp([block.height]);
        assert.equal(ts, block.timestamp);
      }
    });

    it("should return positive difficulty for stored blocks", async function () {
      const { contracts, config } = await loadFixture(deployRelayFixture);
      const diff = await contracts.btcRelay.read.getDifficulty([config.blocks[0].height]);
      assert.ok(diff > 0n);
    });

    it("should return consistent difficulty across same-epoch blocks", async function () {
      const { contracts, config } = await loadFixture(deployRelayFixture);
      const diff0 = await contracts.btcRelay.read.getDifficulty([config.blocks[0].height]);
      const diff1 = await contracts.btcRelay.read.getDifficulty([config.blocks[1].height]);
      assert.equal(diff0, diff1);
    });

    it("should return non-zero merkle roots for stored blocks", async function () {
      const { contracts, config } = await loadFixture(deployRelayFixture);
      for (const block of config.blocks.slice(0, config.batchEnd)) {
        const root = await contracts.btcRelay.read.getMerkleRoot([block.height]);
        assert.notEqual(root, zeroHash);
      }
    });

    it("should map each height to the correct block hash", async function () {
      const { contracts, config } = await loadFixture(deployRelayFixture);
      for (const block of config.blocks.slice(0, config.batchEnd)) {
        const hash = await contracts.btcRelay.read.heightToHash([block.height]);
        assert.equal(hash.toLowerCase(), hex(block.hash).toLowerCase());
      }
    });

    it("should revert on duplicate header submission", async function () {
      const { contracts, config } = await loadFixture(deployRelayFixture);
      const ancestorHash = hex(config.blocks[0].hash);
      const header = hex(config.blocks[1].rawHeader);

      await catchError(contracts.btcRelay.abi, "HeaderAlreadyExists", async () => {
        await contracts.btcRelay.write.submitHeaders([header, ancestorHash]);
      });
    });

    it("should revert on invalid header length", async function () {
      const { contracts } = await loadFixture(deployRelayFixture);
      const tip = await contracts.btcRelay.read.chainTip();

      await catchError(contracts.btcRelay.abi, "InvalidHeaderLength", async () => {
        await contracts.btcRelay.write.submitHeaders(["0xdeadbeef", tip]);
      });
    });

    it("should revert when querying unknown height", async function () {
      const { contracts } = await loadFixture(deployRelayFixture);

      await catchError(contracts.btcRelay.abi, "UnknownHeight", async () => {
        await contracts.btcRelay.read.getDifficulty([1]);
      });
    });

    it("should revert when ancestor is unknown", async function () {
      const { contracts, config } = await loadFixture(deployRelayFixture);
      const fakeAncestor =
        "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
      const header = hex(config.blocks[1].rawHeader);

      await catchError(contracts.btcRelay.abi, "UnknownAncestor", async () => {
        await contracts.btcRelay.write.submitHeaders([header, fakeAncestor]);
      });
    });
  });

  // ─── CoinbaseVerifier ──────────────────────────────────────────────

  describe("CoinbaseVerifier", function () {
    it("should verify coinbase proofs and extract correct fees", async function () {
      const { contracts, config } = await loadFixture(deployFullFixture);
      const subsidy = getBlockSubsidy(config.blocks[0].height);
      const submitted = config.blocks.slice(0, config.batchEnd);

      for (const block of submitted) {
        const fees = await contracts.coinbaseVerifier.read.blockFees([block.height]);
        const expectedFees = BigInt(block.coinbase.totalOutputValue) - subsidy;
        assert.equal(fees, expectedFees);
      }
    });

    it("should mark blocks as verified", async function () {
      const { contracts, config } = await loadFixture(deployFullFixture);
      for (const block of config.blocks.slice(0, config.batchEnd)) {
        assert.ok(await contracts.coinbaseVerifier.read.isVerified([block.height]));
      }
    });

    it("should track oldest and newest verified heights", async function () {
      const { contracts, config } = await loadFixture(deployFullFixture);
      const submitted = config.blocks.slice(0, config.batchEnd);
      const oldest = await contracts.coinbaseVerifier.read.oldestVerifiedHeight();
      const newest = await contracts.coinbaseVerifier.read.newestVerifiedHeight();
      assert.equal(oldest, submitted[0].height);
      assert.equal(newest, submitted[submitted.length - 1].height);
    });

    it("should track verified block count", async function () {
      const { contracts, config } = await loadFixture(deployFullFixture);
      assert.equal(
        await contracts.coinbaseVerifier.read.verifiedBlockCount(),
        config.batchEnd,
      );
    });

    it("should compute correct average fees for the window", async function () {
      const { contracts, config } = await loadFixture(deployFullFixture);
      const { feeWindow } = config;
      const subsidy = getBlockSubsidy(config.blocks[0].height);
      const submitted = config.blocks.slice(0, config.batchEnd);

      const windowBlocks = submitted.slice(-feeWindow);
      let totalFees = 0n;
      for (const b of windowBlocks) {
        totalFees += BigInt(b.coinbase.totalOutputValue) - subsidy;
      }
      const expectedAvg = totalFees / BigInt(feeWindow);

      const avgFees = await contracts.coinbaseVerifier.read.getAverageFees([feeWindow]);
      assert.equal(avgFees, expectedAvg);
    });

    it("should compute correct average fees for the full range", async function () {
      const { contracts, config } = await loadFixture(deployFullFixture);
      const subsidy = getBlockSubsidy(config.blocks[0].height);
      const submitted = config.blocks.slice(0, config.batchEnd);

      let totalFees = 0n;
      for (const b of submitted) {
        totalFees += BigInt(b.coinbase.totalOutputValue) - subsidy;
      }
      const expectedAvg = totalFees / BigInt(submitted.length);

      const avgFees = await contracts.coinbaseVerifier.read.getAverageFees([submitted.length]);
      assert.equal(avgFees, expectedAvg);
    });

    it("should revert when submitting a duplicate proof", async function () {
      const { contracts, config } = await loadFixture(deployFullFixture);
      const block = config.blocks[0];

      await catchError(contracts.coinbaseVerifier.abi, "AlreadyVerified", async () => {
        await contracts.coinbaseVerifier.write.submitCoinbaseProof([
          block.height,
          hex(block.coinbase.rawHexStripped),
          block.merkleProof.map((h) => hex(h)) as `0x${string}`[],
        ]);
      });
    });

    it("should revert when block is not in relay", async function () {
      const { contracts } = await loadFixture(deployFullFixture);

      await catchError(contracts.coinbaseVerifier.abi, "BlockNotInRelay", async () => {
        await contracts.coinbaseVerifier.write.submitCoinbaseProof([1, "0x00", []]);
      });
    });
  });

  // ─── HashrateOracleV2 ─────────────────────────────────────────────

  describe("HashrateOracleV2", function () {
    describe("AggregatorV3Interface", function () {
      it("decimals() should return 8", async function () {
        const { contracts } = await loadFixture(deployFullFixture);
        assert.equal(await contracts.oracle.read.decimals(), 8);
      });

      it('description() should return "The price of 100 TH/s per day in BTC"', async function () {
        const { contracts } = await loadFixture(deployFullFixture);
        assert.equal(
          await contracts.oracle.read.description(),
          "The price of 100 TH/s per day in BTC",
        );
      });

      it("version() should return 1", async function () {
        const { contracts } = await loadFixture(deployFullFixture);
        assert.equal(await contracts.oracle.read.version(), 1n);
      });

      it("getRoundData() should revert with NotImplemented", async function () {
        const { contracts } = await loadFixture(deployFullFixture);
        await catchError(contracts.oracle.abi, "NotImplemented", async () => {
          await contracts.oracle.read.getRoundData([0n]);
        });
      });

      it('VERSION() should return "1.0.0"', async function () {
        const { contracts } = await loadFixture(deployFullFixture);
        assert.equal(await contracts.oracle.read.VERSION(), "1.0.0");
      });
    });

    describe("latestRoundData()", function () {
      it("should return a positive hashprice", async function () {
        const { contracts } = await loadFixture(deployFullFixture);
        const [, answer] = await contracts.oracle.read.latestRoundData();
        assert.ok(answer > 0n);
      });

      it("should set roundId to confirmedHeight", async function () {
        const { contracts } = await loadFixture(deployFullFixture);
        const confirmedHeight = await contracts.btcRelay.read.confirmedHeight();
        const [roundId] = await contracts.oracle.read.latestRoundData();
        assert.equal(roundId, BigInt(confirmedHeight));
      });

      it("should set answeredInRound equal to roundId", async function () {
        const { contracts } = await loadFixture(deployFullFixture);
        const [roundId, , , , answeredInRound] = await contracts.oracle.read.latestRoundData();
        assert.equal(answeredInRound, roundId);
      });

      it("should set timestamps to the confirmed block timestamp", async function () {
        const { contracts } = await loadFixture(deployFullFixture);
        const confirmedHeight = await contracts.btcRelay.read.confirmedHeight();
        const expectedTs = await contracts.btcRelay.read.getTimestamp([confirmedHeight]);
        const [, , startedAt, updatedAt] = await contracts.oracle.read.latestRoundData();
        assert.equal(startedAt, BigInt(expectedTs));
        assert.equal(updatedAt, BigInt(expectedTs));
      });

      it("should compute hashprice matching the on-chain formula", async function () {
        const { contracts, config } = await loadFixture(deployFullFixture);
        const confirmedHeight = await contracts.btcRelay.read.confirmedHeight();
        const difficulty = await contracts.btcRelay.read.getDifficulty([confirmedHeight]);
        const subsidy = getBlockSubsidy(Number(confirmedHeight));
        const avgFees = await contracts.coinbaseVerifier.read.getAverageFees([config.feeWindow]);
        const rewardPerBlock = subsidy + BigInt(avgFees);

        const HASHES_PER_100THS_PER_DAY = 8_640_000_000_000_000_000n;
        const expectedHashprice =
          (HASHES_PER_100THS_PER_DAY * rewardPerBlock) / (difficulty * (1n << 32n));

        const [, answer] = await contracts.oracle.read.latestRoundData();
        assert.equal(answer, expectedHashprice);
      });

      it("should return hashprice in a plausible range", async function () {
        const { contracts } = await loadFixture(deployFullFixture);
        const [, answer] = await contracts.oracle.read.latestRoundData();
        assert.ok(answer > 100n);
        assert.ok(answer < 1_000_000n);
      });
    });

    describe("setFeeWindow()", function () {
      it("should allow the owner to change the fee window", async function () {
        const { contracts, accounts } = await loadFixture(deployFullFixture);
        await contracts.oracle.write.setFeeWindow([5], {
          account: accounts.owner.account,
        });
        assert.equal(await contracts.oracle.read.feeWindow(), 5);
      });

      it("should affect the hashprice when fee window changes", async function () {
        const { contracts, accounts, config } = await loadFixture(deployFullFixture);

        const [, answer3] = await contracts.oracle.read.latestRoundData();

        await contracts.oracle.write.setFeeWindow([1], {
          account: accounts.owner.account,
        });

        const [, answerAll] = await contracts.oracle.read.latestRoundData();

        assert.notEqual(answer3, answerAll);
      });

      it("should revert when called by non-owner", async function () {
        const { contracts, accounts } = await loadFixture(deployFullFixture);

        await catchError(contracts.oracle.abi, "OwnableUnauthorizedAccount", async () => {
          await contracts.oracle.write.setFeeWindow([5], {
            account: accounts.user.account,
          });
        });
      });
    });
  });
  // ─── Gas benchmark ─────────────────────────────────────────────

  describe("Gas benchmark", function () {
    it("average gas per block (submit one-by-one)", async function () {
      const { contracts, accounts, config } = await loadFixture(deployV2Fixture);
      const { btcRelay, coinbaseVerifier } = contracts;
      const { pc } = accounts;
      const toSubmit = config.blocks.slice(1);

      let totalGas = 0n;
      for (const b of toSubmit) {
        const ancestorHash = await btcRelay.read.chainTip();
        const hHash = await btcRelay.write.submitHeaders([hex(b.rawHeader), ancestorHash]);
        const hReceipt = await pc.waitForTransactionReceipt({ hash: hHash });

        const pHash = await coinbaseVerifier.write.submitCoinbaseProof([
          b.height,
          hex(b.coinbase.rawHexStripped),
          b.merkleProof.map((h) => hex(h)) as `0x${string}`[],
        ]);
        const pReceipt = await pc.waitForTransactionReceipt({ hash: pHash });

        totalGas += hReceipt.gasUsed + pReceipt.gasUsed;
      }

      console.log(`  V2 avg per block (${toSubmit.length} blocks): ${Math.round(Number(totalGas) / toSubmit.length).toLocaleString()} gas`);
    });
  });
});

const hex = (s: string): `0x${string}` => `0x${s}`;

function getBlockSubsidy(height: number): bigint {
  const halvings = Math.floor(height / 210_000);
  if (halvings >= 64) return 0n;
  return 5_000_000_000n >> BigInt(halvings);
}
