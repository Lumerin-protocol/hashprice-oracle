import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { subscribeBitcoinBlocks } from "./btcBlocks.ts";

const log = pino({ level: "silent" });

/** Opens on demand and never closes by itself, like a socket stuck on a dead server. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  sent: string[] = [];
  closed = false;

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }
}

describe("N68 — Bitcoin block subscription", () => {
  const realWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    FakeSocket.instances = [];
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  });

  afterEach(() => {
    mock.timers.reset();
    globalThis.WebSocket = realWebSocket;
  });

  it("reconnects when a socket opens but never confirms the subscription", () => {
    const sub = subscribeBitcoinBlocks("wss://btc.test", log, () => {});
    const first = FakeSocket.instances[0];
    assert.ok(first);
    first.onopen?.();
    assert.equal(first.sent.length, 1);

    for (let s = 0; s < 120; s++) mock.timers.tick(1_000);

    assert.equal(first.closed, true);
    assert.ok(FakeSocket.instances.length >= 2, `sockets ${FakeSocket.instances.length}`);
    sub.close();
  });
});
