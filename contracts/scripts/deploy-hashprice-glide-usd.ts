import { network } from "hardhat";
import { requireEnvsSet } from "../lib/env.ts";
import { verifyContract } from "../lib/verify.ts";

async function main() {
  const { viem } = await network.connect();
  console.log("HashpriceGlideUSD deployment script");
  console.log();

  const env = <{ HASHPRICE_USD_ADDRESS: `0x${string}` }>requireEnvsSet("HASHPRICE_USD_ADDRESS");

  const [deployer] = await viem.getWalletClients();
  console.log("Deployer:", deployer.account.address);
  console.log("HashpriceUSD:", env.HASHPRICE_USD_ADDRESS);
  console.log();

  console.log("Deploying HashpriceGlideUSD...");
  const glideUSD = await viem.deployContract("HashpriceGlideUSD", [env.HASHPRICE_USD_ADDRESS], {
    confirmations: 5,
  });
  console.log("Deployed at:", glideUSD.address);

  const hashpriceUsd = await viem.getContractAt("HashpriceUSD", env.HASHPRICE_USD_ADDRESS);
  const [, index, , updatedAt] = await hashpriceUsd.read.latestRoundData();
  const [, glide, , glideUpdatedAt] = await glideUSD.read.latestRoundData();
  const eta = await glideUSD.read.halvingEta();

  console.log();
  console.log("On-chain state:");
  console.log("  hashpriceBtc:", await glideUSD.read.hashpriceBtc());
  console.log("  decimals:", await glideUSD.read.decimals());
  console.log("  description:", await glideUSD.read.description());
  console.log("  version:", await glideUSD.read.version());
  console.log("  next halving height:", await glideUSD.read.nextHalvingHeight());
  console.log("  halving estimate:", new Date(Number(eta) * 1000).toISOString());
  console.log("  halving window (s):", await glideUSD.read.halvingWindow());
  console.log("  halving step (WAD):", await glideUSD.read.halvingStep());
  console.log("  glide progress (WAD):", await glideUSD.read.glideProgress());
  console.log("  index:", index, "updatedAt:", updatedAt);
  console.log("  glide:", glide, "updatedAt:", glideUpdatedAt);
  console.log("  post-halving price:", await glideUSD.read.postHalvingPrice());
  console.log();

  await verifyContract(glideUSD.address, [env.HASHPRICE_USD_ADDRESS]);

  console.log("Done!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
