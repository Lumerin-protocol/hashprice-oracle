/**
 * Self-contained seed generator.
 *
 * Starts Hardhat + graph-node (via Testcontainers), replays SEED_DAYS of
 * Bitcoin/Chainlink history, deploys the subgraph, waits for sync, dumps
 * JSON into contracts/seed/ (and optionally the UI seed dir), then tears down.
 *
 * Docs: indexer/SEED.md
 *
 * Usage:
 *   SEED_DAYS=30 pnpm seed:generate
 */

import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";
import { DockerComposeEnvironment, TestContainers, Wait } from "testcontainers";
import {
  dumpSubgraph,
  UI_SEED_FILES,
  waitForSubgraphSync,
} from "../../contracts/scripts/dump-subgraph.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEXER_DIR = resolve(__dirname, "..");
const CONTRACTS_DIR = resolve(INDEXER_DIR, "../contracts");
const REPO_ROOT = resolve(INDEXER_DIR, "..");
const HARDHAT_RPC = "http://127.0.0.1:8545";
const HARDHAT_PORT = 8545;
const SUBGRAPH_NAME = "hashprice";

/** Chainlink BTC/USD AggregatorProxy on Base mainnet — used only for historical round fetch. */
const BASE_MAINNET_CHAIN_ID = "8453";
const BASE_MAINNET_CHAINLINK_BTC_USD =
  "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F" as const;

const SEED_DAYS = process.env.SEED_DAYS ?? "30";
const UI_SEED_DIR =
  process.env.UI_SEED_DIR ??
  resolve(REPO_ROOT, "../futures-marketplace/ui/src/seed");

function tryLoadEnv(path: string): void {
  try {
    loadEnvFile(path);
  } catch {
    // optional
  }
}

/** Prefer an explicit Base mainnet RPC; otherwise rewrite Alchemy base-sepolia → base-mainnet. */
function resolveBaseMainnetRpc(): string {
  const explicit = process.env.BASE_RPC_URL ?? process.env.CHAINLINK_RPC_URL;
  if (explicit) return explicit;

  const eth = process.env.ETHEREUM_RPC_URL;
  if (!eth) {
    throw new Error(
      "Missing ETHEREUM_RPC_URL (or set BASE_RPC_URL / CHAINLINK_RPC_URL for Base mainnet)",
    );
  }
  if (eth.includes("base-sepolia")) {
    return eth.replaceAll("base-sepolia", "base-mainnet");
  }
  if (eth.includes("base-mainnet") || /\/base([/?]|$)/.test(eth)) {
    return eth;
  }
  throw new Error(
    `ETHEREUM_RPC_URL is not a Base RPC (${eth}). Set BASE_RPC_URL to a Base mainnet endpoint ` +
      `for Chainlink history (feed ${BASE_MAINNET_CHAINLINK_BTC_USD}).`,
  );
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

async function waitForHttpJsonRpc(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (res.ok) {
        const body = (await res.json()) as { result?: string };
        if (body.result) return;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for JSON-RPC at ${url}`);
}

async function ethBlockNumber(url: string): Promise<bigint> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  const body = (await res.json()) as { result: string };
  return BigInt(body.result);
}

function spawnLogged(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; label: string },
): ChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = `[${options.label}] `;
  child.stdout?.on("data", (buf: Buffer) => {
    for (const line of buf.toString().split("\n")) {
      if (line.length) console.log(prefix + line);
    }
  });
  child.stderr?.on("data", (buf: Buffer) => {
    for (const line of buf.toString().split("\n")) {
      if (line.length) console.error(prefix + line);
    }
  });
  return child;
}

function waitForExit(child: ChildProcess, label: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${label} exited with code=${code} signal=${signal}`));
    });
  });
}

async function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; label: string },
): Promise<void> {
  const child = spawnLogged(command, args, options);
  await waitForExit(child, options.label);
}

function killProcessTree(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // already dead
    }
  }
}

async function main(): Promise<void> {
  tryLoadEnv(resolve(REPO_ROOT, ".env"));
  tryLoadEnv(resolve(CONTRACTS_DIR, ".env"));

  for (const key of ["BITCOIN_RPC_URL"]) {
    if (!process.env[key]) {
      throw new Error(`Missing required env var: ${key} (load from repo-root .env)`);
    }
  }

  const chainlinkRpc = resolveBaseMainnetRpc();
  console.log(
    `Chainlink history: chain=${BASE_MAINNET_CHAIN_ID} feed=${BASE_MAINNET_CHAINLINK_BTC_USD}`,
  );
  console.log(`Chainlink RPC host: ${new URL(chainlinkRpc).host}`);

  let hardhat: ChildProcess | undefined;
  let environment: Awaited<ReturnType<DockerComposeEnvironment["up"]>> | undefined;

  try {
    console.log("\n=== 1/6 Starting Hardhat node ===");
    // Bind 0.0.0.0 so Docker (host.docker.internal / host.testcontainers.internal)
    // can reach the JSON-RPC port; default 127.0.0.1 is host-only.
    hardhat = spawn(
      "pnpm",
      ["exec", "hardhat", "node", "--hostname", "0.0.0.0", "--port", String(HARDHAT_PORT)],
      {
        cwd: CONTRACTS_DIR,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    hardhat.stdout?.on("data", (buf: Buffer) => {
      const text = buf.toString();
      if (text.includes("Started HTTP") || text.includes("JSON-RPC")) {
        process.stdout.write(`[hardhat] ${text}`);
      }
    });
    hardhat.stderr?.on("data", (buf: Buffer) => {
      process.stderr.write(`[hardhat] ${buf.toString()}`);
    });
    await waitForHttpJsonRpc(HARDHAT_RPC, 120_000);
    console.log(`Hardhat ready at ${HARDHAT_RPC} (bound 0.0.0.0:${HARDHAT_PORT})`);

    console.log("\n=== 2/6 Starting graph-node stack (Testcontainers) ===");
    // On Docker Desktop, host.docker.internal reaches the host. Hardhat must
    // listen on 0.0.0.0 (set above). exposeHostPorts helps Linux CI where
    // host.docker.internal is absent — compose also maps host-gateway.
    await TestContainers.exposeHostPorts(HARDHAT_PORT);

    const ethNode = `hardhat:http://host.docker.internal:${HARDHAT_PORT}`;
    console.log(`  ethereum provider: ${ethNode}`);

    try {
      environment = await new DockerComposeEnvironment(INDEXER_DIR, "docker-compose.seed.yml")
        .withEnvironment({ SUBGRAPH_ETH_NODE: ethNode })
        .withWaitStrategy("postgres-1", Wait.forHealthCheck())
        .withWaitStrategy("ipfs-1", Wait.forListeningPorts())
        .withWaitStrategy(
          "graph-node-1",
          Wait.forHttp("/", 8000).forStatusCodeMatching((c) => c >= 200 && c < 500),
        )
        .withStartupTimeout(180_000)
        .up();
    } catch (err) {
      // Best-effort: dump graph-node logs from any leftover compose project.
      console.error("\nFailed to start compose environment:", err);
      try {
        const { execSync } = await import("node:child_process");
        const logs = execSync(
          `docker ps -a --filter "name=graph-node" --format '{{.Names}}' | head -5 | while read n; do echo "===== $n ====="; docker logs --tail 80 "$n" 2>&1; done`,
          { encoding: "utf8", shell: "/bin/zsh" },
        );
        console.error(logs);
      } catch {
        // ignore
      }
      throw err;
    }

    // Compose v2 → testcontainers keys containers as `{service}-{replica}`.
    const graphNode = environment.getContainer("graph-node-1");
    const ipfs = environment.getContainer("ipfs-1");
    const graphqlPort = graphNode.getMappedPort(8000);
    const adminPort = graphNode.getMappedPort(8020);
    const ipfsPort = ipfs.getMappedPort(5001);
    const host = graphNode.getHost();

    const subgraphUrl = `http://${host}:${graphqlPort}/subgraphs/name/${SUBGRAPH_NAME}`;
    const adminUrl = `http://${host}:${adminPort}/`;
    const ipfsUrl = `http://${host}:${ipfsPort}`;

    console.log(`  graph-node GraphQL: ${subgraphUrl}`);
    console.log(`  graph-node admin:   ${adminUrl}`);
    console.log(`  ipfs:               ${ipfsUrl}`);

    console.log(`\n=== 3/6 Seeding ${SEED_DAYS} days of history ===`);
    // Clear fixed-height overrides from .env so SEED_DAYS actually applies.
    // Force Base mainnet Chainlink for AnswerUpdated history (not Base Sepolia).
    await run("pnpm", ["seed-history"], {
      cwd: CONTRACTS_DIR,
      env: {
        ...process.env,
        SEED_DAYS,
        BTC_SEED_START: "",
        BTC_SEED_END: "",
        ETH_SEED_START_BLOCK: "",
        CHAIN_ID: BASE_MAINNET_CHAIN_ID,
        CHAINLINK_BTC_USD_ADDRESS: BASE_MAINNET_CHAINLINK_BTC_USD,
        ETHEREUM_RPC_URL: chainlinkRpc,
      },
      label: "seed-history",
    });

    const envLocal = parseEnvFile(resolve(REPO_ROOT, ".env.local"));
    if (!envLocal.HASHPRICE_BTC_ADDRESS || !envLocal.HASHPRICE_START_BLOCK) {
      throw new Error(".env.local missing after seed-history (expected contract addresses)");
    }

    console.log("\n=== 4/6 Building & deploying subgraph ===");
    // Prepare subgraph.yaml from template using seeded addresses.
    const template = readFileSync(resolve(INDEXER_DIR, "subgraph.template.yaml"), "utf8");
    const prepared = template.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, key: string) => {
      const val = envLocal[key] ?? process.env[key];
      if (val === undefined) {
        throw new Error(`Missing env for subgraph template: ${key}`);
      }
      return val;
    });
    writeFileSync(resolve(INDEXER_DIR, "subgraph.yaml"), prepared);

    await run("pnpm", ["codegen"], { cwd: INDEXER_DIR, label: "codegen" });
    await run("pnpm", ["build"], { cwd: INDEXER_DIR, label: "build" });
    await run(
      "pnpm",
      ["exec", "graph", "create", "--node", adminUrl, SUBGRAPH_NAME],
      { cwd: INDEXER_DIR, label: "graph-create" },
    );
    await run(
      "pnpm",
      [
        "exec",
        "graph",
        "deploy",
        "--node",
        adminUrl,
        "--ipfs",
        ipfsUrl,
        "--version-label",
        "0",
        SUBGRAPH_NAME,
      ],
      { cwd: INDEXER_DIR, label: "graph-deploy" },
    );

    console.log("\n=== 5/6 Waiting for subgraph sync ===");
    const tip = await ethBlockNumber(HARDHAT_RPC);
    await waitForSubgraphSync({ subgraphUrl, targetBlock: tip, timeoutMs: 60 * 60_000 });

    console.log("\n=== 6/6 Dumping seed JSON ===");
    const contractsSeedDir = resolve(CONTRACTS_DIR, "seed");
    await dumpSubgraph({ subgraphUrl, outDir: contractsSeedDir });

    if (existsSync(UI_SEED_DIR)) {
      console.log(`\nSyncing UI seed files → ${UI_SEED_DIR}`);
      mkdirSync(UI_SEED_DIR, { recursive: true });
      for (const file of UI_SEED_FILES) {
        const src = resolve(contractsSeedDir, file);
        if (!existsSync(src)) {
          console.warn(`  skip missing ${file}`);
          continue;
        }
        // UI candles only need id/sum/count/timestamp; minify later in UI README.
        copyFileSync(src, resolve(UI_SEED_DIR, file));
        console.log(`  → ${file}`);
      }
    } else {
      console.log(`\nUI seed dir not found (${UI_SEED_DIR}); skipped UI sync`);
    }

    console.log("\n=== Seed generation complete ===");
  } finally {
    console.log("\nTearing down…");
    if (environment) {
      try {
        await environment.down({ timeout: 60_000 });
      } catch (err) {
        console.warn("Failed to tear down Testcontainers:", err);
      }
    }
    killProcessTree(hardhat);
  }
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
