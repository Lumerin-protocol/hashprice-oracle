import { HashpriceBTCAbi } from "../../abi/HashpriceBTC.ts";
import { deployV3Fixture, prepareBlocks } from "./fixtures.ts";
import { network } from "hardhat";
import { describe, it } from "node:test";
import { encodeFunctionData } from "viem";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const {
  networkHelpers: { loadFixture },
} = await network.connect();

/** Batch sizes to sweep independently from the keeper's single-block submitBlock fast path. */
const BATCH_SIZES = [1, 5, 10, 25, 50];

describe("HashpriceBTC — Gas benchmark", function () {
  it("average gas per block (submit one-by-one)", async function () {
    const { contracts, accounts, config } = await loadFixture(deployV3Fixture);
    const { oracle } = contracts;
    const { pc } = accounts;
    const { blocks } = config;
    const { formatBlock } = prepareBlocks(blocks);

    const FEE_WINDOW = 144;
    let coldGas = 0n;
    let warmGas = 0n;
    let totalGas = 0n;
    const toSubmit = blocks.slice(1);

    for (let i = 0; i < toSubmit.length; i++) {
      const fb = formatBlock(toSubmit[i]);
      const hash = await oracle.write.submitBlock([fb.header, fb.coinbaseTx, fb.merkleProof]);
      const receipt = await pc.waitForTransactionReceipt({ hash });
      totalGas += receipt.gasUsed;
      if (i < FEE_WINDOW) {
        coldGas += receipt.gasUsed;
      } else {
        warmGas += receipt.gasUsed;
      }
    }

    const warmCount = toSubmit.length - FEE_WINDOW;
    console.log(
      `  V3 avg (all ${toSubmit.length} blocks):   ${Math.round(Number(totalGas) / toSubmit.length).toLocaleString()} gas`,
    );
    console.log(
      `  V3 avg (cold, first ${FEE_WINDOW}):  ${Math.round(Number(coldGas) / FEE_WINDOW).toLocaleString()} gas`,
    );
    if (warmCount > 0) {
      console.log(
        `  V3 avg (warm, last ${warmCount}):   ${Math.round(Number(warmGas) / warmCount).toLocaleString()} gas`,
      );
    }

    const [, answer] = await oracle.read.latestRoundData();
    const satsPerBtc = 100_000_000n;
    console.log(
      `  V3 hashprice: ${answer} sats (${Number(answer) / Number(satsPerBtc)} BTC) per 1 PH/s/day`,
    );

    const latestRoundDataGas = await pc.estimateGas({
      to: oracle.address,
      data: encodeFunctionData({
        abi: HashpriceBTCAbi,
        functionName: "latestRoundData",
      }),
    });
    console.log(
      `  V3 latestRoundData (estimate): ${Number(latestRoundDataGas).toLocaleString()} gas`,
    );

    const avgAll = Math.round(Number(totalGas) / toSubmit.length);
    const avgCold = Math.round(Number(coldGas) / FEE_WINDOW);
    const avgWarm = warmCount > 0 ? Math.round(Number(warmGas) / warmCount) : null;
    const hashpriceBtc = (Number(answer) / Number(satsPerBtc)).toFixed(8);

    // ─── submitBlocks, swept over batch size ────────────────────────
    //
    // Same blocks, same total work, only the number of transactions differs. The
    // per-block figure falls with batch size because the 21,000 intrinsic fee and the
    // hashprice cache write are paid once per call rather than once per block.
    const batchRows: { size: number; perBlock: number; total: bigint; calls: number }[] = [];

    for (const size of BATCH_SIZES) {
      const fresh = await loadFixture(deployV3Fixture);
      let batchTotal = 0n;
      let calls = 0;
      let ancestorHeight = fresh.config.checkpoint.height;

      for (let i = 0; i < toSubmit.length; i += size) {
        const chunk = toSubmit.slice(i, i + size);
        const formatted = chunk.map(formatBlock);
        const hash = await fresh.contracts.oracle.write.submitBlocks([
          ancestorHeight,
          `0x${formatted.map((b) => b.header.slice(2)).join("")}`,
          formatted.map((b) => b.coinbaseTx),
          formatted.map((b) => b.merkleProof),
        ]);
        const receipt = await fresh.accounts.pc.waitForTransactionReceipt({ hash });
        batchTotal += receipt.gasUsed;
        calls++;
        ancestorHeight = chunk[chunk.length - 1].height;
      }

      const perBlock = Math.round(Number(batchTotal) / toSubmit.length);
      batchRows.push({ size, perBlock, total: batchTotal, calls });
      console.log(
        `  V3 submitBlocks batch=${String(size).padStart(2)}: ${perBlock.toLocaleString()} gas/block over ${calls} txs`,
      );
    }

    const date = new Date().toISOString().slice(0, 10);
    const lines = [
      `# Gas Benchmark — HashpriceBTC`,
      ``,
      `_Last updated: ${date}_`,
      ``,
      `## \`submitBlock\` — one-by-one over ${toSubmit.length} real mainnet blocks`,
      ``,
      `| Metric | Gas |`,
      `|--------|----:|`,
      `| Average (all ${toSubmit.length} blocks) | ${avgAll.toLocaleString()} |`,
      `| Average cold (first ${FEE_WINDOW} blocks, writing fee window) | ${avgCold.toLocaleString()} |`,
      ...(avgWarm !== null
        ? [
            `| Average warm (last ${warmCount} blocks, steady state) | ${avgWarm.toLocaleString()} |`,
          ]
        : []),
      ``,
      `## \`submitBlocks\` — same ${toSubmit.length} blocks, swept over batch size`,
      ``,
      `The keeper uses \`submitBlock\` for a single plain extension and \`submitBlocks\` for`,
      `backlogs and reorgs. The \`size = 1\` row isolates the batch path's floor; larger batches`,
      `amortise the 21,000 intrinsic fee and the single hashprice cache write across more blocks.`,
      ``,
      `| Batch size | Transactions | Total gas | Gas per block |`,
      `|-----------:|-------------:|----------:|--------------:|`,
      ...batchRows.map(
        (r) =>
          `| ${r.size} | ${r.calls} | ${Number(r.total).toLocaleString()} | ${r.perBlock.toLocaleString()} |`,
      ),
      ``,
      `## \`latestRoundData\` — read-only call`,
      ``,
      `| Metric | Gas |`,
      `|--------|----:|`,
      `| Estimate | ${Number(latestRoundDataGas).toLocaleString()} |`,
      ``,
      `## Hashprice at benchmark tip`,
      ``,
      `| Value |`,
      `|-------|`,
      `| ${answer} sats / ${hashpriceBtc} BTC per 1 PH/s/day |`,
    ];

    const outPath = resolve(process.cwd(), "./gas-benchmark.md");
    writeFileSync(outPath, `${lines.join("\n")}\n`);
    console.log(`  Gas benchmark written to ${outPath}`);
  });
});
