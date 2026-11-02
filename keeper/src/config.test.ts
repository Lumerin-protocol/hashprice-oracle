import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { configFromEnv } from "./config.ts";

const baseEnv = {
  CHAIN_ID: "8453",
  BITCOIN_RPC_URL: "http://localhost:8332",
  ETHEREUM_RPC_URL: "http://localhost:8545",
  HASHPRICE_BTC_ADDRESS: "0x0000000000000000000000000000000000000001",
  PRIVATE_KEY: `0x${"11".repeat(32)}`,
};

describe("configFromEnv", () => {
  it("waits for 4 receipt confirmations when KEEPER_CONFIRMATIONS is unset", () => {
    assert.equal(configFromEnv(baseEnv).confirmations, 4);
  });

  it("uses KEEPER_CONFIRMATIONS when set", () => {
    assert.equal(configFromEnv({ ...baseEnv, KEEPER_CONFIRMATIONS: "2" }).confirmations, 2);
  });
});
