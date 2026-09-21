// ─── Bitcoin JSON-RPC client ────────────────────────────────────────

export class BitcoinRpc {
  private readonly rpcUrl: string;
  private reqId = 0;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
  }

  async getBlockCount(): Promise<number> {
    return this.call<number>("getblockcount");
  }

  async getBlockHash(height: number): Promise<string> {
    return this.call<string>("getblockhash", [height]);
  }

  /** @param verbose false = hex header, true = JSON object */
  async getBlockHeader(hashOrHeight: string, verbose: false): Promise<string>;
  async getBlockHeader(hashOrHeight: string, verbose: true): Promise<RpcBlockHeader>;
  async getBlockHeader(hashOrHeight: string, verbose: boolean): Promise<string | RpcBlockHeader> {
    return this.call("getblockheader", [hashOrHeight, verbose]);
  }

  /** verbosity 1 = JSON with txid list */
  async getBlock(hash: string): Promise<RpcBlock> {
    return this.call<RpcBlock>("getblock", [hash, 1]);
  }

  async getRawTransaction(txid: string): Promise<string> {
    return this.call<string>("getrawtransaction", [txid, false]);
  }

  async getRawTransactionVerbose(txid: string): Promise<RpcTransaction> {
    return this.call<RpcTransaction>("getrawtransaction", [txid, true]);
  }

  private async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const url = new URL(this.rpcUrl);
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    if (url.username) {
      headers["Authorization"] = `Basic ${btoa(`${url.username}:${url.password}`)}`;
      url.username = "";
      url.password = "";
    }

    const res = await fetch(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: this.reqId++, method, params }),
    });

    const text = await res.text();
    let json: { result: T; error?: { message: string } };
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Failed to parse RPC response for ${method} (HTTP ${res.status}): ${text.substring(0, 500)}`);
    }
    if (!res.ok || json.error) {
      throw new Error(json.error?.message ?? `RPC error for ${method}: HTTP ${res.status}`);
    }
    return json.result;
  }
}

export interface RpcBlockHeader {
  hash: string;
  confirmations: number;
  height: number;
  version: number;
  merkleroot: string;
  time: number;
  mediantime: number;
  nonce: number;
  bits: string;
  difficulty: number;
  chainwork: string;
  nTx: number;
  previousblockhash: string;
  nextblockhash?: string;
}

export interface RpcBlock {
  hash: string;
  height: number;
  time: number;
  difficulty: number;
  nTx: number;
  bits: string;
  previousblockhash: string;
  merkleroot: string;
  tx: string[];
}

export interface RpcTransaction {
  txid: string;
  vout: { value: number; n: number }[];
}

// ─── SHA-256 injection ──────────────────────────────────────────────

/**
 * Synchronous SHA-256 injected by each runtime adapter.
 * Node/Lambda use `node:crypto`, CF Workers use a pure-JS implementation.
 */
let _sha256: (data: Uint8Array) => Uint8Array;

export function setSha256(fn: (data: Uint8Array) => Uint8Array): void {
  _sha256 = fn;
}

export function dsha256(data: Uint8Array): Uint8Array {
  return _sha256(_sha256(data));
}

// ─── Byte helpers ───────────────────────────────────────────────────

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

export function reverseBytes(bytes: Uint8Array): Uint8Array {
  const reversed = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    reversed[i] = bytes[bytes.length - 1 - i];
  }
  return reversed;
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

// ─── Bitcoin varint ─────────────────────────────────────────────────

export function readVarint(buf: Uint8Array, offset: number): { value: number; size: number } {
  const first = buf[offset];
  if (first < 0xfd) return { value: first, size: 1 };
  if (first === 0xfd) {
    return { value: buf[offset + 1] | (buf[offset + 2] << 8), size: 3 };
  }
  if (first === 0xfe) {
    return {
      value: buf[offset + 1] | (buf[offset + 2] << 8) | (buf[offset + 3] << 16) | (buf[offset + 4] << 24),
      size: 5,
    };
  }
  let val = 0;
  for (let i = 0; i < 6; i++) {
    val += buf[offset + 1 + i] * 2 ** (i * 8);
  }
  return { value: val, size: 9 };
}

// ─── Merkle proof (coinbase = index 0) ──────────────────────────────

export function buildMerkleProof(txids: string[]): string[] {
  if (txids.length <= 1) return [];

  let level: Uint8Array[] = txids.map((txid) => reverseBytes(hexToBytes(txid)));
  const proof: string[] = [];
  let index = 0;

  while (level.length > 1) {
    if (level.length % 2 !== 0) {
      level.push(level[level.length - 1]);
    }

    const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
    proof.push(bytesToHex(level[siblingIndex]));

    const nextLevel: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      nextLevel.push(dsha256(concatBytes(level[i], level[i + 1])));
    }

    index = Math.floor(index / 2);
    level = nextLevel;
  }

  return proof;
}

// ─── Strip segwit witness from raw tx ───────────────────────────────

export function stripWitness(rawHex: string): string {
  const buf = hexToBytes(rawHex);
  let offset = 0;

  const version = buf.slice(offset, offset + 4);
  offset += 4;

  const marker = buf[offset];
  const flag = buf[offset + 1];
  const isSegwit = marker === 0x00 && flag !== 0x00;

  if (!isSegwit) return rawHex;

  offset += 2;

  const vinStart = offset;
  const { value: vinCount, size: vinVarSize } = readVarint(buf, offset);
  offset += vinVarSize;

  for (let i = 0; i < vinCount; i++) {
    offset += 32 + 4;
    const { value: scriptLen, size: scriptVarSize } = readVarint(buf, offset);
    offset += scriptVarSize + scriptLen + 4;
  }

  const { value: voutCount, size: voutVarSize } = readVarint(buf, offset);
  offset += voutVarSize;

  for (let i = 0; i < voutCount; i++) {
    offset += 8;
    const { value: scriptLen, size: scriptVarSize } = readVarint(buf, offset);
    offset += scriptVarSize + scriptLen;
  }
  const vinVoutEnd = offset;

  for (let i = 0; i < vinCount; i++) {
    const { value: witnessCount, size: wcSize } = readVarint(buf, offset);
    offset += wcSize;
    for (let j = 0; j < witnessCount; j++) {
      const { value: itemLen, size: itemVarSize } = readVarint(buf, offset);
      offset += itemVarSize + itemLen;
    }
  }

  const locktime = buf.slice(offset, offset + 4);

  const result = concatBytes(
    concatBytes(version, buf.slice(vinStart, vinVoutEnd)),
    locktime,
  );
  return bytesToHex(result);
}
