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
///         - `markRangeAt(t)` (futures): a date settling before the estimated halving date minus
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

    /// @notice Length of the perps glide, about 7 days.
    uint256 public constant GLIDE_BLOCKS = 1008;

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
    /// @dev `HashpriceUSD`'s inputs, read directly so a snapshot costs no extra hop.
    AggregatorV3Interface private immutable btcUsdOracle;
    uint256 private immutable _indexScale;

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
        /// @dev The next halving's step as a share of the index (WAD).
        uint256 step;
    }

    constructor(HashpriceUSD _hashpriceUsd) {
        hashpriceUsd = _hashpriceUsd;
        hashpriceBtc = HashpriceBTC(address(_hashpriceUsd.hashpriceOracle()));
        _decimals = _hashpriceUsd.decimals();
        btcUsdOracle = _hashpriceUsd.btcUsdOracle();
        _indexScale = 10 ** (uint256(hashpriceBtc.decimals()) + btcUsdOracle.decimals() - _decimals);
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
        return _step(hashpriceBtc.confirmedHeight());
    }

    /// @notice How far the perps glide has gone (WAD): 0 before it starts, WAD at its end.
    function glideProgress() external view returns (uint256) {
        return _glideElapsed(_blocksToHalving(hashpriceBtc.confirmedHeight())) * WAD / GLIDE_BLOCKS;
    }

    /// @notice `latestRoundData()`'s answer and `updatedAt` with `latestSchedule()`, from one oracle
    ///         read, for venues that pay holders the factor's changes.
    function latestMarkAndSchedule()
        external
        view
        returns (int256 mark, uint256 updatedAt, uint256 factor, uint256 endFactor, uint256 epoch)
    {
        Snapshot memory s = _snapshot();
        mark = int256(_glide(s));
        updatedAt = s.updatedAt;
        endFactor = WAD - s.step;
        factor = WAD - s.step * _glideElapsed(s.blocksToHalving) / GLIDE_BLOCKS;
        epoch = _nextHalving(_heightOf(s));
    }

    /// @notice The share of the index the mark keeps under the schedule (`factor`, WAD), the factor
    ///         the current segment ends at, and an `epoch` that changes when the factor resets
    ///         (the next halving height).
    /// @dev For venues that pay holders the factor's changes (drift funding). Within an epoch the
    ///      factor moves only along the glide (and with the live fee average); at an epoch change
    ///      it resets to 1 in the block the index steps down by the old `endFactor`, so
    ///      index × factor is continuous across it.
    function latestSchedule() external view returns (uint256 factor, uint256 endFactor, uint256 epoch) {
        uint256 height = hashpriceBtc.confirmedHeight();
        uint256 step = _step(height);
        endFactor = WAD - step;
        factor = WAD - step * _glideElapsed(_blocksToHalving(height)) / GLIDE_BLOCKS;
        epoch = _nextHalving(height);
    }

    /// @notice The index with the next halving's subsidy step applied.
    function postHalvingPrice() external view returns (uint256) {
        return _snapshot().postHalving;
    }

    /// @notice The perps reference: the index, gliding to `postHalvingPrice()` before a halving.
    function glidePrice() external view returns (uint256) {
        return _glide(_snapshot());
    }

    /// @notice Mark range of a contract settling at `expiry`: venues value longs at `low` and
    ///         shorts at `high`.
    function markRangeAt(uint256 expiry) external view returns (uint256 low, uint256 high, uint256 updatedAt) {
        Snapshot memory s = _snapshot();
        uint256 eta = _eta(s.blocksToHalving);
        (low, high) = _range(s, expiry, eta, _window(eta));
        updatedAt = s.updatedAt;
    }

    /// @notice `markRangeAt` for several expiries from one oracle read.
    function markRangesAt(uint256[] calldata expiries)
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

    /// @dev `HashpriceUSD.latestRoundData()` computed here from the same two feeds, with the same
    ///      formula, round id and timestamps, plus the schedule. `HashpriceBTC`'s round id is its
    ///      confirmed height, so no separate height read is needed.
    function _snapshot() internal view returns (Snapshot memory s) {
        (uint80 hpRoundId, int256 hashpriceBtcAnswer,, uint256 hpUpdatedAt,) = hashpriceBtc.latestRoundData();
        (uint80 btcRoundId, int256 btcUsd,, uint256 btcUpdatedAt,) = btcUsdOracle.latestRoundData();
        int256 answer = int256((uint256(hashpriceBtcAnswer) * uint256(btcUsd)) / _indexScale);
        if (answer > 0) s.index = uint256(answer);
        s.roundId = uint80((uint256(hpRoundId) << 40) | (uint256(btcRoundId) & 0xFFFFFFFFFF));
        s.answeredInRound = s.roundId;
        s.startedAt = hpUpdatedAt > btcUpdatedAt ? hpUpdatedAt : btcUpdatedAt;
        s.updatedAt = hpUpdatedAt < btcUpdatedAt ? hpUpdatedAt : btcUpdatedAt;

        uint256 height = hpRoundId;
        s.blocksToHalving = _blocksToHalving(height);
        (uint256 rewardNow, uint256 rewardAfter) = _rewards(height);
        s.postHalving = rewardNow == 0 ? s.index : s.index * rewardAfter / rewardNow;
        s.step = rewardNow == 0 ? 0 : WAD - rewardAfter * WAD / rewardNow;
    }

    function _heightOf(Snapshot memory s) internal pure returns (uint256) {
        return uint256(s.roundId >> 40);
    }

    /// @dev The next halving's step as a share of the index (WAD).
    function _step(uint256 height) internal view returns (uint256) {
        (uint256 rewardNow, uint256 rewardAfter) = _rewards(height);
        if (rewardNow == 0) return 0;
        return WAD - rewardAfter * WAD / rewardNow;
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
