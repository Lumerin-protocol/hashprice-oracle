import { log, ethereum, dataSource, Address } from "@graphprotocol/graph-ts";
import { AggregatorV3Interface } from "../generated/Hashprice/AggregatorV3Interface";
import { HashpriceBTC } from "../generated/HashpriceBtc/HashpriceBtc";
import { HashpriceUsd, BtcUsd, HashpriceBtc as HashpriceBtcEntity } from "../generated/schema";
import { HashpriceUpdated } from "../generated/HashpriceBtc/HashpriceBtc";
import { HashpriceMeta } from "../generated/schema";
import { BigInt } from "@graphprotocol/graph-ts";

// Block (polling) handler to collect hashrate data for HashpriceUsd and BtcUsd feeds
export function handleBlock(block: ethereum.Block): void {
  log.info("Handling block {}", [block.number.toString()]);

  // HashpriceUsd feed
  const hashpriceUsdAddress = dataSource.address();
  log.info("HashpriceUsd feed address: {}", [hashpriceUsdAddress.toHexString()]);
  const hashpriceUsd = AggregatorV3Interface.bind(hashpriceUsdAddress);
  const hashpriceUsdData = hashpriceUsd.try_latestRoundData();
  if (hashpriceUsdData.reverted) {
    log.error("HashpriceUsd latestRoundData reverted", []);
  } else {
    const hashpriceUsdEntry = new HashpriceUsd(0);
    hashpriceUsdEntry.id = hashpriceUsdData.value.getRoundId().toI64();
    hashpriceUsdEntry.price = hashpriceUsdData.value.getAnswer();
    hashpriceUsdEntry.timestamp = hashpriceUsdData.value.getUpdatedAt().toI64();
    hashpriceUsdEntry.blockNumber = block.number;
    hashpriceUsdEntry.save();
    log.info("HashpriceUsd: {}, Block number: {}", [
      hashpriceUsdEntry.price.toString(),
      block.number.toString(),
    ]);
  }

  // BtcUsd feed
  const context = dataSource.context();
  const btcUsdAddress = context.mustGet("btcUsdAddress").toString();
  log.info("BtcUsd feed address: {}", [btcUsdAddress]);

  const btcUsdContract = AggregatorV3Interface.bind(Address.fromString(btcUsdAddress));
  const btcUsdData = btcUsdContract.try_latestRoundData();
  if (btcUsdData.reverted) {
    log.error("BtcTokenOracle latestRoundData reverted", []);
  } else {
    const record = new BtcUsd(0);
    record.id = btcUsdData.value.getRoundId().toI64();
    record.price = btcUsdData.value.getAnswer();
    record.timestamp = btcUsdData.value.getUpdatedAt().toI64();
    record.blockNumber = block.number;
    record.save();

    log.info("BtcUsd: {}, Block number: {}", [record.price.toString(), block.number.toString()]);
  }
}

// Event handler to collect hashprice data for the BTC feed
export function handleHashpriceUpdated(event: HashpriceUpdated): void {
  const hashpriceBtcEntry = new HashpriceBtcEntity(0);
  hashpriceBtcEntry.id = event.params.confirmedHeight.toI64();
  hashpriceBtcEntry.price = event.params.hashprice;
  hashpriceBtcEntry.timestamp = event.block.timestamp.toI64();
  hashpriceBtcEntry.blockNumber = event.block.number;
  hashpriceBtcEntry.save();

  log.info("HashpriceUpdated: id: {}, price: {}, blockNumber: {}, timestamp: {}", [
    hashpriceBtcEntry.id.toString(),
    hashpriceBtcEntry.price.toString(),
    hashpriceBtcEntry.blockNumber.toString(),
    hashpriceBtcEntry.timestamp.toString(),
  ]);
}

export function initHashpriceMeta(block: ethereum.Block): void {
  const context = dataSource.context();
  const hashpriceUsdAddress = context.mustGet("hashpriceUsdAddress").toString();
  const hashpriceBtcAddress = context.mustGet("hashpriceBtcAddress").toString();
  const btcUsdAddress = context.mustGet("btcUsdAddress").toString();
  const hashpriceStartBlock = context.mustGet("hashpriceStartBlock").toBigInt();
  const hashpricePollingBlockInterval = context.mustGet("hashpricePollingBlockInterval").toBigInt();

  const hashpriceUsd = AggregatorV3Interface.bind(Address.fromString(hashpriceUsdAddress));
  const hashpriceBtc = HashpriceBTC.bind(Address.fromString(hashpriceBtcAddress));
  const BtcUsd = AggregatorV3Interface.bind(Address.fromString(btcUsdAddress));

  let hashpriceMeta = HashpriceMeta.load(0);
  if (!hashpriceMeta) {
    hashpriceMeta = new HashpriceMeta(0);
    hashpriceMeta.id = 0;
    hashpriceMeta.hashpriceUsdAddress = Address.fromString(hashpriceUsdAddress);
    hashpriceMeta.hashpriceBtcAddress = Address.fromString(hashpriceBtcAddress);
    hashpriceMeta.btcUsdAddress = Address.fromString(btcUsdAddress);
    hashpriceMeta.startBlock = hashpriceStartBlock;
    hashpriceMeta.pollingBlockInterval = hashpricePollingBlockInterval;
    hashpriceMeta.hashpriceUsdDecimals = hashpriceUsd.decimals();
    hashpriceMeta.hashpriceBtcDecimals = hashpriceBtc.decimals();
    hashpriceMeta.btcUsdDecimals = BtcUsd.decimals();
    hashpriceMeta.save();
  }
}
