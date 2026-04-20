/**
 * Deploys a local oracle simulation and seeds it with historical data.
 *
 *   - HashpriceBTC  is deployed with BTC_SEED_START as its checkpoint block,
 *                   then receives blocks [BTC_SEED_START+1 … BTC_SEED_END] as
 *                   real coinbase headers + merkle proofs from the Bitcoin RPC.
 *   - BTCUSDMock    receives historical Chainlink AnswerUpdated rounds replayed
 *                   from the production Ethereum chain so timestamps match the
 *                   real feed.
 *
 * The Hardhat node must already be running (`pnpm node` or a previous
 * `pnpm deploy-local` that left a node running). Addresses of the freshly
 * deployed contracts are written to repo-root .env.local so the indexer / keeper
 * can pick them up.
 *
 * Usage:
 *   BTC_SEED_START=945478 BTC_SEED_END=945504 pnpm seed-history
 *
 * Required env vars:
 *   BITCOIN_RPC_URL           Bitcoin Core RPC endpoint
 *   CHAINLINK_BTC_USD_ADDRESS Chainlink BTC/USD proxy address on the production chain
 *   ETHEREUM_RPC_URL          Production Ethereum RPC (to fetch Chainlink history)
 *   CHAIN_ID                  Production chain ID (for Chainlink RPC)
 *   BTC_SEED_START            First Bitcoin block height — used as the
 *                             HashpriceBTC checkpoint; submissions begin at
 *                             BTC_SEED_START + 1.
 *
 * Optional:
 *   BTC_SEED_END              Last Bitcoin block height (default: tip − 6)
 *   ETH_SEED_START_BLOCK      Ethereum block to start Chainlink log query from
 *                             (auto-estimated from BTC_SEED_START block timestamp if omitted)
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import hre, { network } from "hardhat";
import {
  createPublicClient,
  decodeEventLog,
  http,
  parseAbi,
  type AbiEvent,
  type Chain,
} from "viem";
import {
  base,
  baseSepolia,
  arbitrum,
  arbitrumSepolia,
  mainnet,
  hardhat as hardhatChain,
} from "viem/chains";

// ─── Chain registry ───────────────────────────────────────────────────────────

const CHAIN_MAP: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [base.id]: base,
  [baseSepolia.id]: baseSepolia,
  [arbitrum.id]: arbitrum,
  [arbitrumSepolia.id]: arbitrumSepolia,
  [hardhatChain.id]: hardhatChain,
};

// ─── Crypto helpers ───────────────────────────────────────────────────────────

function sha256(data: Uint8Array): Uint8Array {
  const h = createHash("sha256").update(data).digest();
  return new Uint8Array(h.buffer, h.byteOffset, h.byteLength);
}

function dsha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Bitcoin varint ───────────────────────────────────────────────────────────

function readVarint(buf: Uint8Array, offset: number): { value: number; size: number } {
  const first = buf[offset];
  if (first < 0xfd) return { value: first, size: 1 };
  if (first === 0xfd) return { value: buf[offset + 1] | (buf[offset + 2] << 8), size: 3 };
  if (first === 0xfe) {
    return {
      value:
        buf[offset + 1] |
        (buf[offset + 2] << 8) |
        (buf[offset + 3] << 16) |
        (buf[offset + 4] << 24),
      size: 5,
    };
  }
  let val = 0;
  for (let i = 0; i < 6; i++) val += buf[offset + 1 + i] * 2 ** (i * 8);
  return { value: val, size: 9 };
}

// ─── Bitcoin merkle proof ─────────────────────────────────────────────────────

function buildMerkleProof(txids: string[]): string[] {
  if (txids.length <= 1) return [];
  let level = txids.map((id) => {
    const b = hexToBytes(id);
    return b.reverse();
  });
  const proof: string[] = [];
  let index = 0;

  while (level.length > 1) {
    if (level.length % 2 !== 0) level.push(level[level.length - 1]);
    proof.push(bytesToHex(level[index % 2 === 0 ? index + 1 : index - 1]));
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const cat = new Uint8Array(64);
      cat.set(level[i], 0);
      cat.set(level[i + 1], 32);
      next.push(dsha256(cat));
    }
    index = Math.floor(index / 2);
    level = next;
  }
  return proof;
}

// ─── Strip segwit witness ─────────────────────────────────────────────────────

function stripWitness(rawHex: string): string {
  const buf = hexToBytes(rawHex);
  let offset = 0;

  const version = buf.slice(offset, offset + 4);
  offset += 4;

  const isSegwit = buf[offset] === 0x00 && buf[offset + 1] !== 0x00;
  if (!isSegwit) return rawHex;
  offset += 2;

  const vinStart = offset;
  const { value: vinCount, size: vinVarSize } = readVarint(buf, offset);
  offset += vinVarSize;
  for (let i = 0; i < vinCount; i++) {
    offset += 36;
    const { value: sLen, size: sVar } = readVarint(buf, offset);
    offset += sVar + sLen + 4;
  }

  const { value: voutCount, size: voutVarSize } = readVarint(buf, offset);
  offset += voutVarSize;
  for (let i = 0; i < voutCount; i++) {
    offset += 8;
    const { value: sLen, size: sVar } = readVarint(buf, offset);
    offset += sVar + sLen;
  }
  const vinVoutEnd = offset;

  for (let i = 0; i < vinCount; i++) {
    const { value: wCount, size: wVar } = readVarint(buf, offset);
    offset += wVar;
    for (let j = 0; j < wCount; j++) {
      const { value: iLen, size: iVar } = readVarint(buf, offset);
      offset += iVar + iLen;
    }
  }

  const locktime = buf.slice(offset, offset + 4);
  const result = new Uint8Array(4 + (vinVoutEnd - vinStart) + 4);
  result.set(version, 0);
  result.set(buf.slice(vinStart, vinVoutEnd), 4);
  result.set(locktime, 4 + (vinVoutEnd - vinStart));
  return bytesToHex(result);
}

// ─── Bitcoin RPC ──────────────────────────────────────────────────────────────

async function btcRpc<T>(rpcUrl: string, method: string, params: unknown[] = []): Promise<T> {
  const url = new URL(rpcUrl);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (url.username) {
    headers["Authorization"] = `Basic ${btoa(`${url.username}:${url.password}`)}`;
    url.username = "";
    url.password = "";
  }
  const res = await fetch(url.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result: T; error?: { message: string } };
  if (json.error) throw new Error(`Bitcoin RPC: ${json.error.message}`);
  return json.result;
}

interface BtcBlock {
  height: number;
  timestamp: number;
  rawHeader: string;
  coinbaseStripped: string;
  merkleProof: string[];
}

interface BtcHeader {
  hash: string;
  height: number;
  time: number;
  bits: string;
}

async function fetchBtcHeader(rpcUrl: string, height: number): Promise<BtcHeader> {
  const hash = await btcRpc<string>(rpcUrl, "getblockhash", [height]);
  return btcRpc<BtcHeader>(rpcUrl, "getblockheader", [hash, true]);
}

function reverseHex(hex: string): `0x${string}` {
  const clean = hex.replace(/^0x/, "");
  const bytes = clean.match(/.{2}/g);
  if (!bytes) throw new Error("Invalid hex string");
  return `0x${bytes.reverse().join("")}`;
}

// Cache fetched blocks on disk so a restart doesn't re-download everything.
// One file per block keeps writes atomic and avoids re-serializing large arrays.
const BTC_CACHE_DIR = resolve(fileURLToPath(import.meta.url), "../../.cache/btc-blocks");

function btcCachePath(height: number): string {
  return resolve(BTC_CACHE_DIR, `${height}.json`);
}

function readBtcBlockFromCache(height: number): BtcBlock | null {
  const path = btcCachePath(height);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as BtcBlock;
    if (parsed.height === height && parsed.rawHeader && parsed.coinbaseStripped) {
      return parsed;
    }
  } catch {
    // Corrupt cache entry — fall through to refetch.
  }
  return null;
}

function writeBtcBlockToCache(block: BtcBlock): void {
  mkdirSync(BTC_CACHE_DIR, { recursive: true });
  writeFileSync(btcCachePath(block.height), JSON.stringify(block), "utf8");
}

async function fetchBtcBlock(rpcUrl: string, height: number): Promise<BtcBlock> {
  const cached = readBtcBlockFromCache(height);
  if (cached) return cached;

  const hash = await btcRpc<string>(rpcUrl, "getblockhash", [height]);
  const [rawHeader, block] = await Promise.all([
    btcRpc<string>(rpcUrl, "getblockheader", [hash, false]),
    btcRpc<{ tx: string[]; time: number }>(rpcUrl, "getblock", [hash, 1]),
  ]);
  const coinbaseHex = await btcRpc<string>(rpcUrl, "getrawtransaction", [block.tx[0], false]);
  const result: BtcBlock = {
    height,
    timestamp: block.time,
    rawHeader,
    coinbaseStripped: stripWitness(coinbaseHex),
    merkleProof: buildMerkleProof(block.tx),
  };
  writeBtcBlockToCache(result);
  return result;
}

// ─── Chainlink history ────────────────────────────────────────────────────────

const PROXY_ABI = parseAbi([
  "function phaseId() view returns (uint16)",
  "function phaseAggregators(uint16 phase) view returns (address)",
  "function decimals() view returns (uint8)",
]);

const ANSWER_UPDATED_ABI = parseAbi([
  "event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)",
]);

interface ChainlinkRound {
  roundId: bigint;
  price: bigint;
  updatedAt: number;
}

async function fetchChainlinkHistory(
  ethClient: ReturnType<typeof createPublicClient>,
  proxyAddress: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
  chunkSize = 2000,
): Promise<ChainlinkRound[]> {
  const currentPhaseId = await ethClient.readContract({
    address: proxyAddress,
    abi: PROXY_ABI,
    functionName: "phaseId",
  });

  const phases = Array.from({ length: currentPhaseId }, (_, i) => i + 1);
  const phaseAddrs = await Promise.all(
    phases.map(
      (phase) =>
        ethClient.readContract({
          address: proxyAddress,
          abi: PROXY_ABI,
          functionName: "phaseAggregators",
          args: [phase],
        }) as Promise<`0x${string}`>,
    ),
  );

  const ZERO = "0x0000000000000000000000000000000000000000";
  const aggregators = [...new Set(phaseAddrs.filter((a) => a !== ZERO))];
  console.log(`  Chainlink phases: ${currentPhaseId}, aggregators: ${aggregators.length}`);

  const rounds: ChainlinkRound[] = [];
  const seen = new Set<string>();

  for (let from = fromBlock; from <= toBlock; ) {
    const to = from + BigInt(chunkSize) - 1n < toBlock ? from + BigInt(chunkSize) - 1n : toBlock;
    process.stdout.write(`  AnswerUpdated: blocks ${from}–${to} (${rounds.length} so far)\r`);

    const logs = await ethClient.getLogs({
      address: aggregators,
      event: ANSWER_UPDATED_ABI[0],
      fromBlock: from,
      toBlock: to,
    });

    for (const log of logs) {
      const key = `${log.blockNumber}-${log.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const args = log.args as { current: bigint; roundId: bigint; updatedAt: bigint };
      rounds.push({
        roundId: args.roundId,
        price: args.current,
        updatedAt: Number(args.updatedAt),
      });
    }
    from = to + 1n;
  }

  process.stdout.write("\n");
  rounds.sort((a, b) => a.updatedAt - b.updatedAt);
  return rounds;
}

// ─── Ethereum block at timestamp (binary search) ──────────────────────────────

async function findEthBlockAtTimestamp(
  client: ReturnType<typeof createPublicClient>,
  targetTimestamp: number,
): Promise<bigint> {
  const tip = await client.getBlock();
  if (targetTimestamp >= Number(tip.timestamp)) return tip.number;

  // Estimate average block time from last 1000 blocks
  const older = await client.getBlock({ blockNumber: tip.number - 1000n });
  const avgBlockSec = Number(tip.timestamp - older.timestamp) / 1000;
  const blocksBack = Math.ceil((Number(tip.timestamp) - targetTimestamp) / avgBlockSec);
  const estimate = tip.number - BigInt(blocksBack);
  return estimate > 0n ? estimate : 0n;
}

// ─── Hardhat EVM time helper ──────────────────────────────────────────────────

async function setEvmTimestamp(
  client: ReturnType<typeof createPublicClient>,
  timestamp: number,
): Promise<void> {
  await client.request({
    method: "evm_setNextBlockTimestamp",
    params: [`0x${timestamp.toString(16)}`],
  } as unknown as Parameters<typeof client.request>[0]);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function required(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
  return val;
}

function prefixed(hex: string): `0x${string}` {
  return `0x${hex.replace(/^0x/, "")}` as `0x${string}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const RETARGET_INTERVAL = 2016;
const ACCOUNT_0_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");

async function main() {
  const bitcoinRpcUrl = required("BITCOIN_RPC_URL");
  const ethereumRpcUrl = required("ETHEREUM_RPC_URL");
  const chainId = Number(required("CHAIN_ID"));
  const chainlinkProxy = required("CHAINLINK_BTC_USD_ADDRESS") as `0x${string}`;
  const btcSeedStart = Number(required("BTC_SEED_START"));

  // ── Determine Bitcoin block range ─────────────────────────────────────────
  const tipHeight = await btcRpc<number>(bitcoinRpcUrl, "getblockcount");
  const btcSeedEnd = process.env.BTC_SEED_END ? Number(process.env.BTC_SEED_END) : tipHeight - 6;

  if (btcSeedStart >= btcSeedEnd) {
    console.error(`BTC_SEED_START (${btcSeedStart}) >= end (${btcSeedEnd})`);
    process.exit(1);
  }

  // ── Fetch checkpoint block (first block of seed range) + epoch anchor ─────
  console.log("\nFetching Bitcoin checkpoint (first seed block)...");
  const checkpoint = await fetchBtcHeader(bitcoinRpcUrl, btcSeedStart);
  const epochStartHeight = btcSeedStart - (btcSeedStart % RETARGET_INTERVAL);
  const epochHeader =
    epochStartHeight === btcSeedStart
      ? checkpoint
      : await fetchBtcHeader(bitcoinRpcUrl, epochStartHeight);

  const checkpointHashLE = reverseHex(checkpoint.hash);
  const checkpointNBits = parseInt(checkpoint.bits, 16);
  const epochNBits = parseInt(epochHeader.bits, 16);

  console.log("=== BITCOIN CHECKPOINT ===");
  console.log("Height:            ", btcSeedStart);
  console.log("Hash (internal LE):", checkpointHashLE);
  console.log(
    "Timestamp:         ",
    checkpoint.time,
    `(${new Date(checkpoint.time * 1000).toISOString()})`,
  );
  console.log("nBits:             ", `0x${checkpoint.bits}`);
  console.log("Epoch start height:", epochStartHeight);
  console.log(
    "Epoch start ts:    ",
    epochHeader.time,
    `(${new Date(epochHeader.time * 1000).toISOString()})`,
  );
  console.log("Epoch start nBits: ", `0x${epochHeader.bits}`);

  // ── Connect to local Hardhat node + deploy contracts ──────────────────────
  console.log("\nCompiling contracts...");
  await hre.tasks.getTask("compile").run();

  const conn = await network.connect("localhost");
  const { viem } = conn;
  const localPc = await viem.getPublicClient();
  const [owner] = await viem.getWalletClients();

  console.log("\nDeploying HashpriceBTC with checkpoint = first seed block...");
  const hashpriceBTC = await viem.deployContract("HashpriceBTC", [
    checkpointHashLE,
    btcSeedStart,
    checkpoint.time,
    checkpointNBits,
    epochHeader.time,
    epochNBits,
  ]);
  console.log("  Deployed at:", hashpriceBTC.address);

  console.log("Deploying BTCUSDMock...");
  const btcUsdMock = await viem.deployContract("BTCUSDMock", []);
  console.log("  Deployed at:", btcUsdMock.address);

  console.log("Deploying HashpriceUSD...");
  const hashpriceUSD = await viem.deployContract("HashpriceUSD", [
    hashpriceBTC.address as `0x${string}`,
    btcUsdMock.address,
  ]);
  console.log("  Deployed at:", hashpriceUSD.address);

  // Persist addresses so the indexer / keeper can find them.
  if (conn.networkConfig.type === "edr-simulated") {
    throw new Error("EDR simulated networks are not supported — use --network localhost");
  }
  const hashpriceBtcAddress = hashpriceBTC.address as `0x${string}`;
  const btcUsdMockAddress = btcUsdMock.address as `0x${string}`;
  const startBlock = await localPc.getBlockNumber();
  writeEnvLocal({
    CHAIN_ID: conn.networkConfig.chainId?.toString() ?? "31337",
    ETHEREUM_RPC_URL: await conn.networkConfig.url.get(),
    HASHPRICE_BTC_ADDRESS: hashpriceBtcAddress,
    HASHPRICE_USD_ADDRESS: hashpriceUSD.address as `0x${string}`,
    BTC_USD_ADDRESS: btcUsdMockAddress,
    BITCOIN_RPC_URL: bitcoinRpcUrl,
    PRIVATE_KEY: ACCOUNT_0_PRIVATE_KEY,
    SUBGRAPH_ETH_NODE: `hardhat:${await conn.networkConfig.url.get()}`,
    NETWORK: "hardhat",
    HASHPRICE_START_BLOCK: startBlock.toString(),
    HASHPRICE_POLLING_BLOCK_INTERVAL: "1",
  });

  // Snapshot the local chain tip so we can fetch emitted events at the end.
  const seedFromBlock = await localPc.getBlockNumber();

  console.log(`\n=== Seeding history ===`);
  console.log(
    `Owner:          ${owner.account.address}`,
  );
  console.log(
    `Bitcoin blocks: ${btcSeedStart + 1} → ${btcSeedEnd} (${btcSeedEnd - btcSeedStart} blocks; checkpoint at ${btcSeedStart})`,
  );
  console.log(`HashpriceBTC:   ${hashpriceBtcAddress}`);
  console.log(`BTCUSDMock:     ${btcUsdMockAddress}`);

  // ── Fetch Bitcoin blocks to submit (skip checkpoint itself) ───────────────
  // Blocks are cached to disk (.cache/btc-blocks/) so restarts don't re-download.
  console.log(`\nFetching Bitcoin blocks (cache: ${BTC_CACHE_DIR})...`);
  const btcBlocks: BtcBlock[] = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  for (let h = btcSeedStart + 1; h <= btcSeedEnd; h++) {
    const wasCached = readBtcBlockFromCache(h) !== null;
    if (wasCached) cacheHits++;
    else cacheMisses++;
    process.stdout.write(
      `  block ${h} / ${btcSeedEnd}  (cached=${cacheHits} fetched=${cacheMisses})\r`,
    );
    btcBlocks.push(await fetchBtcBlock(bitcoinRpcUrl, h));
  }
  process.stdout.write("\n");
  console.log(`  → ${btcBlocks.length} blocks (${cacheHits} cached, ${cacheMisses} fetched)`);

  // ── Fetch Chainlink BTC/USD history ──────────────────────────────────────
  console.log("\nFetching Chainlink BTC/USD history...");
  const chain = CHAIN_MAP[chainId];
  if (!chain) {
    console.error(`Unsupported chain ID: ${chainId}`);
    process.exit(1);
  }
  const ethClient = createPublicClient({ chain, transport: http(ethereumRpcUrl) });

  const startTimestamp = checkpoint.time;
  const endTimestamp = btcBlocks[btcBlocks.length - 1]?.timestamp ?? checkpoint.time;

  const ethFromBlock = process.env.ETH_SEED_START_BLOCK
    ? BigInt(process.env.ETH_SEED_START_BLOCK)
    : await findEthBlockAtTimestamp(ethClient, startTimestamp);
  const ethToBlock = await ethClient.getBlockNumber();

  console.log(`  Ethereum blocks: ${ethFromBlock} → ${ethToBlock}`);
  const chainlinkRounds = await fetchChainlinkHistory(
    ethClient,
    chainlinkProxy,
    ethFromBlock,
    ethToBlock,
  );

  // Filter to only rounds within the Bitcoin time window
  const filteredRounds = chainlinkRounds.filter(
    (r) => r.updatedAt >= startTimestamp && r.updatedAt <= endTimestamp,
  );
  console.log(`  → ${filteredRounds.length} Chainlink rounds in time window`);

  // ── Merge and sort by timestamp ───────────────────────────────────────────
  type SeedEvent =
    | { kind: "btc"; timestamp: number; block: BtcBlock }
    | { kind: "btcusd"; timestamp: number; round: ChainlinkRound };

  const events: SeedEvent[] = [
    ...btcBlocks.map((b) => ({ kind: "btc" as const, timestamp: b.timestamp, block: b })),
    ...filteredRounds.map((r) => ({ kind: "btcusd" as const, timestamp: r.updatedAt, round: r })),
  ].sort((a, b) => a.timestamp - b.timestamp);

  console.log(`\nReplaying ${events.length} events to local contracts...`);

  // ── Replay ────────────────────────────────────────────────────────────────
  // Read the actual latest EVM timestamp after every mined block so we always
  // have a correct floor — Bitcoin timestamps can go slightly backwards (the
  // protocol only requires them to exceed the median of the last 11 blocks).
  async function currentEvmTs(): Promise<number> {
    const block = await localPc.getBlock({ blockTag: "latest" });
    return Number(block.timestamp);
  }

  let btcCount = 0;
  let usdCount = 0;
  let btcErrors = 0;

  // Collect every log emitted during replay so we can decode them at the end.
  type CapturedLog = {
    address: `0x${string}`;
    topics: readonly `0x${string}`[];
    data: `0x${string}`;
    blockNumber: bigint;
    logIndex: number;
    transactionHash: `0x${string}`;
  };
  const capturedLogs: CapturedLog[] = [];

  for (const ev of events) {
    const evmTs = await currentEvmTs();

    if (ev.kind === "btc") {
      // Clamp: never go below the current EVM tip (Bitcoin allows slight regression).
      const ts = Math.max(ev.timestamp, evmTs + 1);
      await setEvmTimestamp(localPc, ts);

      try {
        const tx = await hashpriceBTC.write.submitBlock([
          prefixed(ev.block.rawHeader),
          prefixed(ev.block.coinbaseStripped),
          ev.block.merkleProof.map(prefixed),
        ]);
        const receipt = await localPc.waitForTransactionReceipt({ hash: tx });
        if (receipt.status !== "success") {
          throw new Error(`submitBlock failed: ${receipt.status}`);
        }
        for (const l of receipt.logs) {
          capturedLogs.push({
            address: l.address as `0x${string}`,
            topics: l.topics as readonly `0x${string}`[],
            data: l.data,
            blockNumber: l.blockNumber,
            logIndex: l.logIndex,
            transactionHash: l.transactionHash,
          });
        }

        btcCount++;
        process.stdout.write(
          `  [btc] block ${ev.block.height} [eth] block ${receipt.blockNumber} ts=${new Date(ts * 1000).toISOString()}  logs=${receipt.logs.length}  (${btcCount}/${btcBlocks.length})\n`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        btcErrors++;
        console.warn(`\n  [btc] block ${ev.block.height} SKIPPED: ${msg.split("\n")[0]}`);
      }
    } else {
      // setRound sets updatedAt explicitly from the Chainlink historical value,
      // so the EVM block.timestamp does not affect BtcUsd.timestamp in the schema.
      // Still pin EVM time forward so subsequent BTC blocks have a valid floor.
      const ts = Math.max(ev.timestamp, evmTs + 1);
      await setEvmTimestamp(localPc, ts);

      const r = ev.round;
      const tx = await btcUsdMock.write.setRound([
        r.roundId,
        r.price,
        BigInt(r.updatedAt),
        BigInt(r.updatedAt),
        r.roundId,
      ]);
      const receipt = await localPc.waitForTransactionReceipt({ hash: tx });
      if (receipt.status !== "success") {
        throw new Error(`setRound failed: ${receipt.status}`);
      }
      for (const l of receipt.logs) {
        capturedLogs.push({
          address: l.address as `0x${string}`,
          topics: l.topics as readonly `0x${string}`[],
          data: l.data,
          blockNumber: l.blockNumber,
          logIndex: l.logIndex,
          transactionHash: l.transactionHash,
        });
      }
      usdCount++;
      process.stdout.write(
        `  [usd] round ${r.roundId} [eth] block ${receipt.blockNumber} ts=${new Date(ts * 1000).toISOString()}  logs=${receipt.logs.length}  (${usdCount}/${filteredRounds.length})\n`,
      );
    }
  }

  console.log("\n");
  console.log("=== Done ===");
  console.log(`  Bitcoin blocks submitted: ${btcCount} (${btcErrors} skipped)`);
  console.log(`  BTC/USD rounds replayed:  ${usdCount}`);

  // ── Event dump ────────────────────────────────────────────────────────────
  // Decode every log we captured from tx receipts during replay so you can
  // sanity-check what the indexer will see.
  const seedToBlock = await localPc.getBlockNumber();
  console.log(
    `\n=== Events emitted (Ethereum blocks ${seedFromBlock + 1n} → ${seedToBlock}, ${capturedLogs.length} raw logs) ===`,
  );

  const EVENT_ABIS: AbiEvent[] = [
    parseAbi([
      "event HashpriceUpdated(uint32 indexed confirmedHeight, int256 hashprice, uint256 avgFees)",
    ])[0],
    parseAbi([
      "event BlockSubmitted(bytes32 indexed blockHash, uint32 indexed height, uint64 fees)",
    ])[0],
    parseAbi(["event ChainReorg(bytes32 indexed newTip, uint32 indexed newHeight)"])[0],
    parseAbi([
      "event DifficultyChanged(uint32 indexed height, uint32 nBits, uint256 difficulty)",
    ])[0],
    parseAbi([
      "event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)",
    ])[0],
  ];

  const counts: Record<string, number> = {};
  type DecodedEntry = {
    log: (typeof capturedLogs)[number];
    eventName: string;
    args: Record<string, unknown>;
  };
  const decoded: DecodedEntry[] = [];
  let undecoded = 0;

  for (const l of capturedLogs) {
    let ok = false;
    for (const abi of EVENT_ABIS) {
      try {
        const d = decodeEventLog({
          abi: [abi],
          data: l.data,
          topics: l.topics as [`0x${string}`, ...`0x${string}`[]],
          strict: true,
        });
        const eventName = d.eventName as string;
        counts[eventName] = (counts[eventName] ?? 0) + 1;
        decoded.push({ log: l, eventName, args: d.args as Record<string, unknown> });
        ok = true;
        break;
      } catch {
        // Not this event, try next.
      }
    }
    if (!ok) undecoded++;
  }

  console.log(`\n  Counts:`);
  for (const name of [
    "BlockSubmitted",
    "HashpriceUpdated",
    "DifficultyChanged",
    "ChainReorg",
    "AnswerUpdated",
  ]) {
    console.log(`    ${name.padEnd(18)} ${counts[name] ?? 0}`);
  }
  if (undecoded > 0) console.log(`    (undecoded)        ${undecoded}`);

  const fmtArgs = (name: string, a: Record<string, unknown>): string => {
    if (name === "BlockSubmitted") {
      return `btc=${a.height} fees=${a.fees} hash=${a.blockHash}`;
    }
    if (name === "HashpriceUpdated") {
      return `confirmedHeight=${a.confirmedHeight} hashprice=${a.hashprice} avgFees=${a.avgFees}`;
    }
    if (name === "DifficultyChanged") {
      const nBits = a.nBits as number;
      return `height=${a.height} nBits=0x${nBits.toString(16)} difficulty=${a.difficulty}`;
    }
    if (name === "ChainReorg") {
      return `newHeight=${a.newHeight} newTip=${a.newTip}`;
    }
    if (name === "AnswerUpdated") {
      const ts = Number(a.updatedAt);
      return `roundId=${a.roundId} price=${a.current} updatedAt=${ts} (${new Date(ts * 1000).toISOString()})`;
    }
    return JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  };

  if (decoded.length > 0) {
    console.log(`\n  Event log:`);
    for (const d of decoded) {
      console.log(
        `    eth=${d.log.blockNumber}  ${d.eventName.padEnd(18)} ${fmtArgs(d.eventName, d.args)}`,
      );
    }
  }
}

function writeEnvLocal(params: Record<string, string>) {
  const lines = [
    "# Generated by contracts/scripts/seed-history.ts.",
    "# Regenerate: cd contracts && pnpm seed-history",
    "# PRIVATE_KEY is Hardhat #0 — local dev only.",
    "",
    ...Object.entries(params).map(([key, value]) => `${key}=${value}`),
    "",
  ];
  const out = resolve(REPO_ROOT, ".env.local");
  writeFileSync(out, `${lines.join("\n")}\n`, "utf8");
  console.log(`Wrote ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
