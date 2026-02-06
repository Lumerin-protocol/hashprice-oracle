import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployTokenOraclesAndMulticall3 } from "./fixtures";
import { parseUnits } from "viem";
import { catchError } from "../lib/lib";

describe("HashrateOracle - Chainlink AggregatorV3Interface", function () {
  describe("decimals()", function () {
    it("should return 8", async function () {
      const { contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
      const result = await contracts.hashrateOracle.read.decimals();
      expect(result).to.equal(8);
    });
  });

  describe("description()", function () {
    it("should return 'Hashprice Oracle'", async function () {
      const { contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
      const result = await contracts.hashrateOracle.read.description();
      expect(result).to.equal("Hashprice Oracle");
    });
  });

  describe("version()", function () {
    it("should return 0", async function () {
      const { contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
      const result = await contracts.hashrateOracle.read.version();
      expect(result).to.equal(0n);
    });
  });

  describe("getRoundData()", function () {
    it("should revert with NotImplemented for any roundId", async function () {
      const { contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
      const { hashrateOracle } = contracts;

      await catchError(hashrateOracle.abi, "NotImplemented", async () => {
        await hashrateOracle.read.getRoundData([0n]);
      });
    });

    it("should revert with NotImplemented for non-zero roundId", async function () {
      const { contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
      const { hashrateOracle } = contracts;

      await catchError(hashrateOracle.abi, "NotImplemented", async () => {
        await hashrateOracle.read.getRoundData([1n]);
      });
    });
  });

  describe("latestRoundData()", function () {
    it("should return all five fields", async function () {
      const { contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
      const { hashrateOracle } = contracts;

      const [roundId, answer, startedAt, updatedAt, answeredInRound] =
        await hashrateOracle.read.latestRoundData();

      expect(typeof roundId).to.equal("bigint");
      expect(typeof answer).to.equal("bigint");
      expect(typeof startedAt).to.equal("bigint");
      expect(typeof updatedAt).to.equal("bigint");
      expect(typeof answeredInRound).to.equal("bigint");
    });

    it("should return a positive answer (hashprice)", async function () {
      const { contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
      const { hashrateOracle } = contracts;

      const [, answer] = await hashrateOracle.read.latestRoundData();
      expect(answer > 0n).to.be.true;
    });

    it("should return answeredInRound equal to roundId", async function () {
      const { contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
      const { hashrateOracle } = contracts;

      const [roundId, , , , answeredInRound] = await hashrateOracle.read.latestRoundData();
      expect(answeredInRound).to.equal(roundId);
    });

    it("should calculate the correct hashprice using the formula", async function () {
      const { contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
      const { hashrateOracle, btcPriceOracleMock } = contracts;

      // Get BTC price from the mock oracle
      const [, btcPrice] = await btcPriceOracleMock.read.latestRoundData();
      const oracleDecimals = await btcPriceOracleMock.read.decimals();
      const tokenDecimals = 6; // USDC decimals

      const BTC_DECIMALS = 8n;
      const HASHES_PER_100_THS_PER_DAY = 100n * 10n ** 12n * 24n * 3600n;

      const hashesForBTC = (await hashrateOracle.read.getHashesForBTC()).value;

      // Expected: (HASHES_PER_100_THS_PER_DAY * btcPrice * 10^tokenDecimals)
      //           / (hashesForBTC * 10^(BTC_DECIMALS + oracleDecimals))
      const expectedPrice =
        (HASHES_PER_100_THS_PER_DAY * BigInt(btcPrice) * 10n ** BigInt(tokenDecimals)) /
        (hashesForBTC * 10n ** (BTC_DECIMALS + BigInt(oracleDecimals)));

      const [, answer] = await hashrateOracle.read.latestRoundData();
      expect(answer).to.equal(expectedPrice);
    });

    it("should update the answer when hashesForBTC changes", async function () {
      const { contracts, accounts } = await loadFixture(deployTokenOraclesAndMulticall3);
      const { hashrateOracle } = contracts;
      const { owner } = accounts;

      const [, answerBefore] = await hashrateOracle.read.latestRoundData();

      // Double the hashesForBTC (more hashes needed = lower hashprice)
      const currentHashes = (await hashrateOracle.read.getHashesForBTC()).value;
      await hashrateOracle.write.setHashesForBTC([currentHashes * 2n], {
        account: owner.account,
      });

      const [, answerAfter] = await hashrateOracle.read.latestRoundData();

      // Doubling hashesForBTC should halve the price
      expect(answerAfter).to.equal(answerBefore / 2n);
    });

    it("should update the answer when BTC price changes", async function () {
      const { contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
      const { hashrateOracle, btcPriceOracleMock } = contracts;

      const [, answerBefore] = await hashrateOracle.read.latestRoundData();

      // Double the BTC price
      const btcDecimals = await btcPriceOracleMock.read.decimals();
      const [, currentPrice] = await btcPriceOracleMock.read.latestRoundData();
      await btcPriceOracleMock.write.setPrice([currentPrice * 2n, btcDecimals]);

      const [, answerAfter] = await hashrateOracle.read.latestRoundData();

      // Doubling BTC price should double the hashprice
      expect(Number(answerAfter)).to.approximately(Number(answerBefore) * 2, 1);
    });

    describe("composite roundId", function () {
      it("should encode BTC roundId in upper bits and hashesForBTC roundId in lower bits", async function () {
        const { contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
        const { hashrateOracle, btcPriceOracleMock } = contracts;

        // BTC mock roundId increments on each setPrice call (1 after fixture setup)
        const [btcRoundId] = await btcPriceOracleMock.read.latestRoundData();

        const [compositeRoundId] = await hashrateOracle.read.latestRoundData();

        // Upper 40 bits should be btcRoundId
        const upperBits = compositeRoundId >> 40n;
        expect(upperBits).to.equal(BigInt(btcRoundId));

        // Lower 40 bits should be hashesForBTCRoundId (masked to 40 bits)
        const lowerBits = compositeRoundId & 0xffffffffffn;
        // After fixture setup, setHashesForBTC was called once, so roundId should be 1
        expect(lowerBits).to.equal(1n);
      });

      it("should increment the lower roundId bits when hashesForBTC is updated", async function () {
        const { contracts, accounts } = await loadFixture(deployTokenOraclesAndMulticall3);
        const { hashrateOracle } = contracts;
        const { owner } = accounts;

        const [roundIdBefore] = await hashrateOracle.read.latestRoundData();
        const lowerBefore = roundIdBefore & 0xffffffffffn;

        // Update hashesForBTC
        await hashrateOracle.write.setHashesForBTC([parseUnits("200", 12)], {
          account: owner.account,
        });

        const [roundIdAfter] = await hashrateOracle.read.latestRoundData();
        const lowerAfter = roundIdAfter & 0xffffffffffn;

        expect(lowerAfter).to.equal(lowerBefore + 1n);
      });

      it("should monotonically increase roundId on successive updates", async function () {
        const { contracts, accounts } = await loadFixture(deployTokenOraclesAndMulticall3);
        const { hashrateOracle } = contracts;
        const { owner } = accounts;

        const roundIds: bigint[] = [];
        const [initialRoundId] = await hashrateOracle.read.latestRoundData();
        roundIds.push(initialRoundId);

        for (let i = 1; i <= 5; i++) {
          await hashrateOracle.write.setHashesForBTC([parseUnits(String(100 + i * 10), 12)], {
            account: owner.account,
          });
          const [roundId] = await hashrateOracle.read.latestRoundData();
          roundIds.push(roundId);
        }

        // Verify monotonic increase
        for (let i = 1; i < roundIds.length; i++) {
          expect(roundIds[i] > roundIds[i - 1]).to.be.true;
        }
      });
    });

    describe("timestamps", function () {
      it("should return updatedAt as the minimum of BTC oracle and hashesForBTC timestamps", async function () {
        const { contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
        const { hashrateOracle, btcPriceOracleMock } = contracts;

        const [, , , btcUpdatedAt] = await btcPriceOracleMock.read.latestRoundData();
        const [, hashesUpdatedAt] = await hashrateOracle.read.getHashesForBTCV2();

        const expectedUpdatedAt = btcUpdatedAt < hashesUpdatedAt ? btcUpdatedAt : hashesUpdatedAt;

        const [, , , updatedAt] = await hashrateOracle.read.latestRoundData();
        expect(updatedAt).to.equal(expectedUpdatedAt);
      });

      it("should return startedAt as the minimum of BTC oracle startedAt and hashesForBTC updatedAt", async function () {
        const { contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
        const { hashrateOracle, btcPriceOracleMock } = contracts;

        const [, , btcStartedAt] = await btcPriceOracleMock.read.latestRoundData();
        const [, hashesUpdatedAt] = await hashrateOracle.read.getHashesForBTCV2();

        const expectedStartedAt = btcStartedAt < hashesUpdatedAt ? btcStartedAt : hashesUpdatedAt;

        const [, , startedAt] = await hashrateOracle.read.latestRoundData();
        expect(startedAt).to.equal(expectedStartedAt);
      });

      it("should return the earlier timestamp when hashesForBTC is newer than BTC price", async function () {
        const { contracts, accounts } = await loadFixture(deployTokenOraclesAndMulticall3);
        const { hashrateOracle, btcPriceOracleMock } = contracts;
        const { owner } = accounts;

        // BTC price was set during fixture setup (earlier timestamp)
        const [, , , btcUpdatedAt] = await btcPriceOracleMock.read.latestRoundData();

        // Update hashesForBTC (creates a newer timestamp)
        await hashrateOracle.write.setHashesForBTC([parseUnits("200", 12)], {
          account: owner.account,
        });

        const [, hashesUpdatedAt] = await hashrateOracle.read.getHashesForBTCV2();
        const [, , , updatedAt] = await hashrateOracle.read.latestRoundData();

        // updatedAt should be the min of both — the older BTC timestamp
        expect(hashesUpdatedAt >= btcUpdatedAt).to.be.true;
        expect(updatedAt).to.equal(btcUpdatedAt);
      });

      it("should return the earlier timestamp when BTC price is newer than hashesForBTC", async function () {
        const { contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
        const { hashrateOracle, btcPriceOracleMock } = contracts;

        // Get the hashesForBTC timestamp (set during fixture)
        const [, hashesUpdatedAt] = await hashrateOracle.read.getHashesForBTCV2();

        // Update BTC price (creates a newer timestamp)
        const btcDecimals = await btcPriceOracleMock.read.decimals();
        await btcPriceOracleMock.write.setPrice([parseUnits("90000", btcDecimals), btcDecimals]);

        const [, , , updatedAt] = await hashrateOracle.read.latestRoundData();

        // updatedAt should be the min — the older hashesForBTC timestamp
        expect(updatedAt).to.equal(hashesUpdatedAt);
      });

      it("should advance updatedAt when both oracles are refreshed", async function () {
        const { contracts, accounts } = await loadFixture(deployTokenOraclesAndMulticall3);
        const { hashrateOracle, btcPriceOracleMock } = contracts;
        const { owner } = accounts;

        const [, , , updatedAtBefore] = await hashrateOracle.read.latestRoundData();

        // Refresh both oracles so both timestamps advance
        const btcDecimals = await btcPriceOracleMock.read.decimals();
        await btcPriceOracleMock.write.setPrice([parseUnits("90000", btcDecimals), btcDecimals]);
        await hashrateOracle.write.setHashesForBTC([parseUnits("200", 12)], {
          account: owner.account,
        });

        const [, , , updatedAtAfter] = await hashrateOracle.read.latestRoundData();

        // Both timestamps advanced, so the min should also advance
        expect(updatedAtAfter >= updatedAtBefore).to.be.true;
      });
    });

    describe("price calculation edge cases", function () {
      it("should handle large hashesForBTC values", async function () {
        const { contracts, accounts } = await loadFixture(deployTokenOraclesAndMulticall3);
        const { hashrateOracle } = contracts;
        const { owner } = accounts;

        // Set a very large hashesForBTC (simulating very high difficulty)
        const largeHashes = parseUnits("1", 24); // 10^24
        await hashrateOracle.write.setHashesForBTC([largeHashes], {
          account: owner.account,
        });

        const [, answer] = await hashrateOracle.read.latestRoundData();
        // Should still return a valid (small but positive) answer
        expect(answer >= 0n).to.be.true;
      });

      it("should handle small hashesForBTC values", async function () {
        const { contracts, accounts } = await loadFixture(deployTokenOraclesAndMulticall3);
        const { hashrateOracle } = contracts;
        const { owner } = accounts;

        // Set a small hashesForBTC (simulating very low difficulty)
        await hashrateOracle.write.setHashesForBTC([1n], {
          account: owner.account,
        });

        const [, answer] = await hashrateOracle.read.latestRoundData();
        // Should return a very large hashprice
        expect(answer > 0n).to.be.true;
      });

      it("should reflect proportional price changes", async function () {
        const { contracts, accounts } = await loadFixture(deployTokenOraclesAndMulticall3);
        const { hashrateOracle } = contracts;
        const { owner } = accounts;

        // Set a known hashesForBTC
        const baseHashes = parseUnits("100", 12);
        await hashrateOracle.write.setHashesForBTC([baseHashes], {
          account: owner.account,
        });
        const [, priceAtBase] = await hashrateOracle.read.latestRoundData();

        // Triple hashesForBTC
        await hashrateOracle.write.setHashesForBTC([baseHashes * 3n], {
          account: owner.account,
        });
        const [, priceAtTriple] = await hashrateOracle.read.latestRoundData();

        // Price should be ~1/3 (integer division may cause small rounding)
        expect(priceAtBase / 3n).to.equal(priceAtTriple);
      });
    });

    describe("integration with BTC oracle", function () {
      it("should use the BTC price from the underlying oracle", async function () {
        const { contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
        const { hashrateOracle, btcPriceOracleMock } = contracts;

        // Verify the BTC oracle is correctly referenced
        const btcOracleAddr = await hashrateOracle.read.btcTokenOracle();
        expect(btcOracleAddr.toLowerCase()).to.equal(btcPriceOracleMock.address.toLowerCase());
      });

      it("should reflect BTC price changes in latestRoundData", async function () {
        const { contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
        const { hashrateOracle, btcPriceOracleMock } = contracts;

        const btcDecimals = await btcPriceOracleMock.read.decimals();

        // Set BTC price to $50,000
        const price50k = parseUnits("50000", btcDecimals);
        await btcPriceOracleMock.write.setPrice([price50k, btcDecimals]);
        const [, answer50k] = await hashrateOracle.read.latestRoundData();

        // Set BTC price to $100,000
        const price100k = parseUnits("100000", btcDecimals);
        await btcPriceOracleMock.write.setPrice([price100k, btcDecimals]);
        const [, answer100k] = await hashrateOracle.read.latestRoundData();

        // Hashprice should double when BTC price doubles
        expect(answer100k).to.equal(answer50k * 2n);
      });
    });
  });
});
