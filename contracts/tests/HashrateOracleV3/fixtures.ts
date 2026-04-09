import btcBlocks from "../HashrateOracleV2/btc-blocks.json" with { type: "json" };
import type { NetworkConnection } from "hardhat/types";

function prefixed0x(s: string): `0x${string}` {
  return `0x${s.replace(/^0x/, "")}`;
}

export async function deployOracleFixture(conn: NetworkConnection) {
  const { viem } = conn;
  const [owner, user] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const tc = await viem.getTestClient();
  const blocks = btcBlocks;
  const checkpoint = blocks[0];

  const latestTimestamp = blocks[blocks.length - 1].timestamp;
  await tc.setNextBlockTimestamp({ timestamp: BigInt(latestTimestamp + 3600) });

  const oracle = await viem.deployContract(
    "contracts/HashrateOracleV3.sol:HashrateOracleV3",
    [prefixed0x(checkpoint.hash), checkpoint.height, checkpoint.timestamp, checkpoint.nBits],
  );

  const remainingHeaders = blocks
    .slice(1)
    .map((b) => b.rawHeader)
    .join("");
  const coinbaseTxs = blocks.slice(1).map((b) => prefixed0x(b.coinbase.rawHexStripped));
  const merkleProofs = blocks.slice(1).map((b) => b.merkleProof.map((h) => prefixed0x(h)));

  const submitHash = await oracle.write.submitBlocks([
    checkpoint.height,
    prefixed0x(remainingHeaders),
    coinbaseTxs,
    merkleProofs,
  ]);
  const submitReceipt = await pc.waitForTransactionReceipt({ hash: submitHash });
  console.log(
    `  submitBlocks (${blocks.length - 1} blocks): ${Number(submitReceipt.gasUsed).toLocaleString()} gas`,
  );

  return {
    contracts: { oracle },
    accounts: { owner, user, pc, tc },
    config: { blocks, checkpoint },
  };
}
