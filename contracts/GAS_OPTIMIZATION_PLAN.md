# HashrateOracleV3 Gas Optimization Plan

Current single-block `submitBlock` cost: **189,231 gas** (vs V2: 373,210 gas, 49% savings).

Target: **~148k gas** (~60% savings vs V2).

## Optimizations by priority

### 1. Pack global state into fewer storage slots (~17,000 gas)

`chainHeight`, `blockCount`, `epochStartTimestamp`, `epochStartNBits`, `lastSubmittedAt` are each in their own 32-byte slot — 5 separate SLOADs and SSTOREs. They're all `uint32` (20 bytes total), so they fit in a single slot. Turns 5 cold reads + 5 writes into 1 read + 1 write.

```solidity
struct PackedState {
    uint32 chainHeight;
    uint32 blockCount;
    uint32 epochStartTimestamp;
    uint32 epochStartNBits;
    uint32 lastSubmittedAt;
}
PackedState public state;  // 1 slot (20 bytes)
```

`chainTip` (bytes32) and `feeRunningSum` (uint256) remain as their own slots — they're full-width.

### 2. EMA instead of SMA (~7,000 gas)

Eliminates the 144-entry `_fees` ring buffer entirely. Currently every block does a cold SLOAD + SSTORE to `_fees[idx]` plus reads `feeRunningSum`. With EMA:

```solidity
feeEMA = feeEMA + (fees - feeEMA) / 144;
```

One `uint256` replaces 144 `uint64` slots. No ring buffer read/write per block.

### 3. Assembly merkle proof verification (~4,000 gas)

The current loop allocates new memory every iteration via `abi.encodePacked`:

```solidity
current = BTCUtils.dsha256(abi.encodePacked(current, merkleProof[i]));
```

With assembly, use scratch memory at `0x00` directly with the SHA256 precompile — zero allocations:

```solidity
assembly {
    mstore(0x00, current)
    mstore(0x20, calldataload(proofOffset))
    pop(staticcall(gas(), 0x02, 0x00, 0x40, 0x00, 0x20))
    pop(staticcall(gas(), 0x02, 0x00, 0x20, 0x00, 0x20))
    current := mload(0x00)
}
```

### 4. Relax MTP from 11 to 5 blocks (~12,000 gas)

`_validateTimestamp` reads 11 block timestamps from storage — 11 cold SLOADs at ~2,100 each = ~23k gas. Reducing to 5 blocks cuts this roughly in half. A 5-block MTP is still safe — mining 5 blocks with manipulated timestamps requires sustained majority hashrate.

### 5. Remove `submitBlock` (code size only)

Benchmark showed only 4,452 gas overhead for `submitBlocks` vs `submitBlock`. Not worth the code duplication. The keeper always calls `submitBlocks(chainHeight, singleHeader, [coinbaseTx], [proof])`.

### 6. `unchecked` arithmetic (~800 gas)

Loop counters, height increments, and fee arithmetic where overflow is impossible.

## Summary

| # | Optimization | Estimated savings | Complexity |
|---|---|---|---|
| 1 | Pack global state | ~17,000 gas | Medium |
| 2 | EMA fees | ~7,000 gas | Medium |
| 3 | Assembly merkle proof | ~4,000 gas | Low |
| 4 | MTP 11 → 5 | ~12,000 gas | Low |
| 5 | Remove `submitBlock` | code size | Low |
| 6 | `unchecked` arithmetic | ~800 gas | Low |
| | **Total** | **~40,800 gas** | |

Projected cost after all optimizations: **~148,000 gas** (~60% savings vs V2).
