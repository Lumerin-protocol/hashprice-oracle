/**
 * Deploys the real oracle contracts onto the in-process Hardhat chain and drives them with
 * Bitcoin headers, so the subgraph mapping under test sees genuine logs rather than
 * synthetic events.
 *
 * Artifacts are read straight off disk instead of going through Hardhat's artifact map:
 * the contracts live in a sibling package, and this Hardhat project compiles no Solidity
 * of its own. Run `pnpm compile` in `contracts/` first.
 */
import { readFile } from "node:fs/promises";
import type { NetworkConnection } from "hardhat/types/network";
import { captureViewMocksFromContract } from "matchstick-ts";
import { type Abi, type Address, type Hex, type PublicClient, type WalletClient, parseEventLogs } from "viem";
import { deployContract } from "viem/actions";
import btcBlocks from "../../contracts/tests/fixtures/btc-blocks.json" with { type: "json" };
import {
  blockHash,
  buildHeader,
  getBlockSubsidy,
  mineHeader,
  mineSyntheticBlock,
  nBitsToDifficulty,
  nBitsToTarget,
  reverseHex,
  type SyntheticBlock,
} from "../../contracts/tests/HashpriceBTC/helpers.ts";
import { renderManifest } from "./manifest.ts";

const ARTIFACTS = "../../contracts/artifacts/contracts/";

/** Blocks the real-chain fixture submits before a test starts submitting its own. */
const BOOTSTRAP_BLOCKS = 8;

/** BTC/USD with 8 decimals, roughly the market when the fixture headers were mined. */
export const BTC_USD_PRICE = 85_000n * 10n ** 8n;

/**
 * Synthetic chains use a target of about 2^245, so each header carries about 2,048 hashes
 * of work: enough for a non-trivial hashrate, little enough to mine a week of blocks in a
 * few seconds.
 */
export const SYNTHETIC_NBITS = 0x1f1fffff;

/** Mirrors the mapping's WINDOW_1D, WINDOW_7D and MTP_WINDOW. */
export const WINDOW_1D = 144;
export const WINDOW_7D = 1008;
export const MTP_WINDOW = 11;

export type BtcBlock = (typeof btcBlocks)[number];

export interface Contract {
  address: Address;
  abi: Abi;
}

export interface Deployment {
  oracle: Contract;
  btcUsd: Contract;
  hashpriceUsd: Contract;
  /** EVM block the oracle was deployed in; indexing starts here. */
  startBlock: bigint;
  owner: WalletClient;
  pc: PublicClient;
}

export function hex(s: string): Hex {
  return `0x${s.replace(/^0x/, "")}`;
}

async function artifact(path: string): Promise<{ abi: Abi; bytecode: Hex }> {
  const json = JSON.parse(await readFile(new URL(`${ARTIFACTS}${path}`, import.meta.url), "utf8"));
  return { abi: json.abi as Abi, bytecode: (json.bytecode?.object ?? json.bytecode) as Hex };
}

async function deploy(owner: WalletClient, pc: PublicClient, path: string, args: unknown[]) {
  const { abi, bytecode } = await artifact(path);
  if (owner.account === undefined) throw new Error("wallet client has no account");
  const hash = await deployContract(owner, {
    abi,
    bytecode,
    args,
    account: owner.account,
    chain: owner.chain,
  });
  const receipt = await pc.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`${path} deployment produced no address`);
  return { contract: { address: receipt.contractAddress, abi } as Contract, blockNumber: receipt.blockNumber };
}

export async function write(
  d: Pick<Deployment, "owner" | "pc">,
  contract: Contract,
  functionName: string,
  args: unknown[],
) {
  if (d.owner.account === undefined) throw new Error("wallet client has no account");
  const hash = await d.owner.writeContract({
    address: contract.address,
    abi: contract.abi,
    functionName,
    args,
    account: d.owner.account,
    chain: d.owner.chain,
  });
  return d.pc.waitForTransactionReceipt({ hash });
}

/** Moves the EVM clock forward to `timestamp`; never backwards, since fixtures share one chain. */
async function advanceClockTo(conn: NetworkConnection, timestamp: number): Promise<void> {
  const pc = await conn.viem.getPublicClient();
  const latest = await pc.getBlock();
  if (BigInt(timestamp) > latest.timestamp) {
    const tc = await conn.viem.getTestClient();
    await tc.setNextBlockTimestamp({ timestamp: BigInt(timestamp) });
  }
}

async function latestTimestamp(conn: NetworkConnection): Promise<number> {
  const pc = await conn.viem.getPublicClient();
  return Number((await pc.getBlock()).timestamp);
}

/**
 * Deploys HashpriceBTC from `checkpoint`, a BTCUSDMock acting as both the BTC/USD proxy and
 * its aggregator, and HashpriceUSD over the two, then publishes one BTC/USD answer.
 */
async function deployFeeds(
  conn: NetworkConnection,
  checkpoint: { hash: string; height: number; timestamp: number; nBits: number },
  oracleArtifact = "HashpriceBTC.sol/HashpriceBTC.json",
): Promise<Deployment> {
  const [owner] = await conn.viem.getWalletClients();
  const pc = await conn.viem.getPublicClient();

  const { contract: oracle, blockNumber: startBlock } = await deploy(owner, pc, oracleArtifact, [
    hex(checkpoint.hash),
    checkpoint.height,
    checkpoint.timestamp,
    checkpoint.nBits,
    checkpoint.timestamp,
    checkpoint.nBits,
  ]);
  const { contract: btcUsd } = await deploy(owner, pc, "mocks/BTCUSDMock.sol/BTCUSDMock.json", []);
  const { contract: hashpriceUsd } = await deploy(owner, pc, "HashpriceUSD.sol/HashpriceUSD.json", [
    oracle.address,
    btcUsd.address,
  ]);

  const d: Deployment = { oracle, btcUsd, hashpriceUsd, startBlock, owner, pc };
  await write(d, btcUsd, "setPrice", [BTC_USD_PRICE]);
  return d;
}

/**
 * Real mainnet headers: deploys at `btcBlocks[0]` and submits the next BOOTSTRAP_BLOCKS in
 * one batch, so the chain is past CONFIRMATION_DEPTH before a test submits its own blocks.
 */
export async function deployOracleFixture(conn: NetworkConnection) {
  const checkpoint = btcBlocks[0];
  await advanceClockTo(conn, btcBlocks[btcBlocks.length - 1].timestamp + 3600);
  const d = await deployFeeds(conn, { ...checkpoint, hash: reverseHex(checkpoint.hash) });

  const bootstrap = btcBlocks.slice(1, 1 + BOOTSTRAP_BLOCKS);
  await submitRealBatch(d, checkpoint.height, bootstrap);

  return { deployment: d, checkpoint, bootstrap, remaining: btcBlocks.slice(1 + BOOTSTRAP_BLOCKS) };
}

/** Real mainnet headers: deploys at `btcBlocks[0]` and submits nothing. */
export async function deployEmptyOracleFixture(conn: NetworkConnection) {
  const checkpoint = btcBlocks[0];
  await advanceClockTo(conn, btcBlocks[btcBlocks.length - 1].timestamp + 3600);
  const d = await deployFeeds(conn, { ...checkpoint, hash: reverseHex(checkpoint.hash) });
  return { deployment: d, checkpoint, blocks: btcBlocks.slice(1) };
}

/** Header timestamps of a synthetic chain: irregular gaps of 5 to 15 seconds. */
function syntheticGap(i: number): number {
  return 5 + ((i * 7919) % 11);
}

/** A synthetic checkpoint at height 100 and its deployment, ahead of every other fixture's clock. */
async function deploySyntheticGenesis(conn: NetworkConnection) {
  const genesisHeight = 100;
  const baseTs = (await latestTimestamp(conn)) + 86_400;
  const genesis = mineHeader(
    buildHeader({ prevHash: "00".repeat(32), timestamp: baseTs, nBits: SYNTHETIC_NBITS }),
    SYNTHETIC_NBITS,
  );
  const genesisHash = blockHash(genesis);
  return { genesisHeight, genesisHash, baseTs };
}

/** Mines `count` synthetic blocks on top of `prevHash`, the fee rising 100 sats per block. */
export function mineSyntheticChain(
  prevHash: string,
  startHeight: number,
  count: number,
  startTs: number,
  baseFee: bigint,
): SyntheticBlock[] {
  const chain: SyntheticBlock[] = [];
  let prev = prevHash;
  let ts = startTs;
  for (let i = 0; i < count; i++) {
    ts += syntheticGap(i);
    const b = mineSyntheticBlock(prev, startHeight + i, ts, SYNTHETIC_NBITS, baseFee + BigInt(i) * 100n);
    chain.push(b);
    prev = b.hash;
  }
  return chain;
}

// Synthetic difficulty rounds down to 0, which the real oracle skips without pricing.
const SYNTHETIC_ORACLE = "HashpriceBTCTestHarness.sol/HashpriceBTCTestHarness.json";

/** Synthetic chain long enough to fill the 7-day hashrate window, submitted in batches. */
export async function deployLongSyntheticFixture(conn: NetworkConnection) {
  const { genesisHeight, genesisHash, baseTs } = await deploySyntheticGenesis(conn);
  const chain = mineSyntheticChain(genesisHash, genesisHeight + 1, WINDOW_7D + MTP_WINDOW + 2, baseTs, 10_000n);
  await advanceClockTo(conn, chain[chain.length - 1].timestamp + 3600);
  const d = await deployFeeds(conn, {
    hash: genesisHash,
    height: genesisHeight,
    timestamp: baseTs,
    nBits: SYNTHETIC_NBITS,
  }, SYNTHETIC_ORACLE);

  for (let i = 0; i < chain.length; i += 100) {
    await submitSyntheticBatch(d, genesisHeight + i, chain.slice(i, i + 100));
  }
  return { deployment: d, genesisHeight, chain };
}

/** Synthetic genesis plus a 5-block canonical chain, and a 6-block fork from the same genesis. */
export async function deployReorgFixture(conn: NetworkConnection) {
  const { genesisHeight, genesisHash, baseTs } = await deploySyntheticGenesis(conn);
  const canonical = mineSyntheticChain(genesisHash, genesisHeight + 1, 5, baseTs, 1_000n);
  const fork = mineSyntheticChain(genesisHash, genesisHeight + 1, 6, baseTs, 50_000n);
  await advanceClockTo(conn, fork[fork.length - 1].timestamp + 3600);
  const d = await deployFeeds(conn, {
    hash: genesisHash,
    height: genesisHeight,
    timestamp: baseTs,
    nBits: SYNTHETIC_NBITS,
  }, SYNTHETIC_ORACLE);
  await submitSyntheticBatch(d, genesisHeight, canonical);
  return { deployment: d, genesisHeight, canonical, fork };
}

export async function submitRealBatch(d: Deployment, ancestorHeight: number, blocks: BtcBlock[]) {
  return write(d, d.oracle, "submitBlocks", [
    ancestorHeight,
    hex(blocks.map((b) => b.rawHeader).join("")),
    blocks.map((b) => hex(b.coinbase.rawHexStripped)),
    blocks.map((b) => b.merkleProof.map(hex)),
  ]);
}

export async function submitSyntheticBatch(d: Deployment, ancestorHeight: number, blocks: SyntheticBlock[]) {
  return write(d, d.oracle, "submitBlocks", [
    ancestorHeight,
    hex(blocks.map((b) => b.rawHeader).join("")),
    blocks.map((b) => hex(b.coinbaseTx)),
    blocks.map(() => [] as Hex[]),
  ]);
}

/** Submits one real header, mining exactly one BlockSubmitted and one HashpriceUpdated log. */
export async function submitBlock(d: Deployment, block: BtcBlock) {
  return write(d, d.oracle, "submitBlock", [
    hex(block.rawHeader),
    hex(block.coinbase.rawHexStripped),
    block.merkleProof.map(hex),
  ]);
}

/**
 * Points the indexer at `d`: renders the test manifest with its addresses, binds the oracle
 * and the BTC/USD aggregator, captures the view calls the mapping makes, and buffers every
 * log since the deployment block so the `once` handler and the full block history replay.
 */
export async function indexDeployment(conn: NetworkConnection, d: Deployment): Promise<void> {
  renderManifest({
    HASHPRICE_BTC_ADDRESS: d.oracle.address,
    HASHPRICE_USD_ADDRESS: d.hashpriceUsd.address,
    BTC_USD_ADDRESS: d.btcUsd.address,
    HASHPRICE_START_BLOCK: d.startBlock,
  });

  // The mock's Ownable event has no handler in the template; leave it out of the decoder.
  const aggregatorAbi = d.btcUsd.abi.filter((item) => !(item.type === "event" && item.name === "OwnershipTransferred"));

  conn.matchstick.bind("HashpriceBTC", d.oracle.address, d.oracle.abi);
  conn.matchstick.bind("ChainlinkAggregator", d.btcUsd.address, aggregatorAbi);
  await conn.matchstick.captureViewMocks();
  conn.matchstick.addCallMocks(await captureViewMocksFromContract(d.pc, d.hashpriceUsd.abi, d.hashpriceUsd.address));
  await conn.matchstick.ingest({ fromBlock: d.startBlock });
}

/** Replays every buffered log through the mapping and returns the store. */
export function indexSnapshot(conn: NetworkConnection) {
  return conn.matchstick.indexSnapshot([]);
}

/** Decoded oracle events emitted since `fromBlock`, in log order. */
export async function oracleEvents(d: Deployment, fromBlock: bigint = d.startBlock) {
  const logs = await d.pc.getLogs({ address: d.oracle.address, fromBlock, toBlock: "latest" });
  // biome-ignore lint/suspicious/noExplicitAny: parsed arg shapes differ per event
  return parseEventLogs({ abi: d.oracle.abi, logs }) as any[];
}

export async function read<T>(d: Deployment, contract: Contract, functionName: string, args: unknown[] = []) {
  return (await d.pc.readContract({ address: contract.address, abi: contract.abi, functionName, args })) as T;
}

// ─── Mirrors of the mapping's arithmetic, for expected values ──────

/** Expected hashes for one header: 2^256 / (target + 1), as the mapping computes it. */
export function blockWork(nBits: number): bigint {
  return 2n ** 256n / (nBitsToTarget(nBits) + 1n);
}

export function difficultyOf(nBits: number): bigint {
  return nBitsToDifficulty(nBits);
}

export function feesOf(height: number, coinbaseValue: bigint): bigint {
  const subsidy = getBlockSubsidy(height);
  return coinbaseValue > subsidy ? coinbaseValue - subsidy : 0n;
}

export interface HeaderTimes {
  height: number;
  timestamp: number;
  nBits: number;
}

/** Median of the timestamps of `height` and its 10 ancestors in `blocks`. */
export function medianTimePast(blocks: HeaderTimes[], height: number): bigint {
  const window = blocks.filter((b) => b.height <= height && b.height > height - MTP_WINDOW);
  if (window.length !== MTP_WINDOW) throw new Error(`median time past at ${height} needs ${MTP_WINDOW} blocks`);
  const sorted = window.map((b) => BigInt(b.timestamp)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor(MTP_WINDOW / 2)];
}

/** Work over (end − window, end] divided by the median-time-past elapsed over it. */
export function windowHashrate(blocks: HeaderTimes[], end: number, window: number): bigint {
  let work = 0n;
  for (const b of blocks) {
    if (b.height > end - window && b.height <= end) work += blockWork(b.nBits);
  }
  return work / (medianTimePast(blocks, end) - medianTimePast(blocks, end - window));
}
