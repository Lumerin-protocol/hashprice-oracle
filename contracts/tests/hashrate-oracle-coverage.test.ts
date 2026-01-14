import { viem } from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployTokenOraclesAndMulticall3 } from "./fixtures";
import { getAddress, parseEventLogs, parseUnits, zeroAddress } from "viem";
import { catchError } from "../lib/lib";

describe("HashrateOracle Coverage Tests", function () {
  describe("Authorization and Upgrades", function () {
    it("should test _authorizeUpgrade function", async function () {
      const { contracts, accounts } = await loadFixture(deployTokenOraclesAndMulticall3);
      const { hashrateOracle } = contracts;
      const { owner, user } = accounts;

      // Deploy a new implementation
      await viem.deployContract("contracts/HashrateOracle.sol:HashrateOracle", [
        contracts.btcPriceOracleMock.address,
        6,
      ]);

      // Non-owner should not be able to upgrade
      await catchError(hashrateOracle.abi, "OwnableUnauthorizedAccount", async () => {
        await hashrateOracle.write.upgradeToAndCall([hashrateOracle.address, "0x"], {
          account: user.account,
        });
      });
    });
  });

  describe("Parameter Updates", function () {
    it("should revert when setting zero difficulty", async function () {
      const { contracts, accounts } = await loadFixture(deployTokenOraclesAndMulticall3);
      const { hashrateOracle } = contracts;
      const { owner } = accounts;

      await expect(
        hashrateOracle.write.setHashesForBTC([0n], {
          account: owner.account,
        })
      ).to.be.rejectedWith("ValueCannotBeZero");
    });

    it("should update value", async function () {
      const { contracts, accounts } = await loadFixture(deployTokenOraclesAndMulticall3);
      const { hashrateOracle } = contracts;
      const { owner } = accounts;

      const newValue = parseUnits("150", 12); // 150T difficulty

      const hash = await hashrateOracle.write.setHashesForBTC([newValue], {
        account: owner.account,
      });

      // Check that difficulty was updated
      const updatedDifficulty = await hashrateOracle.read.getHashesForBTC();
      expect(updatedDifficulty.value).to.equal(newValue);
    });
  });

  describe("Authorization Checks", function () {
    it("should revert when non-owner tries to set difficulty", async function () {
      const { contracts, accounts } = await loadFixture(deployTokenOraclesAndMulticall3);
      const { hashrateOracle } = contracts;
      const { user } = accounts;

      const newDifficulty = parseUnits("150", 12);

      await expect(
        hashrateOracle.write.setHashesForBTC([newDifficulty], {
          account: user.account,
        })
      ).to.be.rejectedWith("Unauthorized");
    });

    it("should revert when non-owner tries to set ttl", async function () {
      const { contracts, accounts } = await loadFixture(deployTokenOraclesAndMulticall3);
      const { hashrateOracle } = contracts;
      const { user } = accounts;

      await expect(
        hashrateOracle.write.setTTL([1n, 1n], {
          account: user.account,
        })
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    });
  });

  describe("Hash Calculations", function () {
    it("should calculate hashes for BTC correctly", async function () {
      const { contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
      const { hashrateOracle } = contracts;

      const hashesForBTC = await hashrateOracle.read.getHashesForBTC();

      expect(typeof hashesForBTC.value).to.equal("bigint");
      expect(hashesForBTC.value > 0n).to.be.true;
    });

    it("should calculate hashes for token correctly", async function () {
      const { contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
      const { hashrateOracle } = contracts;

      const hashesForToken = await hashrateOracle.read.getHashesforToken();

      expect(typeof hashesForToken).to.equal("bigint");
      expect(hashesForToken > 0n).to.be.true;
    });
  });

  it("should initialize with correct values", async function () {
    const decimals = 8;
    const usdcTokenMock = await viem.deployContract("contracts/USDCMock.sol:USDCMock", []);
    const hashrateOracle = await viem.deployContract(
      "contracts/HashrateOracle.sol:HashrateOracle",
      [usdcTokenMock.address, decimals]
    );

    // Check initial values
    expect((await hashrateOracle.read.getHashesForBTC()).value).to.equal(0n);
  });

  it("should allow owner to set difficulty", async function () {
    const { accounts, contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
    const hashrateOracle = contracts.hashrateOracle;
    const owner = accounts.owner;

    // Set difficulty
    const difficulty = 1000n;
    await hashrateOracle.write.setHashesForBTC([difficulty], { account: owner.account });
    expect((await hashrateOracle.read.getHashesForBTC()).value).to.equal(difficulty);
  });

  it("should allow owner to set block reward and difficulty", async function () {
    const { accounts, contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
    const hashrateOracle = contracts.hashrateOracle;
    const owner = accounts.owner;

    // Set difficulty
    const difficulty = 1000n;
    await hashrateOracle.write.setHashesForBTC([difficulty], { account: owner.account });
    expect((await hashrateOracle.read.getHashesForBTC()).value).to.equal(difficulty);
  });

  it("should not allow non-owner to set difficulty", async function () {
    const { accounts, contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
    const hashrateOracle = contracts.hashrateOracle;
    const nonOwner = accounts.user;

    // Try to set difficulty as non-owner
    await catchError(contracts.hashrateOracle.abi, "Unauthorized", async () => {
      await hashrateOracle.write.setHashesForBTC([1000n], { account: nonOwner.account });
    });
  });

  it("should not allow setting zero difficulty", async function () {
    const { accounts, contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
    const hashrateOracle = contracts.hashrateOracle;
    const owner = accounts.owner;

    // Try to set zero difficulty
    await catchError(contracts.hashrateOracle.abi, "ValueCannotBeZero", async () => {
      await hashrateOracle.write.setHashesForBTC([0n], { account: owner.account });
    });
  });

  it("should calculate correct reward per TH in BTC", async function () {
    const { contracts, config } = await loadFixture(deployTokenOraclesAndMulticall3);
    const hashrateOracle = contracts.hashrateOracle;

    const { difficulty, blockReward } = config.oracle;

    // Calculate expected hashes needed to earn 1 BTC using floating point arithmetic
    // Formula: (difficulty * DIFFICULTY_TO_HASHRATE_FACTOR) / blockReward
    const DIFFICULTY_TO_HASHRATE_FACTOR = 2 ** 32;

    // Convert BigInt values to numbers for floating point calculation
    const difficultyFloat = Number(difficulty);
    const blockRewardFloat = Number(blockReward);

    // Calculate using floats
    const expectedHashesFloat =
      (difficultyFloat * DIFFICULTY_TO_HASHRATE_FACTOR) / blockRewardFloat;
    const expectedHashesForBTC = BigInt(Math.floor(expectedHashesFloat));

    const actualHashesForBTC = await hashrateOracle.read.getHashesForBTC();
    expect(actualHashesForBTC.value).to.equal(expectedHashesForBTC);
  });

  it("should calculate correct reward per TH in token", async function () {
    const { contracts, config } = await loadFixture(deployTokenOraclesAndMulticall3);
    const hashrateOracle = contracts.hashrateOracle;

    const { btcPrice, decimals } = config.oracle;

    // Get reward in token
    const hashesForToken = await hashrateOracle.read.getHashesforToken();
    const hashesForBTC = await hashrateOracle.read.getHashesForBTC();

    // oracle has its own decimals
    const btcDecimals = 8;
    const usdcDecimals = 6;
    const resultDecimals = btcDecimals - usdcDecimals + decimals;
    const result = (Number(hashesForBTC.value) / Number(btcPrice)) * 10 ** resultDecimals;

    expect(Number(hashesForToken)).to.approximately(result, 1);
  });

  it("should allow owner to transfer ownership", async function () {
    const { accounts, contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
    const hashrateOracle = contracts.hashrateOracle;
    const owner = accounts.owner;
    const newOwner = accounts.user;
    const pc = accounts.pc;

    // Transfer ownership
    const transferTx = await hashrateOracle.write.transferOwnership([newOwner.account.address], {
      account: owner.account,
    });
    const transferReceipt = await pc.waitForTransactionReceipt({ hash: transferTx });
    const [ownershipEvent] = parseEventLogs({
      abi: hashrateOracle.abi,
      logs: transferReceipt.logs,
      eventName: "OwnershipTransferred",
    });

    expect(ownershipEvent.args.previousOwner).to.equal(getAddress(owner.account.address));
    expect(ownershipEvent.args.newOwner).to.equal(getAddress(newOwner.account.address));
    expect(await hashrateOracle.read.owner()).to.equal(getAddress(newOwner.account.address));
  });

  it("should not allow non-owner to transfer ownership", async function () {
    const { accounts, contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
    const hashrateOracle = contracts.hashrateOracle;
    const nonOwner = accounts.user;
    const newOwner = accounts.user;

    await catchError(contracts.hashrateOracle.abi, "OwnableUnauthorizedAccount", async () => {
      await hashrateOracle.write.transferOwnership([newOwner.account.address], {
        account: nonOwner.account,
      });
    });
  });

  it("should allow owner to renounce ownership", async function () {
    const { accounts, contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
    const hashrateOracle = contracts.hashrateOracle;
    const owner = accounts.owner;
    const pc = accounts.pc;

    // Renounce ownership
    const renounceTx = await hashrateOracle.write.renounceOwnership({
      account: owner.account,
    });
    const renounceReceipt = await pc.waitForTransactionReceipt({ hash: renounceTx });
    const [ownershipEvent] = parseEventLogs({
      abi: hashrateOracle.abi,
      logs: renounceReceipt.logs,
      eventName: "OwnershipTransferred",
    });

    expect(ownershipEvent.args.previousOwner).to.equal(getAddress(owner.account.address));
    expect(ownershipEvent.args.newOwner).to.equal(zeroAddress);
    expect(await hashrateOracle.read.owner()).to.equal(zeroAddress);
  });

  it("should not allow non-owner to renounce ownership", async function () {
    const { accounts, contracts } = await loadFixture(deployTokenOraclesAndMulticall3);
    const hashrateOracle = contracts.hashrateOracle;
    const nonOwner = accounts.user;

    await catchError(contracts.hashrateOracle.abi, "OwnableUnauthorizedAccount", async () => {
      await hashrateOracle.write.renounceOwnership({
        account: nonOwner.account,
      });
    });
  });
});
