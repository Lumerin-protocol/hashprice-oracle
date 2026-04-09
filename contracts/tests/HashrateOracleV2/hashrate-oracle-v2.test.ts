import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { catchError } from "../../lib/lib";
import { deployFullFixture, deployRelayFixture } from "./fixtures";

const hex = (s: string): `0x${string}` => `0x${s}`;

function getBlockSubsidy(height: number): bigint {
  const halvings = Math.floor(height / 210_000);
  if (halvings >= 64) return 0n;
  return 5_000_000_000n >> BigInt(halvings);
}

describe("HashrateOracleV2", function () {
  // ─── BTCRelay ──────────────────────────────────────────────────────

  describe("BTCRelay", function () {
    it("should set chain tip to the last submitted block hash", async function () {
      const { contracts, config } = await loadFixture(deployRelayFixture);
      const lastBlock = config.blocks[config.blocks.length - 1];
      const chainTip = await contracts.btcRelay.read.chainTip();
      expect(chainTip.toLowerCase()).to.equal(hex(lastBlock.hash).toLowerCase());
    });

    it("should set chain height to the last submitted block height", async function () {
      const { contracts, config } = await loadFixture(deployRelayFixture);
      const lastBlock = config.blocks[config.blocks.length - 1];
      expect(await contracts.btcRelay.read.chainHeight()).to.equal(lastBlock.height);
    });

    it("should return confirmedHeight = chainHeight - 6", async function () {
      const { contracts, config } = await loadFixture(deployRelayFixture);
      const lastBlock = config.blocks[config.blocks.length - 1];
      expect(await contracts.btcRelay.read.confirmedHeight()).to.equal(lastBlock.height - 6);
    });

    it("should store correct timestamps for all blocks", async function () {
      const { contracts, config } = await loadFixture(deployRelayFixture);
      for (const block of config.blocks) {
        const ts = await contracts.btcRelay.read.getTimestamp([block.height]);
        expect(ts).to.equal(block.timestamp);
      }
    });

    it("should return positive difficulty for stored blocks", async function () {
      const { contracts, config } = await loadFixture(deployRelayFixture);
      const diff = await contracts.btcRelay.read.getDifficulty([config.blocks[0].height]);
      expect(diff > 0n).to.be.true;
    });

    it("should return consistent difficulty across same-epoch blocks", async function () {
      const { contracts, config } = await loadFixture(deployRelayFixture);
      const diff0 = await contracts.btcRelay.read.getDifficulty([config.blocks[0].height]);
      const diff1 = await contracts.btcRelay.read.getDifficulty([config.blocks[1].height]);
      expect(diff0).to.equal(diff1);
    });

    it("should return non-zero merkle roots for stored blocks", async function () {
      const { contracts, config } = await loadFixture(deployRelayFixture);
      for (const block of config.blocks) {
        const root = await contracts.btcRelay.read.getMerkleRoot([block.height]);
        expect(root).to.not.equal(
          "0x0000000000000000000000000000000000000000000000000000000000000000",
        );
      }
    });

    it("should map each height to the correct block hash", async function () {
      const { contracts, config } = await loadFixture(deployRelayFixture);
      for (const block of config.blocks) {
        const hash = await contracts.btcRelay.read.heightToHash([block.height]);
        expect(hash.toLowerCase()).to.equal(hex(block.hash).toLowerCase());
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

      for (const block of config.blocks) {
        const fees = await contracts.coinbaseVerifier.read.blockFees([block.height]);
        const expectedFees = BigInt(block.coinbase.totalOutputValue) - subsidy;
        expect(fees).to.equal(expectedFees);
      }
    });

    it("should mark blocks as verified", async function () {
      const { contracts, config } = await loadFixture(deployFullFixture);
      for (const block of config.blocks) {
        expect(await contracts.coinbaseVerifier.read.isVerified([block.height])).to.be.true;
      }
    });

    it("should track oldest and newest verified heights", async function () {
      const { contracts, config } = await loadFixture(deployFullFixture);
      const oldest = await contracts.coinbaseVerifier.read.oldestVerifiedHeight();
      const newest = await contracts.coinbaseVerifier.read.newestVerifiedHeight();
      expect(oldest).to.equal(config.blocks[0].height);
      expect(newest).to.equal(config.blocks[config.blocks.length - 1].height);
    });

    it("should track verified block count", async function () {
      const { contracts, config } = await loadFixture(deployFullFixture);
      expect(await contracts.coinbaseVerifier.read.verifiedBlockCount()).to.equal(
        config.blocks.length,
      );
    });

    it("should compute correct average fees for the window", async function () {
      const { contracts, config } = await loadFixture(deployFullFixture);
      const { feeWindow } = config;
      const subsidy = getBlockSubsidy(config.blocks[0].height);

      const windowBlocks = config.blocks.slice(-feeWindow);
      let totalFees = 0n;
      for (const b of windowBlocks) {
        totalFees += BigInt(b.coinbase.totalOutputValue) - subsidy;
      }
      const expectedAvg = totalFees / BigInt(feeWindow);

      const avgFees = await contracts.coinbaseVerifier.read.getAverageFees([feeWindow]);
      expect(avgFees).to.equal(expectedAvg);
    });

    it("should compute correct average fees for the full range", async function () {
      const { contracts, config } = await loadFixture(deployFullFixture);
      const subsidy = getBlockSubsidy(config.blocks[0].height);

      let totalFees = 0n;
      for (const b of config.blocks) {
        totalFees += BigInt(b.coinbase.totalOutputValue) - subsidy;
      }
      const expectedAvg = totalFees / BigInt(config.blocks.length);

      const avgFees = await contracts.coinbaseVerifier.read.getAverageFees([config.blocks.length]);
      expect(avgFees).to.equal(expectedAvg);
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
        expect(await contracts.oracle.read.decimals()).to.equal(8);
      });

      it('description() should return "The price of 100 TH/s per day in BTC"', async function () {
        const { contracts } = await loadFixture(deployFullFixture);
        expect(await contracts.oracle.read.description()).to.equal(
          "The price of 100 TH/s per day in BTC",
        );
      });

      it("version() should return 1", async function () {
        const { contracts } = await loadFixture(deployFullFixture);
        expect(await contracts.oracle.read.version()).to.equal(1n);
      });

      it("getRoundData() should revert with NotImplemented", async function () {
        const { contracts } = await loadFixture(deployFullFixture);
        await catchError(contracts.oracle.abi, "NotImplemented", async () => {
          await contracts.oracle.read.getRoundData([0n]);
        });
      });

      it('VERSION() should return "1.0.0"', async function () {
        const { contracts } = await loadFixture(deployFullFixture);
        expect(await contracts.oracle.read.VERSION()).to.equal("1.0.0");
      });
    });

    describe("latestRoundData()", function () {
      it("should return a positive hashprice", async function () {
        const { contracts } = await loadFixture(deployFullFixture);
        const [, answer] = await contracts.oracle.read.latestRoundData();
        expect(answer > 0n).to.be.true;
      });

      it("should set roundId to confirmedHeight", async function () {
        const { contracts } = await loadFixture(deployFullFixture);
        const confirmedHeight = await contracts.btcRelay.read.confirmedHeight();
        const [roundId] = await contracts.oracle.read.latestRoundData();
        expect(roundId).to.equal(BigInt(confirmedHeight));
      });

      it("should set answeredInRound equal to roundId", async function () {
        const { contracts } = await loadFixture(deployFullFixture);
        const [roundId, , , , answeredInRound] = await contracts.oracle.read.latestRoundData();
        expect(answeredInRound).to.equal(roundId);
      });

      it("should set timestamps to the confirmed block timestamp", async function () {
        const { contracts } = await loadFixture(deployFullFixture);
        const confirmedHeight = await contracts.btcRelay.read.confirmedHeight();
        const expectedTs = await contracts.btcRelay.read.getTimestamp([confirmedHeight]);
        const [, , startedAt, updatedAt] = await contracts.oracle.read.latestRoundData();
        expect(startedAt).to.equal(BigInt(expectedTs));
        expect(updatedAt).to.equal(BigInt(expectedTs));
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
        expect(answer).to.equal(expectedHashprice);
      });

      it("should return hashprice in a plausible range", async function () {
        const { contracts } = await loadFixture(deployFullFixture);
        const [, answer] = await contracts.oracle.read.latestRoundData();
        expect(answer > 100n).to.be.true;
        expect(answer < 1_000_000n).to.be.true;
      });
    });

    describe("setFeeWindow()", function () {
      it("should allow the owner to change the fee window", async function () {
        const { contracts, accounts } = await loadFixture(deployFullFixture);
        await contracts.oracle.write.setFeeWindow([5], {
          account: accounts.owner.account,
        });
        expect(await contracts.oracle.read.feeWindow()).to.equal(5);
      });

      it("should affect the hashprice when fee window changes", async function () {
        const { contracts, accounts, config } = await loadFixture(deployFullFixture);

        const [, answer3] = await contracts.oracle.read.latestRoundData();

        await contracts.oracle.write.setFeeWindow([config.blocks.length], {
          account: accounts.owner.account,
        });

        const [, answerAll] = await contracts.oracle.read.latestRoundData();

        expect(answer3).to.not.equal(answerAll);
      });

      it("should revert when called by non-owner", async function () {
        const { contracts, accounts } = await loadFixture(deployFullFixture);

        try {
          await contracts.oracle.write.setFeeWindow([5], {
            account: accounts.user.account,
          });
          expect.fail("Expected revert");
        } catch {
          // OwnableUnauthorizedAccount revert expected
        }
      });
    });
  });
});
