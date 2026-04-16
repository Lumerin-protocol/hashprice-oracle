import { createHash } from "node:crypto";
import pino from "pino";
import { configFromEnv } from "../config.ts";
import { setSha256 } from "../lib.ts";
import { runKeeper } from "../core/keeper.ts";
import { serializeError } from "../../lib/errSerializer.ts";

setSha256((data) => {
  const hash = createHash("sha256").update(data).digest();
  return new Uint8Array(hash.buffer, hash.byteOffset, hash.byteLength);
});

const config = configFromEnv(process.env as Record<string, string>);

const log = pino({
  level: config.logLevel,
  transport: process.stdout.isTTY
    ? { target: "pino-pretty", options: { colorize: true } }
    : undefined,
});

async function loop(): Promise<never> {
  log.info({ pollIntervalMs: config.pollIntervalMs }, "keeper started");

  while (true) {
    try {
      const result = await runKeeper(config, log);
      log.info(
        { blocksSubmitted: result.blocksSubmitted, oracleHeight: result.oracleHeight },
        "HashpriceBTC oracle is up to date",
      );
    } catch (err) {
      log.error({ err: serializeError(err) }, "tick failed");
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}

loop().catch((err) => {
  log.fatal({ err }, "unrecoverable error");
  process.exit(1);
});
