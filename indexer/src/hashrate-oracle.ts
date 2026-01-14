import { log, ethereum, dataSource, BigInt } from "@graphprotocol/graph-ts";
import { HashrateOracle } from "../generated/HashrateOracle/HashrateOracle";
import { HashrateIndex, HashrateOracle as HashrateOracleEntity } from "../generated/schema";
import { bigIntToBytes } from "./lib";

export function handleInitialized(event: ethereum.Event): void {
  log.info("Oracle Initialized {}", [event.address.toHexString()]);
  const hashrateOracle = new HashrateOracleEntity(0);
  hashrateOracle.initializedBlockNumber = event.block.number;
  hashrateOracle.initializeTimestamp = event.block.timestamp;
  hashrateOracle.save();
}

// Block handler to collect hashrate data on each block
export function handleBlock(block: ethereum.Block): void {
  log.info("Handling block {}", [block.number.toString()]);

  let hashrateOracle = HashrateOracleEntity.load(0);
  if (!hashrateOracle) {
    hashrateOracle = new HashrateOracleEntity(0);
    hashrateOracle.initializedBlockNumber = block.number;
    hashrateOracle.initializeTimestamp = block.timestamp;
    hashrateOracle.save();
  }

  // Access data source information from subgraph.yaml
  const address = dataSource.address();
  log.info("Oracle Address {}", [address.toHexString()]);

  const ho = HashrateOracle.bind(address);
  const hashesForBTC = ho.try_getHashesForBTC();
  if (hashesForBTC.reverted) {
    log.info("Hashes for BTC reverted", []);
    return;
  }

  const hashesForToken = ho.try_getHashesforToken();
  if (hashesForToken.reverted) {
    log.info("Hashes for Token reverted", []);
    return;
  }

  //TODO: store the latest hashrate index entry ID
  // and update indexer only if the hashrate index entry is different from the latest one
  // also considering the timestamp of the latest update
  const hashrateIndexEntry = new HashrateIndex(0);
  hashrateIndexEntry.hashesForBTC = hashesForBTC.value.value;
  hashrateIndexEntry.hashesForToken = hashesForToken.value;
  hashrateIndexEntry.updatedAt = block.timestamp;

  log.info("Block timestamp: {} / {} / {}", [
    block.timestamp.toString(),
    block.timestamp.toI64().toString(),
    block.timestamp.toI32().toString(),
  ]);

  hashrateIndexEntry.blockNumber = block.number;
  hashrateIndexEntry.save();

  log.info("Hashes for BTC: {}, Hashes for Token: {}, Block number: {}, Timestamp: {}", [
    hashesForBTC.value.value.toString(),
    hashesForToken.value.toString(),
    block.number.toString(),
    block.timestamp.toString(),
  ]);
}
