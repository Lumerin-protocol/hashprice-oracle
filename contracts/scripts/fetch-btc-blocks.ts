/**
 * Fetches consecutive Bitcoin block headers, coinbase transactions, and merkle proofs
 * from blockstream.info API and stores them in a JSON fixture file.
 *
 * Usage: npx ts-node scripts/fetch-btc-blocks.ts [startHeight] [count]
 *   startHeight: Bitcoin block height to start from (default: latest - count)
 *   count: number of consecutive blocks to fetch (default: 8)
 *
 * Output: tests/fixtures/btc-blocks.json
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_BASE = "https://blockstream.info/api";
const RATE_LIMIT_MS = 300;

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJSON(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return (await res.text()).trim();
}

async function getBlockHashAtHeight(height: number): Promise<string> {
  return fetchText(`${API_BASE}/block-height/${height}`);
}

async function getBlockHeader(hash: string): Promise<string> {
  return fetchText(`${API_BASE}/block/${hash}/header`);
}

async function getBlock(hash: string): Promise<any> {
  return fetchJSON(`${API_BASE}/block/${hash}`);
}

async function getBlockTxids(hash: string): Promise<string[]> {
  return fetchJSON(`${API_BASE}/block/${hash}/txids`);
}

async function getCoinbaseTxHex(txid: string): Promise<string> {
  return fetchText(`${API_BASE}/tx/${txid}/hex`);
}

async function getTxInfo(txid: string): Promise<any> {
  return fetchJSON(`${API_BASE}/tx/${txid}`);
}

/** Build the Bitcoin merkle tree from an array of txids and return the proof for index 0 (coinbase). */
function buildMerkleProof(txids: string[]): string[] {
  if (txids.length === 0) return [];
  if (txids.length === 1) return [];

  // txids are in display (big-endian) order from the API; convert to internal (little-endian) byte order
  let level: Buffer[] = txids.map((txid) => Buffer.from(txid, "hex").reverse());

  const proof: string[] = [];
  let index = 0;

  while (level.length > 1) {
    // If odd number, duplicate the last element
    if (level.length % 2 !== 0) {
      level.push(level[level.length - 1]);
    }

    // The sibling of index at this level
    const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
    proof.push(level[siblingIndex].toString("hex"));

    // Build next level
    const nextLevel: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const concat = Buffer.concat([level[i], level[i + 1]]);
      const hash = createHash("sha256")
        .update(createHash("sha256").update(concat).digest())
        .digest();
      nextLevel.push(hash);
    }

    index = Math.floor(index / 2);
    level = nextLevel;
  }

  return proof;
}

/** Strip witness data from a raw segwit transaction hex, returning the non-witness serialization. */
function stripWitness(rawHex: string): string {
  const buf = Buffer.from(rawHex, "hex");
  let offset = 0;

  // version (4 bytes)
  const version = buf.subarray(offset, offset + 4);
  offset += 4;

  // Check for segwit marker (0x00) and flag (0x01)
  const marker = buf[offset];
  const flag = buf[offset + 1];
  const isSegwit = marker === 0x00 && flag !== 0x00;

  if (!isSegwit) {
    return rawHex; // already non-witness
  }

  offset += 2; // skip marker + flag

  // Read vin
  const { value: vinCount, size: vinVarSize } = readVarint(buf, offset);
  const vinStart = offset;
  offset += vinVarSize;

  for (let i = 0; i < vinCount; i++) {
    offset += 32 + 4; // prevHash + prevIndex
    const { value: scriptLen, size: scriptVarSize } = readVarint(buf, offset);
    offset += scriptVarSize + Number(scriptLen) + 4; // script + sequence
  }

  // Read vout
  const { value: voutCount, size: voutVarSize } = readVarint(buf, offset);
  offset += voutVarSize;

  for (let i = 0; i < voutCount; i++) {
    offset += 8; // value
    const { value: scriptLen, size: scriptVarSize } = readVarint(buf, offset);
    offset += scriptVarSize + Number(scriptLen);
  }
  const vinVoutEnd = offset;

  // Skip witness data
  for (let i = 0; i < vinCount; i++) {
    const { value: witnessCount, size: wcSize } = readVarint(buf, offset);
    offset += wcSize;
    for (let j = 0; j < witnessCount; j++) {
      const { value: itemLen, size: itemVarSize } = readVarint(buf, offset);
      offset += itemVarSize + Number(itemLen);
    }
  }

  // locktime (4 bytes)
  const locktime = buf.subarray(offset, offset + 4);

  // Reconstruct: version + vin/vout (from vinStart to vinVoutEnd) + locktime
  return Buffer.concat([version, buf.subarray(vinStart, vinVoutEnd), locktime]).toString("hex");
}

function readVarint(buf: Buffer, offset: number): { value: number; size: number } {
  const first = buf[offset];
  if (first < 0xfd) return { value: first, size: 1 };
  if (first === 0xfd) return { value: buf.readUInt16LE(offset + 1), size: 3 };
  if (first === 0xfe) return { value: buf.readUInt32LE(offset + 1), size: 5 };
  return { value: Number(buf.readBigUInt64LE(offset + 1)), size: 9 };
}

function flushBlocks(outPath: string, blocks: any[]) {
  fs.writeFileSync(outPath, JSON.stringify(blocks, null, 2));
}

async function main() {
  const count = parseInt(process.argv[3] || "8", 10);
  let startHeight: number;

  if (process.argv[2]) {
    startHeight = parseInt(process.argv[2], 10);
  } else {
    const tipHash = await fetchText(`${API_BASE}/blocks/tip/hash`);
    const tipBlock = await getBlock(tipHash);
    startHeight = tipBlock.height - count;
    console.log(`Tip height: ${tipBlock.height}, starting from ${startHeight}`);
  }

  const outDir = path.join(__dirname, "..", "tests", "fixtures");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "btc-blocks.json");

  let blocks: any[] = [];
  if (fs.existsSync(outPath)) {
    blocks = JSON.parse(fs.readFileSync(outPath, "utf-8"));
  }
  const fetched = new Set(blocks.map((b: any) => b.height));

  console.log(`Fetching ${count} blocks starting at height ${startHeight}...`);
  if (fetched.size > 0) {
    console.log(`  (${fetched.size} blocks already cached, will skip)`);
  }

  for (let i = 0; i < count; i++) {
    const height = startHeight + i;

    if (fetched.has(height)) {
      console.log(`\n--- Block ${height} --- (cached, skipping)`);
      continue;
    }

    console.log(`\n--- Block ${height} ---`);

    await sleep(RATE_LIMIT_MS);
    const hash = await getBlockHashAtHeight(height);
    console.log(`  hash: ${hash}`);

    await sleep(RATE_LIMIT_MS);
    const rawHeader = await getBlockHeader(hash);
    console.log(`  header: ${rawHeader.substring(0, 40)}...`);

    await sleep(RATE_LIMIT_MS);
    const blockInfo = await getBlock(hash);
    console.log(
      `  nBits: ${blockInfo.bits}, nTx: ${blockInfo.tx_count}, timestamp: ${blockInfo.timestamp}`,
    );

    await sleep(RATE_LIMIT_MS);
    const txids = await getBlockTxids(hash);
    const coinbaseTxid = txids[0];
    console.log(`  coinbase txid: ${coinbaseTxid}`);

    await sleep(RATE_LIMIT_MS);
    const coinbaseRawHex = await getCoinbaseTxHex(coinbaseTxid);
    const coinbaseStripped = stripWitness(coinbaseRawHex);
    console.log(
      `  coinbase raw: ${coinbaseRawHex.length / 2} bytes, stripped: ${coinbaseStripped.length / 2} bytes`,
    );

    await sleep(RATE_LIMIT_MS);
    const coinbaseTxInfo = await getTxInfo(coinbaseTxid);
    const totalOutputValue = coinbaseTxInfo.vout.reduce((sum: number, o: any) => sum + o.value, 0);
    console.log(`  coinbase total output: ${totalOutputValue} sats`);

    const merkleProof = buildMerkleProof(txids);
    console.log(`  merkle proof length: ${merkleProof.length}`);

    blocks.push({
      height,
      hash,
      rawHeader,
      nBits: blockInfo.bits,
      timestamp: blockInfo.timestamp,
      difficulty: blockInfo.difficulty,
      nTx: blockInfo.tx_count,
      previousblockhash: blockInfo.previousblockhash,
      merkle_root: blockInfo.merkle_root,
      coinbase: {
        txid: coinbaseTxid,
        rawHex: coinbaseRawHex,
        rawHexStripped: coinbaseStripped,
        totalOutputValue,
      },
      merkleProof,
    });

    blocks.sort((a: any, b: any) => a.height - b.height);
    flushBlocks(outPath, blocks);
    console.log(`  (flushed ${blocks.length} blocks to disk)`);
  }

  console.log(`\nDone. ${blocks.length} total blocks in ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
