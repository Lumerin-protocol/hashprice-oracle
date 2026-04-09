// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Versionable} from "./Versionable.sol";
import {BTCUtils} from "./libraries/BTCUtils.sol";
import {BTCRelay} from "./BTCRelay.sol";
import {CoinbaseVerifier} from "./CoinbaseVerifier.sol";

/// @title HashrateOracleV2
/// @notice Trustless hashprice oracle returning the price of 100 TH/s per day in BTC.
///         Derives hashprice entirely from verified Bitcoin block headers (BTCRelay)
///         and SPV-proven coinbase fees (CoinbaseVerifier).
/// @dev Implements AggregatorV3Interface so callers can compose it with other oracles.
contract HashrateOracleV2 is UUPSUpgradeable, OwnableUpgradeable, Versionable, AggregatorV3Interface {
    BTCRelay public immutable relay;
    CoinbaseVerifier public immutable coinbaseVerifier;

    /// @dev Number of blocks to average fees over (default 144 = ~1 day)
    uint32 public feeWindow;

    // 100 TH/s per day = 100 * 10^12 hashes/sec * 86400 sec/day
    uint256 private constant HASHES_PER_100THS_PER_DAY = 8_640_000_000_000_000_000;

    string public constant VERSION = "1.0.0";

    error NotImplemented();
    error InsufficientData();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address _relay, address _coinbaseVerifier) {
        relay = BTCRelay(_relay);
        coinbaseVerifier = CoinbaseVerifier(_coinbaseVerifier);
        _disableInitializers();
    }

    /// @notice Initializes the contract with the fee averaging window
    /// @param _feeWindow Number of blocks to average fees over
    function initialize(uint32 _feeWindow) external initializer {
        __Ownable_init(_msgSender());
        __UUPSUpgradeable_init();
        feeWindow = _feeWindow;
    }

    // ─── AggregatorV3Interface ────────────────────────────────────────

    function decimals() public pure returns (uint8) {
        return 8;
    }

    function description() external pure returns (string memory) {
        return "The price of 100 TH/s per day in BTC";
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function getRoundData(uint80) external pure returns (uint80, int256, uint256, uint256, uint80) {
        revert NotImplemented();
    }

    /// @notice Returns the latest hashprice of 100 TH/s per day in satoshis
    /// @return roundId Confirmed Bitcoin block height
    /// @return answer Hashprice in satoshis (8 decimals = BTC)
    /// @return startedAt Bitcoin block timestamp at confirmed height
    /// @return updatedAt Bitcoin block timestamp at confirmed height
    /// @return answeredInRound Same as roundId
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        uint32 safeHeight = relay.confirmedHeight();
        if (safeHeight == 0) revert InsufficientData();

        uint256 difficulty = relay.getDifficulty(safeHeight);

        uint64 subsidy = BTCUtils.getBlockSubsidy(safeHeight);
        uint64 avgFees = coinbaseVerifier.getAverageFees(feeWindow);
        uint256 rewardPerBlock = uint256(subsidy) + uint256(avgFees);

        // hashprice (sats) = daily hashes at 100 TH/s * reward per block / hashes per block
        // where hashes per block = difficulty * 2^32
        uint256 hashpriceSats = (HASHES_PER_100THS_PER_DAY * rewardPerBlock) / (difficulty * (1 << 32));

        uint80 rid = uint80(safeHeight);
        uint256 ts = uint256(relay.getTimestamp(safeHeight));
        return (rid, int256(hashpriceSats), ts, ts, rid);
    }

    // ─── Owner functions ──────────────────────────────────────────────

    /// @notice Update the fee averaging window
    function setFeeWindow(uint32 _feeWindow) external onlyOwner {
        feeWindow = _feeWindow;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
