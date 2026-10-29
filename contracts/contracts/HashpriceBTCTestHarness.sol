// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import { HashpriceBTC } from "./HashpriceBTC.sol";

/// @dev Test-only harness that makes every hashprice computation observable without requiring
///      synthetic headers to satisfy mainnet proof-of-work difficulty.
contract HashpriceBTCTestHarness is HashpriceBTC {
    constructor(
        bytes32 blockHash,
        uint32 height,
        uint32 timestamp,
        uint32 nBits,
        uint32 epochStartTimestamp,
        uint32 epochStartNBits
    ) HashpriceBTC(blockHash, height, timestamp, nBits, epochStartTimestamp, epochStartNBits) { }

    function _computeAndEmitHashprice(PackedState memory s) internal override returns (CachedRoundData memory c) {
        if (s.chainHeight < CONFIRMATION_DEPTH) return c;

        uint32 confirmed = s.chainHeight - CONFIRMATION_DEPTH;
        c = CachedRoundData({ roundId: uint80(confirmed), startedAt: 0, updatedAt: s.lastSubmittedAt, answer: 1 });
        emit HashpriceUpdated(confirmed, 1, _averageFees(s));
    }
}
