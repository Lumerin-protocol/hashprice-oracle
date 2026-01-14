import { viem } from "hardhat";
import { formatUnits, parseUnits } from "viem";
import { createInterface } from "readline";

async function main() {
  const oracleAddress = process.env.BTCUSDC_ORACLE_ADDRESS as `0x${string}`;
  if (!oracleAddress) {
    console.error("BTCUSDC_ORACLE_ADDRESS environment variable is required");
    console.error(
      "Usage: BTCUSDC_ORACLE_ADDRESS=0x... npx hardhat run scripts/set-bitcoin-price.ts --network localhost"
    );
    process.exit(1);
  }

  console.log("Connecting to BTCPriceOracleMock at:", oracleAddress);

  const pc = await viem.getPublicClient();

  const btcPriceOracleMock = await viem.getContractAt(
    "contracts/BTCPriceOracleMock.sol:BTCPriceOracleMock",
    oracleAddress
  );

  // Read current price from oracle
  const [, answer] = await btcPriceOracleMock.read.latestRoundData();
  const decimals = await btcPriceOracleMock.read.decimals();
  let currentPrice = Number(formatUnits(answer, decimals));

  console.log(`Current oracle price: $${currentPrice.toLocaleString()}`);

  // Create readline interface for user input
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    console.log("\n" + "=".repeat(50));
    console.log(`Current BTC price: $${currentPrice.toLocaleString()}`);
    console.log("=".repeat(50));
    console.log('Enter price change (e.g., "+2" for +2%, "-5" for -5%)');
    console.log('Or enter "quit" to exit');

    rl.question("> ", async (input) => {
      const trimmed = input.trim().toLowerCase();

      if (trimmed === "quit" || trimmed === "q" || trimmed === "exit") {
        console.log("Goodbye!");
        rl.close();
        process.exit(0);
      }

      // Parse percentage change (e.g., "+2", "-5", "2", "-10")
      const match = trimmed.match(/^([+-])?(\d+(?:\.\d+)?)$/);
      if (!match) {
        console.error('Invalid input. Use format like "+2", "-5", "10", or "-0.5"');
        prompt();
        return;
      }

      const sign = match[1] === "-" ? -1 : 1;
      const percent = parseFloat(match[2]) * sign;

      // Calculate new price
      const newPrice = currentPrice * (1 + percent / 100);
      const newPriceScaled = parseUnits(newPrice.toFixed(2), decimals);

      console.log(`\nApplying ${percent >= 0 ? "+" : ""}${percent}% change...`);
      console.log(`$${currentPrice.toLocaleString()} → $${newPrice.toLocaleString()}`);

      try {
        const hash = await btcPriceOracleMock.write.setPrice([newPriceScaled, decimals]);
        await pc.waitForTransactionReceipt({ hash });

        // Verify the price was updated
        const [, newAnswer] = await btcPriceOracleMock.read.latestRoundData();
        currentPrice = Number(formatUnits(newAnswer, decimals));

        console.log(`✓ Transaction confirmed!`);
        console.log(`✓ New oracle price: $${currentPrice.toLocaleString()}`);
      } catch (error) {
        console.error("Transaction failed:", error);
      }

      prompt();
    });
  };

  prompt();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
