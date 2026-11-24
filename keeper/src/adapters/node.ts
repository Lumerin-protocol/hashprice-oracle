import { createHash } from "node:crypto";
import { createServer } from "node:http";
import pino from "pino";
import { configFromEnv } from "../config.ts";
import { setSha256 } from "../lib.ts";
import { Relay } from "../core/keeper.ts";
import { serializeError } from "../../lib/errSerializer.ts";
import { subscribeBitcoinBlocks } from "./btcBlocks.ts";

setSha256((data) => {
  const hash = createHash("sha256").update(data).digest();
  return new Uint8Array(hash.buffer, hash.byteOffset, hash.byteLength);
});

/** /health fails when the loop has made no progress for this long; ECS then replaces the task. */
const HEALTH_STALE_MS = 180_000;

const config = configFromEnv(process.env as Record<string, string>);

const log = pino({
  level: config.logLevel,
  serializers: { err: serializeError },
  transport: process.stdout.isTTY
    ? { target: "pino-pretty", options: { colorize: true } }
    : undefined,
});

let lastProgressAt = Date.now();
const relay = new Relay(config, log, {
  onHeartbeat: () => {
    lastProgressAt = Date.now();
  },
});

let running = false;
let rerun = false;

/** Ticks never overlap; a trigger during a tick runs one more tick after it. */
async function tick(reason: string): Promise<void> {
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  try {
    let trigger = reason;
    do {
      rerun = false;
      const startedAt = Date.now();
      try {
        const result = await relay.tick();
        log.info(
          { event: "tick", trigger, durationMs: Date.now() - startedAt, ...result },
          "HashpriceBTC oracle is up to date",
        );
      } catch (err) {
        log.error({ event: "tick_error", trigger, err }, "tick failed");
      }
      lastProgressAt = Date.now();
      trigger = "rerun";
    } while (rerun);
  } finally {
    running = false;
  }
}

createServer((req, res) => {
  if (req.url !== "/health") {
    res.writeHead(404).end();
    return;
  }
  const staleMs = Date.now() - lastProgressAt;
  res
    .writeHead(staleMs < HEALTH_STALE_MS ? 200 : 503, { "content-type": "application/json" })
    .end(JSON.stringify({ lastProgressSec: Math.round(staleMs / 1000) }));
}).listen(config.healthPort);

log.info(
  { pollIntervalMs: config.pollIntervalMs, subscription: Boolean(config.bitcoinWsUrl), healthPort: config.healthPort },
  "keeper started",
);

if (config.bitcoinWsUrl) {
  subscribeBitcoinBlocks(config.bitcoinWsUrl, log, () => void tick("btc-block"));
}
setInterval(() => void tick("poll"), config.pollIntervalMs);
void tick("startup");
