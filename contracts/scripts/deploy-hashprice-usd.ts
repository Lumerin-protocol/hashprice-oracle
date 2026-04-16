import { network } from "hardhat";
import { requireEnvsSet } from "../lib/env.ts";
import { verifyContract } from "../lib/verify.ts";

async function main() {
  const { viem } = await network.connect();
  console.log("HashpriceUSD deployment script");
  console.log();

  const env = <
    {
      HASHPRICE_BTC_ADDRESS: `0x${string}`;
      BTC_USD_ADDRESS: `0x${string}`;
    }
  >requireEnvsSet("HASHPRICE_BTC_ADDRESS", "BTC_USD_ADDRESS");

  const [deployer] = await viem.getWalletClients();
  console.log("Deployer:", deployer.account.address);
  console.log();

  console.log("Upstream oracles:");
  console.log("  HashpriceBTC:", env.HASHPRICE_BTC_ADDRESS);
  console.log("  BTC/USD:", env.BTC_USD_ADDRESS);
  console.log();

  const hashpriceBtc = await viem.getContractAt("HashpriceBTC", env.HASHPRICE_BTC_ADDRESS);
  console.log("HashpriceBTC details:");
  console.log("  decimals:", await hashpriceBtc.read.decimals());
  console.log("  description:", await hashpriceBtc.read.description());

  const btcUsdOracle = await viem.getContractAt("AggregatorV3Interface", env.BTC_USD_ADDRESS);
  const btcUsdDecimals = await btcUsdOracle.read.decimals();
  console.log("BTC/USD oracle details:");
  console.log("  decimals:", btcUsdDecimals);
  console.log();

  console.log("Deploying HashpriceUSD...");
  const hashpriceUsd = await viem.deployContract("HashpriceUSD", [
    env.HASHPRICE_BTC_ADDRESS,
    env.BTC_USD_ADDRESS,
  ]);
  console.log("Deployed at:", hashpriceUsd.address);

  console.log();
  console.log("On-chain state:");
  console.log("  decimals:", await hashpriceUsd.read.decimals());
  console.log("  description:", await hashpriceUsd.read.description());
  console.log("  version:", await hashpriceUsd.read.version());
  console.log("  hashpriceOracle:", await hashpriceUsd.read.hashpriceOracle());
  console.log("  btcUsdOracle:", await hashpriceUsd.read.btcUsdOracle());
  console.log();

  await verifyContract(hashpriceUsd.address, [env.HASHPRICE_BTC_ADDRESS, env.BTC_USD_ADDRESS]);

  console.log("Done!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
