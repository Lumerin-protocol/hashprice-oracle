// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Versionable} from "./Versionable.sol";

/// @title HashrateOracle
/// @author Oleksandr (Shev) Shevchuk (Lumerin)
/// @notice Contract for managing hashrate and mining difficulty calculations
/// @dev This contract provides functions to calculate hashrate requirements based on BTC price and mining difficulty
contract HashrateOracle is UUPSUpgradeable, OwnableUpgradeable, Versionable {
    AggregatorV3Interface public immutable btcTokenOracle;
    uint8 private immutable oracleDecimals;
    uint8 private immutable tokenDecimals;

    Result private hashesForBTC;
    address public updaterAddress;
    /// @dev deprecated
    uint256 public btcPriceTTL;
    /// @dev deprecated
    uint256 public hashesForBTCTTL;

    uint256 private constant BTC_DECIMALS = 8;
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

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyOwner {
        // Only the owner can upgrade the contract
    }

    function setHashesForBTC(uint256 newHashesForBTC) external onlyUpdater {
        if (newHashesForBTC == 0) revert ValueCannotBeZero();
        if (newHashesForBTC != hashesForBTC.value) {
            hashesForBTC.value = newHashesForBTC;
            hashesForBTC.updatedAt = block.timestamp;
        }
    }

    /// @notice Returns the number of hashes to mine per 1 satoshi
    /// @dev deprecated
    function getHashesForBTC() external view returns (Feed memory) {
        return
            Feed({
                value: hashesForBTC.value,
                updatedAt: hashesForBTC.updatedAt,
                ttl: hashesForBTCTTL
            });
    }

    /// @notice Returns the number of hashes required to mine BTC equivalent of 1 token minimum denomination
    /// @dev deprecated
    function getHashesforToken() external view returns (uint256) {
        (, int256 btcPrice, , uint256 updatedAt, ) = btcTokenOracle
            .latestRoundData();

        if (block.timestamp - updatedAt > btcPriceTTL) revert StaleData();
        if (block.timestamp - hashesForBTC.updatedAt > hashesForBTCTTL)
            revert StaleData();

        return
            (hashesForBTC.value *
                (10 ** (BTC_DECIMALS + oracleDecimals - tokenDecimals))) /
            uint256(btcPrice);
    }

    /// @dev deprecated
    function setTTL(
        uint256 newBtcPriceTTL,
        uint256 newHashesForBTCTTL
    ) external onlyOwner {
        btcPriceTTL = newBtcPriceTTL;
        hashesForBTCTTL = newHashesForBTCTTL;
    }

    /// @notice Returns the number of hashes required to mine BTC equivalent of 1 token minimum denomination
    /// @dev Deprecated. This function does not check for stale data
    function getHashesForTokenUnchecked() external view returns (uint256) {
        (, int256 btcPrice, , , ) = btcTokenOracle.latestRoundData();
        return
            (hashesForBTC.value *
                (10 ** (BTC_DECIMALS + oracleDecimals - tokenDecimals))) /
            uint256(btcPrice);
    }

    function getHashesForTokenV2()
        external
        view
        returns (uint256 value, uint256 updatedAt)
    {
        (, int256 btcPrice, , uint256 _updatedAt, ) = btcTokenOracle
            .latestRoundData();
        uint256 price = (hashesForBTC.value *
            (10 ** (BTC_DECIMALS + oracleDecimals - tokenDecimals))) /
            uint256(btcPrice);
        uint256 timestamp = min(_updatedAt, hashesForBTC.updatedAt);
        return (price, timestamp);
    }

    function getHashesForBTCV2()
        external
        view
        returns (uint256 value, uint256 updatedAt)
    {
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
}
