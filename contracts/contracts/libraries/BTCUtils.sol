// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

/// @title BTCUtils
/// @notice Pure utility functions for Bitcoin data structures
library BTCUtils {
    struct HeaderInfo {
        bytes32 prevBlockHashLE;
        bytes32 merkleRoot;
        uint32 timestamp;
        uint32 nBits;
    }

    /// @notice Parse an 80-byte Bitcoin block header
    /// @dev Bitcoin header layout (all little-endian):
    ///   [0..4)   version
    ///   [4..36)  prevBlockHash (internal byte order, reversed vs SHA-256 output)
    ///   [36..68) merkleRoot    (internal byte order)
    ///   [68..72) timestamp
    ///   [72..76) nBits (compact target)
    ///   [76..80) nonce
    function parseHeader(bytes memory header) internal pure returns (HeaderInfo memory) {
        require(header.length == 80, "Invalid header length");

        bytes32 prevBlockHash = readBytes32Mem(header, 4);
        bytes32 merkleRootVal = readBytes32Mem(header, 36);
        uint32 ts = readUint32LEMem(header, 68);
        uint32 bits = readUint32LEMem(header, 72);

        return HeaderInfo({
            prevBlockHashLE: reverseBytes32(prevBlockHash),
            merkleRoot: merkleRootVal,
            timestamp: ts,
            nBits: bits
        });
    }

    /// @notice Double-SHA256 (Bitcoin's standard hash function)
    function dsha256(bytes memory data) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(sha256(data)));
    }

    /// @notice Expand nBits compact target to 256-bit target
    /// @dev nBits format: [exponent (1 byte)][coefficient (3 bytes)]
    ///      target = coefficient * 2^(8 * (exponent - 3))
    function nBitsToTarget(uint32 nBits) internal pure returns (uint256) {
        uint256 exponent = uint256(nBits >> 24);
        uint256 coefficient = uint256(nBits & 0x7fffff);
        if (exponent <= 3) {
            return coefficient >> (8 * (3 - exponent));
        }
        return coefficient << (8 * (exponent - 3));
    }

    /// @notice Expected number of hashes to mine a block at the given target
    /// @dev work = 2^256 / (target + 1)
    function targetToWork(uint256 target) internal pure returns (uint256) {
        return type(uint256).max / (target + 1);
    }

    /// @notice Convert nBits to difficulty
    /// @dev difficulty = diff1Target / currentTarget
    function nBitsToDifficulty(uint32 nBits) internal pure returns (uint256) {
        uint256 target = nBitsToTarget(nBits);
        require(target > 0, "Zero target");
        uint256 diff1Target = 0x00000000FFFF0000000000000000000000000000000000000000000000000000;
        return diff1Target / target;
    }

    /// @notice Compute block subsidy given height (handles halvings)
    /// @dev 50 BTC initially, halves every 210,000 blocks
    function getBlockSubsidy(uint256 height) internal pure returns (uint64) {
        uint256 halvings = height / 210_000;
        if (halvings >= 64) return 0;
        return uint64(5_000_000_000 >> halvings);
    }

    /// @notice Read a Bitcoin varint from raw bytes
    /// @return value The decoded varint value
    /// @return size Number of bytes consumed
    function readVarint(bytes calldata data, uint256 offset) internal pure returns (uint64 value, uint256 size) {
        uint8 first = uint8(data[offset]);
        if (first < 0xfd) {
            return (uint64(first), 1);
        } else if (first == 0xfd) {
            return (uint64(readUint16LE(data, offset + 1)), 3);
        } else if (first == 0xfe) {
            return (uint64(readUint32LE(data, offset + 1)), 5);
        } else {
            return (readUint64LE(data, offset + 1), 9);
        }
    }

    /// @notice Parse a raw Bitcoin coinbase tx and return total output value (satoshis)
    /// @dev The tx must be in non-witness serialization (for txid computation).
    ///      Layout: version(4) | vinCount(varint,=1) | vin | voutCount(varint) | vouts | locktime(4)
    function parseCoinbaseOutputValue(bytes calldata rawTx) internal pure returns (uint64 totalValue) {
        uint256 offset = 4; // skip version

        // Skip vin (always exactly 1 input for coinbase)
        (uint64 vinCount, uint256 vinSize) = readVarint(rawTx, offset);
        offset += vinSize;
        require(vinCount == 1, "Not a coinbase tx");

        // Skip the single input: prevHash(32) + prevIndex(4) + scriptLen(varint) + script + sequence(4)
        offset += 36; // prevHash + prevIndex
        (uint64 scriptLen, uint256 scriptLenSize) = readVarint(rawTx, offset);
        offset += scriptLenSize + uint256(scriptLen) + 4; // script + sequence

        // Parse outputs
        (uint64 voutCount, uint256 voutSize) = readVarint(rawTx, offset);
        offset += voutSize;

        for (uint64 i = 0; i < voutCount; i++) {
            totalValue += readUint64LE(rawTx, offset);
            offset += 8;
            (uint64 pkScriptLen, uint256 pkSize) = readVarint(rawTx, offset);
            offset += pkSize + uint256(pkScriptLen);
        }
    }

    /// @notice Reverse the byte order of a bytes32 value
    function reverseBytes32(bytes32 input) internal pure returns (bytes32) {
        uint256 v = uint256(input);
        // swap bytes
        v = ((v & 0xFF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00) >> 8)
            | ((v & 0x00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF) << 8);
        // swap 2-byte pairs
        v = ((v & 0xFFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000) >> 16)
            | ((v & 0x0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF) << 16);
        // swap 4-byte pairs
        v = ((v & 0xFFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000) >> 32)
            | ((v & 0x00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF) << 32);
        // swap 8-byte pairs
        v = ((v & 0xFFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF0000000000000000) >> 64)
            | ((v & 0x0000000000000000FFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF) << 64);
        // swap 16-byte halves
        v = (v >> 128) | (v << 128);
        return bytes32(v);
    }

    /// @notice Read a uint16 in little-endian from calldata
    function readUint16LE(bytes calldata data, uint256 offset) internal pure returns (uint16) {
        return uint16(uint8(data[offset])) | (uint16(uint8(data[offset + 1])) << 8);
    }

    /// @notice Read a uint32 in little-endian from calldata
    function readUint32LE(bytes calldata data, uint256 offset) internal pure returns (uint32) {
        return uint32(uint8(data[offset])) | (uint32(uint8(data[offset + 1])) << 8)
            | (uint32(uint8(data[offset + 2])) << 16) | (uint32(uint8(data[offset + 3])) << 24);
    }

    /// @notice Read a bytes32 from memory at the given byte offset
    function readBytes32Mem(bytes memory data, uint256 offset) internal pure returns (bytes32 result) {
        assembly {
            result := mload(add(add(data, 32), offset))
        }
    }

    /// @notice Read a uint32 in little-endian from memory
    function readUint32LEMem(bytes memory data, uint256 offset) internal pure returns (uint32) {
        return uint32(uint8(data[offset])) | (uint32(uint8(data[offset + 1])) << 8)
            | (uint32(uint8(data[offset + 2])) << 16) | (uint32(uint8(data[offset + 3])) << 24);
    }

    /// @notice Read a uint64 in little-endian from calldata
    function readUint64LE(bytes calldata data, uint256 offset) internal pure returns (uint64) {
        return uint64(uint8(data[offset])) | (uint64(uint8(data[offset + 1])) << 8)
            | (uint64(uint8(data[offset + 2])) << 16) | (uint64(uint8(data[offset + 3])) << 24)
            | (uint64(uint8(data[offset + 4])) << 32) | (uint64(uint8(data[offset + 5])) << 40)
            | (uint64(uint8(data[offset + 6])) << 48) | (uint64(uint8(data[offset + 7])) << 56);
    }
}
