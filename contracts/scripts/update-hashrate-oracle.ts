import { requireEnvsSet } from "../lib/env";
import { viem } from "hardhat";
import { verifyContract } from "../lib/verify";
import { SafeWallet } from "../lib/safe";
import { encodeFunctionData } from "viem/utils";
import { OperationType } from "@safe-global/types-kit";

async function main() {
  console.log("Hashrate Oracle deployment script");
  console.log();

  const env = <
    {
      BTCUSDC_ORACLE_ADDRESS: `0x${string}`;
      USDC_TOKEN_ADDRESS: `0x${string}`;
      HASHRATE_ORACLE_ADDRESS: `0x${string}`;
    }
  >requireEnvsSet("BTCUSDC_ORACLE_ADDRESS", "USDC_TOKEN_ADDRESS", "HASHRATE_ORACLE_ADDRESS");

  const SAFE_OWNER_ADDRESS = process.env.SAFE_OWNER_ADDRESS as `0x${string}` | undefined;

  const [deployer, proposer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  console.log("Deployer:", deployer.account.address);
  console.log("Safe owner address:", SAFE_OWNER_ADDRESS);

  console.log();

  console.log("Getting payment token decimals...");
  const paymentToken = await viem.getContractAt(
    "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata",
    env.USDC_TOKEN_ADDRESS
  );
  const tokenDecimals = await paymentToken.read.decimals();
  console.log("Name:", await paymentToken.read.name());
  console.log("Symbol:", await paymentToken.read.symbol());
  console.log("Decimals:", tokenDecimals);

  console.log();

  console.log("Getting Oracle details...");
  const btcusdOracle = await viem.getContractAt(
    "AggregatorV3Interface",
    env.BTCUSDC_ORACLE_ADDRESS
  );
  const oracleDecimals = await btcusdOracle.read.decimals();
  const btcPrice = Number((await btcusdOracle.read.latestRoundData())[1]) / 10 ** oracleDecimals;
  console.log("Oracle decimals:", oracleDecimals);
  console.log("BTC price:", btcPrice);

  console.log();

  // console.log("Checking existing HashrateOracle...");
  const oracleProxy = await viem.getContractAt("HashrateOracle", env.HASHRATE_ORACLE_ADDRESS);
  console.log("Version:", await oracleProxy.read.VERSION());
  console.log("Current implementation:", oracleProxy.address);
  console.log();

  console.log("Deploying new HashrateOracle implementation...");
  const hashrateOracleImpl = await viem.deployContract("HashrateOracle", [
    env.BTCUSDC_ORACLE_ADDRESS,
    tokenDecimals,
  ]);
  console.log("Deployed at:", hashrateOracleImpl.address);
  await verifyContract(hashrateOracleImpl.address, [env.BTCUSDC_ORACLE_ADDRESS, tokenDecimals]);

  if (SAFE_OWNER_ADDRESS) {
    console.log();
    console.log("Proposing upgrade to Safe wallet...");

    const upgradeData = encodeFunctionData({
      abi: oracleProxy.abi,
      functionName: "upgradeToAndCall",
      args: [hashrateOracleImpl.address, "0x"],
    });

    const safe = new SafeWallet(SAFE_OWNER_ADDRESS, proposer);
    const txHash = await safe.proposeTransaction({
      data: upgradeData,
      to: env.HASHRATE_ORACLE_ADDRESS,
      value: "0",
      operation: OperationType.Call,
    });

    console.log("Transaction proposed!");
    console.log("Safe TX Hash:", txHash);
    console.log("Transaction URL:", safe.getSafeUITxUrl(txHash));
    await pc.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
  } else {
    console.log();
    console.log("Upgrading proxy to new implementation...");
    const tx = await oracleProxy.write.upgradeToAndCall([hashrateOracleImpl.address, "0x"]);

    await pc.waitForTransactionReceipt({ hash: tx });
    console.log("Upgrade transaction completed!");
  }

  console.log();
  console.log("Verifying upgrade...");
  const upgradedOracle = await viem.getContractAt("HashrateOracle", env.HASHRATE_ORACLE_ADDRESS);

  console.log("Hashes for BTC:", await upgradedOracle.read.getHashesForBTCV2());
  console.log("Hashes for token:", await upgradedOracle.read.getHashesForTokenV2());
  console.log("Updater address:", await upgradedOracle.read.updaterAddress());
  console.log("Owner:", await upgradedOracle.read.owner());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
