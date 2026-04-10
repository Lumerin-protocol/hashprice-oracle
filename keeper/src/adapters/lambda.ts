import { createHash } from "node:crypto";
import pino from "pino";
import { configFromEnv } from "../config.ts";
import { setSha256 } from "../lib.ts";
import { runKeeper, type KeeperResult } from "../core/keeper.ts";

setSha256((data) => {
  const hash = createHash("sha256").update(data).digest();
  return new Uint8Array(hash.buffer, hash.byteOffset, hash.byteLength);
});

export async function handler(): Promise<{
  statusCode: number;
  body: string;
}> {
  const config = configFromEnv(process.env as Record<string, string>);
  const log = pino({ level: config.logLevel });

  try {
    const result = await runKeeper(config, log);
    log.info(result, "keeper run completed");
    log.flush();
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    log.error({ err }, "keeper run failed");
    log.flush();
    return { statusCode: 500, body: JSON.stringify({ error: String(err) }) };
  }
}
