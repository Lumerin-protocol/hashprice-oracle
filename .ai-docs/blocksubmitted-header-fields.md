# Emit header timestamp and nBits in `BlockSubmitted`

Reminder / not scheduled. Bundle into the next `HashpriceBTC` redeploy — see [Why this is not standalone](#why-this-is-not-standalone).

## Problem

The actual-hashrate estimate in the subgraph needs the Bitcoin header timestamp and `nBits`
for every block. `BlockSubmitted` carries neither:

```solidity
event BlockSubmitted(bytes32 indexed blockHash, uint32 indexed height, uint64 fees);
```

So the indexer reads them back out of the 32-slot ring buffer with `getBlockFromTip`, which
costs one `eth_call` to find the tip height plus one more per block that is not the tip
(`readBlockEntry` in [indexer/src/hashprice.ts](../indexer/src/hashprice.ts)). Roughly 288
calls a day at 144 Bitcoin blocks — cheap, but it makes the mapping depend on an archive
node and puts a 32-block ceiling on how large a submission the indexer can follow: anything
deeper has had its ring slot overwritten, and the indexer has to drop the block and restart
its window.

## Change

```solidity
event BlockSubmitted(
    bytes32 indexed blockHash,
    uint32 indexed height,
    uint64 fees,
    uint32 timestamp,
    uint32 nBits
);
```

Both values are already in memory at the emit site — `incoming.timestamp` and
`incoming.nBits` in `_processHeader` — so there is no extra `SLOAD`. The only cost is log
data: two more ABI-padded words, 64 bytes at 8 gas each, so **+512 gas** on a ~121,000 gas
average `submitBlock` ([gas-benchmark.md](../contracts/gas-benchmark.md)). About 0.4%.

In exchange the indexer drops both `eth_call`s, stops needing an archive node, and no longer
cares how deep a submission is.

## Deliberately not included

**Median time past.** The estimator divides by MTP rather than raw timestamps, but computing
it on-chain means reading 11 ring-buffer entries — each its own storage slot, so ~23,000 gas
per block, 45x the cost of the change above. The mapping already computes it for free from
the timestamps it stores. Keep MTP off-chain.

**Cumulative work.** Pure function of `nBits`; the mapping derives it.

`nBits` could arguably be dropped too, since `DifficultyChanged` already carries it at every
retarget and it is constant in between. That saves 256 of the 512 gas in exchange for a
mapping that has to seed itself from a retarget event and carry `nBits` forward across
blocks. Not worth the fragility.

## Why this is not standalone

`HashpriceBTC` is immutable — no proxy, chain state anchored in the constructor — so any code
change is a redeploy. `HashpriceUSD.hashpriceOracle` is also `immutable`, so it has to be
redeployed alongside it, which repoints every downstream consumer.

A redeploy costs:

- New checkpoint via `contracts/scripts/generate-checkpoint.ts`, regenerating `HashpriceBTCDeploy.sol`
- `HashpriceUSD` redeploy, and consumers migrated to the new address
- Keeper config, `oracle-abi/deployments.json`, and a version bump on `@hashpower/oracle-abi`
- Full subgraph resync from the new start block
- A fresh 144-block fee SMA warmup, during which the reported hashprice is averaged over
  fewer blocks than the Luxor index it is meant to match

None of that is worth paying to remove two `eth_call`s. Do it when a redeploy is happening
anyway.

## Checklist for when that happens

- [ ] Add the two fields to the event and update `_processHeader`
- [ ] Update `contracts/abi/` and `keeper/src/abi/` (generated)
- [ ] Assert the new fields in the `BlockSubmitted` contract tests
- [ ] Regenerate the gas benchmark
- [ ] Subgraph: bump the `BlockSubmitted` signature in `subgraph.template.yaml`, delete
      `readBlockEntry` and read `event.params.timestamp` / `event.params.nBits` directly
- [ ] Drop the 32-block buffer guard and its warning path from the mapping
