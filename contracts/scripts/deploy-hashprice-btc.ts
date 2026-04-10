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
  // const hashpriceBtc = await viem.deployContract("HashpriceBTCDeploy", []);
  // console.log("Deployed at:", hashpriceBtc.address);
  const hashpriceBtc = await viem.getContractAt(
    "HashpriceBTCDeploy",
    "0x172621a9e23cd3f439232f8cfd84848a9475ddfc",
  );

  console.log();
  console.log("On-chain state:");
  console.log("  decimals:", await hashpriceBtc.read.decimals());
  console.log("  description:", await hashpriceBtc.read.description());
  console.log("  version:", await hashpriceBtc.read.version());
  console.log("  chainTip:", await hashpriceBtc.read.chainTip());

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
