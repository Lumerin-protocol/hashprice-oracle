import hre from "hardhat";
import { parseUnits } from "viem";
import { writeAndWait } from "../lib/writeContract.ts";
import { verifyContract } from "../lib/verify.ts";

const { viem } = await hre.network.connect();

async function main() {
  console.log("Deploying BTC/USD oracle mock...");

  // // Get wallet client
  const [deployer] = await viem.getWalletClients();
  console.log("Deployer address:", deployer.account.address);

  // Deploy USDC Mock contract
  const btcUsdMock = await viem.deployContract("BTCUSDMock", [], { confirmations: 5 });
  console.log("Deployed at:", btcUsdMock.address);

  const btcPrice = "96936.15";
  const ORACLE_DECIMALS = await btcUsdMock.read.decimals();

  console.log("Setting BTC price to:", btcPrice);
  const sim = await btcUsdMock.simulate.setPrice([parseUnits(btcPrice, ORACLE_DECIMALS)]);
  const receipt = await writeAndWait(deployer, sim);
  console.log("Transaction hash:", receipt.transactionHash);

  await verifyContract(btcUsdMock.address);

  console.log("\nOracle Details:");
  console.log(
    "BTC price:",
    Number((await btcUsdMock.read.latestRoundData())[1]) / 10 ** (await btcUsdMock.read.decimals()),
  );

  console.log("Done!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
