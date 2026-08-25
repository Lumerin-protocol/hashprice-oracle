/**
 * Deploys the real HashpriceBTC oracle onto the in-process Hardhat chain and
 * replays Bitcoin headers into it, so the subgraph mapping under test is driven
 * by genuine `HashpriceUpdated` logs rather than synthetic events.
 *
 * The artifact is read straight off disk instead of going through Hardhat's
 * artifact map: the contracts live in a sibling package, and this Hardhat
 * project intentionally compiles no Solidity of its own.
 */
import { readFile } from "node:fs/promises";
import type { NetworkConnection } from "hardhat/types/network";
import type { Abi, Address, Hex, PublicClient, WalletClient } from "viem";
import { deployContract } from "viem/actions";
import btcBlocks from "../../contracts/tests/fixtures/btc-blocks.json" with { type: "json" };
import { nBitsToDifficulty, reverseHex } from "../../contracts/tests/HashpriceBTC/helpers.ts";

const ARTIFACT_PATH = "../../contracts/artifacts/contracts/HashpriceBTC.sol/HashpriceBTC.json";

/** Blocks fed in by the fixture before the tests start submitting one at a time. */
const BOOTSTRAP_BLOCKS = 8;

export type BtcBlock = (typeof btcBlocks)[number];

export interface Oracle {
  address: Address;
  abi: Abi;
}

function hex(s: string): Hex {
  return `0x${s.replace(/^0x/, "")}`;
}

/**
 * Difficulty-implied network hashrate in hashes/second — the ground truth the
 * indexer's inverted derivation has to reproduce.
 *
 * A block is found every 600s on average, and each unit of difficulty costs
 * 2^32 expected hashes, so hashrate = difficulty * 2^32 / 600.
 */
export function difficultyImpliedHashrate(nBits: number): bigint {
  return (nBitsToDifficulty(nBits) * 2n ** 32n) / 600n;
}

/**
 * The indexer recovers `reward` from the event and divides it back out of a
 * hashprice the contract already truncated to an integer, so the result lands a
 * hair off the exact quotient. Assert closeness rather than equality: at these
 * magnitudes the relative error is ~1e-13.
 */
export function assertRelativelyClose(
  actual: bigint,
  expected: bigint,
  label: string,
  toleranceDenominator = 1_000_000_000n,
): void {
  const delta = actual > expected ? actual - expected : expected - actual;
  if (delta * toleranceDenominator > expected) {
    throw new Error(
      `${label}: ${actual} is not within 1/${toleranceDenominator} of ${expected} (delta ${delta})`,
    );
  }
}

function formatBlock(b: BtcBlock) {
  return {
    header: hex(b.rawHeader),
    coinbaseTx: hex(b.coinbase.rawHexStripped),
    merkleProof: b.merkleProof.map(hex),
  };
}

/**
 * Deploy the oracle at `btcBlocks[0]` and submit the next `BOOTSTRAP_BLOCKS`
 * headers in one batch, so the chain is already past CONFIRMATION_DEPTH and the
 * fee SMA is warm by the time a test submits its own blocks.
 */
export async function deployOracleFixture(conn: NetworkConnection) {
  const { viem } = conn;
  const [owner] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const tc = await viem.getTestClient();

  const checkpoint = btcBlocks[0];
  const lastBlock = btcBlocks[btcBlocks.length - 1];
  await tc.setNextBlockTimestamp({ timestamp: BigInt(lastBlock.timestamp + 3600) });

  const artifact = JSON.parse(await readFile(new URL(ARTIFACT_PATH, import.meta.url), "utf8"));
  const abi = artifact.abi as Abi;
  const bytecode = (artifact.bytecode?.object ?? artifact.bytecode) as Hex;

  if (owner.account === undefined) throw new Error("wallet client has no account");
  const deployTx = await deployContract(owner as WalletClient, {
    abi,
    bytecode,
    args: [
      hex(reverseHex(checkpoint.hash)),
      checkpoint.height,
      checkpoint.timestamp,
      checkpoint.nBits,
      checkpoint.timestamp,
      checkpoint.nBits,
    ],
    account: owner.account,
    chain: owner.chain,
  });
  const receipt = await pc.waitForTransactionReceipt({ hash: deployTx });
  if (!receipt.contractAddress) throw new Error("oracle deployment produced no address");

  const oracle: Oracle = { address: receipt.contractAddress, abi };

  const bootstrap = btcBlocks.slice(1, 1 + BOOTSTRAP_BLOCKS);
  await owner.writeContract({
    address: oracle.address,
    abi,
    functionName: "submitBlocks",
    args: [
      checkpoint.height,
      hex(bootstrap.map((b) => b.rawHeader).join("")),
      bootstrap.map((b) => hex(b.coinbase.rawHexStripped)),
      bootstrap.map((b) => b.merkleProof.map(hex)),
    ],
    chain: owner.chain,
    account: owner.account,
  });

  return {
    contracts: { oracle },
    accounts: { owner, pc, tc },
    // Blocks the fixture has not submitted yet — tests take them from the front.
    config: { remaining: btcBlocks.slice(1 + BOOTSTRAP_BLOCKS), nBits: checkpoint.nBits },
  };
}

/** Submit one header, mining exactly one HashpriceUpdated log. */
export async function submitBlock(
  wallet: WalletClient,
  pc: PublicClient,
  oracle: Oracle,
  block: BtcBlock,
): Promise<void> {
  const { header, coinbaseTx, merkleProof } = formatBlock(block);
  if (wallet.account === undefined) throw new Error("wallet client has no account");
  const hash = await wallet.writeContract({
    address: oracle.address,
    abi: oracle.abi,
    functionName: "submitBlock",
    args: [header, coinbaseTx, merkleProof],
    chain: wallet.chain,
    account: wallet.account,
  });
  await pc.waitForTransactionReceipt({ hash });
}

async function readOracle(pc: PublicClient, oracle: Oracle, functionName: string): Promise<unknown> {
  return pc.readContract({ address: oracle.address, abi: oracle.abi, functionName });
}

/** Height of the block the oracle currently reports a hashprice for (tip − 1). */
export async function latestConfirmedHeight(pc: PublicClient, oracle: Oracle): Promise<bigint> {
  const round = (await readOracle(pc, oracle, "latestRoundData")) as readonly bigint[];
  return round[0];
}

export async function avgFees(pc: PublicClient, oracle: Oracle): Promise<bigint> {
  return (await readOracle(pc, oracle, "avgFees")) as bigint;
}

export async function difficulty(pc: PublicClient, oracle: Oracle): Promise<bigint> {
  return (await readOracle(pc, oracle, "difficulty")) as bigint;
}
