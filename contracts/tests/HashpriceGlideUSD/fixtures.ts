import type { NetworkConnection } from "hardhat/types";

/** About the fee average when the proposal was written: a halving step of about 49.5%. */
export const FEES = 3_150_000n;
/** Network difficulty, about 150 T. */
export const DIFFICULTY = 150_000_000_000_000n;
/** BTC/USD $100,000 (8 decimals). With the values above the index is about $42 per PH/s/day. */
export const BTC_USD = 10_000_000_000_000n;
/** Bitcoin block subsidy at height 0, in satoshis. */
const INITIAL_SUBSIDY = 5_000_000_000n;

/** A height about 208 days before the 2028 halving, before its glide. */
export const START_HEIGHT = 1_020_000;

export async function deployGlideUSDFixture(conn: NetworkConnection) {
  const { viem, networkHelpers } = conn;
  const pc = await viem.getPublicClient();

  const btc = await viem.deployContract("HashpriceBTCMock", []);
  const btcUsd = await viem.deployContract("BTCUSDMock", []);
  await btc.write.setBlock([START_HEIGHT, FEES, DIFFICULTY]);
  await btcUsd.write.setPrice([BTC_USD]);

  const hashpriceUSD = await viem.deployContract("HashpriceUSD", [btc.address, btcUsd.address]);
  const glideUSD = await viem.deployContract("HashpriceGlideUSD", [hashpriceUSD.address]);

  const c = {
    halvingInterval: await glideUSD.read.HALVING_INTERVAL(),
    glideBlocks: await glideUSD.read.GLIDE_BLOCKS(),
    glideEndBlocks: await glideUSD.read.GLIDE_END_BLOCKS(),
    targetBlockTime: await glideUSD.read.TARGET_BLOCK_TIME(),
    minWindow: await glideUSD.read.MIN_HALVING_WINDOW(),
    windowBps: await glideUSD.read.HALVING_WINDOW_BPS(),
    bps: await glideUSD.read.BPS(),
    wad: await glideUSD.read.WAD(),
  };

  /** Relays a block at `height` with the given fee average, as the real oracle would price it. */
  async function relay(height: bigint | number, fees = FEES, difficulty = DIFFICULTY) {
    await btc.write.setBlock([Number(height), fees, difficulty]);
  }

  async function index() {
    const [, answer] = await hashpriceUSD.read.latestRoundData();
    return answer;
  }

  async function updatedAt() {
    const [, , , at] = await hashpriceUSD.read.latestRoundData();
    return at;
  }

  function subsidyAt(height: bigint) {
    return INITIAL_SUBSIDY >> (height / c.halvingInterval);
  }

  function nextHalving(height: bigint) {
    return (height / c.halvingInterval + 1n) * c.halvingInterval;
  }

  /** The index with the next halving's subsidy step applied, from the same inputs. */
  function postHalving(idx: bigint, height: bigint, fees = FEES) {
    return (idx * (subsidyAt(nextHalving(height)) + fees)) / (subsidyAt(height) + fees);
  }

  /** First height of the glide before the halving at `halving`. */
  function glideStart(halving: bigint) {
    return halving - c.glideBlocks - c.glideEndBlocks;
  }

  return {
    viem,
    pc,
    networkHelpers,
    contracts: { btc, btcUsd, hashpriceUSD, glideUSD },
    c,
    relay,
    index,
    updatedAt,
    subsidyAt,
    nextHalving,
    postHalving,
    glideStart,
  };
}

/** Asserts `actual` is within `tolerance` of `expected` (rounding of the contract's divisions). */
export function assertClose(actual: bigint, expected: bigint, tolerance = 1n, message?: string) {
  const diff = actual > expected ? actual - expected : expected - actual;
  if (diff > tolerance) {
    throw new Error(
      `${message ?? "values differ"}: expected ${expected} ± ${tolerance}, got ${actual} (off by ${diff})`,
    );
  }
}
