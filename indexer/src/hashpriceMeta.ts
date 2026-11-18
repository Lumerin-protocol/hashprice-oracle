import { log, ethereum, dataSource, Address } from "@graphprotocol/graph-ts";
import { AggregatorProxy } from "../generated/HashpriceBTC/AggregatorProxy";
import { AggregatorV3Interface } from "../generated/HashpriceBTC/AggregatorV3Interface";
import { HashpriceBTC } from "../generated/HashpriceBTC/HashpriceBTC";
import { HashpriceMetaV2 } from "../generated/schema";

const HASHPRICE_META_ID: i64 = 0;

export function loadHashpriceMeta(): HashpriceMetaV2 | null {
  return HashpriceMetaV2.load(HASHPRICE_META_ID);
}

// Runs only in HashpriceBTC handlers, whose data source context names the feeds. A graft
// copies the base's row, so the first update on different feeds rewrites it.
export function loadOrInitializeHashpriceMeta(block: ethereum.Block): HashpriceMetaV2 | null {
  const context = dataSource.context();
  const hashpriceBtcAddress = dataSource.address();
  const btcUsdAddress = Address.fromString(context.mustGet("btcUsdAddress").toString());
  const hashpriceUsdAddress = Address.fromString(context.mustGet("hashpriceUsdAddress").toString());

  let meta = HashpriceMetaV2.load(HASHPRICE_META_ID);
  if (
    meta !== null &&
    meta.hashpriceBtcAddress.equals(hashpriceBtcAddress) &&
    meta.hashpriceUsdAddress.equals(hashpriceUsdAddress) &&
    meta.btcUsdAddress.equals(btcUsdAddress)
  ) {
    return meta;
  }

  const hashpriceBtcDecimalsResult = HashpriceBTC.bind(hashpriceBtcAddress).try_decimals();
  if (hashpriceBtcDecimalsResult.reverted) {
    log.warning(
      "HashpriceBTC is unavailable at block {}; metadata initialization will retry on feed updates.",
      [block.number.toString()],
    );
    return null;
  }

  const btcUsdDecimalsResult = AggregatorProxy.bind(btcUsdAddress).try_decimals();
  if (btcUsdDecimalsResult.reverted) {
    log.warning(
      "BTC/USD proxy is unavailable at block {}; metadata initialization will retry on feed updates.",
      [block.number.toString()],
    );
    return null;
  }

  const hashpriceUsdDecimalsResult = AggregatorV3Interface.bind(hashpriceUsdAddress).try_decimals();
  if (hashpriceUsdDecimalsResult.reverted) {
    log.warning(
      "HashpriceUSD is unavailable at block {}; metadata initialization will retry on feed updates.",
      [block.number.toString()],
    );
    return null;
  }

  meta = new HashpriceMetaV2(HASHPRICE_META_ID);
  meta.id = HASHPRICE_META_ID;
  meta.hashpriceBtcAddress = hashpriceBtcAddress;
  meta.hashpriceUsdAddress = hashpriceUsdAddress;
  meta.btcUsdAddress = btcUsdAddress;
  meta.startBlock = context.mustGet("hashpriceStartBlock").toBigInt();
  meta.hashpriceBtcDecimals = hashpriceBtcDecimalsResult.value;
  meta.btcUsdDecimals = btcUsdDecimalsResult.value;
  meta.hashpriceUsdDecimals = hashpriceUsdDecimalsResult.value;
  meta.save();

  log.info("HashpriceMetaV2 set at block {}", [block.number.toString()]);
  return meta;
}
