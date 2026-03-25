import { requireEnvsSet } from "../lib/env";
import { viem, artifacts } from "hardhat";
import { encodeFunctionData, getAddress } from "viem";
import { writeAndWait } from "../lib/writeContract";
import { verifyContract } from "../lib/verify";

async function main() {
  console.log("Hashrate Oracle deployment script");
  console.log();

  const env = <
    {
      BTCUSDC_ORACLE_ADDRESS: `0x${string}`;
      USDC_TOKEN_ADDRESS: `0x${string}`;
    }
  >requireEnvsSet("BTCUSDC_ORACLE_ADDRESS", "USDC_TOKEN_ADDRESS");

  const SAFE_OWNER_ADDRESS = process.env.SAFE_OWNER_ADDRESS as `0x${string}` | undefined;

  const pc = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  console.log("Deployer:", deployer.account.address);
  console.log("Safe owner address:", SAFE_OWNER_ADDRESS);

  console.log();

  console.log("Getting payment token decimals...");
  const paymentToken = await viem.getContractAt(
    "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata",
    env.USDC_TOKEN_ADDRESS,
  );
  const tokenDecimals = await paymentToken.read.decimals();
  console.log("Name:", await paymentToken.read.name());
  console.log("Symbol:", await paymentToken.read.symbol());
  console.log("Decimals:", tokenDecimals);

  console.log();

  console.log("Getting Oracle details...");
  const btcusdOracle = await viem.getContractAt(
    "AggregatorV3Interface",
    env.BTCUSDC_ORACLE_ADDRESS,
  );
  const oracleDecimals = await btcusdOracle.read.decimals();
  const btcPrice = Number((await btcusdOracle.read.latestRoundData())[1]) / 10 ** oracleDecimals;
  console.log("Oracle decimals:", oracleDecimals);
  console.log("BTC price:", btcPrice);

  console.log();

  console.log("Deploying HashrateOracle implementation...");
  const hashrateOracleImpl = await viem.deployContract("HashrateOracle", [
    env.BTCUSDC_ORACLE_ADDRESS,
    tokenDecimals,
  ]);
  console.log("Deployed at:", hashrateOracleImpl.address);
  await verifyContract(hashrateOracleImpl.address, [env.BTCUSDC_ORACLE_ADDRESS, tokenDecimals]);

  // Deploy ERC1967Proxy
  console.log("Deploying Proxy...");
  const encodedInitFn = encodeFunctionData({
    abi: hashrateOracleImpl.abi,
    functionName: "initialize",
    args: [],
  });

  const proxyArtifact = await artifacts.readArtifact(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
  );
  const proxyHash = await deployer.deployContract({
    abi: proxyArtifact.abi,
    bytecode: proxyArtifact.bytecode as `0x${string}`,
    args: [hashrateOracleImpl.address as `0x${string}`, encodedInitFn],
  });
  const proxyReceipt = await pc.waitForTransactionReceipt({ hash: proxyHash });
  if (!proxyReceipt.contractAddress) throw new Error("Proxy deploy failed");
  const proxyAddress = getAddress(proxyReceipt.contractAddress);
  console.log("Proxy deployed at:", proxyAddress);

  const hashrateOracle = await viem.getContractAt("HashrateOracle", proxyAddress);
  console.log("Version:", await hashrateOracle.read.VERSION());

  console.log();

  const safeTTL = 3n * 3600n;
  await hashrateOracle.write.setTTL([safeTTL, safeTTL]);
  console.log("ttl is set to", safeTTL);

  // Transfer ownership to the owner address
  if (SAFE_OWNER_ADDRESS) {
    console.log("Transfering ownership to:", SAFE_OWNER_ADDRESS);
    const sim = await hashrateOracle.simulate.transferOwnership([SAFE_OWNER_ADDRESS], {
      account: deployer.account.address,
    });
    const receipt = await writeAndWait(deployer, sim);
    console.log("Transaction hash:", receipt.transactionHash);
  }

  console.log("Done!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
