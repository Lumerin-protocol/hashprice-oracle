import { network } from "hardhat";
import { verifyContract } from "../lib/verify.ts";

async function main() {
  const { viem } = await network.connect();
  console.log("HashpriceBTC deployment script");
  console.log();

  const [deployer] = await viem.getWalletClients();
  console.log("Deployer:", deployer.account.address);
  console.log();

  console.log("Deploying HashpriceBTCDeploy...");
  const hashpriceBtc = await viem.deployContract("HashpriceBTCDeploy", []);
  console.log("Deployed at:", hashpriceBtc.address);

  console.log();
  console.log("On-chain state:");
  console.log("  decimals:", await hashpriceBtc.read.decimals());
  console.log("  description:", await hashpriceBtc.read.description());
  console.log("  version:", await hashpriceBtc.read.version());
  console.log("  chainTipHash:", await hashpriceBtc.read.chainTipHash());

  const [chainHeight] = Object.values(await hashpriceBtc.read.state());
  console.log("  chainHeight:", chainHeight);
  console.log();

  await verifyContract(
    hashpriceBtc.address,
    [],
    "contracts/HashpriceBTCDeploy.sol:HashpriceBTCDeploy",
  );

  console.log("Done!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
