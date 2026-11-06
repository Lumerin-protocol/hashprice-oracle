// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import { AggregatorV3Interface } from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import { HashpriceBTC } from "./HashpriceBTC.sol";
import { HashpriceUSD } from "./HashpriceUSD.sol";
import { BTCUtils } from "./libraries/BTCUtils.sol";

/// @title HashpriceGlideUSD
/// @notice The expected `HashpriceUSD` index at a given time, applying only the known Bitcoin
///         subsidy schedule. The index itself is unchanged; this contract only removes the
///         halving's scheduled step from the prices venues value positions at. As an
///         `AggregatorV3Interface` feed it answers `glidePrice()`, the perps reference.
///
///         - Halving step s = 1 − (subsidy after + fees) / (subsidy now + fees), live from the
///           oracle's height and 144-block fee average; about 49.5% at 2026 fees.
///         - `postHalvingPrice()` = index × (1 − s): at the halving block the new index equals it
///           up to one block's change in the fee average.
///         - `glidePrice()` (perps): the index until `GLIDE_BLOCKS + GLIDE_END_BLOCKS` blocks
///           remain before the halving, then linear by block down to `postHalvingPrice()`,
///           reached `GLIDE_END_BLOCKS` blocks before it. Progress counts blocks, so the glide
///           finishes before the halving however fast blocks come.
///         - `priceRangeAt(t)` (futures): a date settling before the estimated halving date minus
///           the window is priced at the index, one after it plus the window post-halving, and one
///           inside it at both (`low` post-halving, `high` the index): venues value longs at `low`
///           and shorts at `high`.
///
///         Once the halving block is relayed the next halving is 210,000 blocks on and every
///         price is the index again, so later halvings need no redeploy.
/// @dev Prices are in `HashpriceUSD` units and carry its round id and timestamps, so consumers
///      keep their staleness checks. A non-positive index reads as 0 everywhere. Relies on `HashpriceBTC`
///      pricing the subsidy at `confirmedHeight()`, as it does with `CONFIRMATION_DEPTH` 0.
contract HashpriceGlideUSD is AggregatorV3Interface {
    uint256 public constant HALVING_INTERVAL = BTCUtils.HALVING_INTERVAL;

    /// @notice Length of the perps glide, about 90 days.
    uint256 public constant GLIDE_BLOCKS = 12_960;

    /// @notice Blocks before the halving at which the glide reaches the post-halving price, about
    ///         a day.
    uint256 public constant GLIDE_END_BLOCKS = 144;

    /// @notice Seconds per block assumed for the halving date estimate.
    uint256 public constant TARGET_BLOCK_TIME = 600;

    /// @notice Smallest futures window around the halving date estimate.
    uint256 public constant MIN_HALVING_WINDOW = 4 days;

    /// @notice Futures window as a share of the time left to the estimate. It must exceed any
    ///         sustained block-rate drift, so a date never moves from one price into the window.
    uint256 public constant HALVING_WINDOW_BPS = 1000;

    uint256 public constant BPS = 10_000;
    uint256 public constant WAD = 1e18;

    HashpriceUSD public immutable hashpriceUsd;
    HashpriceBTC public immutable hashpriceBtc;
    uint8 private immutable _decimals;

    error NotImplemented();

    /// @dev One read of the oracles, shared by every price derived from it.
    struct Snapshot {
        uint80 roundId;
        uint80 answeredInRound;
        uint256 startedAt;
        uint256 updatedAt;
        uint256 index;
        uint256 postHalving;
        uint256 blocksToHalving;
    }

    constructor(HashpriceUSD _hashpriceUsd) {
        hashpriceUsd = _hashpriceUsd;
        hashpriceBtc = HashpriceBTC(address(_hashpriceUsd.hashpriceOracle()));
        _decimals = _hashpriceUsd.decimals();
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function description() external pure returns (string memory) {
        return "The price of 1 PH/s per day in USD, gliding to the post-halving level before a halving";
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function getRoundData(uint80) external pure returns (uint80, int256, uint256, uint256, uint80) {
        revert NotImplemented();
    }

    /// @notice `HashpriceUSD.latestRoundData()` with `glidePrice()` as the answer.
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        Snapshot memory s = _snapshot();
        return (s.roundId, int256(_glide(s)), s.startedAt, s.updatedAt, s.answeredInRound);
    }

    /// @notice Height of the next halving: the first multiple of 210,000 above the oracle height.
    function nextHalvingHeight() external view returns (uint256) {
        return _nextHalving(hashpriceBtc.confirmedHeight());
    }

    /// @notice Estimated timestamp of the next halving, at `TARGET_BLOCK_TIME` per block from now.
    function halvingEta() public view returns (uint256) {
        return _eta(_blocksToHalving(hashpriceBtc.confirmedHeight()));
    }

    /// @notice Half-width of the futures window around `halvingEta()`.
    function halvingWindow() public view returns (uint256) {
        return _window(halvingEta());
    }

    /// @notice The next halving's step as a share of the index (WAD).
    function halvingStep() external view returns (uint256) {
        uint256 height = hashpriceBtc.confirmedHeight();
        (uint256 rewardNow, uint256 rewardAfter) = _rewards(height);
        if (rewardNow == 0) return 0;
        return WAD - rewardAfter * WAD / rewardNow;
    }

    /// @notice How far the perps glide has gone (WAD): 0 before it starts, WAD at its end.
    function glideProgress() external view returns (uint256) {
        return _glideElapsed(_blocksToHalving(hashpriceBtc.confirmedHeight())) * WAD / GLIDE_BLOCKS;
    }

    /// @notice `latestRoundData()`'s answer and `updatedAt` with `HashpriceUSD`'s answer beside it,
    ///         from one oracle read, for venues that scale deltas by glide / index.
    function latestGlideAndIndex() external view returns (int256 glide, int256 index, uint256 updatedAt) {
        Snapshot memory s = _snapshot();
        return (int256(_glide(s)), int256(s.index), s.updatedAt);
    }

    /// @notice The index with the next halving's subsidy step applied.
    function postHalvingPrice() external view returns (uint256) {
        return _snapshot().postHalving;
    }

    /// @notice The perps reference: the index, gliding to `postHalvingPrice()` before a halving.
    function glidePrice() external view returns (uint256) {
        return _glide(_snapshot());
    }

    /// @notice Price range of a contract settling at `expiry`: venues value longs at `low` and
    ///         shorts at `high`.
    function priceRangeAt(uint256 expiry) external view returns (uint256 low, uint256 high, uint256 updatedAt) {
        Snapshot memory s = _snapshot();
        uint256 eta = _eta(s.blocksToHalving);
        (low, high) = _range(s, expiry, eta, _window(eta));
        updatedAt = s.updatedAt;
    }

    /// @notice `priceRangeAt` for several expiries from one oracle read.
    function priceRangesAt(uint256[] calldata expiries)
        external
        view
        returns (uint256[] memory low, uint256[] memory high, uint256 updatedAt)
    {
        Snapshot memory s = _snapshot();
        uint256 eta = _eta(s.blocksToHalving);
        uint256 w = _window(eta);
        low = new uint256[](expiries.length);
        high = new uint256[](expiries.length);
        for (uint256 i = 0; i < expiries.length; ++i) {
            (low[i], high[i]) = _range(s, expiries[i], eta, w);
        }
        updatedAt = s.updatedAt;
    }

    function _snapshot() internal view returns (Snapshot memory s) {
        int256 answer;
        (s.roundId, answer, s.startedAt, s.updatedAt, s.answeredInRound) = hashpriceUsd.latestRoundData();
        if (answer > 0) s.index = uint256(answer);

        uint256 height = hashpriceBtc.confirmedHeight();
        s.blocksToHalving = _blocksToHalving(height);
        (uint256 rewardNow, uint256 rewardAfter) = _rewards(height);
        s.postHalving = rewardNow == 0 ? s.index : s.index * rewardAfter / rewardNow;
    }

    /// @dev Block reward (subsidy + fee average) now and after the next halving, in satoshis.
    function _rewards(uint256 height) internal view returns (uint256 rewardNow, uint256 rewardAfter) {
        uint256 fees = hashpriceBtc.avgFees();
        rewardNow = BTCUtils.getBlockSubsidy(height) + fees;
        rewardAfter = BTCUtils.getBlockSubsidy(_nextHalving(height)) + fees;
    }

    function _glide(Snapshot memory s) internal pure returns (uint256) {
        return s.index - (s.index - s.postHalving) * _glideElapsed(s.blocksToHalving) / GLIDE_BLOCKS;
    }

    /// @dev Glide blocks done, from 0 (more than `GLIDE_BLOCKS + GLIDE_END_BLOCKS` to go) to
    ///      `GLIDE_BLOCKS` (`GLIDE_END_BLOCKS` or fewer to go).
    function _glideElapsed(uint256 blocksToHalving) internal pure returns (uint256) {
        if (blocksToHalving >= GLIDE_BLOCKS + GLIDE_END_BLOCKS) return 0;
        if (blocksToHalving <= GLIDE_END_BLOCKS) return GLIDE_BLOCKS;
        return GLIDE_BLOCKS + GLIDE_END_BLOCKS - blocksToHalving;
    }

    function _range(Snapshot memory s, uint256 expiry, uint256 eta, uint256 w)
        internal
        pure
        returns (uint256 low, uint256 high)
    {
        if (expiry < eta - w) return (s.index, s.index);
        if (expiry > eta + w) return (s.postHalving, s.postHalving);
        return (s.postHalving, s.index);
    }

    function _eta(uint256 blocksToHalving) internal view returns (uint256) {
        return block.timestamp + blocksToHalving * TARGET_BLOCK_TIME;
    }

    function _window(uint256 eta) internal view returns (uint256) {
        uint256 w = (eta - block.timestamp) * HALVING_WINDOW_BPS / BPS;
        return w > MIN_HALVING_WINDOW ? w : MIN_HALVING_WINDOW;
    }

    function _nextHalving(uint256 height) internal pure returns (uint256) {
        return (height / HALVING_INTERVAL + 1) * HALVING_INTERVAL;
    }

    function _blocksToHalving(uint256 height) internal pure returns (uint256) {
        return _nextHalving(height) - height;
    }
}
