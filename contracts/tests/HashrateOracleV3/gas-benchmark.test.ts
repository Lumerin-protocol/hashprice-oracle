import { deployV3Fixture, prepareBlocks } from "./fixtures.ts";
import { network } from "hardhat";
import { describe, it } from "node:test";

const {
  networkHelpers: { loadFixture },
} = await network.connect();

describe("HashrateOracleV3 — Gas benchmark", function () {
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
  });
});
