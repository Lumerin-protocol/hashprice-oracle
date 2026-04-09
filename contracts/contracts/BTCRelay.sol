// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import { BTCUtils } from "./libraries/BTCUtils.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { console } from "hardhat/console.sol";

/// @title BTCRelay
/// @notice Stores and verifies Bitcoin block headers on-chain with PoW validation,
///         cumulative work tracking, fork resolution, and timestamp validation.
contract BTCRelay is Initializable, OwnableUpgradeable {
    struct StoredHeader {
        bytes32 blockHashLE;
        bytes32 prevBlockHashLE;
        bytes32 merkleRootLE;
        uint32 timestamp;
        uint32 nBits;
        uint32 height;
        uint256 cumulativeWork;
    }

    uint32 public constant CONFIRMATION_DEPTH = 6;
    uint256 public constant EXPECTED_TIMESPAN = 2016 * 600;
    uint256 public constant RETARGET_INTERVAL = 2016;

    bytes32 public chainTip;
    uint32 public chainHeight;
    mapping(bytes32 => StoredHeader) public headers;
    mapping(uint32 => bytes32) public heightToHash;

    error HeaderAlreadyExists();
    error BrokenChain();
    error InsufficientPoW();
    error InvalidTimestamp();
    error UnexpectedDifficultyChange();
    error InvalidRetarget();
    error UnknownHeight();
    error UnknownAncestor();
    error AlreadyInitialized();
    error InvalidHeaderLength();

    event HeaderSubmitted(bytes32 indexed blockHash, uint32 indexed height);
    event ChainReorg(bytes32 indexed newTip, uint32 indexed newHeight, uint256 cumulativeWork);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the relay with a trusted checkpoint header
    /// @param checkpointHeader Raw 80-byte Bitcoin block header at the checkpoint
    /// @param height The known height of this checkpoint block
    function initialize(bytes calldata checkpointHeader, uint32 height) external initializer {
        __Ownable_init(_msgSender());

        require(checkpointHeader.length == 80, "Invalid header length");

        BTCUtils.HeaderInfo memory info = BTCUtils.parseHeader(checkpointHeader);
        bytes32 blockHashLE = BTCUtils.reverseBytes32(BTCUtils.dsha256(checkpointHeader));

        uint256 target = BTCUtils.nBitsToTarget(info.nBits);
        uint256 work = type(uint256).max / (target + 1);

        headers[blockHashLE] = StoredHeader({
            blockHashLE: blockHashLE,
            prevBlockHashLE: info.prevBlockHashLE,
            merkleRootLE: info.merkleRootLE,
            timestamp: info.timestamp,
            nBits: info.nBits,
            height: height,
            cumulativeWork: work
        });

        heightToHash[height] = blockHashLE;
        chainTip = blockHashLE;
        chainHeight = height;

        emit HeaderSubmitted(blockHashLE, height);
    }

    /// @notice Submit one or more consecutive Bitcoin block headers
    /// @param rawHeaders Concatenated 80-byte headers
    /// @param ancestorHashBE Hash of the block these headers extend (must already be stored)
    function submitHeaders(bytes calldata rawHeaders, bytes32 ancestorHashBE) external {
        if (rawHeaders.length % 80 != 0 || rawHeaders.length == 0) revert InvalidHeaderLength();
        uint256 count = rawHeaders.length / 80;

        StoredHeader storage ancestor = headers[ancestorHashBE];
        if (ancestor.blockHashLE == bytes32(0)) revert UnknownAncestor();

        bytes32 prevHash = ancestorHashBE;
        uint32 height = ancestor.height;
        uint256 cumWork = ancestor.cumulativeWork;
        uint32 prevNBits = ancestor.nBits;

        for (uint256 i = 0; i < count; i++) {
            bytes calldata header = rawHeaders[i * 80:(i + 1) * 80];

            bytes32 blockHashLE = BTCUtils.reverseBytes32(BTCUtils.dsha256(header));

            if (headers[blockHashLE].blockHashLE != bytes32(0)) revert HeaderAlreadyExists();

            BTCUtils.HeaderInfo memory info = BTCUtils.parseHeader(header);

            if (info.prevBlockHashLE != prevHash) revert BrokenChain();

            uint256 target = BTCUtils.nBitsToTarget(info.nBits);
            if (uint256(blockHashLE) > target) revert InsufficientPoW();

            height++;

            _validateTimestamp(height, info.timestamp);

            if (height % RETARGET_INTERVAL == 0) {
                _verifyRetarget(height, info.nBits, prevHash);
            } else {
                if (info.nBits != prevNBits) revert UnexpectedDifficultyChange();
            }

            uint256 work = type(uint256).max / (target + 1);
            cumWork += work;

            headers[blockHashLE] = StoredHeader({
                blockHashLE: blockHashLE,
                prevBlockHashLE: info.prevBlockHashLE,
                merkleRootLE: info.merkleRootLE,
                timestamp: info.timestamp,
                nBits: info.nBits,
                height: height,
                cumulativeWork: cumWork
            });

            prevHash = blockHashLE;
            prevNBits = info.nBits;

            emit HeaderSubmitted(blockHashLE, height);
        }

        if (cumWork > headers[chainTip].cumulativeWork) {
            bool isReorg = heightToHash[ancestor.height] != ancestorHashBE;
            _reindexCanonicalChain(prevHash, height);
            if (isReorg) {
                emit ChainReorg(prevHash, height, cumWork);
            }
            chainTip = prevHash;
            chainHeight = height;
        }
    }

    /// @notice Returns the height of the latest confirmed block
    function confirmedHeight() public view returns (uint32) {
        if (chainHeight < CONFIRMATION_DEPTH) return 0;
        return chainHeight - CONFIRMATION_DEPTH;
    }

    /// @notice Get the difficulty at a specific block height
    function getDifficulty(uint32 height) external view returns (uint256) {
        bytes32 hash = heightToHash[height];
        if (hash == bytes32(0)) revert UnknownHeight();
        return BTCUtils.nBitsToDifficulty(headers[hash].nBits);
    }

    /// @notice Get the timestamp at a specific block height
    function getTimestamp(uint32 height) external view returns (uint32) {
        bytes32 hash = heightToHash[height];
        if (hash == bytes32(0)) revert UnknownHeight();
        return headers[hash].timestamp;
    }

    /// @notice Get the merkle root at a specific block height
    function getMerkleRoot(uint32 height) external view returns (bytes32) {
        bytes32 hash = heightToHash[height];
        if (hash == bytes32(0)) revert UnknownHeight();
        return headers[hash].merkleRootLE;
    }

    /// @notice Validate timestamp against MTP rule and 2-hour future limit
    function _validateTimestamp(uint32 currentHeight, uint32 timestamp) internal view {
        if (currentHeight > 11) {
            uint32[11] memory times;
            for (uint32 i = 0; i < 11; i++) {
                bytes32 h = heightToHash[currentHeight - 1 - i];
                if (h == bytes32(0)) break;
                times[i] = headers[h].timestamp;
            }
            uint32 median = _median11(times);
            if (timestamp <= median) revert InvalidTimestamp();
        }

        if (timestamp > uint32(block.timestamp) + 7200) revert InvalidTimestamp();
    }

    /// @notice Compute median of 11 uint32 values via insertion sort
    function _median11(uint32[11] memory arr) internal pure returns (uint32) {
        for (uint256 i = 1; i < 11; i++) {
            uint32 key = arr[i];
            uint256 j = i;
            while (j > 0 && arr[j - 1] > key) {
                arr[j] = arr[j - 1];
                j--;
            }
            arr[j] = key;
        }
        return arr[5];
    }

    /// @notice Verify difficulty retarget at a 2016-block boundary
    function _verifyRetarget(uint32 height, uint32 newNBits, bytes32 lastBlockHash) internal view {
        uint32 periodStart = height - uint32(RETARGET_INTERVAL);
        bytes32 periodStartHash = heightToHash[periodStart];

        uint256 startTime = uint256(headers[periodStartHash].timestamp);
        uint256 endTime = uint256(headers[lastBlockHash].timestamp);

        uint256 actualTimespan = endTime - startTime;

        // Clamp to [expectedTimespan/4, expectedTimespan*4]
        if (actualTimespan < EXPECTED_TIMESPAN / 4) actualTimespan = EXPECTED_TIMESPAN / 4;
        if (actualTimespan > EXPECTED_TIMESPAN * 4) actualTimespan = EXPECTED_TIMESPAN * 4;

        uint256 oldTarget = BTCUtils.nBitsToTarget(headers[periodStartHash].nBits);
        uint256 expectedTarget = (oldTarget * actualTimespan) / EXPECTED_TIMESPAN;
        uint256 newTarget = BTCUtils.nBitsToTarget(newNBits);

        // Allow 0.1% tolerance for nBits rounding
        uint256 tolerance = expectedTarget / 1000;
        if (tolerance == 0) tolerance = 1;
        if (newTarget < expectedTarget - tolerance || newTarget > expectedTarget + tolerance) {
            revert InvalidRetarget();
        }
    }

    /// @notice Rebuild heightToHash mapping when a heavier fork wins
    function _reindexCanonicalChain(bytes32 tipHash, uint32 tipHeight) internal {
        bytes32 current = tipHash;
        for (uint32 h = tipHeight; h > 0; h--) {
            if (heightToHash[h] == current) break;
            heightToHash[h] = current;
            current = headers[current].prevBlockHashLE;
        }
    }
}
