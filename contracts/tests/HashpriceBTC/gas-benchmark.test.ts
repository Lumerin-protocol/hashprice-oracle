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
      `  V3 hashprice: ${answer} sats (${Number(answer) / Number(satsPerBtc)} BTC) per 100 TH/s/day`,
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
      `| ${answer} sats / ${hashpriceBtc} BTC per 100 TH/s/day |`,
    ];

    const outPath = resolve(process.cwd(), "./gas-benchmark.md");
    writeFileSync(outPath, `${lines.join("\n")}\n`);
    console.log(`  Gas benchmark written to ${outPath}`);
  });
});
