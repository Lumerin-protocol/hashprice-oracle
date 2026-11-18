/**
 * HashpriceMetaV2 names the feeds the derived series comes from. A graft copies the base's
 * rows, which name the base's contracts, so the first HashpriceBTC update after a graft
 * onto new feeds must record the current ones.
 */
import { Address, BigInt, DataSourceContext, ethereum } from "@graphprotocol/graph-ts";
import {
  afterEach,
  assert,
  clearStore,
  createMockedFunction,
  dataSourceMock,
  describe,
  newMockEvent,
  test,
} from "matchstick-as/assembly/index";
import { HashpriceMeta, HashpriceMetaV2 } from "../generated/schema";
import { loadOrInitializeHashpriceMeta } from "../src/hashpriceMeta";

// The dev feeds before and after the 2026-11-10 oracle redeploy.
const OLD_HASHPRICE_BTC = "0x7b7f9698cadca34f13d6091c4ee34045f97442e7";
const OLD_HASHPRICE_USD = "0x7df07e84e57890f429935946748757758f7964f1";
const HASHPRICE_BTC = "0x6575e5b952822a3df09619763005371d0b95a7d6";
const HASHPRICE_USD = "0xc1b2476b81865dc292136851b322bdf89a3f2b37";
const BTC_USD = "0x37b5e07c59238ad3bb11ac27129387a67f3340b6";
const OLD_START_BLOCK = 44704408;
const START_BLOCK = 57068233;

function useCurrentFeeds(): void {
  const context = new DataSourceContext();
  context.setString("hashpriceUsdAddress", HASHPRICE_USD);
  context.setString("btcUsdAddress", BTC_USD);
  context.setString("hashpriceBtcAddress", HASHPRICE_BTC);
  context.setBigInt("hashpriceStartBlock", BigInt.fromI32(START_BLOCK));
  dataSourceMock.setReturnValues(HASHPRICE_BTC, "base-sepolia", context);
}

function mockDecimals(address: string, decimals: i32): void {
  createMockedFunction(Address.fromString(address), "decimals", "decimals():(uint8)").returns([
    ethereum.Value.fromI32(decimals),
  ]);
}

function mockFeeds(usdDecimals: i32): void {
  mockDecimals(HASHPRICE_BTC, 16);
  mockDecimals(HASHPRICE_USD, usdDecimals);
  mockDecimals(BTC_USD, usdDecimals);
}

function saveDeprecatedMeta(): void {
  const meta = new HashpriceMeta(0);
  meta.hashpriceBtcAddress = Address.fromString(OLD_HASHPRICE_BTC);
  meta.hashpriceUsdAddress = Address.fromString(OLD_HASHPRICE_USD);
  meta.btcUsdAddress = Address.fromString(BTC_USD);
  meta.hashpriceBtcDecimals = 16;
  meta.btcUsdDecimals = 8;
  meta.hashpriceUsdDecimals = 8;
  meta.startBlock = BigInt.fromI32(OLD_START_BLOCK);
  meta.save();
}

function saveMeta(hashpriceBtc: string, hashpriceUsd: string, startBlock: i32): void {
  const meta = new HashpriceMetaV2(0);
  meta.hashpriceBtcAddress = Address.fromString(hashpriceBtc);
  meta.hashpriceUsdAddress = Address.fromString(hashpriceUsd);
  meta.btcUsdAddress = Address.fromString(BTC_USD);
  meta.hashpriceBtcDecimals = 16;
  meta.btcUsdDecimals = 8;
  meta.hashpriceUsdDecimals = 8;
  meta.startBlock = BigInt.fromI32(startBlock);
  meta.save();
}

function block(): ethereum.Block {
  const event = newMockEvent();
  event.block.number = BigInt.fromI32(57114481);
  return event.block;
}

function assertCurrentFeeds(): void {
  assert.fieldEquals("HashpriceMetaV2", "0", "hashpriceBtcAddress", HASHPRICE_BTC);
  assert.fieldEquals("HashpriceMetaV2", "0", "hashpriceUsdAddress", HASHPRICE_USD);
  assert.fieldEquals("HashpriceMetaV2", "0", "btcUsdAddress", BTC_USD);
  assert.fieldEquals("HashpriceMetaV2", "0", "startBlock", START_BLOCK.toString());
  assert.fieldEquals("HashpriceMetaV2", "0", "hashpriceBtcDecimals", "16");
  assert.fieldEquals("HashpriceMetaV2", "0", "btcUsdDecimals", "8");
  assert.fieldEquals("HashpriceMetaV2", "0", "hashpriceUsdDecimals", "8");
}

describe("HashpriceMetaV2 after a graft", () => {
  afterEach(() => {
    clearStore();
  });

  test("a base with only the deprecated row gets a V2 row naming the current feeds", () => {
    useCurrentFeeds();
    mockFeeds(8);
    saveDeprecatedMeta();

    assert.assertNotNull(loadOrInitializeHashpriceMeta(block()));

    assertCurrentFeeds();
    assert.fieldEquals("HashpriceMeta", "0", "hashpriceUsdAddress", OLD_HASHPRICE_USD);
  });

  test("a V2 row naming the base's feeds is rewritten with the current ones", () => {
    useCurrentFeeds();
    mockFeeds(8);
    saveMeta(OLD_HASHPRICE_BTC, OLD_HASHPRICE_USD, OLD_START_BLOCK);

    assert.assertNotNull(loadOrInitializeHashpriceMeta(block()));

    assertCurrentFeeds();
  });

  test("a V2 row naming the current feeds is kept", () => {
    useCurrentFeeds();
    // Different decimals would show up in a re-read row.
    mockFeeds(18);
    saveMeta(HASHPRICE_BTC, HASHPRICE_USD, START_BLOCK);

    assert.assertNotNull(loadOrInitializeHashpriceMeta(block()));

    assert.fieldEquals("HashpriceMetaV2", "0", "hashpriceUsdDecimals", "8");
  });
});
