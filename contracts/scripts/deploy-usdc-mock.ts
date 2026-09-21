import { viem } from "hardhat";
import { verifyContract } from "../lib/verify";

async function main() {
  console.log("USDCMock deployment script");
  console.log();

  const [deployer] = await viem.getWalletClients();
  console.log("Deployer:", deployer.account.address);
  console.log();

  console.log("Deploying USDCMock...");
  const usdc = await viem.deployContract("USDCMock");
  console.log("Deployed at:", usdc.address);

  console.log("Name:", await usdc.read.name());
  console.log("Symbol:", await usdc.read.symbol());
  console.log("Decimals:", await usdc.read.decimals());
  console.log("Total supply:", await usdc.read.totalSupply());
  console.log();

  await verifyContract(usdc.address, []);

  console.log("Done!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
