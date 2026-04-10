import { catchError } from "../../lib/lib.ts";
import { deployHashpriceUSDFixture } from "./fixtures.ts";
import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  networkHelpers: { loadFixture },
} = await network.connect();

describe("HashpriceUSD — AggregatorV3Interface", function () {
  it("decimals() should return 8", async function () {
    const { contracts } = await loadFixture(deployHashpriceUSDFixture);
    assert.equal(await contracts.hashpriceUSD.read.decimals(), 8);
  });

  it('description() should return "The price of 100 TH/s per day in USD"', async function () {
    const { contracts } = await loadFixture(deployHashpriceUSDFixture);
    assert.equal(
      await contracts.hashpriceUSD.read.description(),
      "The price of 100 TH/s per day in USD",
    );
  });

  it("version() should return 1", async function () {
    const { contracts } = await loadFixture(deployHashpriceUSDFixture);
    assert.equal(await contracts.hashpriceUSD.read.version(), 1n);
  });

  it("getRoundData() should revert with NotImplemented", async function () {
    const { contracts } = await loadFixture(deployHashpriceUSDFixture);
    await catchError(contracts.hashpriceUSD.abi, "NotImplemented", async () => {
      await contracts.hashpriceUSD.read.getRoundData([0n]);
    });
  });

  it("getRoundData() should revert with NotImplemented for non-zero roundId", async function () {
    const { contracts } = await loadFixture(deployHashpriceUSDFixture);
    await catchError(contracts.hashpriceUSD.abi, "NotImplemented", async () => {
      await contracts.hashpriceUSD.read.getRoundData([42n]);
    });
  });
});

describe("HashpriceUSD — constructor", function () {
  it("should store hashpriceOracle address", async function () {
    const { contracts } = await loadFixture(deployHashpriceUSDFixture);
    const addr = await contracts.hashpriceUSD.read.hashpriceOracle();
    assert.equal(addr.toLowerCase(), contracts.hashpriceMock.address.toLowerCase());
  });

  it("should store btcUsdOracle address", async function () {
    const { contracts } = await loadFixture(deployHashpriceUSDFixture);
    const addr = await contracts.hashpriceUSD.read.btcUsdOracle();
    assert.equal(addr.toLowerCase(), contracts.btcUsdMock.address.toLowerCase());
  });
});

describe("HashpriceUSD — latestRoundData()", function () {
  it("should return a positive answer", async function () {
    const { contracts } = await loadFixture(deployHashpriceUSDFixture);
    const [, answer] = await contracts.hashpriceUSD.read.latestRoundData();
    assert.ok(answer > 0n);
  });

  it("should return answeredInRound equal to roundId", async function () {
    const { contracts } = await loadFixture(deployHashpriceUSDFixture);
    const [roundId, , , , answeredInRound] = await contracts.hashpriceUSD.read.latestRoundData();
    assert.equal(answeredInRound, roundId);
  });

  describe("answer calculation", function () {
    it("should compute answer = hashpriceBtc * btcUsd / 10^(hpDec + btcDec - 8)", async function () {
      const { contracts } = await loadFixture(deployHashpriceUSDFixture);

      const [, hashpriceBtc] = await contracts.hashpriceMock.read.latestRoundData();
      const [, btcUsd] = await contracts.btcUsdMock.read.latestRoundData();
      const hpDecimals = await contracts.hashpriceMock.read.decimals();
      const btcDecimals = await contracts.btcUsdMock.read.decimals();

      const divisor = 10n ** BigInt(hpDecimals + btcDecimals - 8);
      const expected = (BigInt(hashpriceBtc) * BigInt(btcUsd)) / divisor;

      const [, answer] = await contracts.hashpriceUSD.read.latestRoundData();
      assert.equal(answer, expected);
    });

    it("should double when BTC/USD price doubles", async function () {
      const { contracts } = await loadFixture(deployHashpriceUSDFixture);

      const [, answerBefore] = await contracts.hashpriceUSD.read.latestRoundData();

      const [, currentBtcPrice] = await contracts.btcUsdMock.read.latestRoundData();
      await contracts.btcUsdMock.write.setPrice([currentBtcPrice * 2n]);

      const [, answerAfter] = await contracts.hashpriceUSD.read.latestRoundData();
      assert.equal(answerAfter, answerBefore * 2n);
    });

    it("should double when hashprice-in-BTC doubles", async function () {
      const { contracts } = await loadFixture(deployHashpriceUSDFixture);

      const [, answerBefore] = await contracts.hashpriceUSD.read.latestRoundData();

      const [, currentHpPrice] = await contracts.hashpriceMock.read.latestRoundData();
      await contracts.hashpriceMock.write.setPrice([currentHpPrice * 2n]);

      const [, answerAfter] = await contracts.hashpriceUSD.read.latestRoundData();
      assert.equal(answerAfter, answerBefore * 2n);
    });

    it("should quadruple when both feeds double", async function () {
      const { contracts } = await loadFixture(deployHashpriceUSDFixture);

      const [, answerBefore] = await contracts.hashpriceUSD.read.latestRoundData();

      const [, hpPrice] = await contracts.hashpriceMock.read.latestRoundData();
      const [, btcPrice] = await contracts.btcUsdMock.read.latestRoundData();
      await contracts.hashpriceMock.write.setPrice([hpPrice * 2n]);
      await contracts.btcUsdMock.write.setPrice([btcPrice * 2n]);

      const [, answerAfter] = await contracts.hashpriceUSD.read.latestRoundData();
      assert.equal(answerAfter, answerBefore * 4n);
    });

    it("should halve when BTC/USD price halves", async function () {
      const { contracts } = await loadFixture(deployHashpriceUSDFixture);

      const [, answerBefore] = await contracts.hashpriceUSD.read.latestRoundData();

      const [, currentBtcPrice] = await contracts.btcUsdMock.read.latestRoundData();
      await contracts.btcUsdMock.write.setPrice([currentBtcPrice / 2n]);

      const [, answerAfter] = await contracts.hashpriceUSD.read.latestRoundData();
      assert.equal(answerAfter, answerBefore / 2n);
    });

    it("should produce a plausible USD hashprice with realistic inputs", async function () {
      const { contracts } = await loadFixture(deployHashpriceUSDFixture);
      const [, answer] = await contracts.hashpriceUSD.read.latestRoundData();

      // With hashprice = 3200 sats and BTC = $84,524.20:
      // hashpriceUSD = 0.00003200 * 84524.20 ≈ $2.70
      // In 8-decimal format: ~270_000_000
      assert.ok(answer > 100_000_000n, `answer ${answer} should be > $1`);
      assert.ok(answer < 1_000_000_000n, `answer ${answer} should be < $10`);
    });
  });

  describe("composite roundId", function () {
    it("should encode hashprice roundId in upper 40 bits and btcUsd roundId in lower 40 bits", async function () {
      const { contracts } = await loadFixture(deployHashpriceUSDFixture);

      const [hpRoundId] = await contracts.hashpriceMock.read.latestRoundData();
      const [btcRoundId] = await contracts.btcUsdMock.read.latestRoundData();

      const [compositeRoundId] = await contracts.hashpriceUSD.read.latestRoundData();

      const upperBits = compositeRoundId >> 40n;
      assert.equal(upperBits, BigInt(hpRoundId));

      const lowerBits = compositeRoundId & 0xffffffffffn;
      assert.equal(lowerBits, BigInt(btcRoundId) & 0xffffffffffn);
    });

    it("should update upper bits when hashprice feed updates", async function () {
      const { contracts } = await loadFixture(deployHashpriceUSDFixture);

      const [roundIdBefore] = await contracts.hashpriceUSD.read.latestRoundData();
      const upperBefore = roundIdBefore >> 40n;

      await contracts.hashpriceMock.write.setPrice([4000n]);

      const [roundIdAfter] = await contracts.hashpriceUSD.read.latestRoundData();
      const upperAfter = roundIdAfter >> 40n;

      assert.equal(upperAfter, upperBefore + 1n);
    });

    it("should update lower bits when btcUsd feed updates", async function () {
      const { contracts } = await loadFixture(deployHashpriceUSDFixture);

      const [roundIdBefore] = await contracts.hashpriceUSD.read.latestRoundData();
      const lowerBefore = roundIdBefore & 0xffffffffffn;

      await contracts.btcUsdMock.write.setPrice([9_000_000_000_000n]);

      const [roundIdAfter] = await contracts.hashpriceUSD.read.latestRoundData();
      const lowerAfter = roundIdAfter & 0xffffffffffn;

      assert.equal(lowerAfter, lowerBefore + 1n);
    });
  });

  describe("timestamp semantics", function () {
    it("startedAt should be max(hpUpdatedAt, btcUpdatedAt)", async function () {
      const { contracts } = await loadFixture(deployHashpriceUSDFixture);

      const [, , , hpUpdatedAt] = await contracts.hashpriceMock.read.latestRoundData();
      const [, , , btcUpdatedAt] = await contracts.btcUsdMock.read.latestRoundData();

      const expectedStartedAt = hpUpdatedAt > btcUpdatedAt ? hpUpdatedAt : btcUpdatedAt;

      const [, , startedAt] = await contracts.hashpriceUSD.read.latestRoundData();
      assert.equal(startedAt, expectedStartedAt);
    });

    it("updatedAt should be min(hpUpdatedAt, btcUpdatedAt)", async function () {
      const { contracts } = await loadFixture(deployHashpriceUSDFixture);

      const [, , , hpUpdatedAt] = await contracts.hashpriceMock.read.latestRoundData();
      const [, , , btcUpdatedAt] = await contracts.btcUsdMock.read.latestRoundData();

      const expectedUpdatedAt = hpUpdatedAt < btcUpdatedAt ? hpUpdatedAt : btcUpdatedAt;

      const [, , , updatedAt] = await contracts.hashpriceUSD.read.latestRoundData();
      assert.equal(updatedAt, expectedUpdatedAt);
    });

    it("startedAt should reflect the newer feed when hashprice updates later", async function () {
      const { contracts } = await loadFixture(deployHashpriceUSDFixture);

      // BTC/USD was set in fixture. Now update hashprice later.
      await contracts.hashpriceMock.write.setPrice([5000n]);

      const [, , , hpUpdatedAt] = await contracts.hashpriceMock.read.latestRoundData();
      const [, , , btcUpdatedAt] = await contracts.btcUsdMock.read.latestRoundData();

      assert.ok(hpUpdatedAt >= btcUpdatedAt, "hashprice should be newer");

      const [, , startedAt] = await contracts.hashpriceUSD.read.latestRoundData();
      assert.equal(startedAt, hpUpdatedAt);
    });

    it("updatedAt should reflect the older feed (staleness bottleneck)", async function () {
      const { contracts } = await loadFixture(deployHashpriceUSDFixture);

      // Update only hashprice — btcUsd becomes the staleness bottleneck
      await contracts.hashpriceMock.write.setPrice([5000n]);

      const [, , , btcUpdatedAt] = await contracts.btcUsdMock.read.latestRoundData();

      const [, , , updatedAt] = await contracts.hashpriceUSD.read.latestRoundData();
      assert.equal(updatedAt, btcUpdatedAt);
    });

    it("should advance updatedAt when both feeds are refreshed", async function () {
      const { contracts } = await loadFixture(deployHashpriceUSDFixture);

      const [, , , updatedAtBefore] = await contracts.hashpriceUSD.read.latestRoundData();

      await contracts.hashpriceMock.write.setPrice([5000n]);
      await contracts.btcUsdMock.write.setPrice([9_000_000_000_000n]);

      const [, , , updatedAtAfter] = await contracts.hashpriceUSD.read.latestRoundData();
      assert.ok(updatedAtAfter >= updatedAtBefore);
    });

    it("startedAt and updatedAt should be equal when both feeds update in the same block", async function () {
      const { contracts } = await loadFixture(deployHashpriceUSDFixture);

      // Use setRound to give both feeds the same updatedAt
      const ts = BigInt(Math.floor(Date.now() / 1000));
      await contracts.hashpriceMock.write.setRound([10n, 3200n, ts, ts, 10n]);
      await contracts.btcUsdMock.write.setRound([20n, 8_452_420_000_000n, ts, ts, 20n]);

      const [, , startedAt, updatedAt] = await contracts.hashpriceUSD.read.latestRoundData();
      assert.equal(startedAt, updatedAt);
    });
  });

  describe("different decimal configurations", function () {
    it("should handle hashprice with 18 decimals and btcUsd with 8 decimals", async function () {
      const { viem, contracts } = await loadFixture(deployHashpriceUSDFixture);

      await contracts.hashpriceMock.write.setDecimals([18]);
      // 0.00003200 BTC in 18 decimals = 32_000_000_000_000
      await contracts.hashpriceMock.write.setPrice([32_000_000_000_000n]);

      const freshUSD = await viem.deployContract("HashpriceUSD", [
        contracts.hashpriceMock.address,
        contracts.btcUsdMock.address,
      ]);

      const [, answer] = await freshUSD.read.latestRoundData();
      const expected = (32_000_000_000_000n * 8_452_420_000_000n) / 10n ** (18n + 8n - 8n);
      assert.equal(answer, expected);
      assert.ok(answer > 0n);
    });

    it("should handle both feeds with 18 decimals", async function () {
      const { viem, contracts } = await loadFixture(deployHashpriceUSDFixture);

      await contracts.hashpriceMock.write.setDecimals([18]);
      await contracts.btcUsdMock.write.setDecimals([18]);
      // 0.00003200 BTC in 18 decimals
      await contracts.hashpriceMock.write.setPrice([32_000_000_000_000n]);
      // $84,524.20 in 18 decimals
      await contracts.btcUsdMock.write.setPrice([84_524_200_000_000_000_000_000n]);

      const freshUSD = await viem.deployContract("HashpriceUSD", [
        contracts.hashpriceMock.address,
        contracts.btcUsdMock.address,
      ]);

      const [, answer] = await freshUSD.read.latestRoundData();
      const expected =
        (32_000_000_000_000n * 84_524_200_000_000_000_000_000n) / 10n ** (18n + 18n - 8n);
      assert.equal(answer, expected);
      assert.ok(answer > 0n);
    });
  });
});
