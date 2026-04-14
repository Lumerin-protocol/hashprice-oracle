import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import hre, { network } from "hardhat";
import { parseUnits } from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");

const RETARGET_INTERVAL = 2016;
const MIN_CONFIRMATIONS = 6;
const ACCOUNT_0_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

async function main() {
  await hre.tasks.getTask("compile").run();

  const runPromise = hre.tasks.getTask("node").run({ hostname: "0.0.0.0" });

  const bitcoinRpcUrl = process.env.BITCOIN_RPC_URL;
  if (!bitcoinRpcUrl) {
    throw new Error("BITCOIN_RPC_URL is required — set it in ../.env");
  }

  console.log("Fetching Bitcoin tip from node...");
  const info = (await bitcoinRpc(bitcoinRpcUrl, "getblockchaininfo")) as { blocks: number };
  const tipHeight = info.blocks;
  const checkpointHeight = tipHeight - MIN_CONFIRMATIONS;
  console.log(`  Node tip: ${tipHeight}, using block ${checkpointHeight} as checkpoint\n`);

  const header = await fetchBlockHeader(bitcoinRpcUrl, checkpointHeight);
  const epochStartHeight = checkpointHeight - (checkpointHeight % RETARGET_INTERVAL);
  let epochStartTimestamp: number;
  let epochStartBits: string;

  if (epochStartHeight === checkpointHeight) {
    epochStartTimestamp = header.time;
    epochStartBits = header.bits;
  } else {
    console.log(`  Fetching epoch start block ${epochStartHeight}...`);
    const epochHeader = await fetchBlockHeader(bitcoinRpcUrl, epochStartHeight);
    epochStartTimestamp = epochHeader.time;
    epochStartBits = epochHeader.bits;
  }

  const blockHashLE = reverseHex(header.hash);
  const nBits = parseInt(header.bits, 16);
  const epochNBits = parseInt(epochStartBits, 16);

  console.log("=== BITCOIN CHECKPOINT ===");
  console.log("Height:            ", checkpointHeight);
  console.log("Hash (internal LE):", blockHashLE);
  console.log(
    "Timestamp:         ",
    header.time,
    `(${new Date(header.time * 1000).toISOString()})`,
  );
  console.log("nBits:             ", `0x${header.bits}`);
  console.log("Epoch start height:", epochStartHeight);
  console.log(
    "Epoch start ts:    ",
    epochStartTimestamp,
    `(${new Date(epochStartTimestamp * 1000).toISOString()})`,
  );
  console.log("Epoch start nBits: ", `0x${epochStartBits}`);
  console.log();

  console.log("Starting local deployment...\n");
  await hre.tasks.getTask("build").run({});

  await new Promise((r) => setTimeout(r, 5000));

  const conn = await network.connect("localhost");
  const { viem } = conn;
  const [owner] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();

  console.log("Deploying HashpriceBTC...");
  const hashpriceBTC = await viem.deployContract("HashpriceBTC", [
    blockHashLE,
    checkpointHeight,
    header.time,
    nBits,
    epochStartTimestamp,
    epochNBits,
  ]);
  console.log("  Deployed at:", hashpriceBTC.address);
  console.log();

  const btcUsdOracle = await viem.deployContract("BTCPriceOracleMock", []);
  console.log("  Deployed at:", btcUsdOracle.address);
  console.log();
  await btcUsdOracle.write.setPrice([parseUnits("70000", 8)]);

  const hashpriceUSD = await viem.deployContract("HashpriceUSD", [
    hashpriceBTC.address as `0x${string}`,
    btcUsdOracle.address,
  ]);
  console.log("  Deployed at:", hashpriceUSD.address);
  console.log();

  const startBlock = await pc.getBlockNumber();

  if (conn.networkConfig.type === "edr-simulated") {
    throw new Error("EDR simulated networks are not supported for local deployment");
  }

  writeEnvLocal({
    CHAIN_ID: conn.networkConfig.chainId?.toString() ?? "31337",
    ETHEREUM_RPC_URL: await conn.networkConfig.url.get(),
    HASHPRICE_BTC_ADDRESS: hashpriceBTC.address as `0x${string}`,
    HASHPRICE_USD_ADDRESS: hashpriceUSD.address as `0x${string}`,
    BTC_USD_ADDRESS: btcUsdOracle.address as `0x${string}`,
    BITCOIN_RPC_URL: bitcoinRpcUrl,
    PRIVATE_KEY: ACCOUNT_0_PRIVATE_KEY,
    SUBGRAPH_ETH_NODE: `hardhat:${await conn.networkConfig.url.get()}`,
    NETWORK: "hardhat",
    HASHPRICE_START_BLOCK: startBlock.toString(),
    HASHPRICE_POLLING_BLOCK_INTERVAL: "1",
  });

  console.log();
  console.log("=== DEPLOYMENT SUMMARY ===");
  console.log("Network:            localhost (chain ID 31337)");
  console.log("Owner:             ", owner.account.address);
  console.log("HashpriceBTC:      ", hashpriceBTC.address);
  console.log("HashpriceUSD:      ", hashpriceUSD.address);
  console.log("BTC/USD Oracle:    ", btcUsdOracle.address);
  console.log("Bitcoin checkpoint:", checkpointHeight);
  console.log();

  await runPromise;
}

main();

interface BlockHeader {
  height: number;
  time: number;
  bits: string;
  hash: string;
}

async function bitcoinRpc(rpcUrl: string, method: string, params: unknown[] = []) {
  const url = new URL(rpcUrl);
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (url.username) {
    const credentials = Buffer.from(`${url.username}:${url.password}`).toString("base64");
    headers.Authorization = `Basic ${credentials}`;
    url.username = "";
    url.password = "";
  }

  const res = await fetch(url.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result: unknown; error?: { message: string } };
  if (json.error) throw new Error(`Bitcoin RPC error: ${json.error.message}`);
  return json.result;
}

function reverseHex(hex: string): `0x${string}` {
  const clean = hex.replace(/^0x/, "");
  const bytes = clean.match(/.{2}/g);
  if (!bytes) throw new Error("Invalid hex string");
  return `0x${bytes.reverse().join("")}`;
}

async function fetchBlockHeader(rpcUrl: string, height: number): Promise<BlockHeader> {
  const hash = (await bitcoinRpc(rpcUrl, "getblockhash", [height])) as string;
  return (await bitcoinRpc(rpcUrl, "getblockheader", [hash, true])) as BlockHeader;
}

function writeEnvLocal(params: Record<string, string>) {
  const lines = [
    "# Generated by contracts/scripts/deploy-local.ts (key names match keeper .env.example).",
    "# Regenerate: cd contracts && pnpm deploy-local",
    "# PRIVATE_KEY is Hardhat #0 — local dev only.",
    "",
    ...Object.entries(params).map(([key, value]) => `${key}=${value}`),
    "",
  ];

  const out = resolve(REPO_ROOT, ".env.local");
  writeFileSync(out, `${lines.join("\n")}\n`, "utf8");
  console.log("Wrote repo root .env.local →", out);
}
