// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import { BTCUtils } from "./libraries/BTCUtils.sol";
import { BTCRelay } from "./BTCRelay.sol";
import { console } from "hardhat/console.sol";

/// @title CoinbaseVerifier
/// @notice Verifies coinbase transactions via SPV proofs against stored merkle roots
///         and extracts per-block fees.
contract CoinbaseVerifier {
    BTCRelay public immutable relay;

    /// @dev Verified fees per block height (in satoshis). Zero means unverified.
    mapping(uint32 => uint64) public blockFees;

    /// @dev Set to true once a block's fees have been verified (distinguishes 0-fee blocks from unverified)
    mapping(uint32 => bool) public isVerified;

    uint32 public oldestVerifiedHeight;
    uint32 public newestVerifiedHeight;
    uint32 public verifiedBlockCount;

    error AlreadyVerified();
    error BlockNotInRelay();
    error InvalidMerkleProof();

    event CoinbaseProofSubmitted(uint32 indexed height, uint64 fees);

    constructor(address _relay) {
        relay = BTCRelay(_relay);
    }

    /// @notice Submit a coinbase tx + merkle proof for a specific block
    /// @param height Bitcoin block height
    /// @param rawCoinbaseTx Non-witness serialized coinbase transaction
    /// @param merkleProof Array of sibling hashes from leaf to root
    function submitCoinbaseProof(uint32 height, bytes calldata rawCoinbaseTx, bytes32[] calldata merkleProof)
        external
    {
        if (isVerified[height]) revert AlreadyVerified();

        console.log("height");
        console.log(height);

        bytes32 expectedRoot = relay.getMerkleRoot(height);

        if (expectedRoot == bytes32(0)) revert BlockNotInRelay();

        // Compute coinbase txid (double-SHA256 of non-witness serialized tx)
        // Reverse to internal byte order for merkle tree computation (Bitcoin
        // merkle trees concatenate hashes in internal/LE order at the leaf level)
        bytes32 current = BTCUtils.dsha256(rawCoinbaseTx);
        for (uint256 i = 0; i < merkleProof.length; i++) {
            current = _dsha256Pair(current, merkleProof[i]);
        }

        if (current != expectedRoot) revert InvalidMerkleProof();

        // Parse coinbase tx to get total output value
        uint64 totalOutput = BTCUtils.parseCoinbaseOutputValue(rawCoinbaseTx);

        // Subtract block subsidy to get fees
        uint64 subsidy = BTCUtils.getBlockSubsidy(height);
        uint64 fees = totalOutput - subsidy;

        blockFees[height] = fees;
        isVerified[height] = true;
        verifiedBlockCount++;

        if (height > newestVerifiedHeight) newestVerifiedHeight = height;
        if (oldestVerifiedHeight == 0 || height < oldestVerifiedHeight) {
            oldestVerifiedHeight = height;
        }

        emit CoinbaseProofSubmitted(height, fees);
    }

    /// @notice Get average fees over a window of recent verified blocks
    /// @param windowBlocks Number of recent blocks to average over
    function getAverageFees(uint32 windowBlocks) external view returns (uint64) {
        require(newestVerifiedHeight > 0, "No verified blocks");
        uint32 startHeight =
            newestVerifiedHeight >= windowBlocks ? newestVerifiedHeight - windowBlocks + 1 : oldestVerifiedHeight;

        uint64 windowFees = 0;
        uint32 count = 0;
        for (uint32 h = startHeight; h <= newestVerifiedHeight; h++) {
            if (isVerified[h]) {
                windowFees += blockFees[h];
                count++;
            }
        }
        require(count > 0, "No verified blocks in window");
        return windowFees / count;
    }

    /// @notice Double-SHA256 of a concatenated pair (for merkle tree computation)
    function _dsha256Pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(sha256(abi.encodePacked(a, b))));
    }
}
