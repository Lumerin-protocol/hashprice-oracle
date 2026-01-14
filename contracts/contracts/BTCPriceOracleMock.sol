//SPDX-License-Identifier: MIT
pragma solidity >0.8.10;

import { AggregatorV3Interface } from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

contract BTCPriceOracleMock is AggregatorV3Interface {
    uint8 _decimals = 8;
    int256 _price = 100 * int256(10 ** _decimals);
    uint256 _version = 0;
    string _description = "BTC Price Oracle Mock";

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function description() external view returns (string memory) {
        return _description;
    }

    function version() external view returns (uint256) {
        return _version;
    }

    function getRoundData(uint80)
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (0, _price, 0, 0, 0);
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (0, _price, 0, 0, 0);
    }

    function setPrice(int256 price, uint8 ndecimals) external {
        _price = price;
        _decimals = ndecimals;
    }
}
