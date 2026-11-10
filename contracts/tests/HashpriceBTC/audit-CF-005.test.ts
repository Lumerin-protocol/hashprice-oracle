import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blockHash, buildHeader, dsha256, EASY_NBITS, getBlockSubsidy, hex, mineHeader } from "./helpers.ts";

const { viem } = await network.connect();

const HONEST_FEE = 2_000_000n; // 0.02 BTC, a realistic block fee

/** Coinbase with a null input; `extranonce` is the 4-byte input script a miner rolls freely. */
function buildCoinbaseTx(outputValue: bigint, extranonce: number): string {
  const value = Buffer.alloc(8);
  value.writeBigUInt64LE(outputValue);
  const script = Buffer.alloc(4);
  script.writeUint32LE(extranonce);
  return ["01000000", "01", "00".repeat(32), "ffffffff", "04", script.toString("hex"), "ffffffff", "01", value.toString("hex"), "01", "51", "00000000"].join("");
}

/** The attacker's own transaction; `locktime` is the harmless field it grinds. */
function buildOwnTx(locktime: number): string {
  const lt = Buffer.alloc(4);
  lt.writeUint32LE(locktime);
  return ["01000000", "01", "11".repeat(32), "00000000", "00", "ffffffff", "01", "e803000000000000", "01", "51", lt.toString("hex")].join("");
}

/**
 * Bytes the oracle's coinbase parser needs in the 64-byte blob `t0 ‖ t1`:
 * [4] = 1 input, [41] = script length s ≤ 8, [46+s] = 1 output, [55+s] = output script length < 0xfd.
 * Returns the "payout" it would read from [47+s .. 54+s], or undefined if the blob doesn't parse.
 */
function parsedPayout(blob: Buffer): bigint | undefined {
  if (blob[4] !== 0x01) return undefined;
  const s = blob[41];
  if (s > 8 || blob[46 + s] !== 0x01 || blob[55 + s] >= 0xfd) return undefined;
  return blob.readBigUInt64LE(47 + s);
}

/**
 * CF-005 (Critical): `_verifyCoinbaseAndExtractFees` folds a caller-chosen number of proof steps
 * and parses any bytes as the coinbase. A miner grinds its coinbase extranonce and one own
 * transaction so that the 64-byte Merkle node preimage `t0 ‖ t1` parses as a coinbase, then
 * submits that blob with a proof one step shorter. The proof reaches the real root and the parser
 * reads 8 bytes of the attacker's txid as the payout, poisoning the fee average.
 *
 * The attack is run in full; the test asserts the fee average is not inflated. On the unfixed
 * oracle the forged blob is accepted; once the coinbase shape is checked the submission reverts.
 */
describe("CF-005 — a Merkle node cannot be passed off as the coinbase", () => {
  it("does not let a shorter proof over t0 ‖ t1 inflate the fee average", async () => {
    const tc = await viem.getTestClient();
    const genesisHeight = 10;
    const baseTs = 2_100_000_000;
    const nBits = EASY_NBITS;

    const genesis = mineHeader(buildHeader({ prevHash: "00".repeat(32), timestamp: baseTs, nBits }), nBits);
    await tc.setNextBlockTimestamp({ timestamp: BigInt(baseTs + 100_000) });
    const oracle = await viem.deployContract("HashpriceBTC", [hex(blockHash(genesis)), genesisHeight, baseTs, nBits, baseTs, nBits]);

    // Honest block at height 11: a lone coinbase paying subsidy + a realistic fee.
    const honestCoinbase = buildCoinbaseTx(getBlockSubsidy(genesisHeight + 1) + HONEST_FEE, 0);
    const honest = mineHeader(
      buildHeader({ prevHash: blockHash(genesis), timestamp: baseTs + 600, nBits, merkleRoot: dsha256(honestCoinbase) }),
      nBits,
    );
    await oracle.write.submitBlock([hex(honest), hex(honestCoinbase), []]);
    assert.equal(await oracle.read.avgFees(), HONEST_FEE, "baseline fee average");

    // Attacker block at height 12: grind the coinbase until blob byte 4 is 0x01 ...
    const attackHeight = genesisHeight + 2;
    let extranonce = 0;
    let t0 = "";
    for (; ; extranonce++) {
      t0 = dsha256(buildCoinbaseTx(getBlockSubsidy(attackHeight), extranonce));
      if (Buffer.from(t0, "hex")[4] === 0x01) break;
    }
    // ... then grind its own transaction until the blob parses with a huge payout.
    let t1 = "";
    let payout: bigint | undefined;
    for (let locktime = 0; ; locktime++) {
      t1 = dsha256(buildOwnTx(locktime));
      payout = parsedPayout(Buffer.from(t0 + t1, "hex"));
      if (payout !== undefined && payout > getBlockSubsidy(attackHeight) * 1_000n) break;
    }

    // Two-transaction block: root = H(t0 ‖ t1). The honest proof is [t1]; the forged one is [].
    const attack = mineHeader(
      buildHeader({ prevHash: blockHash(honest), timestamp: baseTs + 1200, nBits, merkleRoot: dsha256(t0 + t1) }),
      nBits,
    );

    try {
      await oracle.write.submitBlock([hex(attack), hex(t0 + t1), []]);
    } catch {
      // forged coinbase rejected
    }

    assert.ok(
      (await oracle.read.avgFees()) <= HONEST_FEE,
      `fee average must not absorb the forged ${payout} sat payout`,
    );
  });
});
