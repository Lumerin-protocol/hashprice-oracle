import { encodeFunctionData, type Hex } from "viem";
import btcBlocks from "./btc-blocks.json" with { type: "json" };
import type { NetworkConnection } from "hardhat/types";

function prefixed0x(s: string): `0x${string}` {
  return `0x${s.replace(/^0x/, "")}`;
}

export async function deployRelayFixture(conn: NetworkConnection) {
  const { viem } = conn;
  const [owner, user] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const tc = await viem.getTestClient();
  const blocks = btcBlocks;
  const checkpoint = blocks[0];

  const btcRelayImpl = await viem.deployContract("contracts/BTCRelay.sol:BTCRelay", []);

  const btcRelayProxy = await viem.deployContract(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
    [
      btcRelayImpl.address as `0x${string}`,
      encodeFunctionData({
        abi: btcRelayImpl.abi,
        functionName: "initialize",
        args: [prefixed0x(checkpoint.rawHeader), checkpoint.height],
      }),
    ],
  );
  const btcRelay = await viem.getContractAt("BTCRelay", btcRelayProxy.address);

  const latestTimestamp = blocks[blocks.length - 1].timestamp;
  await tc.setNextBlockTimestamp({ timestamp: BigInt(latestTimestamp + 3600) });

  const ancestorHash = await btcRelay.read.chainTip();
  const remainingHeaders = blocks
    .slice(1)
    .map((b) => b.rawHeader)
    .join("");
  const submitHeadersHash = await btcRelay.write.submitHeaders([
    prefixed0x(remainingHeaders),
    prefixed0x(ancestorHash),
  ]);
  const submitHeadersReceipt = await pc.waitForTransactionReceipt({ hash: submitHeadersHash });
  console.log(
    `  submitHeaders (${blocks.length - 1} headers): ${Number(submitHeadersReceipt.gasUsed).toLocaleString()} gas`,
  );

  return {
    contracts: { btcRelay, btcRelayImpl },
    accounts: { owner, user, pc },
    config: { blocks, checkpoint },
  };
}

export async function deployFullFixture(conn: NetworkConnection) {
  const {
    viem,
    networkHelpers: { loadFixture },
  } = conn;
  const { contracts, accounts, config } = await loadFixture(deployRelayFixture);
  const { btcRelay } = contracts;
  const { blocks } = config;

  const coinbaseVerifier = await viem.deployContract(
    "contracts/CoinbaseVerifier.sol:CoinbaseVerifier",
    [btcRelay.address as Hex],
  );

  let totalCoinbaseGas = 0n;
  for (const block of blocks) {
    const proofHash = await coinbaseVerifier.write.submitCoinbaseProof([
      block.height,
      prefixed0x(block.coinbase.rawHexStripped),
      block.merkleProof.map((h) => prefixed0x(h)),
    ]);
    const proofReceipt = await accounts.pc.waitForTransactionReceipt({ hash: proofHash });
    totalCoinbaseGas += proofReceipt.gasUsed;
  }
  console.log(
    `  submitCoinbaseProof (${blocks.length} blocks): ${Number(totalCoinbaseGas).toLocaleString()} gas total, ${Math.round(Number(totalCoinbaseGas) / blocks.length).toLocaleString()} gas avg`,
  );

  const feeWindow = 3;
  const oracleImpl = await viem.deployContract("contracts/HashrateOracleV2.sol:HashrateOracleV2", [
    btcRelay.address as Hex,
    coinbaseVerifier.address as Hex,
  ]);
  const oracleProxy = await viem.deployContract(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
    [
      oracleImpl.address as Hex,
      encodeFunctionData({
        abi: oracleImpl.abi,
        functionName: "initialize",
        args: [feeWindow],
      }),
    ],
  );
  const oracle = await viem.getContractAt("HashrateOracleV2", oracleProxy.address);

  return {
    contracts: { btcRelay, coinbaseVerifier, oracle, oracleImpl },
    accounts,
    config: { ...config, feeWindow },
  };
}
