import crypto from "node:crypto";

export const hex = (s: string): `0x${string}` => `0x${s.replace(/^0x/, "")}`;

export function getBlockSubsidy(height: number): bigint {
  const halvings = Math.floor(height / 210_000);
  if (halvings >= 64) return 0n;
  return 5_000_000_000n >> BigInt(halvings);
}

export function nBitsToTarget(nBits: number): bigint {
  const exponent = BigInt(nBits >> 24);
  const coefficient = BigInt(nBits & 0x7fffff);
  if (exponent <= 3n) {
    return coefficient >> (8n * (3n - exponent));
  }
  return coefficient << (8n * (exponent - 3n));
}

export function nBitsToDifficulty(nBits: number): bigint {
  const target = nBitsToTarget(nBits);
  const diff1Target = 0x00000000ffff0000000000000000000000000000000000000000000000000000n;
  return diff1Target / target;
}

/**
 * Mutate a raw 80-byte header (hex string without 0x) at a given byte offset.
 * Returns a new hex string with the bytes replaced.
 */
export function mutateHeader(rawHeader: string, byteOffset: number, newBytes: string): string {
  const hexOffset = byteOffset * 2;
  return rawHeader.slice(0, hexOffset) + newBytes + rawHeader.slice(hexOffset + newBytes.length);
}

/** Write a uint32 LE into a hex string at the given byte offset */
export function writeUint32LE(rawHeader: string, byteOffset: number, value: number): string {
  const buf = Buffer.alloc(4);
  buf.writeUint32LE(value);
  return mutateHeader(rawHeader, byteOffset, buf.toString("hex"));
}

/** Read a uint32 LE from a hex string at the given byte offset */
export function readUint32LE(rawHeader: string, byteOffset: number): number {
  const buf = Buffer.from(rawHeader.slice(byteOffset * 2, byteOffset * 2 + 8), "hex");
  return buf.readUint32LE(0);
}

/** Double-SHA256 of a hex string (no 0x prefix) — returns bytes32 hex without 0x */
export function dsha256(hexStr: string): string {
  const buf = Buffer.from(hexStr, "hex");
  const first = crypto.createHash("sha256").update(buf).digest();
  const second = crypto.createHash("sha256").update(first).digest();
  return second.toString("hex");
}

/** Reverse bytes of a hex string (no 0x prefix) */
export function reverseHex(hexStr: string): string {
  return Buffer.from(hexStr, "hex").reverse().toString("hex");
}

export const EASY_NBITS = 0x207fffff;
export const HARDER_NBITS = 0x1e07fffe;

// Choose nBits that straddle the integer boundary where floor(2^24 / coeff) jumps from 2 to 3.
//   coeff = 5_592_406 (0x555556): floor(2^24 / 5592406) = 2  → work = 2, ~2 expected hashes
//   coeff = 5_592_405 (0x555555): floor(2^24 / 5592405) = 3  → work = 3, ~3 expected hashes
// Adjacent coefficients → |Δtarget| = 2^232, tolerance = target/1000 ≈ 5592 × 2^232 → retarget passes.
export const EPOCH_NBITS = 0x20555556; // work = 2 per block, mines in ~2 hashes
export const HARDER_EPOCH_NBITS = 0x20555555; // work = 3 per block, mines in ~3 hashes
export const RETARGET_EXPECTED_TIMESPAN = 2016 * 10 * 60;

/** Build a raw 80-byte header hex (no 0x) from components */
export function buildHeader(opts: {
  prevHash: string;
  timestamp: number;
  nBits: number;
  version?: number;
  merkleRoot?: string;
  nonce?: number;
}): string {
  const version = Buffer.alloc(4);
  version.writeUint32LE(opts.version ?? 0x20000000);
  const merkleRoot = opts.merkleRoot ?? "00".repeat(32);
  const ts = Buffer.alloc(4);
  ts.writeUint32LE(opts.timestamp);
  const nBits = Buffer.alloc(4);
  nBits.writeUint32LE(opts.nBits);
  const nonce = Buffer.alloc(4);
  nonce.writeUint32LE(opts.nonce ?? 0);
  return (
    version.toString("hex") +
    opts.prevHash +
    merkleRoot +
    ts.toString("hex") +
    nBits.toString("hex") +
    nonce.toString("hex")
  );
}

/** Compute the raw block hash of a header (same as the contract's dsha256) */
export function blockHash(rawHeader: string): string {
  return dsha256(rawHeader);
}

/** Set the prevBlockHash field (bytes 4-36) in a raw header */
export function setPrevHash(rawHeader: string, prevHash: string): string {
  return mutateHeader(rawHeader, 4, prevHash);
}

/**
 * Set nBits to trivial difficulty and brute-force a valid nonce.
 * With target ≈ 2^255 (~50% of hashes pass), this finds a solution almost instantly.
 * Use to test validation layers that run after PoW (timestamp, difficulty).
 */
export function mineHeader(rawHeader: string, nBits = EASY_NBITS): string {
  let header = writeUint32LE(rawHeader, 72, nBits);
  const target = nBitsToTarget(nBits);

  for (let nonce = 0; nonce <= 0xffffffff; nonce++) {
    header = writeUint32LE(header, 76, nonce);
    const hashReversed = reverseHex(dsha256(header));
    if (BigInt(`0x${hashReversed}`) <= target) {
      return header;
    }
  }
  throw new Error("Failed to mine block");
}

// ─── Synthetic block builders ─────────────────────────────────────
//
// Shared by the reorg, event and buffer tests. Real mainnet headers live in
// tests/fixtures/btc-blocks.json and are reached through fixtures.ts instead;
// these are for chains that have to be shaped a particular way.

/** Minimal coinbase tx with a single output paying `outputValue`. */
export function buildCoinbaseTx(outputValue: bigint): string {
  const valueBuf = Buffer.alloc(8);
  valueBuf.writeBigUInt64LE(outputValue);
  return [
    "01000000",
    "01",
    "00".repeat(32),
    "ffffffff",
    "04",
    "deadbeef",
    "ffffffff",
    "01",
    valueBuf.toString("hex"),
    "01",
    "51",
    "00000000",
  ].join("");
}

export interface SyntheticBlock {
  rawHeader: string;
  coinbaseTx: string;
  hash: string;
  height: number;
  timestamp: number;
  nBits: number;
  /** Total coinbase output — what `BlockSubmitted` reports. */
  coinbaseValue: bigint;
}

/**
 * Mine one synthetic block. The coinbase pays `subsidy(height) + fees` unless
 * `coinbaseValue` overrides it — pass a value below the subsidy to model a miner burning
 * part of its reward, the case where the contract's fee figure saturates to zero.
 */
export function mineSyntheticBlock(
  prevHash: string,
  height: number,
  timestamp: number,
  nBits: number,
  fees: bigint,
  coinbaseValue?: bigint,
): SyntheticBlock {
  const total = coinbaseValue ?? getBlockSubsidy(height) + fees;
  const coinbaseTx = buildCoinbaseTx(total);
  const rawHeader = buildHeader({
    prevHash,
    timestamp,
    nBits,
    merkleRoot: dsha256(coinbaseTx),
  });
  const minedHeader = mineHeader(rawHeader, nBits);
  return {
    rawHeader: minedHeader,
    coinbaseTx,
    hash: blockHash(minedHeader),
    height,
    timestamp,
    nBits,
    coinbaseValue: total,
  };
}

/** Mine a chain of synthetic blocks. Different `baseFee` values produce distinct chains. */
export function mineChain(
  tipHash: string,
  startHeight: number,
  count: number,
  baseTimestamp: number,
  nBits: number,
  baseFee: bigint,
): SyntheticBlock[] {
  const chain: SyntheticBlock[] = [];
  let prev = tipHash;
  for (let i = 0; i < count; i++) {
    const b = mineSyntheticBlock(
      prev,
      startHeight + i,
      baseTimestamp + (i + 1) * 600,
      nBits,
      baseFee + BigInt(i) * 100n,
    );
    chain.push(b);
    prev = b.hash;
  }
  return chain;
}

/** Pack blocks into the (headers, coinbaseTxs, merkleProofs) triple `submitBlocks` takes. */
export function formatBatch(blocks: SyntheticBlock[]) {
  return {
    headers: hex(blocks.map((b) => b.rawHeader).join("")),
    coinbaseTxs: blocks.map((b) => hex(b.coinbaseTx)),
    merkleProofs: blocks.map(() => [] as `0x${string}`[]),
  };
}
