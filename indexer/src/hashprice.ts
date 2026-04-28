import {
  log,
  ethereum,
  dataSource,
  Address,
  DataSourceContext,
  BigInt,
} from "@graphprotocol/graph-ts";
import { AggregatorProxy } from "../generated/HashpriceBTC/AggregatorProxy";
import { AggregatorV2V3Interface } from "../generated/HashpriceBTC/AggregatorV2V3Interface";
import { AggregatorV3Interface } from "../generated/HashpriceBTC/AggregatorV3Interface";
import { HashpriceBTC } from "../generated/HashpriceBTC/HashpriceBTC";
import { AnswerUpdated } from "../generated/HashpriceBTC/AggregatorProxy";
import { HashpriceUpdated } from "../generated/HashpriceBTC/HashpriceBTC";
import {
  HashpriceUsd,
  BtcUsd,
  HashpriceBtc,
  HashpriceMeta,
  LatestRates,
} from "../generated/schema";
import { ChainlinkAggregator } from "../generated/templates";

const LATEST_RATES_ID = 0;

// Once handler — bootstraps the BTC/USD aggregator dynamic data source and initializes HashpriceMeta
export function initFeeds(block: ethereum.Block): void {
  log.info("===============inside initFeeds", []);
  const context = dataSource.context();
  const hashpriceBtcAddress = dataSource.address();
  const btcUsdAddress = Address.fromString(context.mustGet("btcUsdAddress").toString());
  const hashpriceUsdAddress = Address.fromString(context.mustGet("hashpriceUsdAddress").toString());
  const hashpriceStartBlock = context.mustGet("hashpriceStartBlock").toBigInt();

  const btcUsdProxy = AggregatorProxy.bind(btcUsdAddress);
  const hashpriceBtcContract = HashpriceBTC.bind(hashpriceBtcAddress);
  const hashpriceUsdContract = AggregatorV3Interface.bind(hashpriceUsdAddress);
  const btcUsdAggResult = btcUsdProxy.try_aggregator();
  if (btcUsdAggResult.reverted) {
    log.error("Failed to get BtcUsd aggregator address", []);
  } else {
    ChainlinkAggregator.create(btcUsdAggResult.value);
    log.info("Created BtcUsd aggregator data source: {}", [btcUsdAggResult.value.toHexString()]);

    let rates = LatestRates.load(LATEST_RATES_ID);
    if (!rates) {
      rates = new LatestRates(LATEST_RATES_ID);
      rates.id = LATEST_RATES_ID;
    }
    rates.btcUsdAggregator = btcUsdAggResult.value;
    rates.save();
  }

  let meta = HashpriceMeta.load(LATEST_RATES_ID);
  if (!meta) {
    meta = new HashpriceMeta(LATEST_RATES_ID);
    meta.id = LATEST_RATES_ID;
    meta.hashpriceBtcAddress = hashpriceBtcAddress;
    meta.hashpriceUsdAddress = hashpriceUsdAddress;
    meta.btcUsdAddress = btcUsdAddress;
    meta.startBlock = hashpriceStartBlock;

    const hashpriceBtcDecimalsResult = hashpriceBtcContract.try_decimals();
    if (hashpriceBtcDecimalsResult.reverted) {
      log.error("Failed to get HashpriceBTC decimals", []);
      return;
    }
    meta.hashpriceBtcDecimals = hashpriceBtcDecimalsResult.value;

    const btcUsdDecimalsResult = btcUsdProxy.try_decimals();
    if (btcUsdDecimalsResult.reverted) {
      log.error("Failed to get BTC/USD decimals", []);
      return;
    }
    meta.btcUsdDecimals = btcUsdDecimalsResult.value;

    const hashpriceUsdDecimalsResult = hashpriceUsdContract.try_decimals();
    if (hashpriceUsdDecimalsResult.reverted) {
      log.error("Failed to get HashpriceUSD decimals", []);
      return;
    }
    meta.hashpriceUsdDecimals = hashpriceUsdDecimalsResult.value;
    meta.save();
  }
}

// Handles hashprice updates — saves HashpriceBtc and derives HashpriceUsd from latest BtcUsd
export function handleHashpriceUpdated(event: HashpriceUpdated): void {
  log.info("handleHashpriceUpdated: bitcoin block {}", [event.params.confirmedHeight.toString()]);
  const hpBtc = new HashpriceBtc(0);
  hpBtc.id = event.params.confirmedHeight.toI64();
  hpBtc.price = event.params.hashprice;
  hpBtc.timestamp = event.block.timestamp.toI64();
  hpBtc.blockNumber = event.block.number;
  hpBtc.save();

  let rates = LatestRates.load(LATEST_RATES_ID);
  if (!rates) {
    rates = new LatestRates(LATEST_RATES_ID);
    rates.id = LATEST_RATES_ID;
  }
  rates.hashpriceBtcId = hpBtc.id;
  rates.hashpriceBtcPrice = event.params.hashprice;
  rates.hashpriceBtcUpdatedAt = event.block.timestamp;
  rates.hashpriceBtcBlockNumber = event.block.number;
  rates.save();

  const context = dataSource.context();
  const btcUsdAddress = Address.fromString(context.mustGet("btcUsdAddress").toString());

  const proxy = AggregatorProxy.bind(btcUsdAddress);
  const aggResult = proxy.try_aggregator();
  if (!aggResult.reverted) {
    const storedAgg = rates.btcUsdAggregator;
    if (storedAgg === null || storedAgg.toHexString() !== aggResult.value.toHexString()) {
      ChainlinkAggregator.create(aggResult.value);
      rates.btcUsdAggregator = aggResult.value;
      rates.save();
      log.info("BtcUsd aggregator rotated: new aggregator {}", [aggResult.value.toHexString()]);
    }
  }

  const meta = HashpriceMeta.load(LATEST_RATES_ID);
  if (!meta) {
    log.error("HashpriceMeta not found", []);
    return;
  }

  deriveHashpriceUsd(rates, meta);
}

// Handles BTC/USD price updates — saves BtcUsd and derives HashpriceUsd from latest HashpriceBtc
export function handleAnswerUpdated(event: AnswerUpdated): void {
  const btcUsdEntry = new BtcUsd(0);
  btcUsdEntry.id = event.params.roundId.toI64();
  btcUsdEntry.price = event.params.current;
  btcUsdEntry.timestamp = event.params.updatedAt.toI64();
  btcUsdEntry.blockNumber = event.block.number;
  btcUsdEntry.save();

  let rates = LatestRates.load(LATEST_RATES_ID);
  if (!rates) {
    rates = new LatestRates(LATEST_RATES_ID);
    rates.id = LATEST_RATES_ID;
  }
  rates.btcUsdId = event.params.roundId.toI64();
  rates.btcUsdPrice = event.params.current;
  rates.btcUsdUpdatedAt = event.params.updatedAt;
  rates.btcUsdBlockNumber = event.block.number;
  rates.save();

  const meta = HashpriceMeta.load(LATEST_RATES_ID);
  if (!meta) {
    log.error("HashpriceMeta not found", []);
    return;
  }

  deriveHashpriceUsd(rates, meta);
}

function deriveHashpriceUsd(rates: LatestRates, meta: HashpriceMeta): void {
  log.info("inside deriveHashpriceUsd", []);
  if (
    rates.btcUsdId === 0 ||
    rates.btcUsdPrice === null ||
    rates.btcUsdUpdatedAt === null ||
    rates.btcUsdBlockNumber === null ||
    rates.hashpriceBtcId === 0 ||
    rates.hashpriceBtcPrice === null ||
    rates.hashpriceBtcUpdatedAt === null ||
    rates.hashpriceBtcBlockNumber === null
  )
    return;

  // if clause above does not narrow down the null type, so
  // we use throwIfNullBigInt to enforce the type
  const btcUsdPrice = throwIfNullBigInt(rates.btcUsdPrice);
  const btcUsdUpdatedAt = throwIfNullBigInt(rates.btcUsdUpdatedAt);
  const btcUsdBlockNumber = throwIfNullBigInt(rates.btcUsdBlockNumber);
  const hashpriceBtcPrice = throwIfNullBigInt(rates.hashpriceBtcPrice);
  const hashpriceBtcUpdatedAt = throwIfNullBigInt(rates.hashpriceBtcUpdatedAt);
  const hashpriceBtcBlockNumber = throwIfNullBigInt(rates.hashpriceBtcBlockNumber);

  // price = (hashpriceBtc * btcUsd) / 10^(hashpriceBtcDecimals + btcUsdDecimals - hashpriceUsdDecimals)
  const exponent = meta.hashpriceBtcDecimals + meta.btcUsdDecimals - meta.hashpriceUsdDecimals;
  const divisor = BigInt.fromI32(10).pow(exponent as u8);
  const price = hashpriceBtcPrice.times(btcUsdPrice).div(divisor);

  // roundId = (hpRoundId << 40) | (btcRoundId & 0xFFFFFFFFFF)
  const id = (rates.hashpriceBtcId << 40) | (rates.btcUsdId & 0xffffffffff);

  const timestamp = maxBigInt(hashpriceBtcUpdatedAt, btcUsdUpdatedAt).toI64();
  const minTimestamp = minBigInt(hashpriceBtcUpdatedAt, btcUsdUpdatedAt).toI64();

  // blockNumber = latest of the two contributing blocks
  const blockNumber = hashpriceBtcBlockNumber.gt(btcUsdBlockNumber)
    ? hashpriceBtcBlockNumber
    : btcUsdBlockNumber;

  const hashpriceUsd = new HashpriceUsd(0);
  hashpriceUsd.id = id;
  hashpriceUsd.price = price;
  hashpriceUsd.timestamp = timestamp;
  hashpriceUsd.minTimestamp = minTimestamp;
  hashpriceUsd.blockNumber = blockNumber;
  hashpriceUsd.save();

  log.info("HashpriceUsd derived: id={}, price={}", [id.toString(), hashpriceUsd.price.toString()]);
}

function maxBigInt(a: BigInt, b: BigInt): BigInt {
  return a.gt(b) ? a : b;
}

function minBigInt(a: BigInt, b: BigInt): BigInt {
  return a.lt(b) ? a : b;
}

function throwIfNullBigInt(value: BigInt | null): BigInt {
  if (value === null) {
    throw new Error("Value is null");
  }
  return value;
}
