/**
 * Fetches Bitcoin block data (headers, coinbase txs, merkle proofs) via
 * a Bitcoin Core RPC node and writes to a JSON fixture file.
 *
 * Fetches from tip backwards by default so the fixture always contains the
 * most recent blocks. Merges with any existing data and skips cached heights.
 *
 * Usage:
 *   node --env-file=../.env scripts/fetch-fixtures.ts [count=10] [--from HEIGHT]
 *
 * Examples:
 *   pnpm fetch-fixtures              # 10 most recent blocks
 *   pnpm fetch-fixtures -- 20        # 20 most recent blocks
 *   pnpm fetch-fixtures -- --from 890000  # 10 blocks starting at 890000
 *   pnpm fetch-fixtures -- 20 --from 890000
 *
 * Requires BITCOIN_RPC_URL env var.
 *
 * Output: fixtures/btc-blocks.json
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BitcoinRpc, buildMerkleProof, setSha256, stripWitness } from "../src/lib.ts";

setSha256((data) => {
  const hash = createHash("sha256").update(data).digest();
  return new Uint8Array(hash.buffer, hash.byteOffset, hash.byteLength);
});

interface BlockFixture {
  height: number;
  hash: string;
  rawHeader: string;
  nBits: string;
  timestamp: number;
  difficulty: number;
  nTx: number;
  previousblockhash: string;
  merkle_root: string;
  coinbase: {
    txid: string;
    rawHex: string;
    rawHexStripped: string;
    totalOutputValue: number;
  };
  merkleProof: string[];
}

async function fetchBlock(rpc: BitcoinRpc, height: number): Promise<BlockFixture> {
  const hash = await rpc.getBlockHash(height);
  console.log(`  hash: ${hash}`);

  const rawHeader = await rpc.getBlockHeader(hash, false);
  const header = await rpc.getBlockHeader(hash, true);
  console.log(`  nBits: ${header.bits}, nTx: ${header.nTx}, timestamp: ${header.time}`);

  const block = await rpc.getBlock(hash);
  const coinbaseTxid = block.tx[0];

  const rawHex = await rpc.getRawTransaction(coinbaseTxid);
  const rawHexStripped = stripWitness(rawHex);
  console.log(`  coinbase: ${rawHex.length / 2} bytes raw, ${rawHexStripped.length / 2} bytes stripped`);

  const txVerbose = await rpc.getRawTransactionVerbose(coinbaseTxid);
  const totalOutputValue = txVerbose.vout.reduce((sum, o) => sum + Math.round(o.value * 1e8), 0);
  console.log(`  coinbase total output: ${totalOutputValue} sats`);

  const merkleProof = buildMerkleProof(block.tx);
  console.log(`  merkle proof: ${merkleProof.length} hashes`);

  return {
    height,
    hash,
    rawHeader,
    nBits: header.bits,
    timestamp: header.time,
    difficulty: header.difficulty,
    nTx: header.nTx,
    previousblockhash: header.previousblockhash,
    merkle_root: header.merkleroot,
    coinbase: { txid: coinbaseTxid, rawHex, rawHexStripped, totalOutputValue },
    merkleProof,
  };
}

function parseArgs(argv: string[]): { count: number; from?: number } {
  const args = argv.slice(2);
  let count = 10;
  let from: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from" && args[i + 1]) {
      from = parseInt(args[++i], 10);
    } else if (!args[i].startsWith("-")) {
      count = parseInt(args[i], 10);
    }
  }
  if (Number.isNaN(count) || count <= 0) {
    console.error("Invalid count. Usage: fetch-fixtures [count] [--from HEIGHT]");
    process.exit(1);
  }
  return { count, from };
}

async function main() {
  const rpcUrl = process.env["BITCOIN_RPC_URL"];
  if (!rpcUrl) {
    console.error("BITCOIN_RPC_URL env var is required");
    process.exit(1);
  }
  const rpc = new BitcoinRpc(rpcUrl);
  const { count, from } = parseArgs(process.argv);

  let startHeight: number;
  if (from !== undefined) {
    startHeight = from;
  } else {
    const tipHeight = await rpc.getBlockCount();
    startHeight = tipHeight - count + 1;
    console.log(`Tip: ${tipHeight}, fetching ${count} blocks from ${startHeight}`);
  }

  const outDir = path.join(import.meta.dirname, "..", "fixtures");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "btc-blocks.json");

  let blocks: BlockFixture[] = [];
  if (fs.existsSync(outPath)) {
    blocks = JSON.parse(fs.readFileSync(outPath, "utf-8"));
  }
  const cached = new Set(blocks.map((b) => b.height));

  console.log(`Fetching ${count} blocks starting at height ${startHeight}...`);
  if (cached.size > 0) {
    console.log(`  (${cached.size} blocks already cached, will skip)`);
  }

  for (let i = 0; i < count; i++) {
    const height = startHeight + i;

    if (cached.has(height)) {
      console.log(`\n--- Block ${height} --- (cached)`);
      continue;
    }

    console.log(`\n--- Block ${height} ---`);
    const block = await fetchBlock(rpc, height);
    blocks.push(block);

    blocks.sort((a, b) => a.height - b.height);
    fs.writeFileSync(outPath, JSON.stringify(blocks, null, 2));
    console.log(`  (flushed ${blocks.length} blocks to ${outPath})`);
  }

  console.log(`\nDone. ${blocks.length} total blocks in ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
