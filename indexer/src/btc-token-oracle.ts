import { log, ethereum, dataSource, BigInt } from "@graphprotocol/graph-ts";
import { AggregatorV3Interface } from "../generated/BtcTokenOracle/AggregatorV3Interface";
import { BtcPriceIndex, BtcTokenOracle as BtcTokenOracleEntity } from "../generated/schema";

export function handleInitialized(event: ethereum.Event): void {
  log.info("BtcTokenOracle Initialized {}", [event.address.toHexString()]);
  const btcTokenOracle = new BtcTokenOracleEntity(0);
  btcTokenOracle.initializedBlockNumber = event.block.number;
  btcTokenOracle.initializeTimestamp = event.block.timestamp;
  btcTokenOracle.save();
}

// Block handler to collect BTC price data on each block
export function handleBlock(block: ethereum.Block): void {
  log.info("BtcTokenOracle handling block {}", [block.number.toString()]);

  let btcTokenOracle = BtcTokenOracleEntity.load(0);
  if (!btcTokenOracle) {
    btcTokenOracle = new BtcTokenOracleEntity(0);
    btcTokenOracle.initializedBlockNumber = block.number;
    btcTokenOracle.initializeTimestamp = block.timestamp;
    btcTokenOracle.save();
  }

  // Access data source information from subgraph.yaml
  const address = dataSource.address();
  log.info("BtcTokenOracle Address {}", [address.toHexString()]);

  const oracle = AggregatorV3Interface.bind(address);
  const latestRoundData = oracle.try_latestRoundData();
  if (latestRoundData.reverted) {
    log.info("BtcTokenOracle latestRoundData reverted", []);
    return;
  }

  const answer = latestRoundData.value.getAnswer();
  const updatedAt = latestRoundData.value.getUpdatedAt();

  // Store the BTC price index entry
  const btcPriceIndexEntry = new BtcPriceIndex(0);
  btcPriceIndexEntry.price = answer;
  btcPriceIndexEntry.updatedAt = updatedAt;
  btcPriceIndexEntry.blockNumber = block.number;
  btcPriceIndexEntry.save();

  log.info("BTC Price: {}, Block number: {}, UpdatedAt: {}", [
    answer.toString(),
    block.number.toString(),
    updatedAt.toString(),
  ]);
}