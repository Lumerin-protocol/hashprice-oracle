// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import { AggregatorV3Interface } from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Versionable } from "./Versionable.sol";

/// @title HashrateOracle
/// @author Oleksandr (Shev) Shevchuk (Lumerin)
/// @notice Contract for managing hashrate and mining difficulty calculations
/// @dev This contract provides functions to calculate hashrate requirements based on BTC price and mining difficulty
contract HashrateOracle is UUPSUpgradeable, OwnableUpgradeable, Versionable, AggregatorV3Interface {
    AggregatorV3Interface public immutable btcTokenOracle;
    uint8 private immutable oracleDecimals;
    uint8 private immutable tokenDecimals;

    Result private hashesForBTC;
    address public updaterAddress;
    /// @dev deprecated
    uint256 public btcPriceTTL;
    /// @dev deprecated
    uint256 public hashesForBTCTTL;
    uint80 private hashesForBTCRoundId;

    uint256 private constant BTC_DECIMALS = 8;
    // 100 TH/s per day = 100 * 10^12 hashes/sec * 24 hours * 3600 sec/hour = 8.64 * 10^18 hashes/day
    uint256 private constant HASHES_PER_100_THS_PER_DAY = 864;
    uint256 private constant HASHES_PER_100_THS_PER_DAY_DECIMALS = 16;
    string public constant VERSION = "3.0.3";

    /// @dev deprecated
    struct Feed {
        uint256 value;
        uint256 updatedAt;
        uint256 ttl;
    }

    struct Result {
        uint256 value;
        uint256 updatedAt;
    }

    error ValueCannotBeZero();
    error StaleData();
    error Unauthorized();
    error NotImplemented();

    /// @notice Constructor for the HashrateOracle contract
    /// @param _btcTokenOracleAddress Address of the BTC price oracle
    /// @param _tokenDecimals Number of decimals for the token that we are pricing in
    constructor(address _btcTokenOracleAddress, uint8 _tokenDecimals) {
        btcTokenOracle = AggregatorV3Interface(_btcTokenOracleAddress);
        oracleDecimals = btcTokenOracle.decimals();
        tokenDecimals = _tokenDecimals;
        _disableInitializers();
    }

    /// @notice Initializes the contract
    function initialize() external initializer {
        __Ownable_init(_msgSender());
        __UUPSUpgradeable_init();
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        // Only the owner can upgrade the contract
    }

    function setHashesForBTC(uint256 newHashesForBTC) external onlyUpdater {
        if (newHashesForBTC == 0) revert ValueCannotBeZero();
        hashesForBTC.value = newHashesForBTC;
        hashesForBTC.updatedAt = block.timestamp;
        hashesForBTCRoundId++;
    }

    /// @notice Returns the number of hashes to mine per 1 satoshi
    /// @dev deprecated
    function getHashesForBTC() external view returns (Feed memory) {
        return Feed({ value: hashesForBTC.value, updatedAt: hashesForBTC.updatedAt, ttl: hashesForBTCTTL });
    }

    /// @notice Returns the number of hashes required to mine BTC equivalent of 1 token minimum denomination
    /// @dev deprecated
    function getHashesforToken() external view returns (uint256) {
        (, int256 btcPrice,, uint256 updatedAt,) = btcTokenOracle.latestRoundData();

        if (block.timestamp - updatedAt > btcPriceTTL) revert StaleData();
        if (block.timestamp - hashesForBTC.updatedAt > hashesForBTCTTL) {
            revert StaleData();
        }

        return (hashesForBTC.value * (10 ** (BTC_DECIMALS + oracleDecimals - tokenDecimals))) / uint256(btcPrice);
    }

    /// @dev deprecated
    function setTTL(uint256 newBtcPriceTTL, uint256 newHashesForBTCTTL) external onlyOwner {
        btcPriceTTL = newBtcPriceTTL;
        hashesForBTCTTL = newHashesForBTCTTL;
    }

    /// @notice Returns the number of hashes required to mine BTC equivalent of 1 token minimum denomination
    /// @dev Deprecated. This function does not check for stale data
    function getHashesForTokenUnchecked() external view returns (uint256) {
        (, int256 btcPrice,,,) = btcTokenOracle.latestRoundData();
        return (hashesForBTC.value * (10 ** (BTC_DECIMALS + oracleDecimals - tokenDecimals))) / uint256(btcPrice);
    }

    function getHashesForTokenV2() external view returns (uint256 value, uint256 updatedAt) {
        (, int256 btcPrice,, uint256 _updatedAt,) = btcTokenOracle.latestRoundData();
        uint256 price =
            (hashesForBTC.value * (10 ** (BTC_DECIMALS + oracleDecimals - tokenDecimals))) / uint256(btcPrice);
        uint256 timestamp = min(_updatedAt, hashesForBTC.updatedAt);
        return (price, timestamp);
    }

    function getHashesForBTCV2() external view returns (uint256 value, uint256 updatedAt) {
        return (hashesForBTC.value, hashesForBTC.updatedAt);
    }

    function setUpdaterAddress(address addr) external onlyOwner {
        updaterAddress = addr;
    }

    function min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    modifier onlyUpdater() {
        if (_msgSender() != updaterAddress) {
            revert Unauthorized();
        }
        _;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function description() external pure returns (string memory) {
        return "Hashprice Oracle";
    }

    function version() external pure returns (uint256) {
        return 0;
    }

    function getRoundData(uint80) external pure returns (uint80, int256, uint256, uint256, uint80) {
        revert NotImplemented();
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        // Get full round data from BTC price oracle
        (uint80 btcRoundId, int256 btcPrice, uint256 btcStartedAt, uint256 btcUpdatedAt,) =
            btcTokenOracle.latestRoundData();

        // Calculate price: tokens per 100 TH/s per day contract
        // Formula: (100 TH/s per day in hashes) * btcPrice / (hashesForBTC.value * scaling_factor)
        // This gives the token price for a 100 TH/s per day contract
        uint256 price = (
            HASHES_PER_100_THS_PER_DAY * uint256(btcPrice)
                * (10 ** (tokenDecimals + HASHES_PER_100_THS_PER_DAY_DECIMALS - BTC_DECIMALS - oracleDecimals))
        ) / hashesForBTC.value;

        // Create a composite roundId that encodes information from both oracles
        // Upper 40 bits: BTC oracle roundId, Lower 40 bits: lower 40 bits of hashesForBTC.updatedAt
        // Using timestamp directly ensures roundId increases monotonically when either oracle updates
        uint80 compositeRoundId = uint80((uint256(btcRoundId) << 40) | (hashesForBTCRoundId & 0xFFFFFFFFFF));

        // Use the earlier startedAt timestamp (when the round data first became available)
        uint256 roundStartedAt = min(btcStartedAt, hashesForBTC.updatedAt);
        // Use the minimum timestamp from both oracles (freshest data constraint)
        uint256 updateaAt = min(btcUpdatedAt, hashesForBTC.updatedAt);

        return (compositeRoundId, int256(price), roundStartedAt, updateaAt, compositeRoundId);
    }
}
