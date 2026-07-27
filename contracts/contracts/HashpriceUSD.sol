// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import { AggregatorV3Interface } from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @title HashpriceUSD
/// @notice Combines a hashprice-in-BTC feed with a BTC/USD feed to produce hashprice in USD.
///         Both upstream feeds must implement AggregatorV3Interface.
///         Output: price of 1 PH/s per day denominated in USD (8 decimals).
///
/// @dev Timestamp semantics (aggregated feed with two independent sources):
///      - startedAt = max(hashprice.updatedAt, btcUsd.updatedAt)
///        When the latest input arrived from either source (round initiation).
///      - updatedAt = min(hashprice.updatedAt, btcUsd.updatedAt)
///        When the oldest input was last refreshed (staleness bottleneck).
///
///      Recommended staleness check for consumers:
///        require(block.timestamp - updatedAt <= MAX_STALENESS);
///      where MAX_STALENESS depends on the specific upstream oracle configurations.
contract HashpriceUSD is AggregatorV3Interface {
    AggregatorV3Interface public immutable hashpriceOracle;
    AggregatorV3Interface public immutable btcUsdOracle;

    uint8 private immutable _hashpriceDecimals;
    uint8 private immutable _btcUsdDecimals;
    uint8 private constant OUTPUT_DECIMALS = 8;

    error NotImplemented();

    /// @param _hashpriceOracle Hashprice oracle returning price of 1 PH/s per day in BTC
    /// @param _btcUsdOracle BTC/USD price oracle (e.g. Chainlink)
    constructor(address _hashpriceOracle, address _btcUsdOracle) {
        hashpriceOracle = AggregatorV3Interface(_hashpriceOracle);
        btcUsdOracle = AggregatorV3Interface(_btcUsdOracle);
        _hashpriceDecimals = hashpriceOracle.decimals();
        _btcUsdDecimals = btcUsdOracle.decimals();
    }

    function decimals() external pure returns (uint8) {
        return OUTPUT_DECIMALS;
    }

    function description() external pure returns (string memory) {
        return "The price of 1 PH/s per day in USD";
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function getRoundData(uint80) external pure returns (uint80, int256, uint256, uint256, uint80) {
        revert NotImplemented();
    }

    /// @notice Returns the latest hashprice of 1 PH/s per day in USD
    /// @return roundId Composite round id encoding both upstream round ids
    /// @return answer Hashprice in USD (8 decimals)
    /// @return startedAt Most recent update from either source (round initiation)
    /// @return updatedAt Oldest update from either source (staleness bottleneck)
    /// @return answeredInRound Same as roundId
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        (uint80 hpRoundId, int256 hashpriceBtc,, uint256 hpUpdatedAt,) = hashpriceOracle.latestRoundData();

        (uint80 btcRoundId, int256 btcUsd,, uint256 btcUpdatedAt,) = btcUsdOracle.latestRoundData();

        answer = int256(
            (uint256(hashpriceBtc) * uint256(btcUsd)) / (10 ** (_hashpriceDecimals + _btcUsdDecimals - OUTPUT_DECIMALS))
        );

        roundId = uint80((uint256(hpRoundId) << 40) | (uint256(btcRoundId) & 0xFFFFFFFFFF));
        startedAt = hpUpdatedAt > btcUpdatedAt ? hpUpdatedAt : btcUpdatedAt;
        updatedAt = hpUpdatedAt < btcUpdatedAt ? hpUpdatedAt : btcUpdatedAt;
        answeredInRound = roundId;
    }
}
