import { configFromEnv } from "../config.ts";
import { setSha256 } from "../lib.ts";
import { runKeeper, type KeeperResult } from "../core/keeper.ts";

/**
 * Minimal pino-compatible logger for Cloudflare Workers.
 * CF Workers have no fs or streams, so we use console.* directly.
 */
function createWorkerLogger(level: string) {
  const levels: Record<string, number> = {
    trace: 10,
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
    fatal: 60,
  };
  const minLevel = levels[level] ?? 30;

  function shouldLog(lvl: number): boolean {
    return lvl >= minLevel;
  }

  function makeLog(lvl: number, name: string) {
    return (objOrMsg: unknown, ...args: unknown[]) => {
      if (!shouldLog(lvl)) return;
      if (typeof objOrMsg === "string") {
        console.log(JSON.stringify({ level: lvl, msg: objOrMsg }));
      } else {
        const msg = typeof args[0] === "string" ? (args.shift() as string) : "";
        console.log(JSON.stringify({ level: lvl, ...objOrMsg as object, msg }));
      }
    };
  }

  return {
    trace: makeLog(10, "trace"),
    debug: makeLog(20, "debug"),
    info: makeLog(30, "info"),
    warn: makeLog(40, "warn"),
    error: makeLog(50, "error"),
    fatal: makeLog(60, "fatal"),
    child: (_bindings: Record<string, unknown>) => createWorkerLogger(level),
    flush: () => {},
    level,
  };
}

/**
 * SHA-256 using Web Crypto (synchronous in CF Workers via the non-standard
 * crypto.subtle.digestSync or polyfilled with the standard sha256).
 *
 * Since the Bitcoin merkle proof needs synchronous hashing, and CF Workers
 * don't expose a sync SHA-256, we use a pure-JS fallback.
 */
function sha256Sync(data: Uint8Array): Uint8Array {
  // CF Workers environment provides crypto.subtle but only async.
  // For the merkle proof (small data), we use a compact JS SHA-256.
  return jsSha256(data);
}

function jsSha256(data: Uint8Array): Uint8Array {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const len = data.length;
  const bitLen = len * 8;
  const padded = new Uint8Array(((len + 9 + 63) & ~63));
  padded.set(data);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, bitLen, false);

  const w = new Uint32Array(64);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = ror(e, 6) ^ ror(e, 11) ^ ror(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ror(a, 2) ^ ror(a, 13) ^ ror(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;

      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }

    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  const result = new Uint8Array(32);
  const rv = new DataView(result.buffer);
  rv.setUint32(0, h0, false); rv.setUint32(4, h1, false);
  rv.setUint32(8, h2, false); rv.setUint32(12, h3, false);
  rv.setUint32(16, h4, false); rv.setUint32(20, h5, false);
  rv.setUint32(24, h6, false); rv.setUint32(28, h7, false);
  return result;
}

function ror(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

interface Env {
  BITCOIN_RPC_URL: string;
  ETHEREUM_RPC_URL: string;
  CHAIN_ID: string;
  HASHPRICE_BTC_ADDRESS: string;
  PRIVATE_KEY: string;
  LOG_LEVEL?: string;
  MAX_BATCH_SIZE?: string;
}

export default {
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    setSha256(sha256Sync);
    const config = configFromEnv(env as unknown as Record<string, string>);
    const log = createWorkerLogger(config.logLevel) as any;

    const promise = runKeeper(config, log).then(
      (result) => log.info(result, "keeper run completed"),
      (err: unknown) => log.error({ err }, "keeper run failed"),
    );
    ctx.waitUntil(promise);
  },

  async fetch(
    _request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    setSha256(sha256Sync);
    const config = configFromEnv(env as unknown as Record<string, string>);
    const log = createWorkerLogger(config.logLevel) as any;

    try {
      const result = await runKeeper(config, log);
      return new Response(JSON.stringify(result), {
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  },
};

interface ScheduledEvent {
  scheduledTime: number;
  cron: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
