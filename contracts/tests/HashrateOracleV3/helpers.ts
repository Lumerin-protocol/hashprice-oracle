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

/** Build a raw 80-byte header hex (no 0x) from components */
export function buildHeader(opts: {
  prevHashLE: string;
  timestamp: number;
  nBits: number;
  version?: number;
  merkleRoot?: string;
  nonce?: number;
}): string {
  const version = Buffer.alloc(4);
  version.writeUint32LE(opts.version ?? 0x20000000);
  // header stores prevHash in internal byte order (reversed from LE display)
  const prevHash = reverseHex(opts.prevHashLE);
  const merkleRoot = opts.merkleRoot ?? "00".repeat(32);
  const ts = Buffer.alloc(4);
  ts.writeUint32LE(opts.timestamp);
  const nBits = Buffer.alloc(4);
  nBits.writeUint32LE(opts.nBits);
  const nonce = Buffer.alloc(4);
  nonce.writeUint32LE(opts.nonce ?? 0);
  return (
    version.toString("hex") +
    prevHash +
    merkleRoot +
    ts.toString("hex") +
    nBits.toString("hex") +
    nonce.toString("hex")
  );
}

/** Compute the LE block hash of a raw 80-byte header (same as the contract does) */
export function blockHashLE(rawHeader: string): string {
  return reverseHex(dsha256(rawHeader));
}

/** Set the prevBlockHash field (bytes 4-36) in a raw header */
export function setPrevHash(rawHeader: string, prevHashLE: string): string {
  // prevBlockHash is stored in internal byte order (reversed) in the raw header
  return mutateHeader(rawHeader, 4, reverseHex(prevHashLE));
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
