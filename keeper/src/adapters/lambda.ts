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

/** Stop waiting on an unmined tx before the 120 s Lambda timeout; the next run replaces it. */
const WAIT_BUDGET_MS = 90_000;

export async function handler(): Promise<{
  statusCode: number;
  body: string;
}> {
  const config = configFromEnv(process.env as Record<string, string>);
  const log = pino({ level: config.logLevel, serializers: { err: serializeError } });

  try {
    const result = await runKeeper(config, log, { deadline: Date.now() + WAIT_BUDGET_MS });
    log.info(result, "keeper run completed");
    log.flush();
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    log.error({ err }, "keeper run failed");
    log.flush();
    return { statusCode: 500, body: JSON.stringify({ error: serializeError(err).message }) };
  }
}
