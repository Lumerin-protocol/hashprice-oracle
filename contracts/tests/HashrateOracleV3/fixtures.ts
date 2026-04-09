import btcBlocks from "../fixtures/btc-blocks.json" with { type: "json" };
import type { NetworkConnection } from "hardhat/types";

function prefixed0x(s: string): `0x${string}` {
  return `0x${s.replace(/^0x/, "")}`;
}

export function prepareBlocks(blocks: typeof btcBlocks) {
  const _lastBlock = blocks[blocks.length - 1];
  return {
    lastBlock: {
      height: _lastBlock.height,
      timestamp: _lastBlock.timestamp,
      header: prefixed0x(_lastBlock.rawHeader),
      coinbaseTx: prefixed0x(_lastBlock.coinbase.rawHexStripped),
      merkleProof: _lastBlock.merkleProof.map((h) => prefixed0x(h)),
    },
    formatBlock: (b: (typeof blocks)[number]) => ({
      header: prefixed0x(b.rawHeader),
      coinbaseTx: prefixed0x(b.coinbase.rawHexStripped),
      merkleProof: b.merkleProof.map((h) => prefixed0x(h)),
    }),
  };
}

export async function deployV3Fixture(conn: NetworkConnection) {
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

  const { lastBlock } = prepareBlocks(blocks);

  return {
    contracts: { oracle },
    accounts: { owner, user, pc, tc },
    config: { blocks, checkpoint, lastBlock },
  };
}

const BATCH_SIZE = 7;

export async function deployOracleFixture(conn: NetworkConnection) {
  const {
    viem,
    networkHelpers: { loadFixture },
  } = conn;
  const { contracts, accounts, config } = await loadFixture(deployV3Fixture);
  const { oracle } = contracts;
  const { blocks, checkpoint } = config;

  const batchBlocks = blocks.slice(1, BATCH_SIZE);

  let remainingHeaders = "";
  const coinbaseTxs: `0x${string}`[] = [];
  const merkleProofs: `0x${string}`[][] = [];

  for (const b of batchBlocks) {
    remainingHeaders += b.rawHeader;
    coinbaseTxs.push(prefixed0x(b.coinbase.rawHexStripped));
    merkleProofs.push(b.merkleProof.map((h) => prefixed0x(h)));
  }

  const submitHash = await oracle.write.submitBlocks([
    checkpoint.height,
    prefixed0x(remainingHeaders),
    coinbaseTxs,
    merkleProofs,
  ]);
  const submitReceipt = await accounts.pc.waitForTransactionReceipt({ hash: submitHash });
  console.log(
    `  submitBlocks (${batchBlocks.length} blocks): ${Number(submitReceipt.gasUsed).toLocaleString()} gas`,
  );

  return { contracts, accounts, config: { ...config, batchEnd: BATCH_SIZE } };
}
