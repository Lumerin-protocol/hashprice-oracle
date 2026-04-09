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

  const oracle = await viem.deployContract("contracts/HashrateOracleV3.sol:HashrateOracleV3", [
    prefixed0x(checkpoint.hash),
    checkpoint.height,
    checkpoint.timestamp,
    checkpoint.nBits,
  ]);

  let remainingHeaders = "";
  const coinbaseTxs: `0x${string}`[] = [];
  const merkleProofs: `0x${string}`[][] = [];

  // Submit all blocks except the last one, we use it in tests
  for (let i = 1; i < blocks.length - 1; i++) {
    const b = blocks[i];
    remainingHeaders += b.rawHeader;
    coinbaseTxs.push(prefixed0x(b.coinbase.rawHexStripped));
    merkleProofs.push(b.merkleProof.map((h) => prefixed0x(h)));
  }

  const _lastBlock = blocks[blocks.length - 1];

  const lastBlock = {
    height: _lastBlock.height,
    timestamp: _lastBlock.timestamp,
    header: prefixed0x(_lastBlock.rawHeader),
    coinbaseTx: prefixed0x(_lastBlock.coinbase.rawHexStripped),
    merkleProof: _lastBlock.merkleProof.map((h) => prefixed0x(h)),
  };

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
    config: { blocks, checkpoint, lastBlock },
  };
}
