import type { Logger } from "pino";

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
export const DOWN_WARN_MS = 120_000;

/**
 * Alchemy's Bitcoin WebSocket (`subscribeNewBlock`). Each event is only a wake-up: the relay
 * tick reads the tip and blocks over RPC. A reorg arrives as one event per new-chain block.
 * Reconnects with backoff; warns while down for more than DOWN_WARN_MS.
 */
export function subscribeBitcoinBlocks(
  url: string,
  log: Logger,
  onBlock: (height: number) => void,
): { close(): void } {
  const wsLog = log.child({ component: "btc-ws" });
  let ws: WebSocket | undefined;
  let closed = false;
  let backoffMs = MIN_BACKOFF_MS;
  let downSince: number | undefined = Date.now();
  let reconnectTimer: NodeJS.Timeout | undefined;

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  };

  const connect = () => {
    const socket = new WebSocket(url);
    ws = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify({ id: "1", method: "subscribeNewBlock", params: {} }));
    };
    socket.onmessage = (event) => {
      let data: { subscribed?: boolean; height?: number; hash?: string; error?: { message?: string } };
      try {
        data = JSON.parse(String(event.data))?.data ?? {};
      } catch {
        return;
      }
      if (data.subscribed === true) {
        const downSec = downSince === undefined ? 0 : Math.round((Date.now() - downSince) / 1000);
        wsLog.info({ event: "btc_ws_up", downSec }, "subscribed to Bitcoin blocks");
        downSince = undefined;
        backoffMs = MIN_BACKOFF_MS;
        return;
      }
      if (data.error) {
        wsLog.warn({ message: data.error.message }, "Bitcoin block subscription error; reconnecting");
        socket.close();
        return;
      }
      if (typeof data.height === "number") {
        wsLog.debug({ height: data.height, hash: data.hash }, "Bitcoin block event");
        onBlock(data.height);
      }
    };
    // The error event carries no detail; a close event always follows.
    socket.onerror = () => {};
    socket.onclose = (event) => {
      if (closed || ws !== socket) return;
      downSince ??= Date.now();
      wsLog.warn({ code: event.code, retryInMs: backoffMs }, "Bitcoin block subscription closed");
      scheduleReconnect();
    };
  };

  const downCheck = setInterval(() => {
    if (downSince !== undefined && Date.now() - downSince > DOWN_WARN_MS) {
      wsLog.warn(
        { event: "btc_ws_down", downSec: Math.round((Date.now() - downSince) / 1000) },
        "Bitcoin block subscription down; relying on the fallback poll",
      );
    }
  }, 60_000);
  downCheck.unref();

  connect();

  return {
    close() {
      closed = true;
      clearInterval(downCheck);
      clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}
