import { viem } from "hardhat";
import { parseUnits } from "viem";
import { writeAndWait } from "../lib/writeContract";
import { verifyContract } from "../lib/verify";

async function main() {
  console.log("Deploying BTC/USD oracle mock...");

  // Get wallet client
  const [deployer] = await viem.getWalletClients();
  console.log("Deployer address:", deployer.account.address);

  // Deploy USDC Mock contract
  const btcPriceOracleMock = await viem.deployContract(
    "contracts/BTCPriceOracleMock.sol:BTCPriceOracleMock",
    []
  );
  console.log("Deployed at:", btcPriceOracleMock.address);

  await verifyContract(btcPriceOracleMock.address);

  const btcPrice = "96936.15";
  const ORACLE_DECIMALS = 8;

  console.log("Setting BTC price to:", btcPrice);
  const sim = await btcPriceOracleMock.simulate.setPrice([
    parseUnits(btcPrice, ORACLE_DECIMALS),
    ORACLE_DECIMALS,
  ]);
  const receipt = await writeAndWait(deployer, sim);
  console.log("Transaction hash:", receipt.transactionHash);

  console.log("\nOracle Details:");
  console.log(
    "BTC price:",
    Number((await btcPriceOracleMock.read.latestRoundData())[1]) /
      10 ** (await btcPriceOracleMock.read.decimals())
  );

  console.log("Done!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
