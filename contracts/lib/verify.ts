import { run } from "hardhat";

export async function verifyContract(address: string, constructorArgs?: any[]) {
  console.log("Verifying contract...");
  await sleep(5000);
  await run("verify:verify", {
    address,
    constructorArguments: constructorArgs,
  }).catch((err) => {
    console.error(err);
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
