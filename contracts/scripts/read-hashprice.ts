import { network } from "hardhat";
import { formatUnits, isAddress } from "viem";

async function main() {
  const address = process.env.HASHPRICE_BTC_ADDRESS as `0x${string}`;
  if (!address || !isAddress(address)) {
    console.error("HASHPRICE_BTC_ADDRESS environment variable is required");
    console.error(
      "Usage: HASHPRICE_BTC_ADDRESS=0x... pnpm hardhat run scripts/read-hashprice.ts --network localhost",
    );
    process.exit(1);
  }

  console.log("Connecting to HashpriceBTC at:", address);

  const conn = await network.connect();
  const contract = await conn.viem.getContractAt("HashpriceBTC", address);

  const [decimals, description] = await Promise.all([
    contract.read.decimals(),
    contract.read.description(),
  ]);

  const roundData = await contract.read.latestRoundData();

  const [roundId, answer, startedAt, updatedAt, answeredInRound] = roundData;
  const price = Number(formatUnits(answer, decimals));

  console.log();
  console.log("=== HashpriceBTC latestRoundData ===");
  console.log("Description:       ", description);
  console.log("Round ID:          ", roundId.toString());
  console.log("Answer (raw):      ", answer.toString());
  console.log(`Answer (formatted):  ${price.toFixed(8)} BTC / 100 TH/s / day`);
  console.log("Decimals:          ", decimals);
  console.log(
    "Started at:        ",
    startedAt.toString(),
    startedAt > 0n ? `(${new Date(Number(startedAt) * 1000).toISOString()})` : "",
  );
  console.log(
    "Updated at:        ",
    updatedAt.toString(),
    updatedAt > 0n ? `(${new Date(Number(updatedAt) * 1000).toISOString()})` : "",
  );
  console.log("Answered in round: ", answeredInRound.toString());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
