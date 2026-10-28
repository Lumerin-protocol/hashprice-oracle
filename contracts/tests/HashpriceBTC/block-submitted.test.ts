import btcBlocks from "../fixtures/btc-blocks.json" with { type: "json" };
import {
  hex,
  reverseHex,
  buildHeader,
  mineHeader,
  blockHash,
  getBlockSubsidy,
  mineSyntheticBlock,
  mineChain,
  formatBatch,
  EASY_NBITS,
} from "./helpers.ts";
import { deployV3Fixture, prepareBlocks } from "./fixtures.ts";
import { network } from "hardhat";
import type { NetworkConnection } from "hardhat/types";
import { describe, it } from "node:test";
import { parseEventLogs } from "viem";
import assert from "node:assert/strict";

const {
  networkHelpers: { loadFixture },
} = await network.connect();

// Mirrors BLOCK_BUFFER_SIZE in the contract. A batch larger than this wraps the ring
// buffer mid-call, which is the case the deep-batch test exists to cover.
const BLOCK_BUFFER_SIZE = 64;

// ─── Fixtures ─────────────────────────────────────────────────────

/**
 * Two oracles deployed from the same checkpoint. One receives headers one at a time,
 * the other receives all of them in a single batch, so the two can be compared directly.
 */
async function deployTwinFixture(conn: NetworkConnection) {
  const { viem } = conn;
  const pc = await viem.getPublicClient();
  const tc = await viem.getTestClient();
  const blocks = btcBlocks;
  const checkpoint = blocks[0];

  // Well clear of the other fixtures in this file: they share one chain, and
  // setNextBlockTimestamp cannot move the clock backwards.
  await tc.setNextBlockTimestamp({
    timestamp: BigInt(blocks[blocks.length - 1].timestamp + 30 * 24 * 3600),
  });

  const args: [`0x${string}`, number, number, number, number, number] = [
    hex(reverseHex(checkpoint.hash)),
    checkpoint.height,
    checkpoint.timestamp,
    checkpoint.nBits,
    checkpoint.timestamp,
    checkpoint.nBits,
  ];

  const sequential = await viem.deployContract("HashpriceBTC", args);
  const batched = await viem.deployContract("HashpriceBTC", args);

  return { sequential, batched, pc, blocks, checkpoint };
}

/** Synthetic chain at height 100, for cases real mainnet blocks cannot produce. */
async function deploySyntheticFixture(conn: NetworkConnection) {
  const { viem } = conn;
  const pc = await viem.getPublicClient();
  const tc = await viem.getTestClient();

  const genesisHeight = 100;
  const baseTs = 1_764_000_000;
  const nBits = EASY_NBITS;

  const minedGenesis = mineHeader(
    buildHeader({ prevHash: "00".repeat(32), timestamp: baseTs, nBits }),
    nBits,
  );
  const genesisHash = blockHash(minedGenesis);

  await tc.setNextBlockTimestamp({ timestamp: BigInt(baseTs + 200_000) });

  const oracle = await viem.deployContract("HashpriceBTC", [
    hex(genesisHash),
    genesisHeight,
    baseTs,
    nBits,
    baseTs,
    nBits,
  ]);

  return { oracle, pc, genesisHeight, genesisHash, baseTs, nBits };
}

// ─── Helpers ──────────────────────────────────────────────────────

function batchFromReal(blocks: typeof btcBlocks) {
  const { formatBlock } = prepareBlocks(btcBlocks);
  const formatted = blocks.map(formatBlock);
  return {
    headers: hex(formatted.map((b) => b.header.slice(2)).join("")),
    coinbaseTxs: formatted.map((b) => b.coinbaseTx),
    merkleProofs: formatted.map((b) => b.merkleProof),
  };
}

/**
 * Reduce a receipt's logs to a comparable shape. Deliberately keeps every argument:
 * none of these events carry an EVM timestamp, so a batch and the equivalent sequence
 * of single submissions must produce byte-identical streams.
 */
function eventStream(abi: readonly unknown[], logs: readonly unknown[]) {
  // biome-ignore lint/suspicious/noExplicitAny: viem's parsed log arg types vary per event
  return parseEventLogs({ abi, logs } as any).map((log: any) => ({
    name: log.eventName,
    args: log.args,
  }));
}

// ─── Tests ────────────────────────────────────────────────────────

describe("HashpriceBTC — BlockSubmitted", function () {
  it("reports each block's own timestamp and nBits, not the tip's", async function () {
    const { oracle, pc, genesisHeight, genesisHash, baseTs, nBits } =
      await loadFixture(deploySyntheticFixture);

    const chain = mineChain(genesisHash, genesisHeight + 1, 5, baseTs, nBits, 1000n);
    const batch = formatBatch(chain);

    const tx = await oracle.write.submitBlocks([
      genesisHeight,
      batch.headers,
      batch.coinbaseTxs,
      batch.merkleProofs,
    ]);
    const receipt = await pc.waitForTransactionReceipt({ hash: tx });

    const events = parseEventLogs({
      abi: oracle.abi,
      logs: receipt.logs,
      eventName: "BlockSubmitted",
    });

    assert.equal(events.length, chain.length, "one event per header");
    for (let i = 0; i < chain.length; i++) {
      const block = chain[i];
      assert.equal(events[i].args.height, block.height);
      assert.equal(events[i].args.blockHash?.toLowerCase(), hex(block.hash).toLowerCase());
      assert.equal(events[i].args.timestamp, block.timestamp);
      assert.equal(events[i].args.nBits, block.nBits);
      assert.equal(events[i].args.coinbaseValue, block.coinbaseValue);
    }
  });

  it("reports the true coinbase total when a miner burns part of the subsidy", async function () {
    const { oracle, pc, genesisHeight, genesisHash, baseTs, nBits } =
      await loadFixture(deploySyntheticFixture);

    // Pay out less than the subsidy. The contract's fee figure saturates to zero and
    // loses the amount; coinbaseValue exists so it stays recoverable off-chain.
    const height = genesisHeight + 1;
    const subsidy = getBlockSubsidy(height);
    const burned = subsidy - 1_000_000_000n;

    const block = mineSyntheticBlock(genesisHash, height, baseTs + 600, nBits, 0n, burned);

    const tx = await oracle.write.submitBlock([
      hex(block.rawHeader),
      hex(block.coinbaseTx),
      [],
    ]);
    const receipt = await pc.waitForTransactionReceipt({ hash: tx });

    const [event] = parseEventLogs({
      abi: oracle.abi,
      logs: receipt.logs,
      eventName: "BlockSubmitted",
    });

    assert.equal(event.args.coinbaseValue, burned, "reports the unsaturated total");
    assert.ok(burned < subsidy, "fixture really does burn subsidy");
    // The SMA saw zero for this block even though the coinbase paid out `burned`.
    assert.equal(await oracle.read.avgFees(), 0n);
  });

  // The hashprice tests below use real mainnet headers rather than synthetic ones: a
  // synthetic chain has to be mineable in-process, and at that difficulty
  // nBitsToDifficulty truncates to zero, so _computeAndEmitHashprice bails before emitting.

  it("emits one HashpriceUpdated per block in a batch, not one per transaction", async function () {
    const { contracts, accounts, config } = await loadFixture(deployV3Fixture);

    const count = 5;
    const submitted = config.blocks.slice(1, count + 1);
    const batch = batchFromReal(submitted);

    const tx = await contracts.oracle.write.submitBlocks([
      config.checkpoint.height,
      batch.headers,
      batch.coinbaseTxs,
      batch.merkleProofs,
    ]);
    const receipt = await accounts.pc.waitForTransactionReceipt({ hash: tx });

    const events = parseEventLogs({
      abi: contracts.oracle.abi,
      logs: receipt.logs,
      eventName: "HashpriceUpdated",
    });

    assert.equal(events.length, count, "one hashprice per block, not one per batch");
    // CONFIRMATION_DEPTH is 1, so the first event confirms the checkpoint and each
    // subsequent one confirms the block accepted on the previous iteration.
    for (let i = 0; i < count; i++) {
      assert.equal(events[i].args.confirmedHeight, config.checkpoint.height + i);
    }
  });

  it("interleaves BlockSubmitted and HashpriceUpdated per block", async function () {
    const { contracts, accounts, config } = await loadFixture(deployV3Fixture);

    const submitted = config.blocks.slice(1, 5);
    const batch = batchFromReal(submitted);

    const tx = await contracts.oracle.write.submitBlocks([
      config.checkpoint.height,
      batch.headers,
      batch.coinbaseTxs,
      batch.merkleProofs,
    ]);
    const receipt = await accounts.pc.waitForTransactionReceipt({ hash: tx });

    const names = eventStream(contracts.oracle.abi, receipt.logs).map((e) => e.name);
    assert.deepEqual(names, [
      "BlockSubmitted",
      "HashpriceUpdated",
      "BlockSubmitted",
      "HashpriceUpdated",
      "BlockSubmitted",
      "HashpriceUpdated",
      "BlockSubmitted",
      "HashpriceUpdated",
    ]);
  });

  it("follows a batch larger than the ring buffer", async function () {
    // The old design forced an indexer to read header fields back out of the buffer, so a
    // batch deeper than BLOCK_BUFFER_SIZE was unreadable. The contract itself also has to
    // survive the ring wrapping mid-call: the retarget check and the per-block hashprice
    // both read the slot written on the previous iteration.
    const { contracts, accounts, config } = await loadFixture(deployV3Fixture);
    const count = BLOCK_BUFFER_SIZE + 6;
    const submitted = config.blocks.slice(1, count + 1);
    const batch = batchFromReal(submitted);

    const tx = await contracts.oracle.write.submitBlocks([
      config.checkpoint.height,
      batch.headers,
      batch.coinbaseTxs,
      batch.merkleProofs,
    ]);
    const receipt = await accounts.pc.waitForTransactionReceipt({ hash: tx });
    assert.equal(receipt.status, "success");

    const events = parseEventLogs({
      abi: contracts.oracle.abi,
      logs: receipt.logs,
      eventName: "BlockSubmitted",
    });
    assert.equal(events.length, count, "every header reported, buffer size notwithstanding");

    // Heights past the wrap point are still reported correctly even though their ring slots
    // were overwritten later in the same call.
    for (let i = 0; i < submitted.length; i++) {
      assert.equal(events[i].args.height, submitted[i].height);
      assert.equal(events[i].args.nBits, submitted[i].nBits);
      assert.equal(events[i].args.timestamp, submitted[i].timestamp);
    }

    const [chainHeight] = await contracts.oracle.read.state();
    assert.equal(chainHeight, submitted[submitted.length - 1].height);
  });
});

describe("HashpriceBTC — batch and sequential equivalence", function () {
  // The keeper only ever calls submitBlocks, so batching is the production path rather than
  // an edge case. A batch of N must be indistinguishable from N single submissions to any
  // consumer: same events, same order, same values, same resulting state.
  it("produces an identical event stream and state", async function () {
    const { sequential, batched, pc, blocks, checkpoint } =
      await loadFixture(deployTwinFixture);

    const count = 10;
    const submitted = blocks.slice(1, count + 1);
    const { formatBlock } = prepareBlocks(blocks);

    const sequentialLogs = [];
    for (const b of submitted) {
      const fb = formatBlock(b);
      const tx = await sequential.write.submitBlock([fb.header, fb.coinbaseTx, fb.merkleProof]);
      const receipt = await pc.waitForTransactionReceipt({ hash: tx });
      sequentialLogs.push(...receipt.logs);
    }

    const batch = batchFromReal(submitted);
    const batchTx = await batched.write.submitBlocks([
      checkpoint.height,
      batch.headers,
      batch.coinbaseTxs,
      batch.merkleProofs,
    ]);
    const batchReceipt = await pc.waitForTransactionReceipt({ hash: batchTx });

    const batchStream = eventStream(batched.abi, batchReceipt.logs);
    const sequentialStream = eventStream(sequential.abi, sequentialLogs);

    // Guard against the comparison passing because both sides decoded to nothing.
    assert.equal(batchStream.length, count * 2, "a BlockSubmitted and a HashpriceUpdated each");

    assert.deepEqual(
      batchStream,
      sequentialStream,
      "batch log stream must match the sequential one",
    );

    assert.equal(await batched.read.chainTipHash(), await sequential.read.chainTipHash());
    assert.equal(await batched.read.avgFees(), await sequential.read.avgFees());
    assert.equal(await batched.read.difficulty(), await sequential.read.difficulty());

    // Every state field but lastSubmittedAt, which is the EVM clock and legitimately differs:
    // the sequential run's last tx and the batch's single tx land in different blocks.
    const seqState = await sequential.read.state();
    const batchState = await batched.read.state();
    const LAST_SUBMITTED_AT = 4;
    for (let i = 0; i < seqState.length; i++) {
      if (i === LAST_SUBMITTED_AT) continue;
      assert.equal(batchState[i], seqState[i], `state field ${i}`);
    }

    // Same reasoning for updatedAt, which is index 3 of latestRoundData.
    const [seqRound, seqAnswer, seqStarted] = await sequential.read.latestRoundData();
    const [batchRound, batchAnswer, batchStarted] = await batched.read.latestRoundData();
    assert.equal(batchRound, seqRound);
    assert.equal(batchAnswer, seqAnswer);
    assert.equal(batchStarted, seqStarted);
  });
});
