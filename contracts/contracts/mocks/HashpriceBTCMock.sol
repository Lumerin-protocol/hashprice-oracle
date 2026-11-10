// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import { AggregatorV3Interface } from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import { BTCUtils } from "../libraries/BTCUtils.sol";

/// @dev Test-only stand-in for `HashpriceBTC` at any height, halvings included, which real headers
///      cannot reach. Exposes the views `HashpriceSchedule` reads and prices with the same formula.
contract HashpriceBTCMock is AggregatorV3Interface {
    uint256 private constant HASHES_PER_1PHS_PER_DAY = 1e15 * 24 * 3600;
    uint8 private constant DECIMALS = 16;

    uint32 public confirmedHeight;
    uint256 public avgFees;
    uint256 public difficulty;
    uint256 private _startedAt;
    uint256 private _updatedAt;

    error NotImplemented();

    function setBlock(uint32 height, uint256 fees, uint256 diff) external {
        confirmedHeight = height;
        avgFees = fees;
        difficulty = diff;
        _startedAt = block.timestamp;
        _updatedAt = block.timestamp;
    }

    function subsidy() public view returns (uint64) {
        return BTCUtils.getBlockSubsidy(confirmedHeight);
    }

    function decimals() external pure returns (uint8) {
        return DECIMALS;
    }

    function description() external pure returns (string memory) {
        return "HashpriceBTC mock";
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
        uint256 rewardPerBlock = uint256(subsidy()) + avgFees;
        answer = int256((HASHES_PER_1PHS_PER_DAY * rewardPerBlock * (10 ** (DECIMALS - 8))) / (difficulty * (1 << 32)));
        roundId = uint80(confirmedHeight);
        return (roundId, answer, _startedAt, _updatedAt, roundId);
    }
}
