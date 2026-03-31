//SPDX-License-Identifier: MIT
pragma solidity >0.8.10;

import { AggregatorV3Interface } from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

contract BTCPriceOracleMock is AggregatorV3Interface, Ownable {
    uint8 _decimals = 8;
    uint256 _version = 1;
    string _description = "BTC Price Oracle Mock";

    uint80 _roundId = 0;
    int256 _answer = 0;
    uint256 _startedAt = 0;
    uint256 _updatedAt = 0;
    uint80 _answeredInRound = 0;

    constructor() Ownable(msg.sender) {}

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
        pure
        returns (uint80, int256, uint256, uint256, uint80)
    {
        revert("getRoundData not supported");
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (_roundId, _answer, _startedAt, _updatedAt, _answeredInRound);
    }

    function setPrice(int256 price) external {
        _roundId++;
        _answer = price;
        _startedAt = block.timestamp;
        _updatedAt = block.timestamp;
        _answeredInRound = _roundId;
    }

    /// @notice Set all round fields to simulate stale feeds, zero prices,
    ///         mismatched answeredInRound, etc.
    function setRound(
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) external {
        _roundId = roundId;
        _answer = answer;
        _startedAt = startedAt;
        _updatedAt = updatedAt;
        _answeredInRound = answeredInRound;
    }

    function setDecimals(uint8 newDecimals) external {
        _decimals = newDecimals;
    }
}
