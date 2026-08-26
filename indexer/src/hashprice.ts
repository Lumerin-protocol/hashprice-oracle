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
import {
  HashpriceBTC,
  HashpriceBTC__getBlockFromTipResultValue0Struct,
} from "../generated/HashpriceBTC/HashpriceBTC";
import { AnswerUpdated } from "../generated/HashpriceBTC/AggregatorProxy";
import {
  BlockSubmitted,
  HashpriceUpdated,
} from "../generated/HashpriceBTC/HashpriceBTC";
import {
  HashpriceUsd,
  BtcUsd,
  BtcBlock,
  HashpriceBtc,
  HashpriceMeta,
  LatestRates,
  NetworkHashrate1d,
  NetworkHashrate7d,
} from "../generated/schema";
import { ChainlinkAggregator } from "../generated/templates";

const LATEST_RATES_ID = 0;

const ONE = BigInt.fromI32(1);
const TWO = BigInt.fromI32(2);

const TWO_256 = TWO.pow(128).pow(2);

// Bitcoin's maximum nBits exponent; anything above needs more than 256 bits.
const MAX_NBITS_EXPONENT: u32 = 32;

// Mirrors HashpriceBTC.BLOCK_BUFFER_SIZE. A height further than this behind the tip is no
// longer readable through getBlockFromTip — its ring slot has been overwritten.
const BLOCK_BUFFER_SIZE = 32;

// Bitcoin Core's median-time-past window: the block itself plus its 10 ancestors.
const MTP_WINDOW = 11;

const BLOCKS_PER_MINUTE = 10;
const DAY_IN_MINUTES = 24 * 60;

const WINDOW_1D = DAY_IN_MINUTES / BLOCKS_PER_MINUTE; // 24 hours at 10 min/block
const WINDOW_7D = (7 * DAY_IN_MINUTES) / BLOCKS_PER_MINUTE; // 7 days at 10 min/block

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

// Records the header timestamp and difficulty target of one accepted Bitcoin block, which is
// what the actual-hashrate estimate is built from. The event itself carries neither, so both
// are read back out of the contract's ring buffer.
export function handleBlockSubmitted(event: BlockSubmitted): void {
  const height = event.params.height;
  const entry = readBlockEntry(event.address, height);
  if (entry === null) return;

  const target = nBitsToTarget(entry.nBits);
  if (target === null) return;
  const work = TWO_256.div(target.plus(ONE));

  // Accumulate from the parent row rather than a global running total: a reorg re-emits
  // BlockSubmitted for every fork block in order from the common ancestor, so each
  // overwritten height rebuilds its sum from an already-corrected parent.
  const parent = BtcBlock.load(height.toI64() - 1);
  let cumulativeWork = work;
  let chainBaseHeight = height.toI64();
  if (parent !== null) {
    cumulativeWork = parent.cumulativeWork.plus(work);
    chainBaseHeight = parent.chainBaseHeight;
  }

  const block = new BtcBlock(height.toI64());
  block.btcTimestamp = entry.timestamp;
  block.nBits = entry.nBits;
  block.cumulativeWork = cumulativeWork;
  block.chainBaseHeight = chainBaseHeight;
  block.medianTime = medianTimePast(
    height.toI64(),
    entry.timestamp,
    chainBaseHeight,
  );
  block.save();
}

// Handles hashprice updates — saves HashpriceBtc and derives HashpriceUsd from latest BtcUsd
export function handleHashpriceUpdated(event: HashpriceUpdated): void {
  log.info("handleHashpriceUpdated: bitcoin block {}", [event.params.confirmedHeight.toString()]);

  const hpBtc = new HashpriceBtc(0);
  hpBtc.price = event.params.hashprice;
  hpBtc.timestamp = event.block.timestamp.toI64();
  hpBtc.blockNumber = event.block.number;
  hpBtc.confirmedHeight = event.params.confirmedHeight;
  hpBtc.avgFees = event.params.avgFees;
  hpBtc.save();

  let rates = LatestRates.load(LATEST_RATES_ID);
  if (!rates) {
    rates = new LatestRates(LATEST_RATES_ID);
    rates.id = LATEST_RATES_ID;
  }
  rates.hashpriceBtcId = event.params.confirmedHeight.toI64();
  rates.hashpriceBtcPrice = event.params.hashprice;
  rates.hashpriceBtcUpdatedAt = event.block.timestamp;
  rates.hashpriceBtcBlockNumber = event.block.number;

  const hashrate1d = deriveWindowHashrate(
    event.params.confirmedHeight,
    WINDOW_1D,
  );
  if (hashrate1d !== null) {
    const row = new NetworkHashrate1d(0);
    row.hashrateHpS = hashrate1d.hashrateHpS;
    row.timestamp = event.block.timestamp.toI64();
    row.blockNumber = event.block.number;
    row.confirmedHeight = event.params.confirmedHeight;
    row.elapsedSeconds = hashrate1d.elapsedSeconds;
    row.save();

    rates.networkHashrate1dId = event.params.confirmedHeight.toI64();
    rates.networkHashrate1dHpS = hashrate1d.hashrateHpS;
    rates.networkHashrate1dUpdatedAt = event.block.timestamp;
    rates.networkHashrate1dBlockNumber = event.block.number;
  }

  const hashrate7d = deriveWindowHashrate(
    event.params.confirmedHeight,
    WINDOW_7D,
  );
  if (hashrate7d !== null) {
    const row = new NetworkHashrate7d(0);
    row.hashrateHpS = hashrate7d.hashrateHpS;
    row.timestamp = event.block.timestamp.toI64();
    row.blockNumber = event.block.number;
    row.confirmedHeight = event.params.confirmedHeight;
    row.elapsedSeconds = hashrate7d.elapsedSeconds;
    row.save();

    rates.networkHashrate7dId = event.params.confirmedHeight.toI64();
    rates.networkHashrate7dHpS = hashrate7d.hashrateHpS;
    rates.networkHashrate7dUpdatedAt = event.block.timestamp;
    rates.networkHashrate7dBlockNumber = event.block.number;
  }

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

class WindowHashrate {
  hashrateHpS: BigInt;
  elapsedSeconds: BigInt;

  constructor(hashrateHpS: BigInt, elapsedSeconds: BigInt) {
    this.hashrateHpS = hashrateHpS;
    this.elapsedSeconds = elapsedSeconds;
  }
}

// Actual network hashrate in hashes/second over the trailing `window` blocks ending at
// `height`: the expected work those blocks required, divided by how long they actually took.
//
// Elapsed time comes from median time past rather than the raw header timestamps, because
// consensus only requires a header to beat the MTP of its ancestors and to stay within 2h of
// the future — individual timestamps can therefore run backwards or jump by hours. Both
// endpoints carry the same ~6-block median lag, so it cancels out of the difference.
//
// Returns null until enough uninterrupted history has been indexed to measure the window.
function deriveWindowHashrate(
  height: BigInt,
  window: i32,
): WindowHashrate | null {
  const end = BtcBlock.load(height.toI64());
  if (end === null) return null;

  const startHeight = height.toI64() - window;
  if (startHeight < end.chainBaseHeight) return null;

  const start = BtcBlock.load(startHeight);
  if (start === null) return null;

  const endMedian = end.medianTime;
  if (endMedian === null) return null;
  const startMedian = start.medianTime;
  if (startMedian === null) return null;

  const elapsed = endMedian.minus(startMedian);
  if (elapsed.le(BigInt.zero())) {
    log.warning(
      "Non-positive median timespan over {} blocks ending at height {}",
      [window.toString(),
      height.toString(),
    ]);
    return null;
  }

  const work = end.cumulativeWork.minus(start.cumulativeWork);
  return new WindowHashrate(work.div(elapsed), elapsed);
}

// Median of the header timestamps of `height` and its 10 ancestors — Bitcoin Core's
// GetMedianTimePast, exposed as `mediantime` by the `getblock` RPC. `ownTimestamp` is passed
// in because the caller has not written its own BtcBlock row yet.
function medianTimePast(
  height: i64,
  ownTimestamp: BigInt,
  chainBaseHeight: i64,
): BigInt | null {
  if (height - (MTP_WINDOW - 1) < chainBaseHeight) return null;

  const timestamps: BigInt[] = [ownTimestamp];
  for (let i = 1; i < MTP_WINDOW; i++) {
    const ancestor = BtcBlock.load(height - i);
    if (ancestor === null) return null;
    timestamps.push(ancestor.btcTimestamp);
  }

  timestamps.sort(compareBigInt);
  return timestamps[MTP_WINDOW / 2];
}

// Reads the header timestamp and nBits for `height` back out of the contract's ring buffer.
// getBlockFromTip indexes backwards from the tip, so the tip's own height has to be fetched
// first; graph-node caches eth_call results per block, so the repeated tip lookup across
// every BlockSubmitted log in one batch costs a single RPC round trip.
function readBlockEntry(
  contractAddress: Address,
  height: BigInt,
): HashpriceBTC__getBlockFromTipResultValue0Struct | null {
  const contract = HashpriceBTC.bind(contractAddress);

  const tipResult = contract.try_getBlockFromTip(0);
  if (tipResult.reverted) {
    log.error("getBlockFromTip(0) reverted while reading height {}", [
      height.toString(),
    ]);
    return null;
  }
  const tip = tipResult.value;

  const offset = tip.height.minus(height).toI64();
  if (offset < 0 || offset >= BLOCK_BUFFER_SIZE) {
    log.warning(
      "Height {} is {} blocks behind tip {}, outside the {}-slot buffer",
      [
        height.toString(),
        offset.toString(),
        tip.height.toString(),
        BLOCK_BUFFER_SIZE.toString(),
      ],
    );
    return null;
  }
  if (offset === 0) return tip;

  const entryResult = contract.try_getBlockFromTip(offset as i32);
  if (entryResult.reverted) {
    log.error("getBlockFromTip({}) reverted while reading height {}", [
      offset.toString(),
      height.toString(),
    ]);
    return null;
  }

  // A ring slot may still hold an entry from 32 blocks ago even when the offset looks sane.
  const entry = entryResult.value;
  if (entry.height.notEqual(height)) {
    log.warning("Ring slot for height {} holds height {}", [
      height.toString(),
      entry.height.toString(),
    ]);
    return null;
  }
  return entry;
}

// Expands a compact nBits target: coefficient * 2^(8 * (exponent - 3)).
// Mirrors BTCUtils.nBitsToTarget.
function nBitsToTarget(nBits: BigInt): BigInt | null {
  const bits = nBits.toU32();
  const exponent = bits >> 24;
  const coefficient = BigInt.fromU32(bits & 0x7fffff);

  if (exponent > MAX_NBITS_EXPONENT) {
    log.error("Invalid nBits {}: exponent {} exceeds {}", [
      nBits.toString(),
      exponent.toString(),
      MAX_NBITS_EXPONENT.toString(),
    ]);
    return null;
  }
  if (exponent <= 3) {
    return coefficient.div(TWO.pow((8 * (3 - exponent)) as u8));
  }
  return coefficient.times(TWO.pow((8 * (exponent - 3)) as u8));
}

function compareBigInt(a: BigInt, b: BigInt): i32 {
  if (a.lt(b)) return -1;
  if (a.gt(b)) return 1;
  return 0;
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
