import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { configFromEnv } from "./config.ts";
import { redactUrls } from "../lib/errSerializer.ts";

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

  it("N14: waits for 4 confirmations when KEEPER_CONFIRMATIONS is empty", () => {
    assert.equal(configFromEnv({ ...baseEnv, KEEPER_CONFIRMATIONS: "" }).confirmations, 4);
  });

  it("N64: subscribes on the Alchemy Bitcoin RPC host over wss", () => {
    const config = configFromEnv({
      ...baseEnv,
      BITCOIN_RPC_URL: "https://bitcoin-mainnet.g.alchemy.com/v2/test-key",
    });
    assert.equal(config.bitcoinWsUrl, "wss://bitcoin-mainnet.g.alchemy.com/v2/test-key");
  });

  it("N64: only polls when the Bitcoin RPC is not Alchemy and BITCOIN_WS_URL is unset", () => {
    assert.equal(configFromEnv(baseEnv).bitcoinWsUrl, undefined);
  });
});

describe("redactUrls", () => {
  it("N64: keeps RPC keys and credentials out of logged errors", () => {
    const msg =
      'HTTP request failed. URL: https://base-mainnet.g.alchemy.com/v2/secret-key Body: {"x":1} ws wss://u:p@node.example/path';
    const out = redactUrls(msg);
    assert.doesNotMatch(out, /secret-key|u:p|\/path/);
    assert.match(out, /https:\/\/base-mainnet\.g\.alchemy\.com\/<redacted>/);
  });
});
